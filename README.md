# IndiaMART Lead Auto-Contact

Automated pipeline that scrapes buyer leads from IndiaMART, filters them by business criteria (GST, quantity, state, longevity), stores them in-memory with JSON file persistence, and contacts qualifying buyers via a Chrome extension.


![Extension UI](<Screenshot from 2026-06-30 12-37-02.png>)
---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                        FastAPI Server (port 8000)                     │
│                                                                      │
│  ┌─────────────┐    ┌──────────────┐    ┌──────────────────────────┐ │
│  │  Scheduler   │───▶│  Scraper      │───▶│  In-Memory + JSON File   │ │
│  │ (APScheduler)│    │  (Playwright) │    │  latest_leads.json       │ │
│  │ every 5 min  │    │              │    │  Dedup: product+location │ │
│  └─────────────┘    └──────────────┘    └──────────┬───────────────┘ │
│                                                     │                 │
│  ┌─────────────────────────────────────────────────┐│                 │
│  │  REST API                                       ││                 │
│  │  GET /leads        → current qualified leads    │◀                 │
│  │  GET /status       → health + counts            │                  │
│  │  GET /api/leads    → all leads (CRM)            │                  │
│  │  GET /api/leads/csv→ CSV export                 │                  │
│  └──────────────────────┬──────────────────────────┘                  │
└─────────────────────────┼────────────────────────────────────────────┘
                          │  HTTP (localhost:8000)
                          ▼
┌──────────────────────────────────────────────────────────────────────┐
│                   Chrome Extension (Manifest V3)                      │
│                                                                      │
│  ┌────────────┐    ┌──────────────────────────────────────────────┐  │
│  │  popup.js   │◀──▶│  background.js (Service Worker)              │  │
│  │  (UI layer) │    │                                              │  │
│  └────────────┘    │  1. Fetches /leads from server                │  │
│                    │  2. Filters out already-processed leads        │  │
│                    │  3. Opens IndiaMART tabs in background         │  │
│                    │  4. Injects scripts to click "Contact Buyer"   │  │
│                    │  5. Handles login walls, modals, retries        │  │
│                    │  6. Tracks completed/expired/processing stats   │  │
│                    └──────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Project Structure

```
web-scraper/
├── api/                          # FastAPI application package
│   ├── __init__.py
│   ├── config.py                 # Pydantic settings (from .env)
│   ├── lead_store.py             # In-memory lead store + JSON file persistence
│   ├── main.py                   # FastAPI app, CORS, middleware, compat routes
│   ├── models.py                 # Pydantic response schemas
│   ├── scheduler.py              # APScheduler — periodic scrape + store
│   └── routes/
│       ├── __init__.py
│       ├── leads.py              # /api/leads, /api/leads/csv
│       └── status.py             # /api/status — health + scraper stats
│
├── indiamart-extension/          # Chrome Extension (Manifest V3)
│   ├── manifest.json             # Extension manifest — permissions, service worker
│   ├── background.js             # Service worker — core automation logic
│   ├── popup.html                # Extension popup — UI layout
│   ├── popup.js                  # Popup logic — stats, controls, server comms
│   ├── popup.css                 # Popup styling
│   └── icons/                    # Extension icons (16, 48, 128px)
│
├── scrape_indiamart.py           # Core scraper module (Playwright + filters)
├── scraper_loop.py               # Legacy standalone loop (superseded by api/scheduler.py)
├── requirements.txt              # Python dependencies
├── Dockerfile                    # Production container (Playwright + Chromium)
├── docker-compose.yml            # Docker Compose — API service
├── .env                          # Environment variables (gitignored)
└── .gitignore
```

---

## Component Details

### 1. Scraper — `scrape_indiamart.py`

The core data extraction module. Uses Playwright with headless Chromium to:

1. **Load the IndiaMART trade search page** and capture the initial API request/response
2. **Paginate through results** by replaying the captured POST request with incremented offsets
3. **Parse lead fields** from the JSON response (`isqdetails`, `title`, `district_string`, etc.)
4. **Apply qualification filters** via `map_fields()`:

| Filter             | Default               | Config Key            |
|--------------------|-----------------------|-----------------------|
| GST Verified       | Required              | `REQUIRE_GST`         |
| Min Quantity        | ≥ 100 kg             | `MIN_QTY_KG`          |
| Member Longevity    | ≥ 1 year             | `MIN_LONGEVITY_YEARS` |
| Excluded States     | TN, WB, AP, OD       | `OMITTED_STATES`      |

