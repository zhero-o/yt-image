// Content script — runs on labs.google pages

const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, res));

// ── Config ────────────────────────────────────────────────────────────────────
// Selectors configurable via chrome.storage so the user can update them
// without modifying the extension if Google changes the UI.
let SEL = {
  promptEditor: "div[role='textbox']",
  submitButton: "button[aria-label*='Run'], button[aria-label*='Generate'], button[jsname='LgbsSe'], button[type='submit']",
  outputGrid: '.output-grid, [data-tile-id], .media-tile, .generation-result',
  downloadButton: "button[aria-label*='Download'], a[download], button[jsaction*='download']",
  generatingIndicator: '.progress-indicator, [aria-label*="Generating"], .loading-spinner, [aria-busy="true"]',
};

chrome.storage.sync.get('selectors', ({ selectors }) => {
  if (selectors) SEL = { ...SEL, ...selectors };
});

// ── State ─────────────────────────────────────────────────────────────────────
let running = false;
let cancelled = false;

// ── Utilities ─────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function waitFor(selector, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const el = document.querySelector(selector);
    if (el) { resolve(el); return; }
    const obs = new MutationObserver(() => {
      const found = document.querySelector(selector);
      if (found) { obs.disconnect(); resolve(found); }
    });
    obs.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => { obs.disconnect(); reject(new Error(`Timeout waiting for: ${selector}`)); }, timeout);
  });
}

function waitForGone(selector, timeout = 120000) {
  return new Promise((resolve, reject) => {
    if (!document.querySelector(selector)) { resolve(); return; }
    const obs = new MutationObserver(() => {
      if (!document.querySelector(selector)) { obs.disconnect(); resolve(); }
    });
    obs.observe(document.body, { childList: true, subtree: true, attributes: true });
    setTimeout(() => { obs.disconnect(); reject(new Error(`Timeout waiting for removal: ${selector}`)); }, timeout);
  });
}

function getRect(el) {
  const r = el.getBoundingClientRect();
  return {
    x: Math.round(r.left + r.width / 2),
    y: Math.round(r.top + r.height / 2),
  };
}

// ── Core automation ───────────────────────────────────────────────────────────

async function fillPrompt(text) {
  const editor = document.querySelector(SEL.promptEditor);
  if (!editor) throw new Error("Could not find prompt editor (div[role='textbox'])");

  editor.focus();
  await sleep(200);

  // Select all with Ctrl+A (modifiers=2 means Ctrl)
  await send({ type: 'CK', key: 'a', code: 'KeyA', keyCode: 65, modifiers: 2 });
  await sleep(80);
  // Delete selection
  await send({ type: 'CK', key: 'Backspace', code: 'Backspace', keyCode: 8 });
  await sleep(150);

  // Insert new text via debugger Input.insertText
  const result = await send({ type: 'CIT', text });
  if (!result?.success) throw new Error('Failed to fill prompt: ' + (result?.error || 'unknown'));

  // Fire synthetic events so React/Angular picks up the value change
  editor.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
  editor.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(300);
}

async function clickSubmit() {
  // Try direct click on submit button
  const selectors = SEL.submitButton.split(',').map(s => s.trim());
  let btn = null;
  for (const sel of selectors) {
    btn = document.querySelector(sel);
    if (btn) break;
  }

  if (!btn) {
    // Fallback: find button containing "Run" or "Generate" text
    const allBtns = Array.from(document.querySelectorAll('button'));
    btn = allBtns.find(b => /^(Run|Generate|Create)$/i.test(b.textContent?.trim()));
  }

  if (!btn) throw new Error('Could not find submit button');

  const { x, y } = getRect(btn);
  await send({ type: 'CC', x, y });
  await sleep(300);
}

function countTiles() {
  return document.querySelectorAll('[data-tile-id]').length;
}

