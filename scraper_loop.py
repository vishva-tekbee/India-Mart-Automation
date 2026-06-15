#!/usr/bin/env python3
"""
scraper_loop.py
Runs scrape_indiamart.py every INTERVAL_MINUTES and saves the result
to latest_leads.json in the same directory.
Also starts the local CORS server on port 7891 so the Chrome extension
can fetch the leads.
"""

import asyncio
import json
import os
import sys
import time
import threading
import importlib.util
from datetime import datetime
from pathlib import Path
from http.server import HTTPServer, BaseHTTPRequestHandler

# ── Config ────────────────────────────────────────────────────────────────────
INTERVAL_MINUTES = 5           # How often to re-scrape
SERVER_PORT      = 7891        # Port the Chrome extension fetches from
BASE_DIR         = Path(__file__).parent
OUTPUT_FILE      = BASE_DIR / "latest_leads.json"
META_FILE        = BASE_DIR / ".scraper_meta.json"
SCRAPER_FILE     = BASE_DIR / "scrape_indiamart.py"
# Fallback: use previously-scraped file if OUTPUT_FILE doesn't exist yet
FALLBACK_FILE    = BASE_DIR / "indiamart_cashew.json"

# ── Dynamically import scraper module ─────────────────────────────────────────
spec   = importlib.util.spec_from_file_location("scrape_indiamart", SCRAPER_FILE)
mod    = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

fetch_all_pages = mod.fetch_all_pages
map_fields      = mod.map_fields


# ── CORS HTTP Server ──────────────────────────────────────────────────────────

class LeadHandler(BaseHTTPRequestHandler):
    """Serves latest_leads.json with CORS headers for the Chrome extension."""

    def log_message(self, fmt, *args):
        # Show requests so user can confirm extension is hitting the server
        print(f"[server] {self.command} {self.path}")

    def _active_file(self):
        """Return the best available data file."""
        if OUTPUT_FILE.exists():
            return OUTPUT_FILE
        if FALLBACK_FILE.exists():
            return FALLBACK_FILE
        return None

    def _send_cors_headers(self, content_type="application/json"):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-cache")

    def do_OPTIONS(self):
        self.send_response(200)
        self._send_cors_headers()
        self.end_headers()

    def do_GET(self):
        if self.path in ("/leads", "/leads.json", "/"):
            f = self._active_file()
            if f:
                data = f.read_bytes()
                self.send_response(200)
                self._send_cors_headers()
                self.end_headers()
                self.wfile.write(data)
                print(f"[server] Served {len(data)} bytes from {f.name}")
            else:
                msg = b'{"error":"No data yet - scraper still running first cycle"}'
                self.send_response(503)
                self._send_cors_headers()
                self.end_headers()
                self.wfile.write(msg)
                print("[server] ⚠️ No data file available yet")

        elif self.path == "/status":
            f = self._active_file()
            lead_count = 0
            total_raw = 0
            last_updated = None
            if f:
                try:
                    lead_count = len(json.loads(f.read_text()))
                    last_updated = datetime.fromtimestamp(f.stat().st_mtime).isoformat()
                except Exception:
                    pass
            # Read raw total from metadata file
            if META_FILE.exists():
                try:
                    meta = json.loads(META_FILE.read_text())
                    total_raw = meta.get("total_raw", 0)
                except Exception:
                    pass
            status = {
                "ok":                     f is not None,
                "source":                 f.name if f else None,
                "last_updated":           last_updated,
                "lead_count":             lead_count,
                "total_raw":              total_raw,
                "next_scrape_in_seconds": max(
                    0,
                    int(INTERVAL_MINUTES * 60 - (time.time() - _last_scrape_time))
                ),
            }
            body = json.dumps(status).encode()
            self.send_response(200)
            self._send_cors_headers()
            self.end_headers()
            self.wfile.write(body)

        else:
            self.send_response(404)
            self.end_headers()


def start_server():
    server = HTTPServer(("127.0.0.1", SERVER_PORT), LeadHandler)
    print(f"[server] Listening on http://127.0.0.1:{SERVER_PORT}")
    server.serve_forever()


# ── Scraper loop ──────────────────────────────────────────────────────────────

_last_scrape_time = 0.0


async def run_once():
    global _last_scrape_time
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"\n[{ts}] Starting scrape…")
    try:
        all_fields = await fetch_all_pages()
        output     = map_fields(all_fields)

        # Write to file atomically
        tmp = OUTPUT_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(output, indent=2, ensure_ascii=False))
        tmp.replace(OUTPUT_FILE)

        # Save metadata (raw total vs filtered)
        META_FILE.write_text(json.dumps({
            "total_raw": len(all_fields),
            "total_filtered": len(output),
        }))

        _last_scrape_time = time.time()
        print(f"[{ts}] ✅ Scraped {len(all_fields)} raw → {len(output)} qualified → {OUTPUT_FILE.name}")
        return len(output)
    except Exception as e:
        print(f"[{ts}] ❌ Scrape error: {e}")
        return 0


async def scraper_loop():
    while True:
        await run_once()
        print(f"[loop] Sleeping {INTERVAL_MINUTES} minutes until next scrape…")
        await asyncio.sleep(INTERVAL_MINUTES * 60)


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    # Start HTTP server in a background thread (daemon so it exits with main)
    t = threading.Thread(target=start_server, daemon=True)
    t.start()

    print(f"IndiaMART Scraper Loop")
    print(f"  Scrape interval : every {INTERVAL_MINUTES} minutes")
    print(f"  Output file     : {OUTPUT_FILE}")
    print(f"  Extension URL   : http://127.0.0.1:{SERVER_PORT}/leads")
    print(f"  Status URL      : http://127.0.0.1:{SERVER_PORT}/status")
    print(f"  Press Ctrl+C to stop\n")

    try:
        asyncio.run(scraper_loop())
    except KeyboardInterrupt:
        print("\n[loop] Stopped.")
