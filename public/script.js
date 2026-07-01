// ─── DOM Elements ────────────────────────────────────────────────────────────
const urlInput = document.getElementById('urlInput');
const languageSelect = document.getElementById('languageSelect');
const startBtn = document.getElementById('startBtn');
const statusBadge = document.getElementById('statusBadge');
const recordingBanner = document.getElementById('recordingBanner');
const controlsSection = document.getElementById('controlsSection');
const resultsSection = document.getElementById('resultsSection');
const stepsContainer = document.getElementById('stepsContainer');
const codeOutput = document.getElementById('codeOutput');
const copyCodeBtn = document.getElementById('copyCodeBtn');
const newRecordingBtn = document.getElementById('newRecordingBtn');
const testNameInput = document.getElementById('testNameInput');
const saveTestBtn = document.getElementById('saveTestBtn');
const savedTestsList = document.getElementById('savedTestsList');
const refreshTestsBtn = document.getElementById('refreshTestsBtn');
const toastContainer = document.getElementById('toastContainer');
const detailModal = document.getElementById('detailModal');
const modalTitle = document.getElementById('modalTitle');
const modalBody = document.getElementById('modalBody');
const closeModalBtn = document.getElementById('closeModalBtn');

// ─── State ───────────────────────────────────────────────────────────────────
let pollingInterval = null;
let currentResult = null;

// ─── Helpers ─────────────────────────────────────────────────────────────────
function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;

  const icons = {
    success: '✓',
    error: '✕',
    info: 'ℹ',
  };

  toast.innerHTML = `<span>${icons[type] || 'ℹ'}</span><span>${message}</span>`;
  toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('toast-out');
    setTimeout(() => toast.remove(), 250);
  }, 3500);
}

function setStatusBadge(status) {
  const badge = statusBadge;
  badge.className = 'status-badge';

  switch (status) {
    case 'recording':
      badge.classList.add('status-recording');
      badge.querySelector('.status-text').textContent = 'Recording';
      break;
    case 'completed':
      badge.classList.add('status-completed');
      badge.querySelector('.status-text').textContent = 'Completed';
      break;
    default:
      badge.classList.add('status-idle');
      badge.querySelector('.status-text').textContent = 'Idle';
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ─── Recording ───────────────────────────────────────────────────────────────
async function startRecording() {
  const url = (urlInput && urlInput.value) ? urlInput.value.trim() : '';
  const language = languageSelect.value;

  try {
    startBtn.disabled = true;
    startBtn.innerHTML = `
      <svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/></svg>
      Starting…
    `;

    const res = await fetch('/api/record/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, language }),
    });

    const data = await res.json();

    if (!data.success) {
      showToast(data.message, 'error');
      resetStartButton();
      return;
    }

    showToast('Recording started! A browser window should open.', 'success');
    setStatusBadge('recording');
    recordingBanner.classList.remove('hidden');
    resultsSection.classList.add('hidden');
    startBtn.disabled = true;
    startBtn.innerHTML = `
      <svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/></svg>
      Recording…
    `;

    startPolling();
  } catch (err) {
    showToast(`Failed to start: ${err.message}`, 'error');
    resetStartButton();
  }
}

function resetStartButton() {
  startBtn.disabled = false;
  startBtn.innerHTML = `
    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke-width="2"/><circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/></svg>
    Start Recording
  `;
}

function startPolling() {
  if (pollingInterval) clearInterval(pollingInterval);

  pollingInterval = setInterval(async () => {
    try {
      const res = await fetch('/api/record/status');
      const data = await res.json();

      if (data.status === 'completed') {
        stopPolling();
        onRecordingComplete(data);
      } else if (data.status === 'error') {
        stopPolling();
        onRecordingError(data);
      }
      // If 'recording', keep polling
    } catch (err) {
      console.error('Polling error:', err);
    }
  }, 1500);
}

function stopPolling() {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
}

function onRecordingComplete(data) {
  recordingBanner.classList.add('hidden');
  setStatusBadge('completed');
  resetStartButton();

  currentResult = data.data;

  // Render steps
  renderSteps(currentResult.steps);

  // Render code
  codeOutput.textContent = currentResult.code;

  // Show results
  resultsSection.classList.remove('hidden');
  resultsSection.classList.add('fade-in');

  showToast('Recording completed! Your test is ready.', 'success');
}

function onRecordingError(data) {
  recordingBanner.classList.add('hidden');
  setStatusBadge('idle');
  resetStartButton();
  showToast(data.message || 'Recording failed.', 'error');
}

function renderSteps(steps) {
  if (!steps || steps.length === 0) {
    stepsContainer.innerHTML = `
      <div class="text-center py-8 text-surface-500 text-sm">
        No actions were detected during the recording.
      </div>
    `;
    return;
  }

  stepsContainer.innerHTML = steps
    .map(
      (s) => `
    <div class="step-item">
      <div class="step-number">${s.step}</div>
      <div class="step-description">${escapeHtml(s.description)}</div>
    </div>
  `
    )
    .join('');
}

// ─── Copy Code ───────────────────────────────────────────────────────────────
async function copyCode() {
  if (!currentResult || !currentResult.code) return;

  try {
    await navigator.clipboard.writeText(currentResult.code);
    showToast('Code copied to clipboard!', 'success');
  } catch (err) {
    // Fallback
    const textarea = document.createElement('textarea');
    textarea.value = currentResult.code;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
    showToast('Code copied to clipboard!', 'success');
  }
}

// ─── New Recording ───────────────────────────────────────────────────────────
function newRecording() {
  resultsSection.classList.add('hidden');
  setStatusBadge('idle');
  currentResult = null;
  urlInput.value = '';
  testNameInput.value = '';
  urlInput.focus();
}

// ─── Save Test ───────────────────────────────────────────────────────────────
async function saveTest() {
  if (!currentResult) {
    showToast('No recording result to save.', 'error');
    return;
  }

  const name = testNameInput.value.trim();
  if (!name) {
    showToast('Please enter a test name before saving.', 'error');
    testNameInput.focus();
    return;
  }

  try {
    saveTestBtn.disabled = true;

    const res = await fetch('/api/test-cases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        url: currentResult.url,
        language: currentResult.language,
        code: currentResult.code,
        steps: currentResult.steps,
      }),
    });

    const data = await res.json();

    if (data.success) {
      showToast(`Test "${name}" saved to database!`, 'success');
      testNameInput.value = '';
      loadSavedTests();
    } else {
      showToast(data.message || 'Failed to save test.', 'error');
    }
  } catch (err) {
    showToast(`Failed to save: ${err.message}`, 'error');
  } finally {
    saveTestBtn.disabled = false;
  }
}

