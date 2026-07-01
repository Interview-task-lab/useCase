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
let currentPlatform = 'web'; // 'web', 'android', 'ios'

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
  const language = currentPlatform === 'web' ? languageSelect.value : 'yaml';
  const appPath = document.getElementById('mobileAppInput') ? document.getElementById('mobileAppInput').value.trim() : '';
  const deviceName = document.getElementById('mobileDeviceInput') ? document.getElementById('mobileDeviceInput').value.trim() : '';

  try {
    const btn = currentPlatform === 'web' ? startBtn : document.getElementById('startMobileBtn');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `
        <svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/></svg>
        Starting ${currentPlatform.toUpperCase()}…
      `;
    }

    const res = await fetch('/api/record/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, language, platform: currentPlatform, appPath, deviceName }),
    });

    const data = await res.json();

    if (!data.success) {
      showToast(data.message, 'error');
      resetStartButton();
      return;
    }

    if (data.mode === 'mobile-live') {
      showToast(`📱 Live Web Mobile Studio started for ${currentPlatform.toUpperCase()}!`, 'success');
      setStatusBadge('recording');
      recordingBanner.classList.remove('hidden');
      const bannerTitle = recordingBanner.querySelector('h3');
      const bannerDesc = recordingBanner.querySelector('p');
      if (bannerTitle) bannerTitle.innerHTML = `📱 Live Interactive Mobile Studio (${currentPlatform.toUpperCase()})`;
      if (bannerDesc) bannerDesc.innerHTML = `
        ⚡ You are connected directly to the running emulator!<br/>
        👆 <strong>Click directly on the Live Phone Screen below</strong> to tap elements, type text, or press keys.<br/>
        YAML commands and step descriptions will generate automatically in real-time!
      `;

      resultsSection.classList.remove('hidden');
      resultsSection.classList.add('fade-in');

      const bannerStop = document.getElementById('bannerStopBtn');
      if (bannerStop) {
        bannerStop.classList.remove('hidden');
        bannerStop.classList.add('flex');
      }
      const indicator = document.getElementById('phoneStatusIndicator');
      if (indicator) {
        indicator.className = 'text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 font-mono flex items-center gap-1';
        indicator.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span> Live';
      }
      const stopBtn = document.getElementById('stopMobileRecordBtn');
      if (stopBtn) {
        stopBtn.classList.remove('hidden');
        stopBtn.classList.add('animate-pulse');
      }

      const resultsGrid = document.getElementById('resultsGrid');
      const livePhonePanel = document.getElementById('livePhonePanel');
      if (resultsGrid) resultsGrid.className = 'grid grid-cols-1 lg:grid-cols-3 gap-5';
      if (livePhonePanel) {
        livePhonePanel.classList.remove('hidden');
        livePhonePanel.classList.add('flex');
      }

      refreshPhoneScreen();
      startPhoneAutoRefresh();

      try {
        const statusRes = await fetch('/api/record/status');
        const statusData = await statusRes.json();
        if (statusData.data) {
          currentResult = statusData.data;
          renderSteps(currentResult.steps || []);
          const liveEditor = document.getElementById('liveCodeEditor');
          const codePre = document.getElementById('codePre');
          const badge = document.getElementById('codeEditBadge');
          const title = document.getElementById('codeHeaderTitle');
          if (liveEditor && codePre) {
            liveEditor.classList.remove('hidden');
            codePre.classList.add('hidden');
            if (badge) badge.classList.remove('hidden');
            if (title) title.textContent = 'Maestro YAML Live Editor';
            liveEditor.value = currentResult.code || '';
          }
        }
      } catch (_) {}

      resetStartButton();
      return;
    }

    showToast(`Recording started for ${currentPlatform.toUpperCase()}!`, 'success');
    setStatusBadge('recording');
    recordingBanner.classList.remove('hidden');
    resultsSection.classList.add('hidden');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `
        <svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"/></svg>
        Recording…
      `;
    }

    startPolling();
  } catch (err) {
    showToast(`Failed to start: ${err.message}`, 'error');
    resetStartButton();
  }
}

