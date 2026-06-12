import os
import re
import json
import asyncio
import base64
import copy
import math
import time
import logging
import traceback
import httpx
import tiktoken
from datetime import datetime
from io import BytesIO
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel
from typing import Optional
from PIL import Image
from db import ensure_indexes, events
from demo import (
    DEMO_MODE,
    DEMO_RECIPES,
    DEMO_INGREDIENTS_TEXT,
    DEMO_ASR_DELAY_SECONDS,
)
from langs import LANGUAGE_NAMES, SECOND_UNITS, MINUTE_UNITS, HOUR_UNITS, ALL_UNITS
from routes_session import router as session_router
from routes_qa import router as qa_router

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("gestucook")

app = FastAPI(title="GestuCook API")
app.include_router(session_router)
app.include_router(qa_router)

LLM_PROVIDER = os.getenv("LLM_PROVIDER", "openrouter")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-5.4-nano")
OPENROUTER_MODEL = os.getenv("OPENROUTER_MODEL", "google/gemma-4-31b-it:free")
ASR_URL = os.getenv("ASR_URL", "http://asr-service:8001")
TTS_URL = os.getenv("TTS_URL", "http://tts-service:8002")

AUDIO_PROVIDER = os.getenv("AUDIO_PROVIDER", "local").strip().lower()
OPENAI_TRANSCRIBE_MODEL = os.getenv("OPENAI_TRANSCRIBE_MODEL", "gpt-4o-mini-transcribe")
OPENAI_TTS_MODEL = os.getenv("OPENAI_TTS_MODEL", "gpt-4o-mini-tts")
OPENAI_TTS_VOICE = os.getenv("OPENAI_TTS_VOICE", "marin")
# Verified against the live pricing page 2026-06-12 (estimates for usage logging)
ASR_USD_PER_MIN = 0.003
TTS_USD_PER_MIN = 0.015

TOKENIZER = tiktoken.get_encoding("o200k_base")


# ── step duration helpers ─────────────────────────────────────

# Unit alternation is rebuilt from langs.py so localized recipe steps
# ("per 4 minuti", "लगभग 4 मिनट") still produce step timers. Longest-first so
# "मिनटों" wins over "मिनट" and "minutes" over "min".
_UNIT_ALT = "|".join(sorted((re.escape(u) for u in ALL_UNITS), key=len, reverse=True))
_DUR_RE = re.compile(
    r"(?:for\s+|about\s+|~|approximately\s+)?(\d{1,3})\s*(" + _UNIT_ALT + r")\b",
    re.I,
)


def parse_step_duration(text: str):
    if not text:
        return None
    m = _DUR_RE.search(text)
    if not m:
        return None
    n = int(m.group(1))
    unit = m.group(2).lower()
    # Membership sets, not first-letter heuristics: Devanagari units have no
    # useful "first letter" and Italian "ora" must not be guessed at.
    if unit in SECOND_UNITS:
        return n
    if unit in MINUTE_UNITS:
        return n * 60
    if unit in HOUR_UNITS:
        return n * 3600
    return None


def enrich_recipes(recipes):
    for r in recipes.get("recipes", recipes if isinstance(recipes, list) else []):
        # A repaired / truncated LLM response can leave a recipe or its steps
        # in a shape that is not a dict / list -- guard before iterating.
        if not isinstance(r, dict):
            continue
        steps = r.get("steps", [])
        if not isinstance(steps, list):
            steps = []
        new_steps = []
        for s in steps:
            if isinstance(s, str):
                new_steps.append({"text": s, "duration_seconds": parse_step_duration(s)})
            elif isinstance(s, dict):
                s.setdefault("duration_seconds", parse_step_duration(s.get("text", "")))
                new_steps.append(s)
            # any other shape (a stray value from a bad repair) is dropped
        r["steps"] = new_steps
    return recipes


