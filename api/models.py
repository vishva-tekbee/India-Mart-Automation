"""
Pydantic models for API request/response schemas.
"""

from datetime import datetime
from typing import Optional
from pydantic import BaseModel, Field


class LeadOut(BaseModel):
    """Schema for a lead returned by the API."""

    product: str
    location: str
    quantity: str
    quality: str = ""
    packaging_type: str = ""
    probable_order_value: str = ""
    probable_requirement_type: str = ""
    gst_verified: bool = False
    member_longevity: str = ""
    state: str = ""
    quantity_kg: float = 0.0
    display_id: str = ""
    lead_url: str = ""

    class Config:
        from_attributes = True


class StatusResponse(BaseModel):
    """Schema for the /api/status health endpoint."""

    status: str = "running"
    last_scrape_time: Optional[datetime] = None
    lead_count: int = Field(default=0, description="Current qualified lead count")
    total_raw: int = Field(default=0, description="Raw unfiltered leads from last scrape")
    next_scrape_in_seconds: int = 0
    scrape_interval_minutes: int = 5


class APIResponse(BaseModel):
    """Standard wrapper for API responses."""

    ok: bool = True
    count: int = 0
    data: list = []
    message: str = ""