function resetStartButton() {
  if (startBtn) {
    startBtn.disabled = false;
    startBtn.innerHTML = `
      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke-width="2"/><circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/></svg>
      Start Web Studio
    `;
  }
  const startMobileBtn = document.getElementById('startMobileBtn');
  if (startMobileBtn) {
    startMobileBtn.disabled = false;
    startMobileBtn.innerHTML = `
      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z"/></svg>
      Start Maestro Studio
    `;
  }
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
  if (currentResult) {
    currentResult.platform = currentPlatform;
    currentResult.appPath = document.getElementById('mobileAppInput') ? document.getElementById('mobileAppInput').value.trim() : '';
    currentResult.deviceName = document.getElementById('mobileDeviceInput') ? document.getElementById('mobileDeviceInput').value.trim() : '';
  }

  // Render steps
  renderSteps(currentResult.steps);

  // Render code & check live editor
  const liveEditor = document.getElementById('liveCodeEditor');
  const codePre = document.getElementById('codePre');
  const badge = document.getElementById('codeEditBadge');
  const title = document.getElementById('codeHeaderTitle');

  if (currentPlatform !== 'web' && liveEditor && codePre) {
    liveEditor.classList.remove('hidden');
    codePre.classList.add('hidden');
    if (badge) badge.classList.remove('hidden');
    if (title) title.textContent = 'Maestro YAML Live Editor';
    liveEditor.value = currentResult.code || '';
  } else if (liveEditor && codePre) {
    liveEditor.classList.add('hidden');
    codePre.classList.remove('hidden');
    if (badge) badge.classList.add('hidden');
    if (title) title.textContent = 'Generated Code';
    codeOutput.textContent = currentResult.code || '';
  } else {
    codeOutput.textContent = currentResult.code || '';
  }

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
        platform: currentResult.platform || currentPlatform,
        app_path: currentResult.appPath || '',
        device_name: currentResult.deviceName || '',
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
                <span class="text-xs text-surface-500 truncate max-w-[200px]">${escapeHtml(tc.url || tc.app_path || '—')}</span>
                <span class="lang-badge ${tc.platform === 'android' ? '!bg-emerald-500/10 !text-emerald-400 !border-emerald-500/20' : tc.platform === 'ios' ? '!bg-purple-500/10 !text-purple-400 !border-purple-500/20' : ''}">
                  ${tc.platform === 'android' ? '🤖 Android' : tc.platform === 'ios' ? '🍎 iOS' : '🌐 Web'}
                </span>
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

function setPlatform(platform) {
  currentPlatform = platform;
  document.querySelectorAll('.platform-tab').forEach(btn => {
    btn.classList.remove('bg-accent-500', 'text-white', 'shadow-lg', 'shadow-accent-500/20');
    btn.classList.add('text-surface-400');
  });
  const activeBtn = document.getElementById(`tab${platform.charAt(0).toUpperCase() + platform.slice(1)}`);
  if (activeBtn) {
    activeBtn.classList.remove('text-surface-400');
    activeBtn.classList.add('bg-accent-500', 'text-white', 'shadow-lg', 'shadow-accent-500/20');
  }

  const webControls = document.getElementById('webControls');
  const mobileControls = document.getElementById('mobileControls');
  const resultsGrid = document.getElementById('resultsGrid');
  const livePhonePanel = document.getElementById('livePhonePanel');

  if (platform === 'web') {
    if (webControls) webControls.classList.remove('hidden');
    if (mobileControls) mobileControls.classList.add('hidden');
    if (resultsGrid) resultsGrid.className = 'grid grid-cols-1 lg:grid-cols-2 gap-5';
    if (livePhonePanel) {
      livePhonePanel.classList.add('hidden');
      livePhonePanel.classList.remove('flex');
    }
    stopPhoneAutoRefresh();
  } else {
    if (webControls) webControls.classList.add('hidden');
    if (mobileControls) mobileControls.classList.remove('hidden');
    const startMobileBtn = document.getElementById('startMobileBtn');
    if (startMobileBtn) {
      startMobileBtn.innerHTML = `
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z"/></svg>
        Start ${platform === 'android' ? 'Android' : 'iOS'} Maestro Studio
      `;
    }
  }
}

// ─── Event Listeners ─────────────────────────────────────────────────────────
if (startBtn) startBtn.addEventListener('click', startRecording);
const startMobileBtn = document.getElementById('startMobileBtn');
if (startMobileBtn) startMobileBtn.addEventListener('click', startRecording);

const tabWeb = document.getElementById('tabWeb');
const tabAndroid = document.getElementById('tabAndroid');
const tabIos = document.getElementById('tabIos');
if (tabWeb) tabWeb.addEventListener('click', () => setPlatform('web'));
if (tabAndroid) tabAndroid.addEventListener('click', () => setPlatform('android'));
if (tabIos) tabIos.addEventListener('click', () => setPlatform('ios'));

if (copyCodeBtn) copyCodeBtn.addEventListener('click', copyCode);
if (newRecordingBtn) newRecordingBtn.addEventListener('click', newRecording);
if (saveTestBtn) saveTestBtn.addEventListener('click', saveTest);
if (refreshTestsBtn) refreshTestsBtn.addEventListener('click', loadSavedTests);
if (closeModalBtn) closeModalBtn.addEventListener('click', closeModal);

const liveCodeEditor = document.getElementById('liveCodeEditor');
if (liveCodeEditor) {
  let debounceTimer = null;
  liveCodeEditor.addEventListener('input', () => {
    if (currentResult) {
      currentResult.code = liveCodeEditor.value;
    }
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      try {
        const res = await fetch('/api/record/update-code', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: liveCodeEditor.value, language: 'yaml' }),
        });
        const data = await res.json();
        if (data.success && data.data && data.data.steps) {
          if (currentResult) currentResult.steps = data.data.steps;
          renderSteps(data.data.steps);
        }
      } catch (e) {
        console.warn('Live code update failed:', e);
      }
    }, 500);
  });
}