@app.on_event("startup")
async def on_startup():
    await ensure_indexes()
    logger.info("=== GestuCook Backend Starting ===")
    logger.info("DEMO_MODE = %s",
                "ON - fixed recipes + cached salt answer" if DEMO_MODE else "off")
    logger.info("AUDIO_PROVIDER = %s%s", AUDIO_PROVIDER,
                f" ({OPENAI_TRANSCRIBE_MODEL} / {OPENAI_TTS_MODEL} voice={OPENAI_TTS_VOICE})"
                if AUDIO_PROVIDER == "openai" else "")
    logger.info("LLM_PROVIDER = %s", LLM_PROVIDER)
    if LLM_PROVIDER == "openai":
        logger.info("OPENAI_MODEL  = %s", OPENAI_MODEL)
        preview = OPENAI_API_KEY[:12] + "..." if len(OPENAI_API_KEY) > 12 else "(EMPTY)"
        logger.info("OPENAI_API_KEY = %s", preview)
        if not OPENAI_API_KEY:
            logger.error("OPENAI_API_KEY is EMPTY. All LLM calls will fail!")
    else:
        logger.info("OPENROUTER_MODEL = %s", OPENROUTER_MODEL)
        preview = OPENROUTER_API_KEY[:12] + "..." if len(OPENROUTER_API_KEY) > 12 else "(EMPTY)"
        logger.info("OPENROUTER_API_KEY = %s", preview)
        if not OPENROUTER_API_KEY:
            logger.error("OPENROUTER_API_KEY is EMPTY. All LLM calls will fail!")
    logger.info("ASR_URL = %s", ASR_URL)
    logger.info("TTS_URL = %s", TTS_URL)
    logger.info("=================================")


# ── cost helpers ──────────────────────────────────────────────

def count_text_tokens(text: str) -> int:
    return len(TOKENIZER.encode(text))


def count_image_tokens_openai(width: int, height: int, detail: str = "high") -> int:
    """Patch-based image token calc for gpt-5.4-nano.
    32x32 patches, 1536 patch budget, 2.46x multiplier.
    Reference: OpenAI docs 'Patch-based image tokenization'."""

    PATCH_SIZE = 32
    PATCH_BUDGET = 1536
    MULTIPLIER = 2.46
    MAX_DIM = 2048

    if detail == "low":
        return int(math.ceil(16 * 16 * MULTIPLIER))

    # cap max dimension to 2048
    if max(width, height) > MAX_DIM:
        scale = MAX_DIM / max(width, height)
        width = int(width * scale)
        height = int(height * scale)

    # A: original patch count
    patches_x = math.ceil(width / PATCH_SIZE)
    patches_y = math.ceil(height / PATCH_SIZE)
    original_patches = patches_x * patches_y

    if original_patches <= PATCH_BUDGET:
        # fits within budget, no resize needed
        return int(math.ceil(original_patches * MULTIPLIER))

    # B: need to shrink
    shrink = math.sqrt((PATCH_SIZE * PATCH_SIZE * PATCH_BUDGET) / (width * height))
    w_scaled = width * shrink / PATCH_SIZE
    h_scaled = height * shrink / PATCH_SIZE
    adj_shrink = shrink * min(
        math.floor(w_scaled) / w_scaled if w_scaled > 0 else 1,
        math.floor(h_scaled) / h_scaled if h_scaled > 0 else 1,
    )

    rw = max(1, int(width * adj_shrink))
    rh = max(1, int(height * adj_shrink))

    # C: resized patch count
    resized_patches = math.ceil(rw / PATCH_SIZE) * math.ceil(rh / PATCH_SIZE)
    resized_patches = min(resized_patches, PATCH_BUDGET)

    # D: apply multiplier
    return int(math.ceil(resized_patches * MULTIPLIER))


def count_image_tokens_openrouter(width: int, height: int) -> int:
    """Rough estimate for Gemma via OpenRouter."""
    return 258


def estimate_cost(input_tokens: int, output_tokens: int, provider: str) -> dict:
    if provider == "openai":
        input_price = 0.20 / 1_000_000
        output_price = 1.25 / 1_000_000
    else:
        input_price = 0.0
        output_price = 0.0

    return {
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "input_cost_usd": round(input_tokens * input_price, 6),
        "output_cost_usd": round(output_tokens * output_price, 6),
        "total_cost_usd": round(
            input_tokens * input_price + output_tokens * output_price, 6
        ),
        "provider": provider,
    }


# ── LLM call helpers ─────────────────────────────────────────

async def call_openai(messages: list, max_tokens: int = 1024) -> dict:
    logger.info("Calling OpenAI: model=%s max_tokens=%d", OPENAI_MODEL, max_tokens)
    try:
        async with httpx.AsyncClient(timeout=90) as client:
            resp = await client.post(
                "https://api.openai.com/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {OPENAI_API_KEY}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": OPENAI_MODEL,
                    "messages": messages,
                    "max_completion_tokens": max_tokens,
                    "temperature": 0.7,
                },
            )
    except httpx.TimeoutException:
        logger.error("OpenAI request timed out after 90s")
        raise HTTPException(status_code=504, detail="OpenAI request timed out")
    except Exception as e:
        logger.error("OpenAI connection error: %s", str(e))
        raise HTTPException(status_code=502, detail=f"OpenAI connection error: {str(e)}")

    if resp.status_code != 200:
        body = resp.text[:500]
        logger.error("OpenAI returned HTTP %d: %s", resp.status_code, body)
        raise HTTPException(
            status_code=502,
            detail=f"OpenAI API error ({resp.status_code}): {body}",
        )

    data = resp.json()
    logger.info("OpenAI OK, usage=%s", data.get("usage", {}))
    text = data["choices"][0]["message"]["content"]
    usage = data.get("usage", {})
    return {"text": text, "usage": usage}


async def call_openrouter(messages: list, max_tokens: int = 1024) -> dict:
    logger.info("Calling OpenRouter: model=%s max_tokens=%d", OPENROUTER_MODEL, max_tokens)
    try:
        async with httpx.AsyncClient(timeout=90) as client:
            resp = await client.post(
                "https://openrouter.ai/api/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {OPENROUTER_API_KEY}",
                    "Content-Type": "application/json",
                    "HTTP-Referer": "http://localhost:3080",
                    "X-Title": "GestuCook",
                },
                json={
                    "model": OPENROUTER_MODEL,
                    "messages": messages,
                    "max_completion_tokens": max_tokens,
                    "temperature": 0.7,
                },
            )
    except httpx.TimeoutException:
        logger.error("OpenRouter request timed out after 90s")
        raise HTTPException(status_code=504, detail="OpenRouter request timed out")
    except Exception as e:
        logger.error("OpenRouter connection error: %s", str(e))
        raise HTTPException(status_code=502, detail=f"OpenRouter connection error: {str(e)}")

    if resp.status_code != 200:
        body = resp.text[:500]
        logger.error("OpenRouter returned HTTP %d: %s", resp.status_code, body)
        raise HTTPException(
            status_code=502,
            detail=f"OpenRouter API error ({resp.status_code}): {body}",
        )

    data = resp.json()
    logger.info("OpenRouter OK, usage=%s", data.get("usage", {}))
    text = data["choices"][0]["message"]["content"]
    usage = data.get("usage", {})
    return {"text": text, "usage": usage}


async def call_llm(messages: list, max_tokens: int = 1024) -> dict:
    if LLM_PROVIDER == "openai":
        return await call_openai(messages, max_tokens)
    return await call_openrouter(messages, max_tokens)


# ── image detection ───────────────────────────────────────────

DETECT_PROMPT = """Look at this image of food items. Return ONLY a JSON array of ingredient names you can identify.
Example: ["tomato", "onion", "garlic", "chicken breast"]
Return ONLY the JSON array, no explanation."""


async def detect_ingredients(image_b64: str, mime: str) -> tuple[list[str], dict]:
    messages = [
        {
            "role": "user",
            "content": [
                {"type": "text", "text": DETECT_PROMPT},
                {
                    "type": "image_url",
                    "image_url": {
                        "url": f"data:{mime};base64,{image_b64}"
                    },
                },
            ],
        }
    ]

    result = await call_llm(messages, max_tokens=256)
    raw = result["text"].strip()
    logger.info("Detect raw response: %.200s", raw)

    if raw.startswith("```"):
        raw = raw.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
    try:
        items = json.loads(raw)
        if isinstance(items, list):
            return items, result.get("usage", {})
    except json.JSONDecodeError:
        logger.warning("Failed to parse detect JSON: %.200s", raw)

    return [raw], result.get("usage", {})


# ── recipe generation ─────────────────────────────────────────

# A short system message keeps the model in "recipe developer" mode -- it sets
# the bar for detail far more reliably than the same words inside the user turn.
RECIPE_SYSTEM = (
    "You are a professional recipe developer. You write recipes a home cook can "
    "follow end to end with no prior knowledge: every step is one concrete action "
    "with quantities, heat levels, times and a sensory cue for doneness. You always "
    "reply with valid JSON and nothing else."
)

