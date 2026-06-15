"""
IndiaMART Lead API — FastAPI Application

Production-ready API service that:
  1. Scrapes IndiaMart buyer leads every N minutes (APScheduler)
  2. Stores them in MongoDB (motor, with deduplication)
  3. Exposes REST endpoints for CRM consumption

Run:  uvicorn api.main:app --host 0.0.0.0 --port 8000
Docs: http://localhost:8000/docs
"""

import logging
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from api.config import settings
from api.database import init_db, close_db
from api.scheduler import start_scheduler, stop_scheduler
from api.routes import leads, status

# ── Logging ───────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(name)-28s | %(levelname)-5s | %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("indiamart.api")


# ── Lifespan (startup + shutdown) ─────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup: connect DB + start scheduler. Shutdown: clean up."""
    logger.info("Starting IndiaMART Lead API…")

    # Connect to MongoDB
    await init_db()

    # Start the scraper scheduler
    start_scheduler()

    logger.info(f"API ready on port {settings.port}")
    yield

    # Shutdown
    logger.info("Shutting down…")
    stop_scheduler()
    await close_db()
    logger.info("Goodbye.")


# ── FastAPI App ───────────────────────────────────────────────────────────────

app = FastAPI(
    title="IndiaMART Lead API",
    description=(
        "Production API for IndiaMART buyer lead data.\n\n"
        "Scrapes IndiaMart every 5 minutes, filters by GST/quantity/state/longevity, "
        "stores in MongoDB, and exposes REST endpoints for CRM integration."
    ),
    version="1.0.0",
    lifespan=lifespan,
    docs_url="/docs",
    redoc_url="/redoc",
)

# ── CORS ──────────────────────────────────────────────────────────────────────

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Allow all origins (extension + CRM)
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Request Logging Middleware ────────────────────────────────────────────────

@app.middleware("http")
async def log_requests(request: Request, call_next):
    start = time.time()
    response = await call_next(request)
    duration = (time.time() - start) * 1000
    logger.info(
        f"{request.method} {request.url.path} → {response.status_code} ({duration:.0f}ms)"
    )
    return response


# ── Global Error Handler ─────────────────────────────────────────────────────

@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    logger.error(f"Unhandled error: {exc}", exc_info=True)
    return JSONResponse(
        status_code=500,
        content={"ok": False, "message": "Internal server error", "detail": str(exc)},
    )


# ── Register Routes ──────────────────────────────────────────────────────────

app.include_router(leads.router)
app.include_router(status.router)


# ── Root redirect ─────────────────────────────────────────────────────────────

@app.get("/", include_in_schema=False)
async def root():
    return {
        "service": "IndiaMART Lead API",
        "version": "1.0.0",
        "docs": "/docs",
        "endpoints": {
            "leads": "/api/leads",
            "new_leads": "/api/leads/new?since=2026-06-15T10:00:00Z",
            "csv_export": "/api/leads/csv",
            "status": "/api/status",
        },
    }


# ── Backward compatibility for Chrome extension ──────────────────────────────
# The extension currently hits /leads and /status (without /api prefix)
# Keep these working so the extension doesn't need changes immediately

@app.get("/leads", include_in_schema=False)
async def compat_leads():
    """Backward-compatible /leads endpoint for Chrome extension (returns raw list)."""
    from api.database import get_leads_collection
    collection = get_leads_collection()
    cursor = collection.find({}, {"_id": 0}).sort("created_at", -1).limit(500)
    return await cursor.to_list(length=500)


@app.get("/status", include_in_schema=False)
async def compat_status():
    """Backward-compatible /status endpoint for Chrome extension."""
    from api.routes.status import get_scraper_state
    from api.database import get_leads_collection

    collection = get_leads_collection()
    lead_count = await collection.count_documents({})
    state = get_scraper_state()

    return {
        "ok": True,
        "lead_count": lead_count,
        "total_raw": state["total_raw"],
        "last_updated": (
            state["last_scrape_time"].isoformat()
            if state["last_scrape_time"] else None
        ),
        "next_scrape_in_seconds": state["next_scrape_in_seconds"],
    }
