"""
Async MongoDB connection using motor.
Provides connection lifecycle and collection accessors.
"""

import logging
from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorDatabase
from pymongo import ASCENDING
from api.config import settings

logger = logging.getLogger("indiamart.database")

_client: AsyncIOMotorClient | None = None
_db: AsyncIOMotorDatabase | None = None


async def init_db() -> None:
    """Connect to MongoDB and create indexes."""
    global _client, _db
    logger.info(f"Connecting to MongoDB at {settings.mongodb_uri}")
    _client = AsyncIOMotorClient(settings.mongodb_uri)
    _db = _client[settings.mongodb_db]

    # Unique compound index to prevent duplicate leads
    await _db.leads.create_index(
        [("product", ASCENDING), ("location", ASCENDING)],
        unique=True,
        name="unique_product_location",
    )
    logger.info(f"Connected to database '{settings.mongodb_db}', indexes ready")


async def close_db() -> None:
    """Close the MongoDB connection."""
    global _client, _db
    if _client:
        _client.close()
        _client = None
        _db = None
        logger.info("MongoDB connection closed")


def get_db() -> AsyncIOMotorDatabase:
    """Return the current database handle. Raises if not initialized."""
    if _db is None:
        raise RuntimeError("Database not initialized — call init_db() first")
    return _db


def get_leads_collection():
    """Shortcut to the leads collection."""
    return get_db().leads