# NOTE: this template keeps the {count}/{ingredients}/{cuisine_line} placeholders
# because the /api/recipes route re-formats it for token-cost estimation.
RECIPE_PROMPT_TEMPLATE = """Create exactly {count} distinct, genuinely cookable recipes from the ingredients below.

Requirements for EVERY recipe:
- 8 to 14 steps. Each step is ONE concrete action; never bundle two actions into one step.
- Each step, where relevant, states: the quantity used in that step, the heat level
  (for example medium-high), the time written as "for 4 minutes" or "about 4 minutes",
  and a sensory cue for doneness (for example "until golden" or "until it springs back").
- Ingredients list explicit kitchen quantities (grams, cups, pieces).
- Steps may assume common pantry staples on top of the given ingredients:
  salt, pepper, cooking oil, butter, water.
- Realistic prep_time, cook_time and total_time, an integer servings, and a
  difficulty of "Easy", "Medium" or "Hard".

Return ONLY valid JSON in EXACTLY this shape, no prose, no markdown fences:
{{
  "recipes": [
    {{
      "name": "Recipe name",
      "cuisine": "Cuisine, for example Italian",
      "description": "One-line hook for the recipe card.",
      "long_description": "Two or three sentences: what the dish is and what to expect.",
      "difficulty": "Easy",
      "prep_time": "15 min",
      "cook_time": "30 min",
      "total_time": "45 min",
      "servings": 4,
      "ingredients": [
        {{ "name": "chicken thighs", "qty": "6 pieces (about 900 g)" }},
        {{ "name": "garlic", "qty": "5 cloves, minced" }}
      ],
      "steps": [
        "Pat the chicken dry with paper towel and season both sides with salt and pepper; dry skin is what lets it brown.",
        "Heat a large skillet over medium-high heat for about 2 minutes, then add 1 tbsp oil and swirl to coat."
      ]
    }}
  ]
}}

Ingredients available: {ingredients}
{cuisine_line}
Return ONLY the JSON object."""


def extract_recipe_json(raw: str):
    """Best-effort parse of an LLM recipe response. Tolerates code fences,
    leading/trailing prose, trailing commas, and a truncated final object
    (the model running out of tokens mid-recipe). Returns the dict or None."""
    if not raw:
        return None
    text = raw.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end != -1 and end > start:
        text = text[start:end + 1]
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    # Repair: drop trailing commas, then balance any brackets the model left
    # open because the response was truncated.
    fixed = re.sub(r",\s*([}\]])", r"\1", text)
    open_curly = fixed.count("{") - fixed.count("}")
    open_brack = fixed.count("[") - fixed.count("]")
    if open_brack > 0:
        fixed += "]" * open_brack
    if open_curly > 0:
        fixed += "}" * open_curly
    try:
        return json.loads(fixed)
    except json.JSONDecodeError:
        return None


LANGUAGE_PROMPT_LINE = (
    "Write every human-readable text value (name, description, long_description, "
    "difficulty, prep_time, cook_time, total_time, ingredient names and qty, every step) "
    "in {lang}. Keep all JSON keys in English. Use Western Arabic numerals (1, 2, 3) "
    "for all numbers and times."
)


async def generate_recipes(
    ingredients: list[str],
    cuisines: list[str] | None = None,
    count: int = 3,
    language: str = "en",
) -> tuple[dict, dict]:
    cuisine_line = ""
    if cuisines and len(cuisines) > 0 and cuisines[0]:
        cuisine_line = f"Preferred cuisines: {', '.join(cuisines)}."

    prompt = RECIPE_PROMPT_TEMPLATE.format(
        count=count,
        ingredients=", ".join(ingredients),
        cuisine_line=cuisine_line,
    )
    if language and language != "en":
        prompt += "\n" + LANGUAGE_PROMPT_LINE.format(
            lang=LANGUAGE_NAMES.get(language, "English"))

    base_messages = [
        {"role": "system", "content": RECIPE_SYSTEM},
        {"role": "user", "content": prompt},
    ]
    # 4096 output tokens: three recipes of 8-14 detailed steps fit comfortably;
    # 2048 (the old budget) truncated the third recipe and broke the JSON.
    result = await call_llm(base_messages, max_tokens=4096)
    raw = result["text"].strip()
    logger.info("Recipe raw response (first 300): %.300s", raw)
    data = extract_recipe_json(raw)

    if not (isinstance(data, dict) and "recipes" in data):
        # One retry: hand the bad output back and demand JSON only.
        logger.warning("Recipe JSON unparseable; retrying once")
        retry_messages = base_messages + [
            {"role": "assistant", "content": raw[:1000]},
            {"role": "user", "content":
                "That was not valid JSON. Reply again with ONLY the JSON object "
                "described above, no prose and no markdown fences."},
        ]
        result = await call_llm(retry_messages, max_tokens=4096)
        raw = result["text"].strip()
        data = extract_recipe_json(raw)

    if isinstance(data, dict) and "recipes" in data:
        return data, result.get("usage", {})

    logger.warning("Failed to parse recipe JSON after retry")
    return {"recipes": [], "error": "Failed to parse recipes"}, result.get("usage", {})


