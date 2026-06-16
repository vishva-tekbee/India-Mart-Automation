"""
APScheduler integration — runs the scraper every N minutes
and stores results into MongoDB.

The scraper logic is imported directly from the existing
scrape_indiamart.py module (fetch_all_pages + map_fields).
"""

import asyncio
import logging
import time
import sys
from datetime import datetime
from pathlib import Path

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.executors.asyncio import AsyncIOExecutor
from pymongo import UpdateOne

from api.config import settings
from api.database import get_leads_collection
from api.routes.status import update_scraper_state

logger = logging.getLogger("indiamart.scheduler")

# ── Import existing scraper functions ─────────────────────────────────────────
# Add parent dir to path so we can import scrape_indiamart.py
_project_root = Path(__file__).resolve().parent.parent
if str(_project_root) not in sys.path:
    sys.path.insert(0, str(_project_root))

from scrape_indiamart import fetch_all_pages, map_fields  # noqa: E402

# ── Scheduler instance ───────────────────────────────────────────────────────

scheduler = AsyncIOScheduler(
    executors={"default": AsyncIOExecutor()},
    job_defaults={"coalesce": True, "max_instances": 1},  # Never run 2 scrapes at once
)

_last_scrape_time: float = 0.0


async def scrape_and_store() -> int:
    """
    Core job: scrape IndiaMart, filter leads, upsert into MongoDB.
    Returns the number of new leads inserted.
    """
    global _last_scrape_time
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    logger.info(f"[{ts}] Starting scrape…")

    try:
        # Step 1: Fetch raw data using existing Playwright scraper
        all_fields = await fetch_all_pages()
        total_raw = len(all_fields)
        logger.info(f"[{ts}] Fetched {total_raw} raw entries")

        # Step 2: Apply filters using existing map_fields
        # (uses the filter criteria from scrape_indiamart.py — we override them below)
        qualified = map_fields(all_fields)
        logger.info(f"[{ts}] Filtered to {len(qualified)} qualified leads")

        # Step 3: Upsert into MongoDB (dedup by product + location)
        collection = get_leads_collection()
        now = datetime.now()
        new_count = 0

        if qualified:
            operations = []
            for lead in qualified:
                operations.append(
                    UpdateOne(
                        # Filter: match existing lead by product + location
                        {
                            "product": lead["product"],
                            "location": lead["location"],
                        },
                        {
                            # Only set created_at on first insert
                            "$setOnInsert": {"created_at": now},
                            # Always update the lead data (quantity/price might change)
                            "$set": {
                                k: v for k, v in lead.items()
                                if k not in ("product", "location")
                            },
                        },
                        upsert=True,
                    )
                )

            result = await collection.bulk_write(operations, ordered=False)
            new_count = result.upserted_count
            modified = result.modified_count
            logger.info(
                f"[{ts}] MongoDB: {new_count} new, {modified} updated, "
                f"{len(qualified)} total qualified"
            )

        # Step 4: Update status for the /api/status endpoint
        _last_scrape_time = time.time()
        lead_count = await collection.count_documents({})

        update_scraper_state(
            last_scrape_time=datetime.fromtimestamp(_last_scrape_time),
            total_raw=total_raw,
            lead_count=lead_count,
            next_scrape_in_seconds=settings.scrape_interval * 60,
        )

        logger.info(
            f"[{ts}] ✅ Scrape complete: {total_raw} raw → {len(qualified)} qualified → "
            f"{new_count} new in DB ({lead_count} total)"
        )
        return new_count

    except Exception as e:
        logger.error(f"[{ts}] ❌ Scrape failed: {e}", exc_info=True)
        # Update status even on failure
        update_scraper_state(
            last_scrape_time=(
                datetime.fromtimestamp(_last_scrape_time)
                if _last_scrape_time > 0 else None
            ),
            next_scrape_in_seconds=settings.scrape_interval * 60,
        )
        return 0


def start_scheduler() -> None:
    """Add the scrape job and start the scheduler."""
    scheduler.add_job(
        scrape_and_store,
        "interval",
        minutes=settings.scrape_interval,
        id="scrape_indiamart",
        name="IndiaMART Lead Scraper",
        replace_existing=True,
        next_run_time=datetime.now(),  # Run immediately on startup
    )
    scheduler.start()
    logger.info(
        f"Scheduler started — scraping every {settings.scrape_interval} minutes"
    )


def stop_scheduler() -> None:
    """Gracefully shut down the scheduler."""
    if scheduler.running:
        scheduler.shutdown(wait=False)
        logger.info("Scheduler stopped")