async function waitForGeneration() {
  const tilesBefore = countTiles();

  // Give the UI a moment to react to the submit click
  await sleep(3000);

  // Strategy 1: watch for a new tile to appear (most reliable)
  const tileAppeared = await new Promise((resolve) => {
    if (countTiles() > tilesBefore) { resolve(true); return; }
    const obs = new MutationObserver(() => {
      if (countTiles() > tilesBefore) { obs.disconnect(); resolve(true); }
    });
    obs.observe(document.body, { childList: true, subtree: true });
    // Give up waiting for a new tile after 3 minutes
    setTimeout(() => { obs.disconnect(); resolve(false); }, 180000);
  });

  if (tileAppeared) {
    // New tile appeared — wait for loading indicators on it to clear
    const indicatorSelectors = SEL.generatingIndicator.split(',').map(s => s.trim());
    for (const sel of indicatorSelectors) {
      try { await waitForGone(sel, 180000); } catch (_) {}
    }
    await sleep(1500);
    return;
  }

  // Strategy 2: watch for page-level loading indicator disappearing
  const indicatorSelectors = SEL.generatingIndicator.split(',').map(s => s.trim());
  let indicatorFound = false;
  for (const sel of indicatorSelectors) {
    if (document.querySelector(sel)) { indicatorFound = true; break; }
  }

  if (indicatorFound) {
    for (const sel of indicatorSelectors) {
      try { await waitForGone(sel, 180000); } catch (_) {}
    }
  } else {
    // Fallback: fixed wait — video generation can take up to ~90 seconds
    await sleep(90000);
  }

  await sleep(1500);
}

async function downloadOutputs(folder, prefix, promptIndex) {
  // Collect all download buttons — from data-tile-id containers first, then fallback
  const dlSelectors = "button[aria-label*='Download'], a[download], button[jsaction*='download']";
  const tiles = document.querySelectorAll('[data-tile-id]');

  let btns = [];
  if (tiles.length > 0) {
    tiles.forEach(tile => {
      const btn = tile.querySelector(dlSelectors);
      if (btn) btns.push(btn);
    });
  }

  if (btns.length === 0) {
    // Fallback: any matching download button on the page
    btns = Array.from(document.querySelectorAll(dlSelectors));
  }

  // Click each button — background.js onDeterminingFilename applies folder/prefix
  let count = 0;
  for (const btn of btns) {
    if (cancelled) break;
    const { x, y } = getRect(btn);
    await send({ type: 'CC', x, y });
    await sleep(600);
    count++;
  }
  return count;
}

// ── Main batch loop ───────────────────────────────────────────────────────────

async function runBatch({ prompts, folder, prefix, delayBetween = 3000 }) {
  running = true;
  cancelled = false;

  notifyStatus({ status: 'running', total: prompts.length, current: 0 });

  for (let i = 0; i < prompts.length; i++) {
    if (cancelled) break;

    const prompt = prompts[i].trim();
    if (!prompt) continue;

    notifyStatus({ status: 'running', current: i, promptText: prompt, step: 'filling' });

    try {
      await fillPrompt(prompt);
      if (cancelled) break;

      notifyStatus({ status: 'running', current: i, promptText: prompt, step: 'generating' });
      await clickSubmit();
      await waitForGeneration();

      if (cancelled) break;

      notifyStatus({ status: 'running', current: i, promptText: prompt, step: 'downloading' });
      await downloadOutputs(folder, prefix, i);

      notifyStatus({ status: 'running', current: i, promptText: prompt, step: 'done' });

      if (i < prompts.length - 1 && !cancelled) {
        await sleep(delayBetween);
      }
    } catch (err) {
      notifyStatus({ status: 'error', current: i, promptText: prompt, error: err.message });
      // Continue with next prompt
      await sleep(2000);
    }
  }

  running = false;
  notifyStatus({ status: cancelled ? 'cancelled' : 'completed', total: prompts.length });
}

function notifyStatus(data) {
  chrome.runtime.sendMessage({ type: 'PROMPT_GROUP_STATUS', data });
}

// ── Message listener ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  switch (msg.type) {

    case 'AUTO_FILL_FLOW': {
      if (running) { reply({ success: false, error: 'Already running' }); return false; }
      runBatch(msg).then(() => reply({ success: true })).catch(e => reply({ success: false, error: e.message }));
      return true;
    }

    case 'CANCEL_PROMPT_GROUP': {
      cancelled = true;
      running = false;
      reply({ success: true });
      break;
    }

    case 'CHECK_FLOW_PAGE': {
      reply({ success: true, url: window.location.href, running });
      break;
    }

    case 'CONTENT_SCRIPT_RESET': {
      running = false;
      cancelled = false;
      reply({ success: true });
      break;
    }
  }
  return false;
});