# ── audio usage logging (best-effort, OpenAI provider only) ──

def _wav_seconds(wav: bytes) -> float:
    """Duration from a canonical RIFF header: byte-rate field at offset 28."""
    try:
        byte_rate = int.from_bytes(wav[28:32], "little")
        return max(0.0, (len(wav) - 44) / byte_rate) if byte_rate else 0.0
    except Exception:
        return 0.0


async def _log_audio_usage(op: str, seconds_est: float, language: str | None = None):
    try:
        rate = ASR_USD_PER_MIN if op == "asr" else TTS_USD_PER_MIN
        await events.insert_one({
            "session_id": None,
            "ts": datetime.utcnow(),
            "kind": "audio_usage",
            "data": {
                "provider": "openai",
                "op": op,
                "seconds_est": round(seconds_est, 2),
                "cost_est_usd": round(seconds_est / 60.0 * rate, 6),
                "language": language,
            },
        })
    except Exception:
        pass


# ── API routes ────────────────────────────────────────────────

@app.get("/api/health")
async def health():
    return {"status": "ok", "provider": LLM_PROVIDER}


@app.get("/api/config")
async def config():
    return {
        "provider": LLM_PROVIDER,
        "model": OPENAI_MODEL if LLM_PROVIDER == "openai" else OPENROUTER_MODEL,
        "audio_provider": AUDIO_PROVIDER,
    }


class HandsFreeRequest(BaseModel):
    ingredients: list[str]
    cuisines: Optional[list[str]] = None
    count: Optional[int] = 3
    language: Optional[str] = "en"


@app.post("/api/detect")
async def detect(image: UploadFile = File(...)):
    contents = await image.read()
    mime = image.content_type or "image/jpeg"
    logger.info("Detect: file=%s size=%d mime=%s", image.filename, len(contents), mime)

    try:
        img = Image.open(BytesIO(contents))
        w, h = img.size
        logger.info("Image: %dx%d", w, h)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid image file")

    image_b64 = base64.b64encode(contents).decode("utf-8")
    start = time.time()

    try:
        items, usage = await detect_ingredients(image_b64, mime)
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Detect failed: %s\n%s", str(e), traceback.format_exc())
        raise HTTPException(status_code=500, detail=f"Detection failed: {str(e)}")

    elapsed_ms = round((time.time() - start) * 1000)

    if LLM_PROVIDER == "openai":
        img_tokens = count_image_tokens_openai(w, h)
    else:
        img_tokens = count_image_tokens_openrouter(w, h)

    prompt_tokens = count_text_tokens(DETECT_PROMPT) + img_tokens
    output_tokens = usage.get("completion_tokens", count_text_tokens(json.dumps(items)))
    cost = estimate_cost(prompt_tokens, output_tokens, LLM_PROVIDER)

    return {
        "items": items,
        "cost": cost,
        "latency_ms": elapsed_ms,
    }