if (detailModal) {
  detailModal.addEventListener('click', (e) => {
    if (e.target === detailModal) closeModal();
  });
}

// Enter key on URL input
if (urlInput) {
  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') startRecording();
  });
}

// ─── Live Mobile Phone Screen Helpers ────────────────────────────────────────
let phoneRefreshTimer = null;

function startPhoneAutoRefresh() {
  stopPhoneAutoRefresh();
  phoneRefreshTimer = setInterval(refreshPhoneScreen, 2500);
}

function stopPhoneAutoRefresh() {
  if (phoneRefreshTimer) {
    clearInterval(phoneRefreshTimer);
    phoneRefreshTimer = null;
  }
}

function refreshPhoneScreen() {
  const img = document.getElementById('phoneScreenImg');
  if (img) {
    img.src = `/api/mobile/screenshot?t=${Date.now()}`;
  }
}

let mobileStudioMode = 'tap'; // 'tap' or 'assert'

async function handlePhoneScreenClick(e) {
  const img = document.getElementById('phoneScreenImg');
  const spinner = document.getElementById('tapSpinner');
  const spinnerText = document.getElementById('spinnerText');
  if (!img) return;

  const rect = img.getBoundingClientRect();
  const clickX = e.clientX - rect.left;
  const clickY = e.clientY - rect.top;

  const normX = clickX / rect.width;
  const normY = clickY / rect.height;

  if (spinner) {
    if (spinnerText) {
      spinnerText.textContent = mobileStudioMode === 'assert' 
        ? '👁️ Inspecting UI element for visibility assertion...' 
        : 'Tapping & inspecting UI elements...';
    }
    spinner.classList.remove('hidden');
  }

  try {
    const endpoint = mobileStudioMode === 'assert' ? '/api/mobile/assert-screen' : '/api/mobile/tap';
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ normX, normY })
    });
    const data = await res.json();
    if (data.success && data.data) {
      currentResult = data.data;
      renderSteps(currentResult.steps || []);
      const liveEditor = document.getElementById('liveCodeEditor');
      if (liveEditor) liveEditor.value = currentResult.code || '';
      if (mobileStudioMode === 'assert') {
        showToast('👁️ Added assertion step to script!', 'success');
      } else {
        showToast('👆 Tapped element & recorded step!', 'success');
      }
    } else {
      showToast(data.message || (mobileStudioMode === 'assert' ? 'Assertion failed' : 'Tap failed'), 'error');
    }
  } catch (err) {
    showToast((mobileStudioMode === 'assert' ? 'Assertion failed: ' : 'Tap failed: ') + err.message, 'error');
  } finally {
    if (spinner) spinner.classList.add('hidden');
    refreshPhoneScreen();
  }
}

