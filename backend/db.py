# backend/db.py
"""Mongo client wrapper. Hard-locked to the `gestucook` database.

Safety: we never accept a DB name from request input. The constant
SAFE_DB is the only DB name this file ever names. No drop_* calls."""

import os
from motor.motor_asyncio import AsyncIOMotorClient

MONGO_URL = os.environ.get("MONGO_URL", "mongodb://host.docker.internal:27017")
MONGO_DB  = os.environ.get("MONGO_DB",  "gestucook")
SAFE_DB   = "gestucook"

assert MONGO_DB == SAFE_DB, (
    f"Refusing to operate outside the {SAFE_DB} database "
    f"(MONGO_DB={MONGO_DB!r}). This protects other projects' data."
)

_client = AsyncIOMotorClient(MONGO_URL, uuidRepresentation="standard")
db = _client[SAFE_DB]

users            = db["users"]
cooking_sessions = db["cooking_sessions"]
events           = db["events"]

async def ensure_indexes() -> None:
    await users.create_index("name", unique=True)
    await cooking_sessions.create_index([("user_name", 1), ("started_at", -1)])
    await events.create_index([("session_id", 1), ("ts", 1)])

async def close() -> None:
    _client.close()
