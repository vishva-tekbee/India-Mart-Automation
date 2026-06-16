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
const serverUpdated   = document.getElementById('serverUpdated');

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

// ── Server health check ───────────────────────────────────────────────────────
async function checkServer() {
  try {
    const r = await fetch(`${LOCAL_SERVER}/status`, {
      cache:  'no-store',
      signal: AbortSignal.timeout(3000),
    });
    const d = await r.json();
    serverDot.className      = 'dot dot-on';
    serverStatus.textContent  = '✅ Running';
    serverLeads.textContent   = d.lead_count ?? '—';
    serverUpdated.textContent = d.last_updated
      ? new Date(d.last_updated).toLocaleTimeString()
      : '—';
    // Update "All Leads" stat with total raw count from server
    if (d.total_raw != null) {
      statScanned.textContent = d.total_raw;
    }
    return true;
  } catch {
    serverDot.className      = 'dot dot-off';
    serverStatus.textContent  = '❌ Not running';
    serverLeads.textContent   = '—';
    serverUpdated.textContent = '—';
    return false;
  }
}

// ── Refresh all ───────────────────────────────────────────────────────────────
async function refreshAll() {
  await checkServer();
  const r = await bg({ type: 'GET_STATUS' });
  if (r) {
    setStatusUI(r.cfg?.enabled ?? false);
    updateStatsUI(r.stats);
    updateQueueUI(r.queueLength, r.isProcessing);
    if (r.cfg) {
      // Settings are now managed server-side by the scraper
    }
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

  const serverOk = await checkServer();
  if (!serverOk) {
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
  showAlert('🗑️ History cleared', 'success');
});

// ── Init ──────────────────────────────────────────────────────────────────────
(async () => {
  await checkServer();
  await refreshAll();

  // Auto-refresh every 10 seconds while popup is open
  setInterval(async () => {
    await checkServer();
  }, 10_000);
})();
