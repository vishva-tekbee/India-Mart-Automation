/**
 * IndiaMART Lead Auto-Contact — background.js (v3)
 *
 * This service worker owns ALL the core logic:
 *  1. Fetches leads from local Python server (http://127.0.0.1:7891/leads)
 *  2. Filters by quantity threshold
 *  3. Opens qualifying leads in background tabs
 *  4. Injects a click script to hit "Contact Buyer Now"
 *  5. Persists processed IDs across restarts
 *
 * Popup.js talks ONLY to this file. No content script required.
 */

'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────
const LOCAL_SERVER       = 'http://127.0.0.1:8000';
const LEADS_URL          = `${LOCAL_SERVER}/leads`;
const STATUS_URL         = `${LOCAL_SERVER}/status`;
const TAB_LOAD_TIMEOUT   = 20_000;   // ms to wait for a tab to load
const CLICK_WAIT_MS      = 4_000;    // ms after load before trying to click
const MODAL_WAIT_MS      = 1_500;    // ms after first click before starting modal poll
const MODAL_POLL_MS      = 500;      // interval between modal search attempts
const MODAL_TIMEOUT_MS   = 10_000;   // total time to wait for modal before giving up
const INTER_LEAD_DELAY   = 5_000;    // ms between processing consecutive leads
const MAX_RETRIES        = 5;

// ─── In-memory state (rebuilt on SW restart from storage) ────────────────────
let cfg = {
  enabled:   false,
  threshold: 500,
  interval:  5,          // minutes
  mobile:    '',         // IndiaMART login mobile number
  password:  '',         // IndiaMART login password
};
let stats        = { scanned: 0, matched: 0, clicked: 0 };
let processedIds = new Set();
let expiredLeads = [];  // { product, location, state, reason, timestamp }
let queue        = [];
let isProcessing = false;
let lastActiveDate = '';  // YYYY-MM-DD — used to detect date rollover for daily reset

// ─── Storage helpers ──────────────────────────────────────────────────────────
async function loadState() {
  return new Promise(resolve => {
    chrome.storage.local.get(
      ['enabled', 'threshold', 'interval', 'stats', 'processedIds', 'expiredLeads', 'mobile', 'password', 'lastActiveDate'],
      data => {
        cfg.enabled   = data.enabled   ?? false;
        cfg.threshold = data.threshold ?? 500;
        cfg.interval  = data.interval  ?? 5;
        cfg.mobile    = data.mobile    ?? '';
        cfg.password  = data.password  ?? '';
        stats         = data.stats     ?? { scanned: 0, matched: 0, clicked: 0 };
        processedIds  = new Set(data.processedIds || []);
        expiredLeads  = data.expiredLeads || [];
        lastActiveDate = data.lastActiveDate || '';

        // Check for date rollover — clear history if a new day started
        const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
        if (lastActiveDate && lastActiveDate !== today) {
          console.log(`[bg] 🌅 New day detected (${lastActiveDate} → ${today}). Clearing processed history.`);
          processedIds = new Set();
          stats = { scanned: 0, matched: 0, clicked: 0 };
          expiredLeads = [];
          chrome.storage.local.set({ processedIds: [], stats, expiredLeads, lastActiveDate: today });
        } else if (!lastActiveDate) {
          chrome.storage.local.set({ lastActiveDate: today });
        }
        lastActiveDate = today;

        resolve();
      }
    );
  });
}

function saveStats() {
  chrome.storage.local.set({ stats });
}

function saveProcessedIds() {
  chrome.storage.local.set({ processedIds: [...processedIds] });
}

function saveExpiredLeads() {
  chrome.storage.local.set({ expiredLeads });
}

// ─── Quantity parser ──────────────────────────────────────────────────────────
function parseQtyKg(raw) {
  if (!raw) return null;
  const t = raw.toLowerCase().trim();
  const m = t.match(/([\d,]+(?:\.\d+)?)/);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ''));
  if (!n || n <= 0) return null;
  if (/\bton(ne)?s?\b|\bmt\b|\bmetric/.test(t)) return n * 1000;
  if (/\bquintal\b/.test(t)) return n * 100;
  if (/\bgrams?\b/.test(t))  return n * 0.001;
  return n; // kg
}

