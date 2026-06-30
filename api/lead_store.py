"""
In-memory lead store with JSON file persistence.
Replaces MongoDB — stores leads in a list and persists to latest_leads.json.
"""

import json
import logging
import threading
from datetime import datetime
from pathlib import Path
from typing import List, Dict, Optional

logger = logging.getLogger("indiamart.lead_store")

_BASE_DIR = Path(__file__).resolve().parent.parent
_OUTPUT_FILE = _BASE_DIR / "latest_leads.json"
_META_FILE = _BASE_DIR / ".scraper_meta.json"

# Thread-safe access to the lead list
_lock = threading.Lock()
_leads: List[Dict] = []


def load_leads_from_file() -> None:
    """Load leads from the JSON file on startup."""
    global _leads
    if _OUTPUT_FILE.exists():
        try:
            data = json.loads(_OUTPUT_FILE.read_text())
            with _lock:
                _leads = data if isinstance(data, list) else []
            logger.info(f"Loaded {len(_leads)} leads from {_OUTPUT_FILE.name}")
        except Exception as e:
            logger.warning(f"Could not load {_OUTPUT_FILE.name}: {e}")
    else:
        logger.info("No existing leads file found — starting fresh")


def save_leads_to_file() -> None:
    """Persist current leads to the JSON file (atomic write)."""
    with _lock:
        data = list(_leads)
    try:
        tmp = _OUTPUT_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False))
        tmp.replace(_OUTPUT_FILE)
    except Exception as e:
        logger.error(f"Failed to save leads: {e}")


def set_leads(leads: List[Dict], total_raw: int = 0) -> int:
    """
    Replace all leads with the new scraped results and persist.
    Returns the number of qualified leads stored.
    """
    global _leads
    with _lock:
        _leads = list(leads)
    save_leads_to_file()

    # Save metadata
    try:
        _META_FILE.write_text(json.dumps({
            "total_raw": total_raw,
            "total_filtered": len(leads),
        }))
    except Exception as e:
        logger.warning(f"Could not save metadata: {e}")

    return len(leads)


def get_all_leads() -> List[Dict]:
    """Return a copy of all current leads."""
    with _lock:
        return list(_leads)


def get_lead_count() -> int:
    """Return the number of leads currently stored."""
    with _lock:
        return len(_leads)


def get_metadata() -> Dict:
    """Read the scraper metadata file."""
    if _META_FILE.exists():
        try:
            return json.loads(_META_FILE.read_text())
        except Exception:
            pass
    return {"total_raw": 0, "total_filtered": 0}