// ─── Load Saved Tests ────────────────────────────────────────────────────────
async function loadSavedTests() {
  try {
    const res = await fetch('/api/test-cases');
    const data = await res.json();

    if (!data.success || !data.testCases || data.testCases.length === 0) {
      savedTestsList.innerHTML = `
        <div class="text-center py-12 text-surface-500 text-sm">
          <svg class="w-10 h-10 mx-auto mb-3 text-surface-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"/></svg>
          No saved test cases yet. Record a test and save it!
        </div>
      `;
      return;
    }

    savedTestsList.innerHTML = data.testCases
      .map((tc) => {
        const date = new Date(tc.created_at).toLocaleString();
        const stepsCount = Array.isArray(tc.steps) ? tc.steps.length : 0;
        return `
        <div class="saved-test-card fade-in">
          <div class="flex items-center gap-4 flex-1 min-w-0">
            <div class="w-9 h-9 rounded-lg bg-gradient-to-br from-accent-500/20 to-accent-600/10 flex items-center justify-center flex-shrink-0">
              <span class="text-accent-400 text-sm font-bold">#${tc.id}</span>
            </div>
            <div class="min-w-0">
              <div class="font-semibold text-sm text-surface-100 truncate">${escapeHtml(tc.name)}</div>
              <div class="flex items-center gap-3 mt-1">
                <span class="text-xs text-surface-500 truncate max-w-[200px]">${escapeHtml(tc.url || '—')}</span>
                <span class="lang-badge">${escapeHtml(tc.language)}</span>
                <span class="text-xs text-surface-500">${stepsCount} steps</span>
              </div>
            </div>
          </div>
          <div class="flex items-center gap-2 flex-shrink-0 ml-4">
            <span class="text-xs text-surface-500 hidden sm:block">${date}</span>
            <button onclick="runTest(${tc.id}, '${escapeHtml(tc.name).replace(/'/g, "\\'")}')" id="runBtn-${tc.id}" class="btn-run text-xs py-1.5 px-3">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
              Run
            </button>
            <button onclick="viewTestDetail(${tc.id})" class="btn-secondary text-xs py-1.5 px-3">View</button>
            <button onclick="deleteTest(${tc.id}, '${escapeHtml(tc.name).replace(/'/g, "\\'")}')" class="btn-danger text-xs py-1.5 px-2">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
            </button>
          </div>
        </div>
      `;
      })
      .join('');
  } catch (err) {
    savedTestsList.innerHTML = `
      <div class="text-center py-8 text-surface-500 text-sm">
        ⚠️ Could not load tests. Is the database running?
      </div>
    `;
  }
}