// ─── Fetch leads from local server ────────────────────────────────────────────
async function fetchLeads() {
  try {
    const r = await fetch(LEADS_URL, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    console.log(`[bg] ✅ Fetched ${data.length} leads from server`);
    return data;
  } catch (e) {
    console.warn(`[bg] ❌ Server fetch failed: ${e.message}`);
    return null;
  }
}

// ─── Run one scan+queue cycle ─────────────────────────────────────────────────
async function runCycle() {
  console.log('[bg] 🔄 Starting cycle…');

  // Check for date rollover before each cycle
  const today = new Date().toISOString().slice(0, 10);
  if (lastActiveDate && lastActiveDate !== today) {
    console.log(`[bg] 🌅 Date rolled over (${lastActiveDate} → ${today}). Clearing processed history.`);
    processedIds = new Set();
    stats = { scanned: 0, matched: 0, clicked: 0 };
    expiredLeads = [];
    lastActiveDate = today;
    chrome.storage.local.set({ processedIds: [], stats, expiredLeads, lastActiveDate: today });
  }

  const leads = await fetchLeads();
  if (!leads) {
    notify('❌ Server not reachable', 'Run: uvicorn api.main:app --port 8000');
    return { ok: false, reason: 'server_unreachable' };
  }

  // Get total raw count from server status
  try {
    const statusResp = await fetch(STATUS_URL, { cache: 'no-store' });
    if (statusResp.ok) {
      const statusData = await statusResp.json();
      stats.scanned = statusData.total_raw ?? leads.length;
    } else {
      stats.scanned = leads.length;
    }
  } catch {
    stats.scanned = leads.length;
  }

  // stats.scanned = total raw leads from scraper (set above)
  // stats.matched = total qualified leads from server (after Python filters)
  stats.matched = leads.length;

  const qualifying = [];

  for (const lead of leads) {
    const key = `${lead.product}|${lead.location}`.toLowerCase();
    if (processedIds.has(key)) continue;

    qualifying.push({
      id:        key,
      product:   lead.product,
      location:  lead.location,
      state:     lead.state || '',
      rawQty:    lead.quantity,
      qtyKg:     lead.quantity_kg ?? null,
      displayId: lead.display_id || '',
    });
    console.log(`[bg] ✅ MATCH: ${lead.product} | ${lead.location} | ${lead.quantity}`);
  }

  saveStats();
  console.log(`[bg] Cycle: ${stats.scanned} raw, ${stats.matched} qualified, ${qualifying.length} new to contact`);

  if (qualifying.length > 0) {
    notify(
      `🔔 ${qualifying.length} matching lead(s)`,
      qualifying.map(l => `${l.product} · ${l.rawQty}`).slice(0, 3).join('\n')
    );

    // Mark as processed immediately (prevent re-queue on next cycle)
    for (const l of qualifying) processedIds.add(l.id);
    saveProcessedIds();

    queue.push(...qualifying);
    drainQueue();
  }

  return { ok: true, matched: qualifying.length };
}

// ─── Poll scheduler (using chrome.alarms for reliability) ────────────────────
const ALARM_NAME = 'lead-poll';

function schedulePoll() {
  if (!cfg.enabled) {
    chrome.alarms.clear(ALARM_NAME);
    return;
  }
  // Create a repeating alarm every cfg.interval minutes
  chrome.alarms.create(ALARM_NAME, {
    delayInMinutes:  cfg.interval,
    periodInMinutes: cfg.interval,
  });
  console.log(`[bg] ⏰ Alarm set — poll every ${cfg.interval} min`);
}

// Fires every cfg.interval minutes, even if service worker was asleep
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  console.log('[bg] ⏰ Alarm fired — running cycle');
  await runCycle();
});

// ─── Tab-based contact clicking ───────────────────────────────────────────────
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function openTabAndWait(url) {
  return new Promise((resolve, reject) => {
    let tabId;
    const listener = (id, info) => {
      if (id !== tabId) return;
      if (info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(tabId);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.create({ url, active: false }, tab => {
      tabId = tab.id;
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(tabId); // timeout fallback
      }, TAB_LOAD_TIMEOUT);
    });
  });
}

async function closeTab(tabId) {
  return new Promise(resolve => {
    chrome.tabs.remove(tabId, () => {
      chrome.runtime.lastError; // suppress error
      resolve();
    });
  });
}

/** Returns true if the tab still exists in Chrome. */
async function tabExists(tabId) {
  return new Promise(resolve => {
    chrome.tabs.get(tabId, () => {
      if (chrome.runtime.lastError) {
        resolve(false);
      } else {
        resolve(true);
      }
    });
  });
}

/**
 * PHASE 1 — Find the CORRECT listing on the search results page and click
 * its "Contact Buyer Now" button.
 *
 * Accepts full lead metadata (product, location, displayId, minQtyKg) to
 * strictly verify the match before clicking. Prevents clicking random leads.
 *
 * Injected into the lead tab via chrome.scripting.executeScript.
 */
