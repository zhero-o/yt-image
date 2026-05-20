// Tracks tabs with debugger attached
const attachedTabs = new Set();
// Map of url -> custom filename for download renaming
const downloadRenames = new Map();

let downloadFolder = '';
let filePrefix = '';
let autoRename = true;

// ── Side panel ────────────────────────────────────────────────────────────────

async function setupSidePanel() {
  if (!chrome.sidePanel) return;
  try {
    await chrome.sidePanel.setOptions({ path: 'sidepanel/index.html', enabled: true });
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (_) {}
}

setupSidePanel();
chrome.runtime.onInstalled.addListener(() => setupSidePanel());

chrome.action.onClicked.addListener(async (tab) => {
  if (chrome.sidePanel && tab.id != null) {
    try { await chrome.sidePanel.open({ tabId: tab.id }); } catch (_) {}
  }
});

// ── Download interception ─────────────────────────────────────────────────────

function isFlowDownload(item) {
  return item.url.includes('google') && (!item.byExtensionId || item.byExtensionId === chrome.runtime.id);
}

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  if (!isFlowDownload(item)) return;

  const isVideo = /\.(mp4)$/i.test(item.filename || item.url);
  const isImage = /\.(jpg|jpeg|png|gif|webp|bmp|svg|jfif)$/i.test(item.filename || item.url);
  if (!isVideo && !isImage) return;

  if (!autoRename) {
    suggest({ filename: (item.filename || '').split('/').pop() || item.filename });
    return;
  }

  if (downloadRenames.has(item.url)) {
    suggest({ filename: downloadRenames.get(item.url) });
    downloadRenames.delete(item.url);
    return;
  }

  const basename = (item.filename || item.url).split('/').pop() || item.filename;
  const folder = downloadFolder ? `${downloadFolder}/` : '';
  suggest({ filename: `${folder}${filePrefix}${basename}` });
});

// ── Debugger helpers ──────────────────────────────────────────────────────────

chrome.debugger.onDetach.addListener((src) => {
  if (src.tabId != null) attachedTabs.delete(src.tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => attachedTabs.delete(tabId));

async function ensureAttached(tabId) {
  if (attachedTabs.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, '1.3');
  attachedTabs.add(tabId);
}

async function detachDebugger(tabId) {
  if (!attachedTabs.has(tabId)) return;
  await chrome.debugger.detach({ tabId });
  attachedTabs.delete(tabId);
}

async function sendDebugCommand(tabId, method, params = {}) {
  await ensureAttached(tabId);
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

// ── Message handler ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const tabId = sender.tab?.id;

  switch (msg.type) {

    // Insert text at current cursor position via debugger
    case 'CIT': {
      if (!tabId) { reply({ success: false, error: 'No tab' }); break; }
      sendDebugCommand(tabId, 'Input.insertText', { text: msg.text })
        .then(() => reply({ success: true }))
        .catch((e) => reply({ success: false, error: String(e) }));
      return true;
    }

    // Dispatch a key event (modifiers bitmask: Ctrl=2, Shift=8, Alt=1, Meta=4)
    case 'CK': {
      if (!tabId) { reply({ success: false, error: 'No tab' }); break; }
      const { key, keyCode, code, modifiers = 0 } = msg;
      const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers };
      sendDebugCommand(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...base })
        .then(() => sendDebugCommand(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base }))
        .then(() => reply({ success: true }))
        .catch((e) => reply({ success: false, error: String(e) }));
      return true;
    }

    // Dispatch a mouse click at (x, y)
    case 'CC': {
      if (!tabId) { reply({ success: false, error: 'No tab' }); break; }
      const { x, y } = msg;
      const click = async () => {
        await sendDebugCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', modifiers: 0 });
        await sendDebugCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1, modifiers: 0 });
        await sendDebugCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1, modifiers: 0 });
      };
      click().then(() => reply({ success: true })).catch((e) => reply({ success: false, error: String(e) }));
      return true;
    }

    // Attach debugger + disable cache
    case 'CA': {
      if (!tabId) { reply({ success: false, error: 'No tab' }); break; }
      ensureAttached(tabId)
        .then(() => sendDebugCommand(tabId, 'Network.enable', {}))
        .then(() => sendDebugCommand(tabId, 'Network.setCacheDisabled', { cacheDisabled: true }))
        .then(() => reply({ success: true }))
        .catch((e) => reply({ success: false, error: String(e) }));
      return true;
    }

    // Detach debugger
    case 'CD': {
      if (!tabId) { reply({ success: false, error: 'No tab' }); break; }
      detachDebugger(tabId)
        .then(() => reply({ success: true }))
        .catch((e) => { attachedTabs.delete(tabId); reply({ success: false, error: String(e) }); });
      return true;
    }

    // Trigger a named download with optional custom filename
    case 'DOWNLOAD_VIDEO': {
      const { url, filename, folder, autoChangeFileName } = msg;
      if (autoChangeFileName !== false) {
        const dest = folder ? `${folder}/${filename}` : filename;
        downloadRenames.set(url, dest);
      }
      chrome.downloads.download({ url, saveAs: false }, (id) => {
        const err = chrome.runtime?.lastError;
        reply(err || id == null ? { success: false, error: err?.message || 'Download failed' } : { success: true, downloadId: id });
      });
      return true;
    }

    // Update folder / prefix / autoRename settings
    case 'SET_FOLDER_NAME': {
      const { folderName, prefix, autoChangeFileName } = msg;
      if (typeof folderName === 'string') downloadFolder = folderName.trim();
      if (typeof prefix === 'string') filePrefix = prefix.trim();
      if (typeof autoChangeFileName === 'boolean') autoRename = autoChangeFileName;
      reply({ success: true });
      break;
    }

    // Zoom active tab
    case 'SET_ZOOM': {
      if (!tabId) { reply({ success: false, error: 'No tab' }); break; }
      chrome.tabs.setZoom(tabId, msg.zoomFactor);
      reply({ success: true });
      break;
    }

    // Clear session cookies + local storage for labs.google
    case 'CS': {
      if (!tabId) { reply({ success: false, error: 'No tab' }); break; }
      (async () => {
        const keep = ['__Secure', 'SID', 'SSID', 'HSID', 'APISID', 'SAPISID', 'LSID', 'NID', '1P_JAR'];
        const cookies = await chrome.cookies.getAll({ domain: 'labs.google' });
        const removable = cookies.filter(c => !keep.some(k => c.name.startsWith(k)));
        await Promise.all(removable.map(c =>
          chrome.cookies.remove({ url: `https://${c.domain.replace(/^\./, '')}${c.path}`, name: c.name })
        ));
        await ensureAttached(tabId);
        await chrome.debugger.sendCommand({ tabId }, 'Storage.clearDataForOrigin', {
          origin: 'https://labs.google',
          storageTypes: 'local_storage'
        });
        reply({ success: true });
      })().catch((e) => reply({ success: false, error: String(e) }));
      return true;
    }
  }

  return false;
});