// ─── View Test Detail ────────────────────────────────────────────────────────
async function viewTestDetail(id) {
  try {
    const res = await fetch('/api/test-cases');
    const data = await res.json();

    if (!data.success) return;

    const tc = data.testCases.find((t) => t.id === id);
    if (!tc) return;

    modalTitle.textContent = tc.name;

    const steps = Array.isArray(tc.steps) ? tc.steps : [];

    modalBody.innerHTML = `
      <div>
        <h4 class="text-xs font-semibold uppercase tracking-wider text-surface-400 mb-3 flex items-center gap-2">
          <svg class="w-3.5 h-3.5 text-accent-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/></svg>
          Test Steps (${steps.length})
        </h4>
        <div class="space-y-2 max-h-[400px] overflow-y-auto custom-scrollbar">
          ${
            steps.length > 0
              ? steps
                  .map(
                    (s) => `
                <div class="step-item">
                  <div class="step-number">${s.step}</div>
                  <div class="step-description">${escapeHtml(s.description)}</div>
                </div>
              `
                  )
                  .join('')
              : '<p class="text-surface-500 text-sm">No steps recorded.</p>'
          }
        </div>
      </div>
      <div>
        <div class="flex items-center justify-between mb-3">
          <h4 class="text-xs font-semibold uppercase tracking-wider text-surface-400 flex items-center gap-2">
            <svg class="w-3.5 h-3.5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"/></svg>
            Code
          </h4>
          <button onclick="copyModalCode()" class="btn-secondary text-xs py-1 px-2.5">
            <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2" stroke-width="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" stroke-width="2"/></svg>
            Copy
          </button>
        </div>
        <pre class="code-block max-h-[400px] overflow-y-auto custom-scrollbar"><code id="modalCodeOutput" class="text-sm font-mono">${escapeHtml(tc.code)}</code></pre>
      </div>
    `;

    // Store code for copy
    detailModal._code = tc.code;
    detailModal.classList.remove('hidden');
  } catch (err) {
    showToast('Failed to load test details.', 'error');
  }
}

async function copyModalCode() {
  const code = detailModal._code;
  if (!code) return;
  try {
    await navigator.clipboard.writeText(code);
    showToast('Code copied!', 'success');
  } catch {
    showToast('Failed to copy.', 'error');
  }
}

function closeModal() {
  detailModal.classList.add('hidden');
}

// ─── Delete Test ─────────────────────────────────────────────────────────────
async function deleteTest(id, name) {
  if (!confirm(`Delete test "${name}"?`)) return;

  try {
    const res = await fetch(`/api/test-cases/${id}`, { method: 'DELETE' });
    const data = await res.json();

    if (data.success) {
      showToast(`Test "${name}" deleted.`, 'info');
      loadSavedTests();
    } else {
      showToast(data.message || 'Failed to delete.', 'error');
    }
  } catch (err) {
    showToast(`Failed to delete: ${err.message}`, 'error');
  }
}

// ─── Run Test ────────────────────────────────────────────────────────────────
let runPollingInterval = null;
let currentReportWindow = null;

async function runTest(id, name) {
  const btn = document.getElementById(`runBtn-${id}`);
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `
      <svg class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/></svg>
      Running…
    `;
  }

  // Remove old report button if exists
  const oldReportBtn = document.getElementById(`reportBtn-${id}`);
  if (oldReportBtn) oldReportBtn.remove();

  // Open the window synchronously on click to bypass popup blockers
  try {
    currentReportWindow = window.open('about:blank', '_blank');
    if (currentReportWindow) {
      currentReportWindow.document.write(`
        <!DOCTYPE html>
        <html>
          <head>
            <title>Running Test: ${name}...</title>
            <style>
              body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
              .container { text-align: center; padding: 2rem; background: #1e293b; border-radius: 1rem; border: 1px solid #334155; box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.3); max-width: 450px; }
              .spinner { width: 40px; height: 40px; border: 4px solid #3b82f6; border-top-color: transparent; border-radius: 50%; animation: spin 1s linear infinite; margin: 0 auto 1.5rem; }
              @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
              h2 { font-size: 1.25rem; margin: 0 0 0.5rem; font-weight: 600; }
              p { color: #94a3b8; font-size: 0.875rem; margin: 0; line-height: 1.5; }
            </style>
          </head>
          <body>
            <div class="container">
              <div class="spinner"></div>
              <h2>Running Test "${name}"...</h2>
              <p>Please wait while Playwright executes the test steps. This window will automatically display the HTML report as soon as it completes.</p>
            </div>
          </body>
        </html>
      `);
    }
  } catch (e) {
    console.warn('Could not open initial report popup:', e);
  }

  try {
    const res = await fetch(`/api/test-cases/${id}/run`, { method: 'POST' });
    const data = await res.json();

    if (!data.success) {
      showToast(data.message, 'error');
      resetRunBtn(id);
      if (currentReportWindow && !currentReportWindow.closed) {
        currentReportWindow.close();
      }
      return;
    }

    showToast(`Running test "${name}"…`, 'info');
    startRunPolling(id);
  } catch (err) {
    showToast(`Failed to run: ${err.message}`, 'error');
    resetRunBtn(id);
    if (currentReportWindow && !currentReportWindow.closed) {
      currentReportWindow.close();
    }
  }
}