function injectedClickPhase1(leadProduct, leadLocation, leadDisplayId, minQtyKg) {
  function isVisible(el) {
    if (!el) return false;
    const s = window.getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0'
      && !el.disabled && el.getAttribute('aria-disabled') !== 'true';
  }

  function realClick(el) {
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
  }

  // ── Normalize inputs ───────────n───────────────────────────────────────────
  const prodLower = (leadProduct || '').toLowerCase().replace(/&amp;/g, ' ').replace(/[&]+/g, ' ').replace(/\s+/g, ' ').trim();
  const prodWords = prodLower.split(' ').filter(p => p.length > 2);

  const locLower = (leadLocation || '').toLowerCase().replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
  const locParts = locLower.split(' ').filter(p => p.length > 2);

  // Extract the city name from leadLocation (usually the first part before comma)
  const cityToken = (leadLocation || '').split(',')[0].trim().toLowerCase();

  console.log(`[injected] 🔍 Strict match: product="${leadProduct}", location="${leadLocation}" (city="${cityToken}"), displayId="${leadDisplayId}", minQty=${minQtyKg}kg`);

  // ── Early exit: "no results" page ─────────────────────────────────────────
  const pageText = document.body?.innerText || '';
  if (/sorry.*did not get any results/i.test(pageText) ||
      /no\s+results?\s+found/i.test(pageText) ||
      /0\s+buyers?\s+for/i.test(pageText)) {
    console.warn(`[injected] ⚠️ IndiaMART returned NO RESULTS for this search`);
    return { ok: false, reason: 'no_search_results', pageTitle: document.title };
  }

  // ── Parse quantity from card text ─────────────────────────────────────────
  function parseQtyFromText(text) {
    const m = text.match(/quantity\s*[:：]\s*([\d,]+(?:\.\d+)?)\s*(kg|tonne?s?|mt|metric|quintal|grams?)/i);
    if (!m) return null;
    const num = parseFloat(m[1].replace(/,/g, ''));
    if (!num || num <= 0) return null;
    const unit = m[2].toLowerCase();
    if (/ton|mt|metric/.test(unit)) return num * 1000;
    if (/quintal/.test(unit)) return num * 100;
    if (/gram/.test(unit)) return num * 0.001;
    return num;
  }

  // ── Find contact buttons ──────────────────────────────────────────────────
  const traButtons = [...document.querySelectorAll('.TRA_contact_buyer')].filter(isVisible);
  const CONTACT_TEXTS = ['contact buyer now', 'contact buyer', 'contact now', 'send enquiry', 'enquire now', 'buy lead'];

  const otherButtons = [];
  if (traButtons.length === 0) {
    for (const el of document.querySelectorAll('button, a[role=button], input[type=button], input[type=submit], [role=button]')) {
      if (!isVisible(el)) continue;
      const t = (el.textContent || el.value || '').toLowerCase().replace(/\s+/g, ' ').trim();
      if (CONTACT_TEXTS.some(ct => t.includes(ct))) otherButtons.push(el);
    }
  }

  const contactButtons = traButtons.length > 0 ? traButtons : otherButtons;
  console.log(`[injected] Found ${contactButtons.length} contact buttons`);

  if (contactButtons.length === 0) {
    return { ok: false, reason: 'no_contact_buttons_found', pageTitle: document.title };
  }

  // ── Find listing container ────────────────────────────────────────────────
  function getListingContainer(btn) {
    let el = btn.parentElement, depth = 0;
    while (el && depth < 10) {
      if (el.id && /^list\d+$/.test(el.id)) return el;
      el = el.parentElement; depth++;
    }
    el = btn.parentElement; depth = 0;
    while (el && depth < 12) {
      if ((el.textContent || '').length > 50 && (el.textContent || '').length < 5000) return el;
      el = el.parentElement; depth++;
    }
    return btn.parentElement;
  }

  // ── Dynamic product matching ratio threshold ──────────────────────────────
  let reqProdRatio = 0.4;
  if (prodWords.length <= 2) {
    reqProdRatio = 1.0; // Both words must match for short product names
  } else if (prodWords.length === 3) {
    reqProdRatio = 0.66; // At least 2 of 3 words must match
  } else {
    reqProdRatio = 0.5; // At least 50% of words must match
  }

  // ── Score each listing ────────────────────────────────────────────────────
  const listings = contactButtons.map((btn, i) => {
    const container = getListingContainer(btn);
    const cText = (container?.textContent || '').toLowerCase();
    const cHtml = container?.innerHTML || '';

    const hasDisplayId = leadDisplayId ? cHtml.includes(leadDisplayId) : false;
    const prodHits = prodWords.filter(w => cText.includes(w)).length;
    const prodRatio = prodWords.length > 0 ? prodHits / prodWords.length : 0;
    const locHits = locParts.filter(p => cText.includes(p)).length;
    const locRatio = locParts.length > 0 ? locHits / locParts.length : 0;
    const cardQty = parseQtyFromText(cText);
    const qtyOk = cardQty !== null && minQtyKg > 0 ? cardQty >= minQtyKg : true;

    // Strict city matching: if lead location has a city, the card must contain it
    const matchesCity = !cityToken || cText.includes(cityToken);

    console.log(`[injected] Card ${i}: prod=${prodHits}/${prodWords.length} loc=${locHits}/${locParts.length} matchesCity=${matchesCity} qty=${cardQty}kg(min=${minQtyKg}) id=${hasDisplayId}`);

    return { btn, hasDisplayId, prodHits, prodRatio, locHits, locRatio, cardQty, qtyOk, matchesCity, cText };
  });

  // ── Match by displayId (most precise) ─────────────────────────────────────
  const idMatch = listings.find(l => l.hasDisplayId);
  if (idMatch) {
    console.log(`[injected] ✅ Matched by displayId: ${leadDisplayId}`);
    realClick(idMatch.btn);
    return { ok: true, phase: 1, matched: 'displayId', displayId: leadDisplayId };
  }

  // ── Strict composite match ────────────────────────────────────────────────
  // Require: product match + city match + quantity passes minimum
  const candidates = listings.filter(l =>
    l.prodRatio >= reqProdRatio &&
    l.matchesCity &&
    l.qtyOk
  );

  if (candidates.length > 0) {
    candidates.sort((a, b) => {
      const sA = a.prodRatio * 0.4 + a.locRatio * 0.6;
      const sB = b.prodRatio * 0.4 + b.locRatio * 0.6;
      return sB - sA;
    });
    const best = candidates[0];
    const score = best.prodRatio * 0.4 + best.locRatio * 0.6;

    console.log(`[injected] ✅ Strict match candidate: prod=${best.prodHits}/${prodWords.length} loc=${best.locHits}/${locParts.length} qty=${best.cardQty}kg score=${score.toFixed(2)}`);
    realClick(best.btn);
    return {
      ok: true, phase: 1, matched: 'strict-composite',
      prodMatch: `${best.prodHits}/${prodWords.length}`,
      locMatch: `${best.locHits}/${locParts.length}`,
      cardQtyKg: best.cardQty,
      score: score.toFixed(2),
    };
  }

  // ── No strict match — refuse to click ─────────────────────────────────────
  console.warn(`[injected] ❌ No strict match for "${leadProduct}" @ "${leadLocation}" (min ${minQtyKg}kg)`);
  return {
    ok: false,
    reason: 'no_strict_match',
    searchedFor: { product: leadProduct, location: leadLocation, displayId: leadDisplayId, minQtyKg },
    listingCount: listings.length,
    cardInfo: listings.slice(0, 5).map(l => ({
      prod: `${l.prodHits}/${prodWords.length}`, loc: `${l.locHits}/${locParts.length}`,
      qty: l.cardQty, qtyOk: l.qtyOk, matchesCity: l.matchesCity,
      snippet: l.cText.replace(/\s+/g, ' ').trim().slice(0, 120),
    })),
  };
}


