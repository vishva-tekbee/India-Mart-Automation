/**
 * IndiaMART Lead Auto-Contact — popup.js (v4)
 * Talks ONLY to background.js — no content script dependency.
 */

'use strict';

const LOCAL_SERVER = 'http://127.0.0.1:8000';

// ── DOM refs ──────────────────────────────────────────────────────────────────
const enableToggle    = document.getElementById('enableToggle');
const statusBadge     = document.getElementById('statusBadge');
const automationDesc  = document.getElementById('automationDesc');

const runNowBtn       = document.getElementById('runNowBtn');
const refreshBtn      = document.getElementById('refreshBtn');
const clearBtn        = document.getElementById('clearBtn');
const alertBox        = document.getElementById('alertBox');
const statScanned     = document.getElementById('statScanned');
const statMatched     = document.getElementById('statMatched');
const statClicked     = document.getElementById('statClicked');
const queueLength     = document.getElementById('queueLength');
const isProcessingEl  = document.getElementById('isProcessing');
const serverDot       = document.getElementById('serverDot');
const serverStatus    = document.getElementById('serverStatus');
const serverLeads     = document.getElementById('serverLeads');
const serverTotalLeads = document.getElementById('serverTotalLeads');
const serverUpdated   = document.getElementById('serverUpdated');
const statExpired     = document.getElementById('statExpired');
const expiredSection  = document.getElementById('expiredSection');
const expiredToggle   = document.getElementById('expiredToggle');
const expiredCount    = document.getElementById('expiredCount');
const expiredList     = document.getElementById('expiredList');
const expandArrow     = document.getElementById('expandArrow');

// ── Alert ─────────────────────────────────────────────────────────────────────
let alertTimer = null;
function showAlert(msg, type = 'info', ms = 4000) {
  alertBox.textContent = msg;
  alertBox.className   = `alert ${type}`;
  clearTimeout(alertTimer);
  alertTimer = setTimeout(() => { alertBox.className = 'alert hidden'; }, ms);
}

// ── Status UI ─────────────────────────────────────────────────────────────────
function setStatusUI(enabled) {
  enableToggle.checked       = enabled;
  statusBadge.textContent    = enabled ? 'ON' : 'OFF';
  statusBadge.className      = `status-badge ${enabled ? 'status-on' : 'status-off'}`;
  automationDesc.textContent = enabled ? 'Monitoring active' : 'Click to enable';
}

function updateStatsUI(s = {}) {
  statScanned.textContent = s.scanned  ?? 0;
  statMatched.textContent = s.matched  ?? 0;
  statClicked.textContent = s.clicked  ?? 0;
}

function updateQueueUI(qLen, proc) {
  queueLength.textContent    = qLen ?? 0;
  isProcessingEl.textContent = proc ? 'Yes ⏳' : 'No';
}

function formatReasonLabel(reason) {
  switch (reason) {
    case 'no_search_results':                return 'No search results';
    case 'no_strict_match':                  return 'No matching cards';
    case 'no_contact_buttons_found':         return 'No contact buttons';
    case 'no_contact_button_on_detail_page': return 'No button on detail page';
    case 'lead_expired':                     return 'Lead expired / Inactive';
    case 'redirected_away_from_lead_page':   return 'Redirected away';
    case 'product_mismatch_on_detail_page':  return 'Product mismatch';
    case 'location_mismatch_on_detail_page': return 'Location mismatch';
    case 'tab_vanished':                     return 'Tab closed / vanished';
    case 'tab_closed_before_phase1':         return 'Tab closed early';
    case 'tab_closed_after_login':           return 'Tab closed after login';
    case 'login_failed':                     return 'Login failed';
    case 'no_credentials':                   return 'No credentials set';
    case 'all_attempts_exhausted':           return 'All attempts failed';
    default:                                 return reason || 'Unknown';
  }
}

function updateExpiredUI(expired = []) {
  statExpired.textContent = expired.length;
  expiredCount.textContent = expired.length;

  if (expired.length === 0) {
    expiredSection.classList.add('hidden');
    return;
  }

  expiredSection.classList.remove('hidden');

  // Render items (most recent first)
  const sorted = [...expired].reverse();
  expiredList.innerHTML = sorted.map(lead => {
    const time = lead.timestamp
      ? new Date(lead.timestamp).toLocaleString(undefined, {
          month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
        })
      : '—';
    return `
      <div class="expired-item">
        <span class="expired-item-product">${escapeHtml(lead.product)}</span>
        <span class="expired-item-location">📍 ${escapeHtml(lead.location)}${lead.quantity ? ' · ' + escapeHtml(lead.quantity) : ''}</span>
        <div class="expired-item-meta">
          <span class="expired-item-reason">${formatReasonLabel(lead.reason)}</span>
          <span class="expired-item-time">${time}</span>
        </div>
      </div>
    `;
  }).join('');
}

