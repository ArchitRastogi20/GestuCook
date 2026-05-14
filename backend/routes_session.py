# backend/routes_session.py
from datetime import datetime, timezone
from typing import Optional
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from bson import ObjectId
from db import users, cooking_sessions, events

router = APIRouter(prefix="/api/session", tags=["session"])

def _now(): return datetime.now(timezone.utc)
def _oid(s: str) -> ObjectId:
    try: return ObjectId(s)
    except Exception: raise HTTPException(400, "bad id")

class StartIn(BaseModel):
    name: str

@router.post("/start")
async def start(body: StartIn):
    name = body.name.strip()
    if not name: raise HTTPException(400, "name required")
    now = _now()
    user = await users.find_one_and_update(
        {"name": name},
        {"$set": {"last_seen_at": now},
         "$setOnInsert": {
             "name": name,
             "created_at": now,
             "gesture_trainer_completed_at": None,
             "preferences": {
                 "tts_speed": 1.0,
                 "ambient_mode_default": False,
                 "voice_commands_enabled": True,
             },
         }},
        upsert=True, return_document=True,
    )
    s = await cooking_sessions.insert_one({
        "user_name": name, "started_at": now, "ended_at": None,
        "mode": "single", "recipe_title": None,
    })
    return {
        "session_id": str(s.inserted_id),
        "user": {
            "name": name,
            "gesture_trainer_completed_at": user.get("gesture_trainer_completed_at"),
            "preferences": user.get("preferences", {}),
        },
    }

class EventIn(BaseModel):
    session_id: str
    kind: str
    data: dict = {}

@router.post("/event")
async def event(body: EventIn):
    await events.insert_one({
        "session_id": _oid(body.session_id),
        "ts": _now(), "kind": body.kind, "data": body.data,
    })
    return {"ok": True}

class EndIn(BaseModel):
    session_id: str
    recipe_title: Optional[str] = None
    total_cost_usd: float = 0.0
    tokens_in: int = 0
    tokens_out: int = 0
    completed_steps: int = 0
    total_steps: int = 0
    voice_qa_count: int = 0
    moments_count: int = 0
    mode: str = "single"

@router.post("/end")
async def end(body: EndIn):
    oid = _oid(body.session_id)
    sess = await cooking_sessions.find_one({"_id": oid})
    if not sess: raise HTTPException(404, "session not found")
    await cooking_sessions.update_one(
        {"_id": oid},
        {"$set": {
            "ended_at": _now(),
            "recipe_title": body.recipe_title,
            "total_cost_usd": body.total_cost_usd,
            "tokens_in": body.tokens_in,
            "tokens_out": body.tokens_out,
            "completed_steps": body.completed_steps,
            "total_steps": body.total_steps,
            "voice_qa_count": body.voice_qa_count,
            "moments_count": body.moments_count,
            "mode": body.mode,
        }},
    )
    count = await cooking_sessions.count_documents({"user_name": sess["user_name"]})
    return {"ok": True, "history_count": count}

@router.get("/history")
async def history(name: str, limit: int = 10):
    from datetime import timedelta
    cutoff = _now() - timedelta(days=30)
    pipeline = [
        {"$match": {"user_name": name}},
        {"$facet": {
            "page": [
                {"$sort": {"started_at": -1}},
                {"$limit": min(limit, 50)},
            ],
            "totals": [
                {"$group": {
                    "_id": None,
                    "lifetime_cost_usd": {"$sum": {"$ifNull": ["$total_cost_usd", 0]}},
                    "count": {"$sum": 1},
                }},
            ],
            "month": [
                {"$match": {"started_at": {"$gte": cutoff}}},
                {"$count": "n"},
            ],
        }},
    ]
    cur = cooking_sessions.aggregate(pipeline)
    result = None
    async for doc in cur:
        result = doc
        break
    page = (result or {}).get("page", [])
    for s in page:
        s["_id"] = str(s["_id"])
    totals_doc = ((result or {}).get("totals") or [{}])[0]
    month_doc = ((result or {}).get("month") or [{}])[0]
    return {
        "sessions": page,
        "totals": {
            "lifetime_cost_usd": round(totals_doc.get("lifetime_cost_usd", 0.0), 4),
            "count": totals_doc.get("count", 0),
            "month_count": month_doc.get("n", 0),
        },
    }

class PrefsIn(BaseModel):
    name: str
    preferences: dict

@router.post("/prefs")
async def prefs(body: PrefsIn):
    await users.update_one({"name": body.name}, {"$set": {"preferences": body.preferences}})
    return {"ok": True}

class TrainerIn(BaseModel):
    name: str

@router.post("/trainer-completed")
async def trainer(body: TrainerIn):
    await users.update_one({"name": body.name}, {"$set": {"gesture_trainer_completed_at": _now()}})
    return {"ok": True}