/**
 * DETAIL PAGE CLICK — Simpler version for direct lead detail pages
 * (buylead/detail.mp?blid=...) where there's exactly one listing.
 * Just finds the first visible contact button and clicks it.
 */
function injectedClickOnDetailPage(leadDisplayId, leadProduct, leadLocation) {
  const pageUrl = window.location.href;
  const pageText = (document.body?.innerText || '').toLowerCase();

  console.log(`[injected-detail] Checking detail page for displayId=${leadDisplayId}, product="${leadProduct}", location="${leadLocation}"`);
  console.log(`[injected-detail] Page URL: ${pageUrl}`);

  // ── Check 1: URL still contains the display ID (not redirected) ───────────
  if (leadDisplayId && !pageUrl.includes(leadDisplayId)) {
    console.warn(`[injected-detail] ❌ Redirected away from lead. Expected blid=${leadDisplayId}, got URL: ${pageUrl}`);
    return { ok: false, reason: 'redirected_away_from_lead_page' };
  }

  // ── Check 2: Page contains expired/inactive indicators ────────────────────
  const EXPIRED_PATTERNS = /expired|no\s+longer\s+active|similar\s+requirements|requirement\s+closed|requirement\s+fulfilled|this\s+requirement\s+has|no\s+longer\s+looking|buyer\s+has\s+already|not\s+available|lead\s+closed|requirement\s+is\s+closed|looking\s+for\s+similar/i;
  if (EXPIRED_PATTERNS.test(pageText)) {
    console.warn(`[injected-detail] ❌ Lead ${leadDisplayId} appears expired or inactive.`);
    return { ok: false, reason: 'lead_expired' };
  }

  // ── Check 3: Verify the page actually contains the target product ─────────
  const prodClean = (leadProduct || '').toLowerCase()
    .replace(/&amp;/g, ' ').replace(/[&]+/g, ' ').replace(/\s+/g, ' ').trim();
  const prodWords = prodClean.split(' ').filter(w => w.length > 2);

  if (prodWords.length > 0) {
    const prodHits = prodWords.filter(w => pageText.includes(w)).length;
    const prodRatio = prodHits / prodWords.length;
    console.log(`[injected-detail] Product check: ${prodHits}/${prodWords.length} words found (ratio=${prodRatio.toFixed(2)})`);

    if (prodRatio < 0.5) {
      console.warn(`[injected-detail] ❌ Product mismatch: page doesn't contain enough product words ("${leadProduct}")`);
      return { ok: false, reason: 'product_mismatch_on_detail_page' };
    }
  }

  // ── Check 4: Verify the page contains the target city ─────────────────────
  const cityToken = (leadLocation || '').split(',')[0].trim().toLowerCase();
  if (cityToken && cityToken.length > 2 && !pageText.includes(cityToken)) {
    console.warn(`[injected-detail] ❌ City mismatch: page doesn't mention "${cityToken}"`);
    return { ok: false, reason: 'location_mismatch_on_detail_page' };
  }

  // ── All checks passed — find and click the contact button ─────────────────
  function isVisible(el) {
    if (!el) return false;
    const s = window.getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0'
      && !el.disabled && el.getAttribute('aria-disabled') !== 'true';
  }

  function getNormText(el) {
    return (el.textContent || el.value || el.getAttribute('aria-label') || '')
      .toLowerCase().replace(/\s+/g, ' ').trim();
  }

  const CONTACT_TEXTS = [
    'contact buyer now', 'contact buyer', 'contact now',
    'send enquiry', 'enquire now',
  ];

  const allClickables = [
    ...document.querySelectorAll(
      'button, a, div, span, input[type=button], input[type=submit], [role=button], .TRA_contact_buyer, .btn'
    ),
  ];

  console.log(`[injected-detail] Scanning ${allClickables.length} clickable elements…`);

  for (const el of allClickables) {
    if (!isVisible(el)) continue;
    const t = getNormText(el);
    if (CONTACT_TEXTS.some(ct => t.includes(ct))) {
      console.log(`[injected-detail] ✅ Found and clicking: "${t}" [${el.tagName}.${(el.className || '').toString().slice(0, 40)}]`);
      el.click();
      return { ok: true, phase: 1, matched: 'detail-page', text: t };
    }
  }

  // Debug: dump visible buttons
  const visibleBtns = allClickables
    .filter(el => isVisible(el))
    .slice(0, 20)
    .map(el => `[${el.tagName}.${(el.className || '').toString().slice(0, 30)}] "${getNormText(el).slice(0, 50)}"`);

  console.warn(`[injected-detail] ❌ No contact button found. Visible buttons:`, visibleBtns);

  return {
    ok: false,
    reason: 'no_contact_button_on_detail_page',
    visibleButtons: visibleBtns,
  };
}

