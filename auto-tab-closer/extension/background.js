// Auto Tab Closer - background service worker
// Watches for tabs redirected to login pages and closes them after idle_minutes of inactivity.
// "Idle" resets when the user activates (focuses) the tab; cancels if they navigate away.

const CONFIG_TTL_MS = 10_000;
let configCache = null;
let configLoadedAt = 0;

async function loadConfig(force = false) {
  const now = Date.now();
  if (!force && configCache && (now - configLoadedAt) < CONFIG_TTL_MS) return configCache;
  try {
    const resp = await fetch(chrome.runtime.getURL('config.json'));
    configCache = await resp.json();
    configLoadedAt = now;
    return configCache;
  } catch (err) {
    console.error('[AutoClose] Failed to load config:', err);
    return configCache || { idle_minutes: 10, patterns: [] };
  }
}

function matchPattern(url, patterns) {
  if (!url) return null;
  const lower = url.toLowerCase();
  for (const p of patterns) {
    if (lower.includes(p.match.toLowerCase())) return p;
  }
  return null;
}

// User-added patterns live in chrome.storage so they survive config syncs and upgrades
async function getManualPatterns() {
  const { manualPatterns = [] } = await chrome.storage.local.get('manualPatterns');
  return manualPatterns;
}

async function getAllPatterns() {
  const config = await loadConfig();
  const manual = await getManualPatterns();
  return [...(config.patterns || []), ...manual];
}

// Re-evaluate every open tab against the current pattern set.
// Schedules newly-matching tabs; cancels pending tabs that no longer match.
async function rescanTabs() {
  const patterns = await getAllPatterns();
  const tabs = await chrome.tabs.query({});
  const pending = await getPending();
  for (const tab of tabs) {
    if (!tab.id || !tab.url) continue;
    const match = matchPattern(tab.url, patterns);
    if (match && !pending[tab.id]) {
      await scheduleClose(tab.id, match, tab.url);
    } else if (!match && pending[tab.id]) {
      await cancelClose(tab.id, 'no longer matches any pattern');
    }
  }
}

async function getPending() {
  const { pending = {} } = await chrome.storage.local.get('pending');
  return pending;
}

async function savePending(pending) {
  await chrome.storage.local.set({ pending });
  const count = Object.keys(pending).length;
  chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#ea580c' });
}

async function scheduleClose(tabId, pattern, url) {
  const config = await loadConfig();
  const idleMin = config.idle_minutes || 10;
  const alarmName = `close-tab-${tabId}`;

  await chrome.alarms.clear(alarmName);
  await chrome.alarms.create(alarmName, { delayInMinutes: idleMin });

  let title = url;
  try {
    const tab = await chrome.tabs.get(tabId);
    title = tab.title || url;
  } catch { /* tab may have closed */ }

  const pending = await getPending();
  pending[tabId] = {
    name: pattern.name,
    title,
    url,
    closeAt: Date.now() + idleMin * 60_000
  };
  await savePending(pending);
  console.log(`[AutoClose] Scheduled close for tab ${tabId} (${pattern.name}) in ${idleMin} min`);
}

async function cancelClose(tabId, reason) {
  await chrome.alarms.clear(`close-tab-${tabId}`);
  const pending = await getPending();
  if (pending[tabId]) {
    delete pending[tabId];
    await savePending(pending);
    if (reason) console.log(`[AutoClose] Cancelled tab ${tabId}: ${reason}`);
  }
}

// Tab finished loading — check if it's a login page
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab.url) return;
  const match = matchPattern(tab.url, await getAllPatterns());
  if (match) {
    await scheduleClose(tabId, match, tab.url);
  } else {
    await cancelClose(tabId, 'navigated away from login page');
  }
});

// User focused a pending tab — reset the idle timer
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const pending = await getPending();
  if (!pending[tabId]) return;

  const config = await loadConfig();
  const idleMin = config.idle_minutes || 10;
  const alarmName = `close-tab-${tabId}`;

  await chrome.alarms.clear(alarmName);
  await chrome.alarms.create(alarmName, { delayInMinutes: idleMin });

  pending[tabId].closeAt = Date.now() + idleMin * 60_000;
  await savePending(pending);
  console.log(`[AutoClose] Reset timer for tab ${tabId} (user activated)`);
});

// Tab closed manually — clean up
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await cancelClose(tabId);
});

// Alarm fires — time's up, close the tab
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm.name.startsWith('close-tab-')) return;
  const tabId = parseInt(alarm.name.replace('close-tab-', ''), 10);

  const pending = await getPending();
  const info = pending[tabId];
  console.log(`[AutoClose] Closing tab ${tabId}${info ? ' (' + info.name + ')' : ''}`);

  try {
    await chrome.tabs.remove(tabId);
  } catch (err) {
    console.warn(`[AutoClose] Could not close tab ${tabId}:`, err.message);
  }

  delete pending[tabId];
  await savePending(pending);
});

// Popup messages
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'get_pending') {
    getPending().then(sendResponse);
    return true;
  }
  if (msg.type === 'cancel_tab') {
    cancelClose(msg.tabId, 'user cancelled from popup').then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'cancel_all') {
    getPending().then(async (pending) => {
      for (const tabId of Object.keys(pending)) {
        await cancelClose(Number(tabId), 'cancelled all from popup');
      }
      sendResponse({ ok: true });
    });
    return true;
  }
  if (msg.type === 'reload_config') {
    loadConfig(true).then(config => sendResponse({ ok: true, idleMin: config.idle_minutes }));
    return true;
  }
  if (msg.type === 'get_manual_patterns') {
    getManualPatterns().then(patterns => sendResponse({ ok: true, patterns }));
    return true;
  }
  if (msg.type === 'add_manual_pattern') {
    (async () => {
      // Strip scheme so "https://example.com/x" and "example.com/x" behave the same
      const match = String(msg.match || '').trim().replace(/^https?:\/\//i, '');
      if (!match) {
        sendResponse({ ok: false, error: 'Pattern is empty' });
        return;
      }
      const manual = await getManualPatterns();
      if (manual.some(p => p.match.toLowerCase() === match.toLowerCase())) {
        sendResponse({ ok: false, error: 'Already in the list' });
        return;
      }
      const name = String(msg.name || '').trim() || match.split('/')[0];
      manual.push({ name, match });
      await chrome.storage.local.set({ manualPatterns: manual });
      await rescanTabs();
      console.log(`[AutoClose] Added manual pattern: ${match}`);
      sendResponse({ ok: true, patterns: manual });
    })();
    return true;
  }
  if (msg.type === 'remove_manual_pattern') {
    (async () => {
      const manual = (await getManualPatterns()).filter(p => p.match !== msg.match);
      await chrome.storage.local.set({ manualPatterns: manual });
      await rescanTabs();
      console.log(`[AutoClose] Removed manual pattern: ${msg.match}`);
      sendResponse({ ok: true, patterns: manual });
    })();
    return true;
  }
});

// Restore badge count after service worker restart
getPending().then(p => {
  const count = Object.keys(p).length;
  chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#ea580c' });
});
loadConfig(true);