**Output:** A list of qualified lead dicts with fields: `product`, `location`, `state`, `quantity`, `quantity_kg`, `quality`, `packaging_type`, `probable_order_value`, `gst_verified`, `member_longevity`, `display_id`, `lead_url`.

### 2. FastAPI Server — `api/`

Production API that wraps the scraper in a scheduled service.

**Lifecycle:**
- On startup: loads any previously scraped leads from `latest_leads.json`, starts APScheduler
- Every N minutes (default 5): runs `scrape_and_store()` which fetches → filters → stores leads
- On shutdown: stops scheduler

**Storage:**
- Leads are stored **in-memory** for fast API access and **persisted to `latest_leads.json`** on disk
- Each scrape cycle replaces the previous leads with fresh results
- No database required — the JSON file survives server restarts
- Deduplication is handled by `map_fields()` in the scraper (product + location)

### 3. Chrome Extension — `indiamart-extension/`

Manifest V3 extension that automates the "Contact Buyer Now" workflow.

**Architecture:** The popup (`popup.js`) communicates exclusively with the service worker (`background.js`) via `chrome.runtime.sendMessage`. No content scripts are used — all page interaction happens through `chrome.scripting.executeScript` injection.

**Processing Pipeline (per lead):**

```
Lead from /leads
      │
      ▼
Phase 0: Login check ──▶ If login wall → auto-fill credentials
      │
      ▼
Phase 1: Contact click ──▶ 5 search strategies with fallback:
      │                     1. product + full location
      │                     2. product + city only
      │                     3. product + state only
      │                     4. product only
      │                     5. direct lead URL (buylead/detail.mp?blid=...)
      │
      ▼
   Result tracking:
      ├── ✅ Completed → stats.clicked++
      └── ❌ Expired → expiredLeads[] (with reason)
```

**Daily Reset:** The extension checks for date rollover on service worker startup and before each poll cycle. When a new day is detected, it clears `processedIds`, `stats`, and `expiredLeads` from `chrome.storage.local`.

**Stats Invariant:** `Matched = Completed + Expired + Currently Processing`. All failure paths (tab vanished, login failed, no credentials, etc.) are tracked in `expiredLeads`.

---

## API Reference

### Extension Endpoints (no `/api` prefix)

These are used by the Chrome extension.

#### `GET /leads`

Returns all current qualified leads as a JSON array.

```json
[
  {
    "product": "W400 Whole Cashew Nuts, 10 Kg",
    "location": "Ranchi, Jharkhand",
    "state": "Jharkhand",
    "quantity": "500 Kg",
    "quantity_kg": 500.0,
    "quality": "Good",
    "gst_verified": true,
    "display_id": "12345678",
    "lead_url": "https://trade.indiamart.com/buylead/detail.mp?blid=12345678"
  }
]
```

#### `GET /status`

Health check with lead counts.

```json
{
  "ok": true,
  "lead_count": 8,
  "total_lead_count": 8,
  "total_raw": 304,
  "last_updated": "2026-06-30T12:33:17",
  "next_scrape_in_seconds": 300
}
```

| Field              | Description                                       |
|--------------------|---------------------------------------------------|
| `lead_count`       | Current qualified leads                           |
| `total_lead_count` | Same as `lead_count` (no separate DB)             |
| `total_raw`        | Raw unfiltered entries from the last scrape       |

### CRM Endpoints (`/api` prefix)

Full endpoints for external CRM integration. See `/docs` for OpenAPI spec.

| Endpoint             | Method | Description                                  |
|----------------------|--------|----------------------------------------------|
| `/api/leads`         | GET    | All current leads (paginated)                |
| `/api/leads/csv`     | GET    | CSV download                                 |
| `/api/status`        | GET    | Health check + scraper stats                 |

---

## Data Flow