/**
 * PHASE 2 — Polls every 500ms (injected once, runs internally) looking for the
 * confirm modal/popup that IndiaMART shows after clicking "Contact Buyer Now".
 * Returns { ok, ... } as soon as it succeeds, or after timeoutMs gives up.
 */
function injectedClickPhase2Polling(timeoutMs, pollMs) {
  // ── IndiaMART-specific selectors (most specific first) ────────────────────
  const MODAL_SELS = [
    // Bootstrap modal (shown state)
    '.modal.show .btn-primary',
    '.modal.show button[type=submit]',
    '.modal.show input[type=submit]',
    '.modal.fade.show button:not([data-dismiss]):not([data-bs-dismiss])',
    '.modal-footer .btn-primary',
    '.modal-footer button[type=submit]',
    '.modal-footer button:not([data-dismiss]):not([data-bs-dismiss])',
    // IndiaMART-specific IDs
    '#buyLeadModal .btn-primary',
    '#buyLeadModal button[type=submit]',
    '#contactModal .btn-primary',
    '#contactModal button[type=submit]',
    '#sendEnquiryModal button[type=submit]',
    // React portals — mounted directly on body with high z-index overlay
    'body > div[class*="modal"] button[type=submit]',
    'body > div[class*="modal"] .btn-primary',
    'body > div[class*="overlay"] button[type=submit]',
    'body > div[class*="popup"] button[type=submit]',
    // Generic visible-block modals
    '[class*="modal"][style*="display: block"] .btn-primary',
    '[class*="modal"][style*="display: block"] button[type=submit]',
    '[class*="modal"][style*="display: flex"] button[type=submit]',
    // role=dialog (ARIA)
    '[role=dialog] button[type=submit]',
    '[role=dialog] .btn-primary',
    '[role=dialog] button:not([data-dismiss]):not([data-bs-dismiss])',
    // overlay/dialog fallbacks
    '.overlay button[type=submit]',
    '.dialog button[type=submit]',
  ];

  const CONFIRM_TEXTS = [
    'send enquiry', 'send', 'submit', 'confirm', 'proceed',
    'contact buyer', 'contact now', 'buy lead', 'ok', 'yes', 'continue', 'enquire',
  ];

  function isVisible(el) {
    if (!el) return false;
    const s = window.getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0'
      && !el.disabled && el.getAttribute('aria-disabled') !== 'true';
  }

  function tryClick() {
    // Pass 1 — specific CSS selectors
    for (const sel of MODAL_SELS) {
      try {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          if (!isVisible(el)) continue;
          el.click();
          return { ok: true, phase: 2, matched: 'selector', sel };
        }
      } catch (_) {}
    }

    // Pass 2 — text search inside any visible overlay/dialog/modal root
    const overlayRoots = document.querySelectorAll(
      '[role=dialog], [role=alertdialog], ' +
      '.modal, .popup, .dialog, .overlay, ' +
      '[class*="modal"], [class*="popup"], [class*="overlay"], [class*="dialog"]'
    );
    for (const root of overlayRoots) {
      if (!isVisible(root)) continue;
      const rect = root.getBoundingClientRect();
      // Must be actually on screen (not a hidden off-screen container)
      if (rect.width === 0 && rect.height === 0) continue;

      const btns = root.querySelectorAll(
        'button, input[type=button], input[type=submit], [role=button], a.btn'
      );
      for (const btn of btns) {
        if (!isVisible(btn)) continue;
        const t = (btn.textContent || btn.value || btn.getAttribute('aria-label') || '')
          .toLowerCase().replace(/\s+/g, ' ').trim();
        if (CONFIRM_TEXTS.some(ct => t === ct || t.startsWith(ct))) {
          btn.click();
          return { ok: true, phase: 2, matched: 'text-in-overlay', text: t };
        }
      }
    }

    return null; // not found yet
  }

  // ── Polling loop (runs inside the page context) ───────────────────────────
  return new Promise(resolve => {
    const start = Date.now();

    function attempt() {
      const res = tryClick();
      if (res) { resolve(res); return; }

      if (Date.now() - start >= timeoutMs) {
        // Dump visible overlays for debugging
        const debugOverlays = [...document.querySelectorAll(
          '[role=dialog], .modal, [class*="modal"], [class*="popup"], [class*="overlay"]'
        )]
          .filter(el => {
            const s = window.getComputedStyle(el);
            return s.display !== 'none' && s.visibility !== 'hidden';
          })
          .slice(0, 8)
          .map(el => `${el.tagName}.${el.className.toString().trim().slice(0, 60)}`);

        resolve({
          ok: false,
          phase: 2,
          reason: 'modal_not_found_after_timeout',
          visibleOverlays: debugOverlays,
        });
        return;
      }

      setTimeout(attempt, pollMs);
    }

    attempt();
  });
}

