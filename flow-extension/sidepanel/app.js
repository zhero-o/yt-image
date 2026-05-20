// Side panel controller

const DEFAULT_SELECTORS = {
  promptEditor: "div[role='textbox']",
  submitButton: "button[aria-label*='Run'], button[aria-label*='Generate'], button[jsname='LgbsSe'], button[type='submit']",
  outputGrid: '.output-grid, [data-tile-id], .media-tile, .generation-result',
  downloadButton: "button[aria-label*='Download'], a[download], button[jsaction*='download']",
  generatingIndicator: '.progress-indicator, [aria-label*="Generating"], .loading-spinner, [aria-busy="true"]',
};

// ── DOM refs ──────────────────────────────────────────────────────────────────
const promptsInput   = document.getElementById('prompts-input');
const promptCount    = document.getElementById('prompt-count');
const folderInput    = document.getElementById('folder-input');
const prefixInput    = document.getElementById('prefix-input');
const delayInput     = document.getElementById('delay-input');
const autoRename     = document.getElementById('auto-rename');
const btnStart       = document.getElementById('btn-start');
const btnStop        = document.getElementById('btn-stop');
const btnClear       = document.getElementById('btn-clear-prompts');
const btnSaveSel     = document.getElementById('btn-save-selectors');
const statusBadge    = document.getElementById('status-badge');
const progressSection= document.getElementById('progress-section');
const progressBar    = document.getElementById('progress-bar');
const progressList   = document.getElementById('progress-list');

// ── Persistence ───────────────────────────────────────────────────────────────
function saveSettings() {
  chrome.storage.sync.set({
    folder: folderInput.value,
    prefix: prefixInput.value,
    delay: delayInput.value,
    autoRename: autoRename.checked,
  });
}

function loadSettings() {
  chrome.storage.sync.get(['folder', 'prefix', 'delay', 'autoRename', 'selectors'], (data) => {
    if (data.folder != null) folderInput.value = data.folder;
    if (data.prefix != null) prefixInput.value = data.prefix;
    if (data.delay  != null) delayInput.value  = data.delay;
    if (data.autoRename != null) autoRename.checked = data.autoRename;

    const sels = { ...DEFAULT_SELECTORS, ...(data.selectors || {}) };
    document.querySelectorAll('.sel-input').forEach(input => {
      input.value = sels[input.dataset.key] || '';
    });
  });
}

loadSettings();

// ── Prompt counter ────────────────────────────────────────────────────────────
function getPrompts() {
  return promptsInput.value.split('\n').map(l => l.trim()).filter(Boolean);
}

promptsInput.addEventListener('input', () => {
  const n = getPrompts().length;
  promptCount.textContent = `${n} prompt${n !== 1 ? 's' : ''}`;
});

btnClear.addEventListener('click', () => {
  promptsInput.value = '';
  promptCount.textContent = '0 prompts';
});

// ── Settings change ───────────────────────────────────────────────────────────
[folderInput, prefixInput, delayInput].forEach(el => el.addEventListener('change', saveSettings));
autoRename.addEventListener('change', saveSettings);

// ── Selector save ─────────────────────────────────────────────────────────────
btnSaveSel.addEventListener('click', () => {
  const sels = {};
  document.querySelectorAll('.sel-input').forEach(input => {
    sels[input.dataset.key] = input.value.trim() || DEFAULT_SELECTORS[input.dataset.key];
  });
  chrome.storage.sync.set({ selectors: sels }, () => {
    btnSaveSel.textContent = '✓ Saved';
    setTimeout(() => { btnSaveSel.textContent = 'Save selectors'; }, 1500);
  });

  // Push to active flow tab content script
  getFlowTab().then(tab => {
    if (tab) chrome.tabs.sendMessage(tab.id, { type: 'CONTENT_SCRIPT_RESET' });
  });
});

// ── Tab helpers ───────────────────────────────────────────────────────────────
async function getFlowTab() {
  const tabs = await chrome.tabs.query({ url: '*://labs.google/*' });
  const flowTab = tabs.find(t => t.url?.includes('flow'));
  return flowTab || tabs[0] || null;
}

// ── Progress UI ───────────────────────────────────────────────────────────────
let promptItems = [];