```
IndiaMART Website
      │
      │  Playwright (headless Chromium)
      ▼
┌─────────────────┐
│ Raw lead entries │  ~300 per scrape
└────────┬────────┘
         │  map_fields() applies:
         │    • GST verification
         │    • State exclusion
         │    • Quantity threshold
         │    • Member longevity
         ▼
┌─────────────────┐
│ Qualified leads  │  ~8 per scrape
└────────┬────────┘
         │  In-memory store +
         │  JSON file persistence
         ▼
┌─────────────────┐
│ latest_leads.json│  Persisted on disk
│ + in-memory list │
└────────┬────────┘
         │  GET /leads
         ▼
┌─────────────────┐
│ Chrome Extension │
│  background.js   │
│                  │  Filters out already-processed leads
│                  │  Opens tabs → injects click scripts
│                  │  Tracks completed / expired / processing
└─────────────────┘
```

---

## Setup & Installation

### Prerequisites

- **Python 3.10+**
- **Google Chrome** (for the extension)

### 1. Clone & Install Dependencies

```bash
git clone <repository-url>
cd web-scraper

# Create and activate virtual environment
python -m venv .venv
source .venv/bin/activate  # Linux/macOS
# .venv\Scripts\activate   # Windows

# Install Python dependencies
pip install -r requirements.txt

# Install Playwright browser
playwright install chromium
```

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env with your settings
```

**`.env` variables:**

```ini
# Scraper
SCRAPE_INTERVAL=5        # Minutes between scrapes
MAX_RESULTS=500          # Max leads per scrape cycle

# API
PORT=8000
API_KEY=your-secret-key

# Filter criteria
MIN_QTY_KG=100
REQUIRE_GST=true
MIN_LONGEVITY_YEARS=1
OMITTED_STATES=tamil nadu,west bengal,andhra pradesh,odisha,orissa
```

### 3. Start the API Server

```bash
uvicorn api.main:app --host 0.0.0.0 --port 8000
```

The server will:
1. Load any previously scraped leads from `latest_leads.json`
2. Start the APScheduler (first scrape runs immediately)
3. Begin serving the REST API

**Verify:** Open `http://localhost:8000/docs` for the interactive API docs.

### 4. Install the Chrome Extension

1. Open Chrome → `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** → select the `indiamart-extension/` directory
4. Pin the extension to the toolbar
5. Click the extension icon to open the popup

---

## Running with Docker

```bash
# Build and start
docker compose up --build -d

# View logs
docker compose logs -f api

# Stop
docker compose down
```

**Or without Docker Compose:**

```bash
# Build the image
docker build -t indiamart-scraper .

# Run the container
docker run -d --name indiamart -p 8000:8000 --env-file .env indiamart-scraper

# View logs
docker logs -f indiamart

