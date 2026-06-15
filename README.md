# IndiaMART Lead Auto-Contact

> Automated pipeline that scrapes buyer leads from IndiaMART, filters them by quantity, and clicks "Contact Buyer Now" via a Chrome extension.

---

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Project Structure](#project-structure)
- [Component Details](#component-details)
  - [1. Scraper — `scrape_indiamart.py`](#1-scraper--scrape_indiamartpy)
  - [2. Loop + Local Server — `scraper_loop.py`](#2-loop--local-server--scraper_looppy)
  - [3. Chrome Extension — `indiamart-extension/`](#3-chrome-extension--indiamart-extension)
- [Data Flow](#data-flow)
- [Output Files](#output-files)
- [Setup & Installation](#setup--installation)
- [Running the System](#running-the-system)
- [Configuration Reference](#configuration-reference)
- [Extension Popup UI](#extension-popup-ui)
- [Known Behaviours & Notes](#known-behaviours--notes)

---

## Overview

This project has two distinct halves that talk to each other over localhost:

| Half | Technology | Role |
|---|---|---|
| **Backend** | Python + Playwright | Scrapes IndiaMART search results and serves them as JSON |
| **Frontend** | Chrome Extension (MV3) | Consumes the JSON, filters leads, opens tabs and clicks the contact button |

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                         Python Backend                           │
│                                                                  │
│  scrape_indiamart.py                                             │
│  ┌─────────────────────────────────────────────────────────┐     │
│  │  Playwright (headless Chromium)                         │     │
│  │  1. Loads trade.indiamart.com/buyersearch.mp?ss=cashew  │     │
│  │  2. Intercepts XHR to /tradereact/searchpage            │     │
│  │  3. Paginates via direct POST (up to 500 results)       │     │
│  │  4. Parses & deduplicates → JSON array                  │     │
│  └──────────────────────────────┬──────────────────────────┘     │
│                                 │ returns parsed leads           │
│  scraper_loop.py                ▼                                │
│  ┌─────────────────────────────────────────────────────────┐     │
│  │  Async loop — re-scrapes every INTERVAL_MINUTES (5 min) │     │
│  │  Writes result atomically to latest_leads.json          │     │
│  │                                                         │     │
│  │  HTTP server on 127.0.0.1:7891 (background thread)      │     │
│  │    GET /leads   → serves latest_leads.json              │     │
│  │    GET /status  → JSON health/meta                      │     │
│  └──────────────────────────────┬──────────────────────────┘     │
└─────────────────────────────────┼────────────────────────────────┘
                                  │  HTTP (CORS enabled)
                                  ▼
┌──────────────────────────────────────────────────────────────────┐
│                     Chrome Extension (MV3)                       │
│                                                                  │
│  background.js  (service worker)                                 │
│  ┌─────────────────────────────────────────────────────────┐     │
│  │  1. Polls /leads on a configurable interval             │     │
│  │  2. Parses quantity, filters by threshold (≥ 500 kg)    │     │
│  │  3. Deduplicates via processedIds (chrome.storage)      │     │
│  │  4. Queues qualifying leads                             │     │
│  │  5. Opens tab → Phase-0 (login) → Phase-1 (click btn)  │     │
│  │  6. Sends desktop notification on success/failure       │     │
│  └─────────────────────────────────────────────────────────┘     │
│                                                                  │
│  popup.html / popup.js / popup.css  (control panel UI)           │
│  ┌─────────────────────────────────────────────────────────┐     │
│  │  • Server status indicator                              │     │
│  │  • Enable/disable automation toggle                     │     │
│  │  • Threshold & poll interval settings                   │     │
│  │  • Live stats: Scanned / Matched / Contacted            │     │
│  │  • Queue status                                         │     │
│  │  • Run Now / Refresh / Clear History buttons            │     │
│  └─────────────────────────────────────────────────────────┘     │
└──────────────────────────────────────────────────────────────────┘
```

---

## Project Structure

```
web-scraper/
├── scrape_indiamart.py        # Core Playwright scraper
├── scraper_loop.py            # Scheduler + local HTTP server
├── latest_leads.json          # Live output (overwritten every cycle)
├── indiamart_cashew.json      # Fallback / first-run output
└── indiamart-extension/
    ├── manifest.json          # Chrome MV3 manifest
    ├── background.js          # Service worker (all core logic)
    ├── popup.html             # Extension popup markup
    ├── popup.js               # Popup → background messaging
    ├── popup.css              # Popup styles
    └── icons/
        ├── icon16.png
        ├── icon48.png
        └── icon128.png
```

---

## Component Details

### 1. Scraper — `scrape_indiamart.py`

**Purpose:** Extracts buyer lead data from IndiaMART's search results page.

**How it works:**

1. **Browser launch** — Playwright opens a headless Chromium window with a desktop `User-Agent`.
2. **Request/response interception** — Hooks into `page.on("request")` and `page.on("response")` to capture the first XHR call to `/tradereact/searchpage`, extracting:
   - The full POST body (pagination parameters)
   - Session cookies and auth headers (`x-im-glusrid`, `x-im-sid`, `x-im-uid`)
3. **Pagination** — Replays the captured POST body with `options.start` incremented by 10 per page, fetching up to 500 results with a 0.3 s delay between pages.
4. **Field mapping** — `map_fields()` normalises raw API fields into a clean schema and deduplicates by `(product, location)`.

**Output schema per lead:**

```json
{
  "product": "Cashew Nuts",
  "location": "Mumbai, Maharashtra",
  "quantity": "500 Kg",
  "quality": "Good",
  "packaging_type": "Bucket",
  "probable_order_value": "Rs. 1.5 Lakh",
  "probable_requirement_type": "Business Use"
}
```

**Key constants:**

| Name | Value | Description |
|---|---|---|
| `URL` | `trade.indiamart.com/buyersearch.mp?ss=cashew` | Search seed URL |
| `SEARCH_API` | `/tradereact/searchpage` | Intercepted XHR endpoint |
| Max results | 500 | Configurable in the `while` loop guard |

---

### 2. Loop + Local Server — `scraper_loop.py`

**Purpose:** Continuously refreshes the lead data and exposes it over HTTP so the Chrome extension can fetch it without any CORS issues.

**Two concurrent roles:**

| Role | Mechanism |
|---|---|
| **Scraper loop** | `asyncio` event loop calling `run_once()` every `INTERVAL_MINUTES` (default: 5 min) |
| **HTTP server** | `http.server.HTTPServer` in a **daemon thread** on `127.0.0.1:7891` |

**HTTP endpoints:**

| Endpoint | Method | Response |
|---|---|---|
| `/leads` or `/leads.json` | `GET` | Full `latest_leads.json` array |
| `/status` | `GET` | `{ ok, source, last_updated, lead_count, next_scrape_in_seconds }` |

**Atomic writes:** The scraper writes to `latest_leads.tmp` then renames to `latest_leads.json`, preventing the extension from reading a half-written file.

**Fallback file:** If `latest_leads.json` doesn't exist yet (first run still in progress), the server automatically falls back to `indiamart_cashew.json`.

---

### 3. Chrome Extension — `indiamart-extension/`

**Manifest version:** MV3

**Permissions:**

| Permission | Why |
|---|---|
| `storage` | Persist config, stats, and processed lead IDs across restarts |
| `tabs` | Open leads in background tabs |
| `scripting` | Inject click scripts into IndiaMART pages |
| `notifications` | Desktop alerts on match / success / failure |
| `activeTab` | Required by MV3 for scripting injection |
| `host_permissions` → `*.indiamart.com` | Script injection target |
| `host_permissions` → `127.0.0.1:7891` | Fetch leads from Python server |

#### `background.js` — Service Worker

All automation logic lives here. It is split into distinct phases per lead:

```
Phase 0 — Login Wall Detection
  ↓  injectedLoginIfNeeded()
  • Checks if #loginform is visible
  • Auto-fills #email (mobile) and #usr_pass
  • Clicks #submtbtn, waits 5 s for redirect

Phase 1 — Contact Button Click
  ↓  injectedClickPhase1()
  • Pass 0: .TRA_contact_buyer (IndiaMART-specific class)
  • Pass 1: Exact text "contact buyer now"
  • Pass 2: Partial text (contact buyer, buy lead, …)
  • Pass 3: CSS selector fallbacks

Phase 2 — Modal Confirmation (legacy, kept for safety)
  ↓  injectedClickPhase2Polling()
  • Polls every 500 ms for up to 10 s
  • Targets Bootstrap modals, React portals, ARIA role=dialog
```

**In-memory state (rebuilt from `chrome.storage` on SW restart):**

```js
cfg = { enabled, threshold, interval, mobile, password }
stats = { scanned, matched, clicked }
processedIds = Set<string>   // "product|location" keys
queue = []                   // leads waiting to be processed
```

**Message API** (popup → background):

| Message type | Payload | Action |
|---|---|---|
| `SET_CREDENTIALS` | `{ mobile, password }` | Save IndiaMART login |
| `SET_SETTINGS` | `{ enabled, threshold, interval }` | Update config, start/stop poll timer |
| `RUN_NOW` | — | Immediately trigger one scan cycle |
| `GET_STATUS` | — | Returns `{ cfg, stats, queueLength, isProcessing }` |
| `GET_QUEUE_STATUS` | — | Returns `{ queueLength, isProcessing }` |
| `CLEAR_ALL` | — | Wipe processedIds, stats, queue |
| `CLEAR_PROCESSED_IDS` | — | Wipe only processedIds (allows re-contacting) |

**Quantity parser — `parseQtyKg(raw)`:**

Converts any human-readable quantity string to kilograms:
- `"500 Kg"` → `500`
- `"2 Tonnes"` → `2000`
- `"5 Quintal"` → `500`
- `"200 grams"` → `0.2`

#### `popup.html` / `popup.js` / `popup.css`

The extension popup is a single-page control panel:

- **Server card** — pings `/status` and shows online/offline dot, lead count, last updated time
- **Automation toggle** — enable/disable the polling loop
- **Settings card** — Min Quantity (kg) threshold, Poll Interval (minutes)
- **Stats card** — live Scanned / Matched / Contacted counters
- **Queue card** — pending queue depth + processing flag
- **Action buttons** — ⚡ Run Now, 🔄 Refresh Stats, 🗑️ Clear History

---

## Data Flow

```
IndiaMART website
      │  (Playwright headless browser + XHR intercept)
      ▼
scrape_indiamart.py  →  parse & deduplicate
      │
      ▼
latest_leads.json  (written atomically every 5 min)
      │
      ▼
scraper_loop.py HTTP server  (127.0.0.1:7891)
      │  GET /leads
      ▼
background.js (Chrome Extension service worker)
      │  filter by quantity ≥ threshold
      │  deduplicate by processedIds
      ▼
qualifying leads queue
      │  for each lead:
      │    open background tab → Phase-0 login → Phase-1 click
      ▼
IndiaMART "Contact Buyer Now" clicked  →  desktop notification
```

---

## Output Files

| File | Description |
|---|---|
| `latest_leads.json` | Always-current leads array; overwritten atomically every cycle |
| `indiamart_cashew.json` | Output of a one-shot `scrape_indiamart.py` run; used as fallback |

---

## Setup & Installation

### Prerequisites

- Python 3.9+
- Google Chrome / Chromium

### Python dependencies

```bash
pip install playwright
playwright install chromium
```

### Load the Chrome extension

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `indiamart-extension/` folder
5. The extension icon should appear in your toolbar

---

## Running the System

### Step 1 — Start the Python backend

```bash
cd /home/s/Desktop/web-scraper
python3 scraper_loop.py
```

Expected output:
```
IndiaMART Scraper Loop
  Scrape interval : every 5 minutes
  Output file     : .../latest_leads.json
  Extension URL   : http://127.0.0.1:7891/leads
  Status URL      : http://127.0.0.1:7891/status
[server] Listening on http://127.0.0.1:7891
[*] Loading initial page...
```

### Step 2 — Configure the extension

1. Click the extension icon in Chrome
2. (Optional) Enter your IndiaMART **mobile number** and **password** if leads require login
3. Set your **Min Quantity** threshold (default 500 kg)
4. Set your **Poll Interval** (default 5 minutes)
5. Click **Save Settings**

### Step 3 — Enable automation

Toggle **Automation** to ON — the extension will now poll the Python server on schedule and automatically contact matching leads.

### One-shot scrape (no loop)

```bash
python3 scrape_indiamart.py
# → writes indiamart_cashew.json and prints JSON to stdout
```

---

## Configuration Reference

### `scraper_loop.py`

```python
INTERVAL_MINUTES = 5      # Re-scrape frequency
SERVER_PORT      = 7891   # Local HTTP port
OUTPUT_FILE      = "latest_leads.json"
FALLBACK_FILE    = "indiamart_cashew.json"
```

### `background.js`

```js
TAB_LOAD_TIMEOUT  = 20_000  // ms to wait for tab to fully load
CLICK_WAIT_MS     = 4_000   // ms after load before injecting click
MODAL_WAIT_MS     = 1_500   // ms after Phase-1 before Phase-2 poll
MODAL_POLL_MS     = 500     // Phase-2 poll interval
MODAL_TIMEOUT_MS  = 10_000  // Phase-2 total timeout
INTER_LEAD_DELAY  = 5_000   // ms between consecutive leads
MAX_RETRIES       = 2       // retry attempts per lead
```

---

## Extension Popup UI

```
┌─────────────────────────────┐
│ 🤝 IndiaMART  Lead Auto-… OFF│
├─────────────────────────────┤
│ 🟢 Python Server   online   │
│    Leads loaded    142      │
│    Last updated    12:04    │
├─────────────────────────────┤
│ Automation              [●] │
├─────────────────────────────┤
│ ⚙️ Settings                  │
│   Min Quantity   [500]  kg  │
│   Poll Interval  [ 5 ]  min │
│              [Save Settings]│
├─────────────────────────────┤
│ 📊 Statistics               │
│  142 Scanned  3 Matched     │
│  3 Contacted                │
├─────────────────────────────┤
│ 🔄 Queue Status             │
│  Pending: 0  Processing: No │
├─────────────────────────────┤
│ [⚡ Run Now] [🔄] [🗑️ Clear]  │
└─────────────────────────────┘
```

---

## Known Behaviours & Notes

- **Anti-bot measures** — The scraper mimics a real browser session (cookies, auth headers, user-agent). If IndiaMART updates its session token format, `captured_headers` extraction in `scrape_indiamart.py` may need adjustment.
- **Login handling** — If a lead page shows a login wall, the extension auto-fills credentials you saved in the popup. If credentials are not set, it will show a notification and skip.
- **Deduplication** — A lead is identified by `"product|location"` (lowercase). Once contacted, it is stored in `chrome.storage` and will not be re-contacted unless you click **Clear History**.
- **Max results cap** — The scraper fetches at most 500 leads per cycle (`min(total, 500)` in the pagination loop).
- **Atomic file writes** — The server writes to `.tmp` then renames, so the extension never reads a partial file.
- **Service worker lifecycle** — Chrome may suspend the MV3 service worker. State is always loaded from `chrome.storage` on restart, so no data is lost.