/**
 * PHASE 0 — Detect the IndiaMART login wall and auto-fill credentials.
 * The login modal uses #loginform with #email (mobile) and #usr_pass fields.
 * Returns { ok: true } if already logged in (no modal), { ok: true, loggedIn: true } after
 * successfully submitting, or { ok: false, reason } if credentials missing or form not found.
 */
function injectedLoginIfNeeded(mobile, password) {
  const loginForm = document.getElementById('loginform');
  if (!loginForm) return { ok: true, alreadyLoggedIn: true }; // no login wall

  const s = window.getComputedStyle(loginForm);
  const isVisible = s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
  if (!isVisible) return { ok: true, alreadyLoggedIn: true };

  if (!mobile || !password) {
    return { ok: false, reason: 'no_credentials', hint: 'Set mobile & password in the extension popup' };
  }

  // Fill mobile number
  const mobileInput = document.getElementById('email');
  if (!mobileInput) return { ok: false, reason: 'mobile_input_not_found' };
  mobileInput.value = mobile;
  mobileInput.dispatchEvent(new Event('input', { bubbles: true }));
  mobileInput.dispatchEvent(new Event('change', { bubbles: true }));

  // Fill password
  const passInput = document.getElementById('usr_pass');
  if (!passInput) return { ok: false, reason: 'password_input_not_found' };
  passInput.value = password;
  passInput.dispatchEvent(new Event('input', { bubbles: true }));
  passInput.dispatchEvent(new Event('change', { bubbles: true }));

  // Accept T&C checkbox if unchecked
  const checkbox = document.getElementById('myCheckbox');
  if (checkbox && !checkbox.checked) checkbox.click();

  // Click the Continue/Submit button
  const submitBtn = document.getElementById('submtbtn');
  if (!submitBtn) return { ok: false, reason: 'submit_button_not_found' };
  submitBtn.click();

  return { ok: true, loggedIn: true };
}

/**
 * Sanitize product name for use in search queries.
 * - Decodes HTML entities (&amp; → &, &lt; → <, etc.)
 * - Strips & and special chars that break IndiaMART search or cause ambiguity
 * - Collapses extra whitespace
 */
