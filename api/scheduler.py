"""
APScheduler integration — runs the scraper every N minutes
and stores results in-memory + JSON file.

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

from api.config import settings
from api.lead_store import set_leads
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
    Core job: scrape IndiaMart, filter leads, store in-memory + JSON file.
    Returns the number of qualified leads.
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
        qualified = map_fields(all_fields)
        logger.info(f"[{ts}] Filtered to {len(qualified)} qualified leads")

        # Step 3: Store in-memory and persist to JSON file
        lead_count = set_leads(qualified, total_raw=total_raw)

        # Step 4: Update status for the /api/status endpoint
        _last_scrape_time = time.time()

        update_scraper_state(
            last_scrape_time=datetime.fromtimestamp(_last_scrape_time),
            total_raw=total_raw,
            lead_count=lead_count,
            next_scrape_in_seconds=settings.scrape_interval * 60,
        )

        logger.info(
            f"[{ts}] ✅ Scrape complete: {total_raw} raw → {len(qualified)} qualified"
        )
        return lead_count

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