async function handleSendText() {
  const input = document.getElementById('phoneTextInput');
  const spinner = document.getElementById('tapSpinner');
  if (!input || !input.value.trim()) return;

  const text = input.value.trim();
  if (spinner) spinner.classList.remove('hidden');

  try {
    const res = await fetch('/api/mobile/input-text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    const data = await res.json();
    if (data.success && data.data) {
      currentResult = data.data;
      renderSteps(currentResult.steps || []);
      const liveEditor = document.getElementById('liveCodeEditor');
      if (liveEditor) liveEditor.value = currentResult.code || '';
      input.value = '';
      showToast(`⌨️ Sent text: "${text}"`, 'success');
    }
  } catch (err) {
    showToast('Send text failed: ' + err.message, 'error');
  } finally {
    if (spinner) spinner.classList.add('hidden');
    refreshPhoneScreen();
  }
}

async function handlePhoneKey(key) {
  const spinner = document.getElementById('tapSpinner');
  if (spinner) spinner.classList.remove('hidden');

  try {
    const res = await fetch('/api/mobile/key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key })
    });
    const data = await res.json();
    if (data.success && data.data) {
      currentResult = data.data;
      renderSteps(currentResult.steps || []);
      const liveEditor = document.getElementById('liveCodeEditor');
      if (liveEditor) liveEditor.value = currentResult.code || '';
      showToast(`🔘 Pressed key: ${key}`, 'success');
    }
  } catch (err) {
    showToast('Press key failed: ' + err.message, 'error');
  } finally {
    if (spinner) spinner.classList.add('hidden');
    refreshPhoneScreen();
  }
}

const phoneImg = document.getElementById('phoneScreenImg');
if (phoneImg) phoneImg.addEventListener('click', handlePhoneScreenClick);

const refreshPhoneBtn = document.getElementById('refreshPhoneBtn');
if (refreshPhoneBtn) refreshPhoneBtn.addEventListener('click', refreshPhoneScreen);

const sendTextBtn = document.getElementById('sendTextBtn');
if (sendTextBtn) sendTextBtn.addEventListener('click', handleSendText);

const phoneTextInput = document.getElementById('phoneTextInput');
if (phoneTextInput) {
  phoneTextInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleSendText();
  });
}

document.querySelectorAll('.phone-key-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const key = btn.getAttribute('data-key');
    if (key) handlePhoneKey(key);
  });
});

const modeTapBtn = document.getElementById('modeTapBtn');
const modeAssertBtn = document.getElementById('modeAssertBtn');
const phoneFrame = document.getElementById('phoneFrame');
const overlayText = document.getElementById('overlayText');

if (modeTapBtn && modeAssertBtn) {
  modeTapBtn.addEventListener('click', () => {
    mobileStudioMode = 'tap';
    modeTapBtn.className = 'py-1.5 px-2 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 bg-gradient-to-r from-accent-600 to-indigo-600 text-white shadow-md transition-all';
    modeAssertBtn.className = 'py-1.5 px-2 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 text-surface-400 hover:text-white transition-all';
    if (phoneFrame) {
      phoneFrame.classList.remove('border-purple-500', 'shadow-purple-500/30');
      phoneFrame.classList.add('border-surface-700');
    }
    if (overlayText) {
      overlayText.className = 'bg-black/80 text-white text-[10px] px-2 py-1 rounded-md font-mono shadow-lg';
      overlayText.textContent = '👆 Click to Tap';
    }
    showToast('👆 Switched to Tap Mode', 'info');
  });

  modeAssertBtn.addEventListener('click', () => {
    mobileStudioMode = 'assert';
    modeAssertBtn.className = 'py-1.5 px-2 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 bg-gradient-to-r from-purple-600 to-pink-600 text-white shadow-md transition-all';
    modeTapBtn.className = 'py-1.5 px-2 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 text-surface-400 hover:text-white transition-all';
    if (phoneFrame) {
      phoneFrame.classList.remove('border-surface-700');
      phoneFrame.classList.add('border-purple-500', 'shadow-purple-500/30');
    }
    if (overlayText) {
      overlayText.className = 'bg-purple-900/90 text-purple-200 text-[10px] px-2 py-1 rounded-md font-mono shadow-lg border border-purple-500/30';
      overlayText.textContent = '👁️ Click to Assert Visible';
    }
    showToast('👁️ Switched to Assert Mode: Click an element on screen to assert visibility!', 'info');
  });
}

