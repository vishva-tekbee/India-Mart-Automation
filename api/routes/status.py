"""
Status/health API route.

GET /api/status — health check + scraper stats
"""

import logging
from fastapi import APIRouter
from api.models import StatusResponse
from api.config import settings

logger = logging.getLogger("indiamart.routes.status")

router = APIRouter(tags=["Status"])

# These are updated by the scheduler module after each scrape
_scraper_state = {
    "last_scrape_time": None,
    "total_raw": 0,
    "lead_count": 0,
    "next_scrape_in_seconds": 0,
}


def update_scraper_state(*, last_scrape_time=None, total_raw=0, lead_count=0, next_scrape_in_seconds=0):
    """Called by the scheduler after each scrape to update status."""
    _scraper_state["last_scrape_time"] = last_scrape_time
    _scraper_state["total_raw"] = total_raw
    _scraper_state["lead_count"] = lead_count
    _scraper_state["next_scrape_in_seconds"] = next_scrape_in_seconds


def get_scraper_state():
    return _scraper_state


@router.get("/api/status", response_model=StatusResponse, summary="Health check + scraper stats")
async def get_status():
    """
    Returns the current health of the API and scraper status.
    Useful for monitoring and CRM polling.
    """
    from api.database import get_leads_collection
    collection = get_leads_collection()
    lead_count = await collection.count_documents({})

    state = get_scraper_state()

    return StatusResponse(
        status="running",
        last_scrape_time=state["last_scrape_time"],
        lead_count=lead_count,
        total_raw=state["total_raw"],
        next_scrape_in_seconds=state["next_scrape_in_seconds"],
        scrape_interval_minutes=settings.scrape_interval,
    )
