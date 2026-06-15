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
const LOCAL_SERVER       = 'http://127.0.0.1:7891';
const LEADS_URL          = `${LOCAL_SERVER}/leads`;
const STATUS_URL         = `${LOCAL_SERVER}/status`;
const TAB_LOAD_TIMEOUT   = 20_000;   // ms to wait for a tab to load
const CLICK_WAIT_MS      = 4_000;    // ms after load before trying to click
const MODAL_WAIT_MS      = 1_500;    // ms after first click before starting modal poll
const MODAL_POLL_MS      = 500;      // interval between modal search attempts
const MODAL_TIMEOUT_MS   = 10_000;   // total time to wait for modal before giving up
const INTER_LEAD_DELAY   = 5_000;    // ms between processing consecutive leads
const MAX_RETRIES        = 2;

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
let queue        = [];
let isProcessing = false;

// ─── Storage helpers ──────────────────────────────────────────────────────────
async function loadState() {
  return new Promise(resolve => {
    chrome.storage.local.get(
      ['enabled', 'threshold', 'interval', 'stats', 'processedIds', 'mobile', 'password'],
      data => {
        cfg.enabled   = data.enabled   ?? false;
        cfg.threshold = data.threshold ?? 500;
        cfg.interval  = data.interval  ?? 5;
        cfg.mobile    = data.mobile    ?? '';
        cfg.password  = data.password  ?? '';
        stats         = data.stats     ?? { scanned: 0, matched: 0, clicked: 0 };
        processedIds  = new Set(data.processedIds || []);
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

  const leads = await fetchLeads();
  if (!leads) {
    notify('❌ Server not reachable', 'Start scraper_loop.py in the terminal');
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
 * Accepts lead metadata (location, displayId) so it can match the right
 * buyer card instead of blindly clicking the first result.
 *
 * Injected into the lead tab via chrome.scripting.executeScript.
 */
function injectedClickPhase1(leadLocation, leadDisplayId) {
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

  const locLower = (leadLocation || '').toLowerCase().replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
  // Extract city and state parts for flexible matching
  const locParts = locLower.split(' ').filter(p => p.length > 2);

  /**
   * Find the contact button within a given listing card element.
   */
  function findContactBtn(container) {
    // Check for IndiaMART-specific class first
    for (const btn of container.querySelectorAll('.TRA_contact_buyer')) {
      if (isVisible(btn)) return btn;
    }
    // Look for buttons/links with contact text
    const CONTACT_TEXTS = [
      'contact buyer now', 'contact buyer', 'buy lead', 'contact now',
      'send enquiry', 'enquire now',
    ];
    const btns = container.querySelectorAll(
      'button, a, div, span, input[type=button], input[type=submit], [role=button]'
    );
    for (const btn of btns) {
      if (!isVisible(btn)) continue;
      const t = getNormText(btn);
      if (CONTACT_TEXTS.some(ct => t.includes(ct))) return btn;
    }
    return null;
  }

  /**
   * Check if a listing card's text content matches our target location.
   */
  function cardMatchesLocation(card) {
    if (!locParts.length) return false;
    const cardText = card.textContent.toLowerCase();
    // All significant parts of the location must appear in the card
    return locParts.every(part => cardText.includes(part));
  }

  /**
   * Check if a card contains the displayId (in data attributes or hidden text).
   */
  function cardMatchesDisplayId(card) {
    if (!leadDisplayId) return false;
    // Check data attributes
    for (const attr of card.attributes) {
      if (String(attr.value).includes(leadDisplayId)) return true;
    }
    // Check inner elements with data attributes
    const inner = card.querySelectorAll('[data-id], [data-blid], [data-displayid], [data-leadid]');
    for (const el of inner) {
      for (const attr of el.attributes) {
        if (String(attr.value).includes(leadDisplayId)) return true;
      }
    }
    return false;
  }

  // ── Collect all listing cards on the page ──────────────────────────────────
  // IndiaMART uses various card containers; try common patterns
  const CARD_SELECTORS = [
    '.brd_card', '.card', '.listing', '.result-card',
    '[class*="listing"]', '[class*="result"]', '[class*="card"]',
    '.TRA_blCard', '.TRA_card',
    'li[class*="bl"]', 'div[class*="bl_"]',
  ];

  let cards = [];
  for (const sel of CARD_SELECTORS) {
    try {
      const found = document.querySelectorAll(sel);
      if (found.length > 0) {
        cards = [...found].filter(c => findContactBtn(c) !== null);
        if (cards.length > 0) break;
      }
    } catch (_) {}
  }

  console.log(`[injected] Found ${cards.length} listing cards with contact buttons`);
  console.log(`[injected] Looking for location: "${locLower}", displayId: "${leadDisplayId}"`);

  // ── Strategy 1: Match by displayId (most precise) ─────────────────────────
  if (leadDisplayId) {
    for (const card of cards) {
      if (cardMatchesDisplayId(card)) {
        const btn = findContactBtn(card);
        if (btn) {
          btn.click();
          return { ok: true, phase: 1, matched: 'displayId', displayId: leadDisplayId };
        }
      }
    }
  }

  // ── Strategy 2: Match by location text in the card ────────────────────────
  if (locParts.length > 0) {
    for (const card of cards) {
      if (cardMatchesLocation(card)) {
        const btn = findContactBtn(card);
        if (btn) {
          btn.click();
          const cardSnippet = card.textContent.trim().slice(0, 100);
          return { ok: true, phase: 1, matched: 'location', location: leadLocation, cardSnippet };
        }
      }
    }
  }

  // ── Strategy 3: If search was specific enough, take the first result ──────
  // Only if we have cards but location matching failed (search already narrowed)
  if (cards.length > 0 && cards.length <= 3) {
    const btn = findContactBtn(cards[0]);
    if (btn) {
      btn.click();
      const cardSnippet = cards[0].textContent.trim().slice(0, 100);
      return { ok: true, phase: 1, matched: 'first-of-few', cardCount: cards.length, cardSnippet };
    }
  }

  // ── Fallback: find ANY visible contact button on the page ─────────────────
  // (original approach — only if card-based approach found nothing)
  for (const el of document.querySelectorAll('.TRA_contact_buyer')) {
    if (!isVisible(el)) continue;
    el.click();
    return { ok: true, phase: 1, matched: 'TRA_contact_buyer_fallback', text: el.textContent.trim() };
  }

  const allEls = [
    ...document.querySelectorAll(
      'button, a, div, span, input[type=button], input[type=submit], [role=button]'
    )
  ];
  for (const el of allEls) {
    if (getNormText(el) !== 'contact buyer now') continue;
    if (!isVisible(el)) continue;
    el.click();
    return { ok: true, phase: 1, matched: 'exact-text-fallback', text: el.textContent.trim() };
  }

  // Debug: dump card info + first 20 clickable elements
  const cardInfo = cards.slice(0, 5).map(c => c.textContent.trim().slice(0, 80));
  const found = allEls.slice(0, 20).map(el =>
    `[${el.tagName}.${el.className}] "${(el.textContent || el.value || '').trim().slice(0, 40)}"`
  );
  return { ok: false, reason: 'contact_button_not_found', cardInfo, pageButtons: found };
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

async function processOneLead(lead, attempt = 1) {
  // Build search URL based on attempt:
  //   Attempt 1: product + full location (e.g. "Cashew Husk Kamrup, Assam")
  //   Attempt 2: product + state only  (e.g. "Cashew Husk Assam") — broader search
  let searchQuery;
  if (attempt <= 1) {
    searchQuery = `${lead.product} ${lead.location || ''}`;
  } else {
    // Fallback: use product + state (drop district/city for broader results)
    searchQuery = `${lead.product} ${lead.state || ''}`;
  }
  const url = `https://trade.indiamart.com/buyersearch.mp?ss=${encodeURIComponent(searchQuery.trim())}`;

  console.log(`[bg] Processing "${lead.product}" @ ${lead.location} (attempt ${attempt}, search: "${searchQuery.trim()}")`);

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
      notify('🔐 Login required', p0res?.hint || 'Set your IndiaMART credentials in the popup');
      return { ok: false, reason: p0res?.reason };
    }

    if (p0res?.loggedIn) {
      console.log('[bg] Login submitted — waiting for redirect…');
      await sleep(5000);
      if (!await tabExists(tabId)) {
        tabId = null;
        return { ok: false, reason: 'tab_closed_after_login' };
      }
    }

    // ── Phase 1: click "Contact Buyer Now" for the matching dealer ───────────
    const [p1] = await chrome.scripting.executeScript({
      target: { tabId },
      func:   injectedClickPhase1,
      args:   [lead.location || '', lead.displayId || ''],
    });
    const p1res = p1?.result;
    console.log(`[bg] Phase-1 result:`, p1res);

    if (!p1res?.ok) {
      console.warn(`[bg] Phase-1 failed (attempt ${attempt}). Cards:`, p1res?.cardInfo, 'Buttons:', p1res?.pageButtons);

      // Close this tab before retrying with broader search
      await closeTab(tabId); tabId = null;

      if (attempt < MAX_RETRIES) {
        console.log(`[bg] Retrying with broader search (product + state)…`);
        await sleep(3000);
        return processOneLead(lead, attempt + 1);
      }
      notify('⚠️ Button not found', `${lead.product} @ ${lead.location}: could not find the correct dealer`);
      return { ok: false, reason: p1res?.reason };
    }

    // ── Phase 1 click = success ──────────────────────────────────────────────
    console.log(`[bg] ✅ Clicked via strategy: ${p1res.matched} (attempt ${attempt})`);
    stats.clicked++;
    saveStats();
    notify(
      '✅ Contacted!',
      `${lead.product}\n${lead.location} · ${lead.rawQty}`
    );
    await sleep(1000);
    return { ok: true };

  } catch (e) {
    // Gracefully handle tab-already-closed errors without retrying
    if (e.message && e.message.includes('No tab with id')) {
      console.warn(`[bg] Tab vanished mid-process for "${lead.product}" — skipping retry`);
      return { ok: false, reason: 'tab_vanished' };
    }
    console.error(`[bg] Error processing ${lead.id}:`, e.message);
    if (attempt < MAX_RETRIES) {
      await sleep(3000);
      return processOneLead(lead, attempt + 1);
    }
    return { ok: false, reason: e.message };
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
      });
      break;

    case 'GET_QUEUE_STATUS':
      sendResponse({ queueLength: queue.length, isProcessing });
      break;

    case 'CLEAR_ALL':
      processedIds = new Set();
      stats        = { scanned: 0, matched: 0, clicked: 0 };
      queue        = [];
      chrome.storage.local.set({ processedIds: [], stats, clicked: 0 });
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
