import os
import re
import json
import base64
import math
import time
import logging
import traceback
import httpx
import tiktoken
from io import BytesIO
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel
from typing import Optional
from PIL import Image
from db import ensure_indexes
from routes_session import router as session_router

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("gestucook")

app = FastAPI(title="GestuCook API")
app.include_router(session_router)

LLM_PROVIDER = os.getenv("LLM_PROVIDER", "openrouter")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-5.4-nano")
OPENROUTER_MODEL = os.getenv("OPENROUTER_MODEL", "google/gemma-4-31b-it:free")
ASR_URL = os.getenv("ASR_URL", "http://asr-service:8001")
TTS_URL = os.getenv("TTS_URL", "http://tts-service:8002")

TOKENIZER = tiktoken.get_encoding("o200k_base")


# ── step duration helpers ─────────────────────────────────────

_DUR_RE = re.compile(r"""
    (?:for\s+|about\s+|~|approximately\s+)?
    (\d{1,3})\s*
    (s|sec|secs|second|seconds|m|min|mins|minute|minutes|hr|hrs|hour|hours)\b
""", re.I | re.X)


def parse_step_duration(text: str):
    if not text:
        return None
    m = _DUR_RE.search(text)
    if not m:
        return None
    n = int(m.group(1))
    unit = m.group(2).lower()
    if unit.startswith("s") and not unit.startswith("se"):
        return n
    if unit.startswith("se"):
        return n
    if unit.startswith("m"):
        return n * 60
    if unit.startswith("h"):
        return n * 3600
    return None


def enrich_recipes(recipes):
    for r in recipes.get("recipes", recipes if isinstance(recipes, list) else []):
        steps = r.get("steps", [])
        new_steps = []
        for s in steps:
            if isinstance(s, str):
                new_steps.append({"text": s, "duration_seconds": parse_step_duration(s)})
            else:
                s.setdefault("duration_seconds", parse_step_duration(s.get("text", "")))
                new_steps.append(s)
        r["steps"] = new_steps
    return recipes


@app.on_event("startup")
async def on_startup():
    await ensure_indexes()


@app.on_event("startup")
def startup_check():
    logger.info("=== GestuCook Backend Starting ===")
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

RECIPE_PROMPT_TEMPLATE = """You are a culinary assistant. Given ingredients, generate exactly {count} recipes.
Return ONLY valid JSON in this exact format, no other text:
{{
  "recipes": [
    {{
      "name": "Recipe Name",
      "description": "Short 1-line description",
      "prep_time": "15 min",
      "cook_time": "30 min",
      "servings": 4,
      "ingredients": ["200g item1", "1 item2"],
      "steps": ["Step 1 instruction", "Step 2 instruction"]
    }}
  ]
}}

Ingredients available: {ingredients}
{cuisine_line}
Return ONLY the JSON."""


async def generate_recipes(
    ingredients: list[str],
    cuisines: list[str] | None = None,
    count: int = 3,
) -> tuple[dict, dict]:
    cuisine_line = ""
    if cuisines and len(cuisines) > 0 and cuisines[0]:
        cuisine_line = f"Preferred cuisines: {', '.join(cuisines)}"

    prompt = RECIPE_PROMPT_TEMPLATE.format(
        count=count,
        ingredients=", ".join(ingredients),
        cuisine_line=cuisine_line,
    )

    messages = [{"role": "user", "content": prompt}]
    result = await call_llm(messages, max_tokens=2048)
    raw = result["text"].strip()
    logger.info("Recipe raw response (first 300): %.300s", raw)

    if raw.startswith("```"):
        raw = raw.split("\n", 1)[-1].rsplit("```", 1)[0].strip()

    try:
        data = json.loads(raw)
        if "recipes" in data:
            return data, result.get("usage", {})
    except json.JSONDecodeError:
        logger.warning("Failed to parse recipe JSON")

    return {"recipes": [], "error": "Failed to parse recipes"}, result.get("usage", {})


# ── API routes ────────────────────────────────────────────────

@app.get("/api/health")
async def health():
    return {"status": "ok", "provider": LLM_PROVIDER}


@app.get("/api/config")
async def config():
    return {
        "provider": LLM_PROVIDER,
        "model": OPENAI_MODEL if LLM_PROVIDER == "openai" else OPENROUTER_MODEL,
    }


class HandsFreeRequest(BaseModel):
    ingredients: list[str]
    cuisines: Optional[list[str]] = None
    count: Optional[int] = 3


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
    logger.info("Recipes: ingredients=%s cuisines=%s count=%d",
                req.ingredients, req.cuisines, req.count or 3)
    start = time.time()

    try:
        data, usage = await generate_recipes(req.ingredients, req.cuisines, req.count or 3)
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
async def asr(audio: UploadFile = File(...)):
    contents = await audio.read()
    logger.info("ASR: file=%s size=%d", audio.filename, len(contents))
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
    logger.info("TTS: text_len=%d", len(text))
    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.post(f"{TTS_URL}/speak", data={"text": text})
    if resp.status_code != 200:
        logger.error("TTS error %d: %s", resp.status_code, resp.text[:200])
        raise HTTPException(status_code=502, detail="TTS service error")
    return Response(content=resp.content, media_type="audio/wav")