const addAssertBtn = document.getElementById('addAssertBtn');
if (addAssertBtn) {
  addAssertBtn.addEventListener('click', async () => {
    const typeSelect = document.getElementById('assertTypeSelect');
    const valueInput = document.getElementById('assertValueInput');
    if (!valueInput || !valueInput.value.trim()) {
      showToast('Please enter an ID or text to assert', 'warning');
      return;
    }
    const type = typeSelect ? typeSelect.value : 'visible-id';
    const value = valueInput.value.trim();

    try {
      const res = await fetch('/api/mobile/assert-custom', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, value })
      });
      const data = await res.json();
      if (data.success && data.data) {
        currentResult = data.data;
        renderSteps(currentResult.steps || []);
        const liveEditor = document.getElementById('liveCodeEditor');
        if (liveEditor) liveEditor.value = currentResult.code || '';
        valueInput.value = '';
        showToast('⚡ Added assertion step!', 'success');
      } else {
        showToast(data.message || 'Failed to add assertion', 'error');
      }
    } catch (err) {
      showToast('Error adding assertion: ' + err.message, 'error');
    }
  });
}

function stopMobileRecording() {
  stopPhoneAutoRefresh();
  const indicator = document.getElementById('phoneStatusIndicator');
  if (indicator) {
    indicator.className = 'text-[10px] px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 font-mono flex items-center gap-1';
    indicator.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-amber-400"></span> Stopped';
  }
  const stopBtn = document.getElementById('stopMobileRecordBtn');
  if (stopBtn) stopBtn.classList.remove('animate-pulse');

  const bannerStop = document.getElementById('bannerStopBtn');
  if (bannerStop) bannerStop.classList.add('hidden');

  const recordingBanner = document.getElementById('recordingBanner');
  if (recordingBanner) recordingBanner.classList.add('hidden');

  showToast('⏹️ Recording stopped! Please enter a test name below and click "Save Test".', 'success');

  const nameInput = document.getElementById('testNameInput');
  if (nameInput) {
    nameInput.focus();
    nameInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
    nameInput.classList.add('ring-4', 'ring-accent-400', 'border-accent-400', 'transition-all', 'duration-500');
    setTimeout(() => {
      nameInput.classList.remove('ring-4', 'ring-accent-400', 'border-accent-400');
    }, 3500);
  }
}

const stopMobileBtn = document.getElementById('stopMobileRecordBtn');
if (stopMobileBtn) stopMobileBtn.addEventListener('click', stopMobileRecording);

const bannerStopBtn = document.getElementById('bannerStopBtn');
if (bannerStopBtn) bannerStopBtn.addEventListener('click', stopMobileRecording);

async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    const data = await res.json();
    if (data.success && data.config.targetUrl) {
      if (urlInput) urlInput.value = data.config.targetUrl;
      const display = document.getElementById('configUrlDisplay');
      if (display) display.textContent = data.config.targetUrl;
    }
    if (data.success && data.config.mobile) {
      const mobApp = document.getElementById('mobileAppInput');
      const mobDev = document.getElementById('mobileDeviceInput');
      if (mobApp && data.config.mobile.appIdOrPath) mobApp.value = data.config.mobile.appIdOrPath;
      if (mobDev && data.config.mobile.deviceName) mobDev.value = data.config.mobile.deviceName;
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