function sanitizeProductForSearch(product) {
  if (!product) return '';
  let s = product;
  // Decode common HTML entities
  s = s.replace(/&amp;/gi, '&')
       .replace(/&lt;/gi, '<')
       .replace(/&gt;/gi, '>')
       .replace(/&quot;/gi, '"')
       .replace(/&#39;/gi, "'")
       .replace(/&#?\w+;/g, ' ');  // catch any remaining HTML entities
  // Strip & and other characters that corrupt search URLs or cause ambiguity
  s = s.replace(/[&]+/g, ' ');
  // Collapse multiple spaces
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

async function processOneLead(lead, attempt = 1) {
  // Sanitize product name (e.g. "Dry Fruits &amp; Nuts" → "Dry Fruits Nuts")
  const cleanProduct = sanitizeProductForSearch(lead.product);

  // Build search URL based on attempt:
  //   Attempt 1: product + full location (e.g. "Cashew Husk Kamrup, Assam")
  //   Attempt 2: product + city only   (e.g. "Cashew Husk Kamrup")  — drops state
  //   Attempt 3: product + state only  (e.g. "Cashew Husk Assam")
  //   Attempt 4: product only          (e.g. "Cashew Husk")         — broadest search
  //   Attempt 5: direct lead URL       (buylead/detail.mp?blid=...) — last resort
  let url;
  let isDirectUrl = false;

  if (attempt <= 1) {
    const q = `${cleanProduct} ${lead.location || ''}`.trim();
    url = `https://trade.indiamart.com/buyersearch.mp?ss=${encodeURIComponent(q)}`;
  } else if (attempt === 2) {
    // Fallback: product + city only (first part of "City, State")
    const city = (lead.location || '').split(',')[0].trim();
    const q = city ? `${cleanProduct} ${city}` : `${cleanProduct} ${lead.state || ''}`;
    url = `https://trade.indiamart.com/buyersearch.mp?ss=${encodeURIComponent(q.trim())}`;
  } else if (attempt === 3) {
    const q = `${cleanProduct} ${lead.state || ''}`.trim();
    url = `https://trade.indiamart.com/buyersearch.mp?ss=${encodeURIComponent(q)}`;
  } else if (attempt === 4) {
    // Product-only search (broadest)
    url = `https://trade.indiamart.com/buyersearch.mp?ss=${encodeURIComponent(cleanProduct)}`;
  } else {
    // Last resort: direct lead detail URL
    if (lead.displayId) {
      url = `https://trade.indiamart.com/buylead/detail.mp?blid=${lead.displayId}`;
      isDirectUrl = true;
    } else {
      // No displayId available, nothing left to try
      console.warn(`[bg] No displayId for "${lead.product}" — all attempts exhausted`);
      expiredLeads.push({
        product: lead.product, location: lead.location,
        state: lead.state || '', quantity: lead.rawQty || '',
        reason: 'all_attempts_exhausted',
        timestamp: new Date().toISOString(),
      });
      saveExpiredLeads();
      notify('⚠️ Lead expired', `${lead.product} @ ${lead.location}: lead no longer available on IndiaMART`);
      return { ok: false, reason: 'all_attempts_exhausted' };
    }
  }

  const strategyNames = ['product+location', 'product+city', 'product+state', 'product-only', 'direct-url'];
  console.log(`[bg] Processing "${lead.product}" @ ${lead.location} (attempt ${attempt}/${MAX_RETRIES}, strategy: ${strategyNames[attempt - 1] || 'unknown'})`);

  let tabId;
  try {
    // ── Open tab ──────────────────────────────────────────────────────────────
    tabId = await openTabAndWait(url);
    console.log(`[bg] Tab ${tabId} loaded`);
    await sleep(CLICK_WAIT_MS);

    // ── Guard: ensure tab still exists before injecting ───────────────────────
    if (!await tabExists(tabId)) {
      console.warn(`[bg] Tab ${tabId} was closed before Phase-1 injection — skipping`);
      tabId = null;
      expiredLeads.push({
        product: lead.product, location: lead.location,
        state: lead.state || '', quantity: lead.rawQty || '',
        reason: 'tab_closed_before_phase1',
        timestamp: new Date().toISOString(),
      });
      saveExpiredLeads();
      return { ok: false, reason: 'tab_closed_before_phase1' };
    }

    // ── Phase 0: handle login wall if present ────────────────────────────────
    const [p0] = await chrome.scripting.executeScript({
      target: { tabId },
      func:   injectedLoginIfNeeded,
      args:   [cfg.mobile, cfg.password],
    });
    const p0res = p0?.result;
    console.log(`[bg] Phase-0 (login check) result:`, p0res);

    if (!p0res?.ok) {
      console.error(`[bg] Login wall detected but could not log in: ${p0res?.reason}`);
      expiredLeads.push({
        product: lead.product, location: lead.location,
        state: lead.state || '', quantity: lead.rawQty || '',
        reason: p0res?.reason || 'login_failed',
        timestamp: new Date().toISOString(),
      });
      saveExpiredLeads();
      notify('🔐 Login required', p0res?.hint || 'Set your IndiaMART credentials in the popup');
      return { ok: false, reason: p0res?.reason };
    }

    if (p0res?.loggedIn) {
      console.log('[bg] Login submitted — waiting for redirect…');
      await sleep(5000);
      if (!await tabExists(tabId)) {
        tabId = null;
        expiredLeads.push({
          product: lead.product, location: lead.location,
          state: lead.state || '', quantity: lead.rawQty || '',
          reason: 'tab_closed_after_login',
          timestamp: new Date().toISOString(),
        });
        saveExpiredLeads();
        return { ok: false, reason: 'tab_closed_after_login' };
      }
    }

    // ── Phase 1: click "Contact Buyer Now" ─────────────────────────────────
    let p1res;
    if (isDirectUrl) {
      // Direct lead detail page — use the detail-page clicker with verification
      const [p1] = await chrome.scripting.executeScript({
        target: { tabId },
        func:   injectedClickOnDetailPage,
        args:   [lead.displayId || '', lead.product || '', lead.location || ''],
      });
      p1res = p1?.result;
    } else {
      // Search results page — use the strict matching logic
      const [p1] = await chrome.scripting.executeScript({
        target: { tabId },
        func:   injectedClickPhase1,
        args:   [lead.product || '', lead.location || '', lead.displayId || '', lead.qtyKg ?? 100],
      });
      p1res = p1?.result;
    }
    console.log(`[bg] Phase-1 result:`, p1res);

    if (!p1res?.ok) {
      const failReason = p1res?.reason || 'unknown';
      console.warn(`[bg] Phase-1 failed (attempt ${attempt}/${MAX_RETRIES}, reason: ${failReason}). Cards:`, p1res?.cardInfo);

      // Close this tab before retrying with broader search
      await closeTab(tabId); tabId = null;

      if (attempt < MAX_RETRIES) {
        const nextStrategy = strategyNames[attempt] || 'broader search';
        console.log(`[bg] Retrying with ${nextStrategy}…`);
        await sleep(3000);
        return processOneLead(lead, attempt + 1);
      }

      // All attempts exhausted
      // Track this expired lead for display in popup
      expiredLeads.push({
        product:   lead.product,
        location:  lead.location,
        state:     lead.state || '',
        quantity:  lead.rawQty || '',
        reason:    failReason,
        timestamp: new Date().toISOString(),
      });
      saveExpiredLeads();
      notify('⏰ Lead expired', `${lead.product} @ ${lead.location}: no longer available on IndiaMART`);

      return { ok: false, reason: failReason };
    }

    // ── Phase 1 click succeeded — now wait for confirmation modal ────────────
    console.log(`[bg] ✅ Phase-1 clicked via strategy: ${p1res.matched} (attempt ${attempt})`);

    // Wait a bit for the modal to appear after the click
    await sleep(MODAL_WAIT_MS);

    // ── Contact successful — IndiaMART processes the click directly ──────────
    // No confirmation modal to handle; the click itself completes the contact.
    stats.clicked++;
    saveStats();
    notify(
      '✅ Contacted!',
      `${lead.product}\n${lead.location} · ${lead.rawQty}`
    );

    await sleep(1500);
    return { ok: true };

  } catch (e) {
    const isTabVanished = e.message && e.message.includes('No tab with id');
    if (isTabVanished) {
      console.warn(`[bg] Tab vanished mid-process for "${lead.product}" — skipping retry`);
    } else {
      console.error(`[bg] Error processing ${lead.id}:`, e.message);
    }

    if (!isTabVanished && attempt < MAX_RETRIES) {
      await sleep(3000);
      return processOneLead(lead, attempt + 1);
    }

    // All attempts exhausted or tab vanished (no point retrying)
    const reason = isTabVanished ? 'tab_vanished' : (e.message || 'unknown_error');
    expiredLeads.push({
      product:   lead.product,
      location:  lead.location,
      state:     lead.state || '',
      quantity:  lead.rawQty || '',
      reason:    reason,
      timestamp: new Date().toISOString(),
    });
    saveExpiredLeads();
    notify('⏰ Lead expired', `${lead.product} @ ${lead.location}: no longer available on IndiaMART`);

    return { ok: false, reason: reason };
  } finally {
    await sleep(2000);
    if (tabId) await closeTab(tabId);
  }
}

async function drainQueue() {
  if (isProcessing || queue.length === 0) return;
  isProcessing = true;
  while (queue.length > 0) {
    const lead = queue.shift();
    await processOneLead(lead);
    if (queue.length > 0) await sleep(INTER_LEAD_DELAY);
  }
  isProcessing = false;
}

// ─── Notifications ────────────────────────────────────────────────────────────
function notify(title, message) {
  chrome.notifications.create({
    type: 'basic', iconUrl: 'icons/icon48.png',
    title, message, priority: 1,
  });
}

// ─── Message listener (from popup.js) ────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  console.log('[bg] Message:', msg.type);

  switch (msg.type) {

    case 'SET_CREDENTIALS':
      cfg.mobile   = msg.mobile   ?? cfg.mobile;
      cfg.password = msg.password ?? cfg.password;
      chrome.storage.local.set({ mobile: cfg.mobile, password: cfg.password });
      console.log(`[bg] Credentials saved (mobile: ${cfg.mobile})`);
      sendResponse({ ok: true });
      break;

    case 'SET_SETTINGS':
      cfg.enabled   = msg.enabled   ?? cfg.enabled;
      cfg.threshold = msg.threshold ?? cfg.threshold;
      cfg.interval  = msg.interval  ?? cfg.interval;
      chrome.storage.local.set({ ...cfg });

      if (cfg.enabled) {
        // Run a cycle immediately when toggled ON, then start alarm
        runCycle().then(() => schedulePoll());
      } else {
        chrome.alarms.clear(ALARM_NAME);
      }
      sendResponse({ ok: true });
      break;

    case 'RUN_NOW':
      runCycle().then(result => {
        schedulePoll(); // reset timer
        sendResponse({ ok: true, result });
      });
      return true; // async

    case 'GET_STATUS':
      sendResponse({
        ok: true,
        cfg,
        stats,
        queueLength:  queue.length,
        isProcessing,
        expiredLeads,
      });
      break;

    case 'GET_QUEUE_STATUS':
      sendResponse({ queueLength: queue.length, isProcessing });
      break;

    case 'CLEAR_ALL':
      processedIds = new Set();
      expiredLeads = [];
      stats        = { scanned: 0, matched: 0, clicked: 0 };
      queue        = [];
      chrome.storage.local.set({ processedIds: [], expiredLeads: [], stats, clicked: 0 });
      sendResponse({ ok: true });
      break;

    case 'CLEAR_PROCESSED_IDS':
      processedIds = new Set();
      chrome.storage.local.set({ processedIds: [] });
      sendResponse({ ok: true });
      break;

    default:
      sendResponse({ ok: false, error: 'Unknown message' });
  }
  return true;
});

// ─── Init ─────────────────────────────────────────────────────────────────────
loadState().then(() => {
  console.log(`[bg] Service worker started — enabled=${cfg.enabled}, threshold=${cfg.threshold}kg`);
  if (cfg.enabled) {
    // Run a cycle immediately on startup, then set up the alarm
    runCycle().then(() => schedulePoll());
  }
});