function initProgressList(prompts) {
  progressList.innerHTML = '';
  promptItems = prompts.map((text, i) => {
    const li = document.createElement('li');
    li.className = 'progress-item';
    li.id = `pi-${i}`;
    li.innerHTML = `
      <span class="pi-icon">⏳</span>
      <span class="pi-text">
        <span class="pi-prompt">${escapeHtml(text)}</span>
        <span class="pi-step">Waiting…</span>
      </span>`;
    progressList.appendChild(li);
    return li;
  });
  progressBar.style.width = '0%';
  progressSection.style.display = '';
}

function updateProgressItem(index, step, isError = false) {
  const item = promptItems[index];
  if (!item) return;
  const icons   = { filling: '✏️', generating: '⚙️', downloading: '⬇️', done: '✅', error: '❌', waiting: '⏳' };
  const labels  = { filling: 'Filling prompt…', generating: 'Generating…', downloading: 'Downloading…', done: 'Done', error: step, waiting: 'Waiting…' };
  const stepKey = isError ? 'error' : (step || 'waiting');

  item.className = `progress-item ${stepKey === 'done' ? 'done' : stepKey === 'error' ? 'error' : 'active'}`;
  item.querySelector('.pi-icon').textContent = icons[stepKey] || '⏳';
  item.querySelector('.pi-step').textContent = labels[stepKey] || step;
  item.scrollIntoView({ block: 'nearest' });
}

function setProgress(current, total) {
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  progressBar.style.width = `${pct}%`;
}

function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function setBadge(state) {
  statusBadge.className = `badge ${state}`;
  const labels = { idle: 'Idle', running: 'Running', done: 'Done', error: 'Error', stopped: 'Stopped' };
  statusBadge.textContent = labels[state] || state;
}

// ── Start ─────────────────────────────────────────────────────────────────────
btnStart.addEventListener('click', async () => {
  const prompts = getPrompts();
  if (prompts.length === 0) { alert('Please enter at least one prompt.'); return; }

  const tab = await getFlowTab();
  if (!tab) { alert('No Google Flow tab found. Open labs.google/flow first.'); return; }

  // Push folder/prefix settings to background
  await chrome.runtime.sendMessage({
    type: 'SET_FOLDER_NAME',
    folderName: folderInput.value.trim(),
    prefix: prefixInput.value.trim(),
    autoChangeFileName: autoRename.checked,
  });

  btnStart.disabled = true;
  btnStop.disabled = false;
  setBadge('running');
  initProgressList(prompts);

  const delay = Math.max(1, parseInt(delayInput.value, 10) || 3) * 1000;

  chrome.tabs.sendMessage(tab.id, {
    type: 'AUTO_FILL_FLOW',
    prompts,
    folder: folderInput.value.trim(),
    prefix: prefixInput.value.trim(),
    delayBetween: delay,
  }, () => {
    // This fires when the entire batch is done (content script calls reply).
    // Only reset UI if notifyStatus hasn't already done it (badge still 'running').
    if (chrome.runtime.lastError) {
      setBadge('error');
      alert('Could not reach content script. Make sure you are on a Google Flow page and reload the tab.');
      btnStart.disabled = false;
      btnStop.disabled = true;
    }
    // If completed/cancelled, notifyStatus already reset the buttons — don't double-reset.
  });
});

// ── Stop ──────────────────────────────────────────────────────────────────────
btnStop.addEventListener('click', async () => {
  const tab = await getFlowTab();
  if (tab) chrome.tabs.sendMessage(tab.id, { type: 'CANCEL_PROMPT_GROUP' });
  btnStop.disabled = true;
  btnStart.disabled = false;
  setBadge('stopped');
});

// ── Status messages from content script ──────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'PROMPT_GROUP_STATUS') return;
  const { status, current, step, error, total } = msg.data || {};

  if (status === 'running') {
    if (typeof current === 'number') {
      if (step === 'done') {
        updateProgressItem(current, 'done');
        setProgress(current + 1, promptItems.length);
      } else if (step) {
        updateProgressItem(current, step, false);
      }
    }
  } else if (status === 'error') {
    updateProgressItem(current, error || 'Error', true);
  } else if (status === 'completed') {
    setProgress(total || promptItems.length, total || promptItems.length);
    setBadge('done');
    btnStart.disabled = false;
    btnStop.disabled = true;
  } else if (status === 'cancelled') {
    setBadge('stopped');
    btnStart.disabled = false;
    btnStop.disabled = true;
  }
});