function escapeHtml(str) {
  if (!str) return '';
  const decoded = str
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
  return decoded.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Talk to background ONLY ───────────────────────────────────────────────────
function bg(msg) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage(msg, resp => {
      if (chrome.runtime.lastError) {
        console.warn('[popup] bg error:', chrome.runtime.lastError.message);
        resolve(null);
      } else {
        resolve(resp);
      }
    });
  });
}

// ── Server health check (returns data, does NOT touch stats DOM) ──────────────
async function checkServer() {
  try {
    const r = await fetch(`${LOCAL_SERVER}/status`, {
      cache:  'no-store',
      signal: AbortSignal.timeout(3000),
    });
    const d = await r.json();
    serverDot.className       = 'dot dot-on';
    serverStatus.textContent  = '✅ Running';
    serverLeads.textContent   = d.lead_count ?? '—';
    serverTotalLeads.textContent = d.total_lead_count ?? '—';
    serverUpdated.textContent = d.last_updated
      ? new Date(d.last_updated).toLocaleTimeString()
      : '—';
    return { ok: true, data: d };
  } catch {
    serverDot.className       = 'dot dot-off';
    serverStatus.textContent  = '❌ Not running';
    serverLeads.textContent   = '—';
    serverTotalLeads.textContent = '—';
    serverUpdated.textContent = '—';
    return { ok: false, data: null };
  }
}

// ── Refresh all (single atomic DOM update — no 0-flash) ───────────────────────
async function refreshAll() {
  // Fetch both data sources in parallel
  const [serverResult, bgResult] = await Promise.all([
    checkServer(),
    bg({ type: 'GET_STATUS' }),
  ]);

  if (bgResult) {
    setStatusUI(bgResult.cfg?.enabled ?? false);

    // Merge stats: use background stats as base, override "All Leads" with
    // server's total_raw if available (server is the source of truth for this)
    const mergedStats = { ...(bgResult.stats || {}) };
    if (serverResult.ok && serverResult.data?.total_raw != null) {
      mergedStats.scanned = serverResult.data.total_raw;
    }
    updateStatsUI(mergedStats);

    updateQueueUI(bgResult.queueLength, bgResult.isProcessing);
    updateExpiredUI(bgResult.expiredLeads || []);
  }
}

// ── Event handlers ────────────────────────────────────────────────────────────

enableToggle.addEventListener('change', async () => {
  const enabled = enableToggle.checked;

  const r = await bg({ type: 'SET_SETTINGS', enabled });
  setStatusUI(enabled);
  showAlert(
    enabled ? '✅ Automation enabled' : '⏹ Automation disabled',
    enabled ? 'success' : 'info'
  );
});



runNowBtn.addEventListener('click', async () => {
  runNowBtn.disabled    = true;
  runNowBtn.textContent = '⏳ Running…';

  const serverCheck = await checkServer();
  if (!serverCheck.ok) {
    showAlert('❌ API server not running!\nRun: uvicorn api.main:app --port 8000', 'error', 6000);
    runNowBtn.disabled    = false;
    runNowBtn.textContent = '⚡ Run Now';
    return;
  }

  showAlert('⏳ Fetching leads from server…', 'info', 8000);
  const r = await bg({ type: 'RUN_NOW' });

  if (r?.ok) {
    const matched = r.result?.matched ?? 0;
    showAlert(
      matched > 0
        ? `✅ ${matched} lead(s) queued — opening tabs to contact buyers`
        : '✅ Cycle complete — no new qualifying leads found',
      'success', 5000
    );
    setTimeout(refreshAll, 1500);
  } else {
    showAlert('⚠️ Cycle failed — check console for details', 'error');
  }

  setTimeout(() => {
    runNowBtn.disabled    = false;
    runNowBtn.textContent = '⚡ Run Now';
  }, 5000);
});

refreshBtn.addEventListener('click', async () => {
  await refreshAll();
  showAlert('Refreshed.', 'info', 1500);
});

clearBtn.addEventListener('click', async () => {
  if (!confirm('Clear all processed lead history and reset stats?')) return;
  await bg({ type: 'CLEAR_ALL' });
  updateStatsUI({ scanned: 0, matched: 0, clicked: 0 });
  updateQueueUI(0, false);
  updateExpiredUI([]);
  showAlert('🗑️ History cleared', 'success');
});

// ── Expired leads toggle ──────────────────────────────────────────────────────
expiredToggle.addEventListener('click', () => {
  const isOpen = !expiredList.classList.contains('hidden');
  if (isOpen) {
    expiredList.classList.add('hidden');
    expandArrow.classList.remove('open');
  } else {
    expiredList.classList.remove('hidden');
    expandArrow.classList.add('open');
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────
(async () => {
  await refreshAll();

  // Auto-refresh every 10 seconds while popup is open
  setInterval(refreshAll, 10_000);
})();
