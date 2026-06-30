"""
Application settings loaded from environment variables.
Uses pydantic-settings for validation and type coercion.
"""

from pydantic_settings import BaseSettings
from pydantic import Field
from typing import List


class Settings(BaseSettings):
    """All config is driven by environment variables (or .env file)."""

    # Scraper
    scrape_interval: int = Field(default=5, description="Minutes between scrapes")
    max_results: int = Field(default=500, description="Max results per scrape")

    # API
    port: int = Field(default=8000)
    api_key: str = Field(default="change-me-to-a-secret-key")

    # Filter criteria
    min_qty_kg: float = Field(default=100)
    require_gst: bool = Field(default=True)
    min_longevity_years: int = Field(default=1)
    omitted_states: str = Field(
        default="tamil nadu,west bengal,andhra pradesh,odisha,orissa",
        description="Comma-separated list of states to exclude",
    )

    @property
    def omitted_states_list(self) -> List[str]:
        return [s.strip() for s in self.omitted_states.split(",") if s.strip()]

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        case_sensitive = False


# Singleton instance
settings = Settings()