# Stop and remove
docker stop indiamart && docker rm indiamart
```

> **Note:** No database is required. Leads are stored in-memory and persisted to a JSON file inside the container. If you need data to survive container restarts, mount a volume for `latest_leads.json`.

---

## Configuration Reference

### Server-Side (`.env`)

| Variable              | Default          | Description                                      |
|-----------------------|------------------|--------------------------------------------------|
| `SCRAPE_INTERVAL`     | `5`              | Minutes between scrape cycles                    |
| `MAX_RESULTS`         | `500`            | Max raw results to fetch per scrape              |
| `PORT`                | `8000`           | API server port                                  |
| `MIN_QTY_KG`          | `100`            | Minimum quantity in kg to qualify                |
| `REQUIRE_GST`         | `true`           | Only include GST-verified buyers                 |
| `MIN_LONGEVITY_YEARS` | `1`              | Minimum IndiaMART membership duration            |
| `OMITTED_STATES`      | (see .env)       | Comma-separated states to exclude                |

### Extension-Side (`background.js` constants)

| Constant            | Value     | Description                                      |
|---------------------|-----------|--------------------------------------------------|
| `TAB_LOAD_TIMEOUT`  | 20,000 ms | Max wait for a tab to finish loading             |
| `CLICK_WAIT_MS`     | 4,000 ms  | Delay after load before injecting click script   |
| `MODAL_WAIT_MS`     | 1,500 ms  | Delay after Phase 1 click for confirmation       |
| `INTER_LEAD_DELAY`  | 5,000 ms  | Delay between processing consecutive leads       |
| `MAX_RETRIES`       | 5         | Number of search strategy attempts per lead      |

---

## Extension Popup UI

The popup displays real-time status of the automation pipeline:

| Section          | Contents                                                              |
|------------------|-----------------------------------------------------------------------|
| **Server Card**  | Server health, lead count, total stored, last scrape time             |
| **Automation**   | ON/OFF toggle — enables/disables scheduled polling                    |
| **Statistics**   | All Leads (raw), Matched (qualified), Completed (contacted), Expired  |
| **Queue Status** | Pending leads in background queue, current processing state           |
| **Expired Leads**| Expandable list with failure reasons and timestamps                   |
| **Actions**      | Run Now (manual trigger), Refresh Stats, Clear History                |

### Statistics Breakdown

- **All Leads** — Total raw leads from the last scrape (before filtering)
- **Matched** — Qualified leads returned by the server (after all filters)
- **Completed** — Successfully contacted (button clicked on IndiaMART)
- **Expired** — Failed to contact after all retry strategies

**Invariant:** `Matched = Completed + Expired + Currently Processing`

---

## Behavioral Notes

### Lead Deduplication

- **Server-side:** The `map_fields()` function in the scraper deduplicates by `(product, location)` before storing.
- **Extension-side:** Leads are keyed by `product|location` in `processedIds`. Once processed (regardless of outcome), a lead is not re-processed in the same day.

### Daily Reset

- **Extension:** Checks for date rollover (`lastActiveDate`) on service worker startup and before each poll cycle. Clears `processedIds`, `stats`, and `expiredLeads` when a new day is detected.
- **Server:** Each scrape cycle replaces the previous leads with fresh results from IndiaMART.

### Retry Strategy

When a lead cannot be found on the IndiaMART search page, the extension tries progressively broader searches:

1. `product + full location` (e.g., "Cashew Nuts Ranchi, Jharkhand")
2. `product + city only` (e.g., "Cashew Nuts Ranchi")
3. `product + state only` (e.g., "Cashew Nuts Jharkhand")
4. `product only` (e.g., "Cashew Nuts")
5. `direct URL` (e.g., `buylead/detail.mp?blid=12345`)

If all 5 attempts fail, the lead is marked as expired with the specific failure reason.

### Failure Tracking

All failure paths are tracked in `expiredLeads` with a reason code:

| Reason Code                        | Human Label              | Description                                     |
|------------------------------------|--------------------------|------------------------------------------------|
| `no_search_results`                | No search results        | IndiaMART returned zero results for the query   |
| `no_strict_match`                  | No matching cards        | Cards found but none matched product/location   |
| `no_contact_buttons_found`         | No contact buttons       | Matching card has no clickable contact button    |
| `no_contact_button_on_detail_page` | No button on detail page | Direct URL page lacks a contact button           |
| `lead_expired`                     | Lead expired / Inactive  | IndiaMART shows the lead as closed/fulfilled     |
| `product_mismatch_on_detail_page`  | Product mismatch         | Detail page product doesn't match the lead       |
| `location_mismatch_on_detail_page` | Location mismatch        | Detail page city doesn't match the lead          |
| `tab_vanished`                     | Tab closed / vanished    | Chrome tab disappeared during processing         |
| `tab_closed_before_phase1`         | Tab closed early         | Tab closed before script injection               |
| `tab_closed_after_login`           | Tab closed after login   | Tab closed after login form submission           |
| `login_failed`                     | Login failed             | Login wall detected, credentials rejected        |
| `no_credentials`                   | No credentials set       | Login wall but no credentials configured         |
| `all_attempts_exhausted`           | All attempts failed      | All 5 retry strategies failed                    |
| `redirected_away_from_lead_page`   | Redirected away          | Direct URL redirected to a different page         |

---

## Troubleshooting

| Symptom                                | Likely Cause                        | Fix                                                          |
|----------------------------------------|-------------------------------------|--------------------------------------------------------------|
| Extension shows "Server not running"   | API server not started              | Run `uvicorn api.main:app --port 8000`                       |
| 0 leads after scrape                   | Filters too strict or site blocked  | Check scraper logs; adjust `MIN_QTY_KG`, `OMITTED_STATES`   |
| All leads marked expired               | IndiaMART login wall                | Set login credentials in extension popup (if applicable)     |
| Scraper returns empty                  | Playwright browser not installed    | Run `playwright install chromium`                            |
| Stats show 0 then jump to real values  | Normal on first load (async fetch)  | Stats show "—" while loading, then populate atomically       |
| Extension "Receiving end does not exist"| Service worker stopped             | Reload extension at `chrome://extensions`                    |
| Docker container exits immediately     | Port conflict or bad CMD            | Check `docker logs <name>` and free port 8000                |

---

## License

Private — Internal use only.