@app.post("/api/recipes")
async def recipes(req: HandsFreeRequest):
    if DEMO_MODE and (req.language in (None, "en")):
        logger.info("Recipes: DEMO fixture served (heard ingredients=%s cuisines=%s)",
                    req.ingredients, req.cuisines)
        start = time.time()
        # deepcopy: enrich_recipes mutates steps in place and the module-level
        # fixture must stay pristine across requests
        data = enrich_recipes(copy.deepcopy(DEMO_RECIPES))
        return {
            "recipes": data.get("recipes", []),
            "cost": estimate_cost(0, 0, LLM_PROVIDER),
            "latency_ms": round((time.time() - start) * 1000),
        }
    logger.info("Recipes: ingredients=%s cuisines=%s count=%d",
                req.ingredients, req.cuisines, req.count or 3)
    start = time.time()

    try:
        data, usage = await generate_recipes(req.ingredients, req.cuisines,
                                             req.count or 3, req.language or "en")
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Recipes failed: %s\n%s", str(e), traceback.format_exc())
        raise HTTPException(status_code=500, detail=f"Recipe generation failed: {str(e)}")

    elapsed_ms = round((time.time() - start) * 1000)

    # enrich steps with parsed duration_seconds
    enrich_recipes(data)

    prompt_text = RECIPE_PROMPT_TEMPLATE.format(
        count=req.count or 3,
        ingredients=", ".join(req.ingredients),
        cuisine_line="",
    )
    prompt_tokens = usage.get("prompt_tokens", count_text_tokens(prompt_text))
    output_tokens = usage.get(
        "completion_tokens", count_text_tokens(json.dumps(data))
    )
    cost = estimate_cost(prompt_tokens, output_tokens, LLM_PROVIDER)

    return {
        "recipes": data.get("recipes", []),
        "cost": cost,
        "latency_ms": elapsed_ms,
    }


@app.post("/api/asr")
async def asr(audio: UploadFile = File(...), purpose: Optional[str] = Form(None),
              language: Optional[str] = Form(None)):
    contents = await audio.read()
    logger.info("ASR: file=%s size=%d purpose=%s lang=%s",
                audio.filename, len(contents), purpose, language)
    # Demo mode scripts ONLY the English hands-free ingredient capture. Voice
    # commands and Q&A questions also pass through this route and must keep
    # hitting the real ASR, and a non-English session is always live.
    if DEMO_MODE and purpose == "ingredients" and (language in (None, "en")):
        await asyncio.sleep(DEMO_ASR_DELAY_SECONDS)
        logger.info("ASR: DEMO scripted ingredients served")
        return {"text": DEMO_INGREDIENTS_TEXT, "language": "en", "language_probability": 1.0}

    if AUDIO_PROVIDER == "openai":
        data = {"model": OPENAI_TRANSCRIBE_MODEL, "response_format": "json"}
        if language in LANGUAGE_NAMES:
            data["language"] = language       # accuracy hint, ISO-639-1
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(
                "https://api.openai.com/v1/audio/transcriptions",
                headers={"Authorization": f"Bearer {OPENAI_API_KEY}"},
                data=data,
                files={"file": (audio.filename or "audio.webm", contents,
                                audio.content_type or "audio/webm")},
            )
        if resp.status_code != 200:
            logger.error("OpenAI ASR error %d: %s", resp.status_code, resp.text[:200])
            raise HTTPException(status_code=502, detail="ASR service error")
        await _log_audio_usage("asr", len(contents) / 4000.0, language)  # webm/opus ~ 4 kB/s
        return {"text": resp.json().get("text", "")}

    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.post(
            f"{ASR_URL}/transcribe",
            files={"audio": (audio.filename, contents, audio.content_type)},
        )
    if resp.status_code != 200:
        logger.error("ASR error %d: %s", resp.status_code, resp.text[:200])
        raise HTTPException(status_code=502, detail="ASR service error")
    return resp.json()


@app.post("/api/tts")
async def tts(text: str = Form(...)):
    logger.info("TTS: text_len=%d provider=%s", len(text), AUDIO_PROVIDER)
    if AUDIO_PROVIDER == "openai":
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(
                "https://api.openai.com/v1/audio/speech",
                headers={"Authorization": f"Bearer {OPENAI_API_KEY}"},
                json={"model": OPENAI_TTS_MODEL, "voice": OPENAI_TTS_VOICE,
                      "input": text, "response_format": "wav"},
            )
        if resp.status_code != 200:
            logger.error("OpenAI TTS error %d: %s", resp.status_code, resp.text[:200])
            raise HTTPException(status_code=502, detail="TTS service error")
        await _log_audio_usage("tts", _wav_seconds(resp.content))
        return Response(content=resp.content, media_type="audio/wav")

    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.post(f"{TTS_URL}/speak", data={"text": text})
    if resp.status_code != 200:
        logger.error("TTS error %d: %s", resp.status_code, resp.text[:200])
        raise HTTPException(status_code=502, detail="TTS service error")
    return Response(content=resp.content, media_type="audio/wav")
