"""
Lead API routes.

GET /api/leads          — all leads
GET /api/leads/new      — leads since a given timestamp
GET /api/leads/csv      — CSV download for sales team
"""

import csv
import io
import logging
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Query, HTTPException
from fastapi.responses import StreamingResponse

from api.database import get_leads_collection
from api.models import APIResponse

logger = logging.getLogger("indiamart.routes.leads")

router = APIRouter(prefix="/api/leads", tags=["Leads"])


@router.get("", response_model=APIResponse, summary="Get all leads")
async def get_all_leads(
    limit: int = Query(default=500, ge=1, le=5000, description="Max leads to return"),
    skip: int = Query(default=0, ge=0, description="Number of leads to skip"),
):
    """Return all currently available leads, newest first."""
    collection = get_leads_collection()
    cursor = collection.find(
        {},
        {"_id": 0},  # Exclude MongoDB _id field
    ).sort("created_at", -1).skip(skip).limit(limit)

    leads = await cursor.to_list(length=limit)
    total = await collection.count_documents({})

    return APIResponse(
        ok=True,
        count=len(leads),
        data=leads,
        message=f"Showing {len(leads)} of {total} total leads",
    )


@router.get("/new", response_model=APIResponse, summary="Get new leads since timestamp")
async def get_new_leads(
    since: datetime = Query(
        ...,
        description="ISO 8601 timestamp — returns leads discovered after this time",
        example="2026-06-15T10:00:00Z",
    ),
    limit: int = Query(default=500, ge=1, le=5000),
):
    """Return only leads discovered after the provided timestamp."""
    collection = get_leads_collection()
    cursor = collection.find(
        {"created_at": {"$gt": since}},
        {"_id": 0},
    ).sort("created_at", -1).limit(limit)

    leads = await cursor.to_list(length=limit)

    return APIResponse(
        ok=True,
        count=len(leads),
        data=leads,
        message=f"{len(leads)} new lead(s) since {since.isoformat()}",
    )


@router.get("/csv", summary="Download leads as CSV")
async def download_csv(
    since: Optional[datetime] = Query(
        default=None,
        description="Optional — only export leads after this timestamp",
    ),
):
    """Download leads as a CSV file for the sales team."""
    collection = get_leads_collection()
    query = {}
    if since:
        query["created_at"] = {"$gt": since}

    cursor = collection.find(query, {"_id": 0}).sort("created_at", -1)
    leads = await cursor.to_list(length=5000)

    if not leads:
        raise HTTPException(status_code=404, detail="No leads found")

    # Build CSV in memory
    output = io.StringIO()
    fields = [
        "product", "location", "state", "quantity", "quantity_kg",
        "quality", "packaging_type", "probable_order_value",
        "probable_requirement_type", "gst_verified", "member_longevity",
        "display_id", "lead_url", "created_at",
    ]
    writer = csv.DictWriter(output, fieldnames=fields, extrasaction="ignore")
    writer.writeheader()
    for lead in leads:
        # Convert datetime to string for CSV
        if "created_at" in lead and isinstance(lead["created_at"], datetime):
            lead["created_at"] = lead["created_at"].isoformat()
        writer.writerow(lead)

    output.seek(0)
    timestamp = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
    filename = f"indiamart_leads_{timestamp}.csv"

    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )
