"""
Lead API routes.

GET /api/leads          — all leads
GET /api/leads/csv      — CSV download for sales team
"""

import csv
import io
import logging
from datetime import datetime

from fastapi import APIRouter, Query, HTTPException
from fastapi.responses import StreamingResponse

from api.lead_store import get_all_leads, get_lead_count
from api.models import APIResponse

logger = logging.getLogger("indiamart.routes.leads")

router = APIRouter(prefix="/api/leads", tags=["Leads"])


@router.get("", response_model=APIResponse, summary="Get all leads")
async def get_all_leads_endpoint(
    limit: int = Query(default=500, ge=1, le=5000, description="Max leads to return"),
    skip: int = Query(default=0, ge=0, description="Number of leads to skip"),
):
    """Return all currently available qualified leads."""
    all_leads = get_all_leads()
    total = len(all_leads)
    paginated = all_leads[skip : skip + limit]

    return APIResponse(
        ok=True,
        count=len(paginated),
        data=paginated,
        message=f"Showing {len(paginated)} of {total} total leads",
    )


@router.get("/csv", summary="Download leads as CSV")
async def download_csv():
    """Download leads as a CSV file for the sales team."""
    leads = get_all_leads()

    if not leads:
        raise HTTPException(status_code=404, detail="No leads found")

    # Build CSV in memory
    output = io.StringIO()
    fields = [
        "product", "location", "state", "quantity", "quantity_kg",
        "quality", "packaging_type", "probable_order_value",
        "probable_requirement_type", "gst_verified", "member_longevity",
        "display_id", "lead_url",
    ]
    writer = csv.DictWriter(output, fieldnames=fields, extrasaction="ignore")
    writer.writeheader()
    for lead in leads:
        writer.writerow(lead)

    output.seek(0)
    timestamp = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
    filename = f"indiamart_leads_{timestamp}.csv"

    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )
