import asyncio
import json
import re
from playwright.async_api import async_playwright

URL = "https://trade.indiamart.com/buyersearch.mp?ss=cashew"
SEARCH_API = "https://trade.indiamart.com/tradereact/searchpage"

def safe_str(val):
    if val is None:
        return ""
    if isinstance(val, list):
        return str(val[0]).strip() if val else ""
    return str(val).strip()

def clean_title(title):
    """Remove imsws/imswe markers from title"""
    return re.sub(r'\bimsw[se]\b', '', title).strip()

async def fetch_all_pages():
    all_fields = []
    initial_data = {}
    initial_post_body = {}
    captured_headers = {}

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(
            user_agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            viewport={"width": 1280, "height": 900},
        )
        page = await context.new_page()

        async def handle_response(response):
            if "tradereact/searchpage" in response.url and not initial_data:
                try:
                    body = await response.body()
                    data = json.loads(body.decode())
                    initial_data.update(data)
                except:
                    pass

        async def handle_request(request):
            if "tradereact/searchpage" in request.url and not initial_post_body:
                try:
                    pd = request.post_data
                    if pd:
                        initial_post_body.update(json.loads(pd))
                    captured_headers.update(dict(request.headers))
                except:
                    pass

        page.on("response", handle_response)
        page.on("request", handle_request)

        print("[*] Loading initial page...")
        await page.goto(URL, wait_until="networkidle", timeout=60000)
        await page.wait_for_timeout(3000)

        cookies = await context.cookies()
        cookie_str = "; ".join(f"{c['name']}={c['value']}" for c in cookies)

        for item in initial_data.get("results", []):
            all_fields.append(item.get("fields", {}))

        total = initial_data.get("total_results", 0)
        print(f"[*] Total available: {total} | First page: {len(all_fields)} entries")

        req_headers = {
            "accept": "application/json, text/javascript, */*; q=0.01",
            "accept-language": "en-US,en;q=0.9",
            "content-type": "application/json",
            "x-requested-with": "XMLHttpRequest",
            "referer": URL,
            "cookie": cookie_str,
            "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        }
        for k, v in captured_headers.items():
            if k.lower() in ["origin", "x-im-glusrid", "x-im-sid", "x-im-uid"]:
                req_headers[k] = v

        start = 10
        page_num = 2
        fail_count = 0

        while start < min(total, 500) and fail_count < 3:
            print(f"[*] Fetching page {page_num} (start={start})...")
            post_body = dict(initial_post_body)
            post_body["options.start"] = start
            post_body["options.results"] = 10

            try:
                response = await page.request.post(
                    SEARCH_API,
                    data=json.dumps(post_body),
                    headers=req_headers,
                )
                if response.status == 200:
                    data = json.loads((await response.body()).decode())
                    items = data.get("results", [])
                    print(f"  -> {len(items)} results")
                    if not items:
                        fail_count += 1
                    else:
                        fail_count = 0
                        for item in items:
                            all_fields.append(item.get("fields", {}))
                else:
                    print(f"  -> HTTP {response.status}")
                    fail_count += 1
            except Exception as e:
                print(f"  -> Error: {e}")
                fail_count += 1

            start += 10
            page_num += 1
            await asyncio.sleep(0.3)

        await browser.close()
        print(f"[*] Total raw entries collected: {len(all_fields)}")
        return all_fields


def parse_isqdetails(isqdetails):
    """Parse the isqdetails list into a dict.
    E.g. ['Quantity:200 Kg', 'Quality:Good', 'Packaging Type:Bucket',
          'Probable Order Value:Rs. 1.5 Lakh', 'Probable Requirement Type:Business Use']
    """
    result = {}
    if not isqdetails or not isinstance(isqdetails, list):
        return result
    for item in isqdetails:
        if ":" in str(item):
            key, _, val = str(item).partition(":")
            result[key.strip()] = val.strip()
    return result


# ── Filtering Criteria ────────────────────────────────────────────────────────
MIN_QTY_KG = 100
OMITTED_STATES = ["tamil nadu", "tamilnadu", "west bengal", "andhra pradesh", "odisha", "orissa"]
REQUIRE_GST = True
MIN_LONGEVITY_YEARS = 1

def parse_qty_kg(raw):
    if not raw:
        return None
    t = str(raw).lower().strip()
    m = re.search(r'([\d,]+(?:\.\d+)?)', t)
    if not m:
        return None
    try:
        n = float(m.group(1).replace(',', ''))
    except ValueError:
        return None
    if n <= 0:
        return None
    if re.search(r'\bton(ne)?s?\b|\bmt\b|\bmetric', t):
        return n * 1000
    if re.search(r'\bquintal\b', t):
        return n * 100
    if re.search(r'\bgrams?\b', t):
        return n * 0.001
    return n  # kg

def parse_member_years(membersince):
    if not membersince:
        return 0
    t = str(membersince).lower().strip()
    if 'year' not in t:
        return 0
    m = re.search(r'(\d+)\+?\s*year', t)
    if m:
        try:
            return int(m.group(1))
        except ValueError:
            pass
    return 1  # Fallback if 'year' is present but no digit parsed

def map_fields(all_fields):
    output = []
    seen = set()

    for f in all_fields:
        # Product / requirement title (clean markers)
        raw_title = safe_str(f.get("title") or f.get("titlex") or "")
        product = clean_title(raw_title)
        if not product:
            mcat = f.get("mcat_name")
            product = safe_str(mcat[0] if isinstance(mcat, list) and mcat else mcat or "")

        # Location & State
        state_name = safe_str(f.get("state") or "")
        location = safe_str(
            f.get("district_string") or f.get("dist_hq_name") or
            f.get("city_string") or f.get("city") or
            state_name or ""
        )
        if location and state_name and safe_str(state_name) != location:
            location = f"{location}, {state_name}"

        # Parse isqdetails for the requested fields
        isq = parse_isqdetails(f.get("isqdetails"))
        quantity             = isq.get("Quantity", "")
        quality              = isq.get("Quality", "")
        packaging_type       = isq.get("Packaging Type", "")
        probable_order_value = isq.get("Probable Order Value", "")
        probable_req_type    = isq.get("Probable Requirement Type", "")

        # Skip if truly empty
        if not product and not location:
            continue

        # ── Criteria Checks ──
        
        # 1. GST Verified check
        gst_status = safe_str(f.get("gstverificationstatus") or "0")
        if REQUIRE_GST and gst_status != "1":
            continue

        # 2. State Exclusion check
        if state_name:
            state_lower = state_name.lower().replace(" ", "").strip()
            if any(state_lower == s.lower().replace(" ", "").strip() for s in OMITTED_STATES):
                continue

        # 3. Member Longevity check
        member_since = safe_str(f.get("membersince") or "")
        longevity_years = parse_member_years(member_since)
        if longevity_years < MIN_LONGEVITY_YEARS:
            continue

        # 4. Minimum Quantity check
        qty_kg = parse_qty_kg(quantity)
        if qty_kg is None or qty_kg < MIN_QTY_KG:
            continue

        key = (product.lower(), location.lower())
        if key in seen:
            continue
        seen.add(key)

        # Extract unique lead ID for direct URL
        display_id = safe_str(f.get("displayid") or "")

        entry = {
            "product": product,
            "location": location,
            "quantity": quantity,
            "quality": quality,
            "packaging_type": packaging_type,
            "probable_order_value": probable_order_value,
            "probable_requirement_type": probable_req_type,
            "gst_verified": gst_status == "1",
            "member_longevity": member_since,
            "state": state_name,
            "quantity_kg": qty_kg,
            "display_id": display_id,
            "lead_url": f"https://trade.indiamart.com/buylead/detail.mp?blid={display_id}" if display_id else ""
        }
        output.append(entry)

    return output


async def main():
    all_fields = await fetch_all_pages()
    output = map_fields(all_fields)

    print(f"\n[✓] {len(output)} unique entries")
    print(json.dumps(output, indent=2, ensure_ascii=False))

    with open("/home/s/Desktop/web-scraper/indiamart_cashew.json", "w") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)
    print(f"\n[✓] Saved to indiamart_cashew.json")


if __name__ == "__main__":
    asyncio.run(main())