function startRunPolling(testId) {
  if (runPollingInterval) clearInterval(runPollingInterval);

  runPollingInterval = setInterval(async () => {
    try {
      const res = await fetch('/api/test-cases/run-status');
      const data = await res.json();

      if (data.status === 'completed') {
        clearInterval(runPollingInterval);
        runPollingInterval = null;
        resetRunBtn(testId);

        if (data.reportUrl) {
          showToast('Test finished! Opening report…', 'success');
          
          // Navigate existing window or open new one
          if (currentReportWindow && !currentReportWindow.closed) {
            currentReportWindow.location.href = data.reportUrl;
          } else {
            window.open(data.reportUrl, '_blank');
          }

          // Add a direct Report link button next to Run
          addReportBtn(testId, data.reportUrl);
        } else {
          showToast('Test finished but no report was generated.', 'info');
          if (currentReportWindow && !currentReportWindow.closed) {
            currentReportWindow.close();
          }
        }
      } else if (data.status === 'error') {
        clearInterval(runPollingInterval);
        runPollingInterval = null;
        resetRunBtn(testId);
        showToast('Test run encountered an error.', 'error');
        if (currentReportWindow && !currentReportWindow.closed) {
          currentReportWindow.document.body.innerHTML = `
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #ef4444; display: flex; align-items: center; justify-content: center; height: 100vh; text-align: center; margin:0;">
              <div style="padding: 2rem; background: #1e293b; border-radius: 1rem; border: 1px solid #ef4444/30;"><h2 style="margin:0 0 0.5rem; color:#f87171;">❌ Test Run Failed</h2><p style="color:#94a3b8; margin:0;">Check terminal logs for details.</p></div>
            </div>
          `;
        }
      }
    } catch (err) {
      console.error('Run polling error:', err);
    }
  }, 1500);
}

function addReportBtn(testId, reportUrl) {
  const runBtn = document.getElementById(`runBtn-${testId}`);
  if (runBtn && runBtn.parentNode && !document.getElementById(`reportBtn-${testId}`)) {
    const reportBtn = document.createElement('a');
    reportBtn.id = `reportBtn-${testId}`;
    reportBtn.href = reportUrl;
    reportBtn.target = '_blank';
    reportBtn.className = 'btn-secondary text-xs py-1.5 px-3 flex items-center gap-1.5 bg-accent-500/10 text-accent-400 border border-accent-500/20 hover:bg-accent-500/20';
    reportBtn.innerHTML = `
      <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>
      Report
    `;
    runBtn.parentNode.insertBefore(reportBtn, runBtn.nextSibling);
  }
}

function resetRunBtn(id) {
  const btn = document.getElementById(`runBtn-${id}`);
  if (btn) {
    btn.disabled = false;
    btn.innerHTML = `
      <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
      Run
    `;
  }
}

// ─── Event Listeners ─────────────────────────────────────────────────────────
startBtn.addEventListener('click', startRecording);
copyCodeBtn.addEventListener('click', copyCode);
newRecordingBtn.addEventListener('click', newRecording);
saveTestBtn.addEventListener('click', saveTest);
refreshTestsBtn.addEventListener('click', loadSavedTests);
closeModalBtn.addEventListener('click', closeModal);

detailModal.addEventListener('click', (e) => {
  if (e.target === detailModal) closeModal();
});

// Enter key on URL input
if (urlInput) {
  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') startRecording();
  });
}

async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    const data = await res.json();
    if (data.success && data.config.targetUrl) {
      if (urlInput) urlInput.value = data.config.targetUrl;
      const display = document.getElementById('configUrlDisplay');
      if (display) display.textContent = data.config.targetUrl;
    }
  } catch (e) {
    console.warn('Failed to load config:', e);
  }
}

// ─── Init ────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadConfig();
  loadSavedTests();
});
