# backend/routes_qa.py
import os
import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
import tiktoken
from db import events

router = APIRouter(prefix="/api", tags=["qa"])

_QA_CLIENT = httpx.AsyncClient(timeout=30.0)


class QABody(BaseModel):
    session_id: str
    current_recipe: dict
    current_step_index: int
    question: str


PROVIDER = os.environ.get("LLM_PROVIDER", "openrouter").lower()

PROMPT_TMPL = (
    "Answer in at most 2 short sentences.\n"
    "Recipe title: {title}\n"
    "Current step: {step}\n"
    "Q: {q}\nA:"
)


def _cost(prov: str, model: str, n_in: int, n_out: int) -> float:
    rates = {
        "openai":     {"gpt-5.4-nano": (0.20, 1.25)},
        "openrouter": {"google/gemma-4-31b-it:free": (0.0, 0.0)},
    }
    pin, pout = rates.get(prov, {}).get(model, (0.0, 0.0))
    return (n_in * pin + n_out * pout) / 1_000_000


@router.post("/qa")
async def qa(body: QABody):
    title = body.current_recipe.get("name", "")
    steps = body.current_recipe.get("steps", [])
    cur = steps[body.current_step_index] if 0 <= body.current_step_index < len(steps) else ""
    if isinstance(cur, dict):
        cur = cur.get("text", "")
    prompt = PROMPT_TMPL.format(title=title, step=cur, q=body.question.strip())

    enc = tiktoken.get_encoding("o200k_base")
    n_in = len(enc.encode(prompt))

    if PROVIDER == "openai":
        url = "https://api.openai.com/v1/chat/completions"
        key = os.environ.get("OPENAI_API_KEY", "")
        model = os.environ.get("OPENAI_MODEL", "gpt-5.4-nano")
    else:
        url = "https://openrouter.ai/api/v1/chat/completions"
        key = os.environ.get("OPENROUTER_API_KEY", "")
        model = os.environ.get("OPENROUTER_MODEL", "google/gemma-4-31b-it:free")

    if not key:
        raise HTTPException(500, f"{PROVIDER} API key not configured")

    payload = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 80,
        "temperature": 0.3,
    }
    c = _QA_CLIENT
    r = await c.post(url, headers={"Authorization": f"Bearer {key}"}, json=payload)
    if r.status_code != 200:
        raise HTTPException(502, "llm upstream error")
    data = r.json()

    text = data["choices"][0]["message"]["content"].strip()
    n_out = len(enc.encode(text))
    cost = _cost(PROVIDER, model, n_in, n_out)

    try:
        from bson import ObjectId
        await events.insert_one({
            "session_id": ObjectId(body.session_id) if len(body.session_id) == 24 else body.session_id,
            "ts": __import__("datetime").datetime.utcnow(),
            "kind": "voice_qa",
            "data": {
                "question": body.question,
                "answer": text,
                "cost_usd": cost,
                "tokens_in": n_in,
                "tokens_out": n_out,
            },
        })
    except Exception:
        pass

    return {"answer": text, "cost_delta_usd": cost, "tokens_in": n_in, "tokens_out": n_out}
