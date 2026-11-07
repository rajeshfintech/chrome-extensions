// Auto Tab Closer - background service worker
// Watches for tabs that land on login pages (or user-watched links) and closes
// them after idle_minutes without user attention. Focusing the tab resets the
// timer; navigating away cancels it; a tab that is active and focused when the
// timer fires is never closed, it just gets another round.

import { matchPattern, usesTitles, ruleKey, normalisePath } from './rules.js';
import { reloadIfUpdatedOnDisk } from './self-update.js';

const CONFIG_TTL_MS = 10_000;
const RECENT_LIMIT = 20;
const CLOSE_PREFIX = 'close-tab-';
const WARN_PREFIX = 'warn-tab-';
const DEFAULTS = { idle_minutes: 10, warn_minutes: 1, patterns: [] };

let configCache = null;
let configLoadedAt = 0;

// ---------------------------------------------------------------------------
// Config and patterns
// ---------------------------------------------------------------------------

async function loadConfig(force = false) {
  const now = Date.now();
  if (!force && configCache && (now - configLoadedAt) < CONFIG_TTL_MS) return configCache;
  try {
    const resp = await fetch(chrome.runtime.getURL('config.json'));
    configCache = { ...DEFAULTS, ...(await resp.json()) };
    configLoadedAt = now;
    // `tabclose install` replaced the extension files: pick up the new code.
    if (await reloadIfUpdatedOnDisk('AutoClose')) return configCache;
    return configCache;
  } catch (err) {
    console.error('[AutoClose] Failed to load config:', err);
    return configCache || DEFAULTS;
  }
}

// User-added patterns live in chrome.storage so they survive config syncs.
async function getManualPatterns() {
  const { manualPatterns = [] } = await chrome.storage.local.get('manualPatterns');
  return manualPatterns;
}

async function getAllPatterns() {
  const config = await loadConfig();
  return [...(config.patterns || []), ...(await getManualPatterns())];
}

function minutesFor(pattern, config) {
  const n = Number(pattern?.idle_minutes);
  return n > 0 ? n : (Number(config.idle_minutes) > 0 ? Number(config.idle_minutes) : DEFAULTS.idle_minutes);
}

function isWatchableUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}

async function isPaused() {
  const { paused = false } = await chrome.storage.local.get('paused');
  return paused;
}

// ---------------------------------------------------------------------------
// Stored state. Every read-modify-write of a storage key goes through
// withStorage(), which serialises updates so concurrent tab events cannot
// clobber each other's writes.
// ---------------------------------------------------------------------------

let storageLock = Promise.resolve();

function withStorage(key, initial, fn) {
  const run = storageLock.then(async () => {
    const stored = await chrome.storage.local.get(key);
    const value = stored[key] ?? initial;
    const result = await fn(value);
    await chrome.storage.local.set({ [key]: value });
    return result;
  });
  storageLock = run.catch(() => {});
  return run;
}

async function withPending(fn) {
  let pendingSnapshot;
  const result = await withStorage('pending', {}, async (pending) => {
    pendingSnapshot = pending;
    return fn(pending);
  });
  await updateBadge(pendingSnapshot);
  return result;
}

async function getPending() {
  const { pending = {} } = await chrome.storage.local.get('pending');
  return pending;
}

async function updateBadge(pending) {
  if (await isPaused()) {
    await chrome.action.setBadgeText({ text: 'II' });
    return;
  }
  const count = Object.keys(pending).length;
  await chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
}

async function armAlarms(tabId, idleMin, warnMin) {
  await chrome.alarms.clear(CLOSE_PREFIX + tabId);
  await chrome.alarms.clear(WARN_PREFIX + tabId);
  await chrome.alarms.create(CLOSE_PREFIX + tabId, { delayInMinutes: idleMin });
  if (warnMin > 0 && idleMin > warnMin) {
    await chrome.alarms.create(WARN_PREFIX + tabId, { delayInMinutes: idleMin - warnMin });
  }
  chrome.notifications.clear(WARN_PREFIX + tabId);
}

async function scheduleClose(tabId, pattern, url, title) {
  if (await isPaused()) return;
  const config = await loadConfig();
  const idleMin = minutesFor(pattern, config);
  const warnMin = Number(config.warn_minutes) >= 0 ? Number(config.warn_minutes) : DEFAULTS.warn_minutes;

  await armAlarms(tabId, idleMin, warnMin);
  await withPending((pending) => {
    pending[tabId] = {
      name: pattern.name || ruleKey(pattern).split(':')[1],
      title: title || url,
      url,
      idleMin,
      closeAt: Date.now() + idleMin * 60_000
    };
  });
  console.log(`[AutoClose] Scheduled close for tab ${tabId} (${pattern.name}) in ${idleMin} min`);
}

async function resetTimer(tabId, reason) {
  const changed = await withPending(async (pending) => {
    const info = pending[tabId];
    if (!info) return false;
    const config = await loadConfig();
    const warnMin = Number(config.warn_minutes) >= 0 ? Number(config.warn_minutes) : DEFAULTS.warn_minutes;
    await armAlarms(tabId, info.idleMin, warnMin);
    info.closeAt = Date.now() + info.idleMin * 60_000;
    return true;
  });
  if (changed) console.log(`[AutoClose] Reset timer for tab ${tabId}: ${reason}`);
}

async function cancelClose(tabId, reason) {
  await chrome.alarms.clear(CLOSE_PREFIX + tabId);
  await chrome.alarms.clear(WARN_PREFIX + tabId);
  chrome.notifications.clear(WARN_PREFIX + tabId);
  const had = await withPending((pending) => {
    if (!pending[tabId]) return false;
    delete pending[tabId];
    return true;
  });
  if (had && reason) console.log(`[AutoClose] Cancelled tab ${tabId}: ${reason}`);
}

async function cancelAll(reason) {
  const pending = await getPending();
  for (const tabId of Object.keys(pending)) await cancelClose(Number(tabId), reason);
}

// Re-evaluate every open tab against the current pattern set.
async function rescanTabs() {
  if (await isPaused()) return;
  const patterns = await getAllPatterns();
  const tabs = await chrome.tabs.query({});
  const pending = await getPending();
  for (const tab of tabs) {
    if (!tab.id || !isWatchableUrl(tab.url)) continue;
    const match = matchPattern(tab.url, tab.title, patterns);
    if (match && !pending[tab.id]) {
      await scheduleClose(tab.id, match, tab.url, tab.title);
    } else if (!match && pending[tab.id]) {
      await cancelClose(tab.id, 'no longer matches any pattern');
    }
  }
}

function recordClosed(info) {
  return withStorage('recentlyClosed', [], (list) => {
    list.unshift({ url: info.url, title: info.title, name: info.name, closedAt: Date.now() });
    list.splice(RECENT_LIMIT);
  });
}

async function tabIsInFront(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.active) return false;
    const win = await chrome.windows.get(tab.windowId);
    return win.focused === true;
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// Tab events
// ---------------------------------------------------------------------------

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  const relevant = changeInfo.url !== undefined
    || changeInfo.status === 'complete'
    || changeInfo.title !== undefined;
  if (!relevant || !tab.url) return;
  if (!isWatchableUrl(tab.url)) {
    // chrome://, file://, extension pages: never on a timer, even if a broad
    // `match` rule would hit them. Cancel if the tab was pending before.
    await cancelClose(tabId, 'left http(s)');
    return;
  }

  const patterns = await getAllPatterns();
  if (changeInfo.title !== undefined && changeInfo.url === undefined
      && changeInfo.status !== 'complete' && !usesTitles(patterns)) return;

  const match = matchPattern(tab.url, tab.title, patterns);
  const pending = await getPending();
  const current = pending[tabId];

  if (!match) {
    if (current) await cancelClose(tabId, 'navigated away from login page');
    return;
  }
  // Already on the timer for this URL: a reload or SPA tick must not reset it.
  if (current && current.url === tab.url) return;
  await scheduleClose(tabId, match, tab.url, tab.title);
});

chrome.tabs.onActivated.addListener(({ tabId }) => resetTimer(tabId, 'user activated'));

chrome.tabs.onRemoved.addListener((tabId) => cancelClose(tabId));

// ---------------------------------------------------------------------------
// Alarms and notifications
// ---------------------------------------------------------------------------

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name.startsWith(WARN_PREFIX)) {
    const tabId = Number(alarm.name.slice(WARN_PREFIX.length));
    const info = (await getPending())[tabId];
    if (!info || await tabIsInFront(tabId)) return;
    const minutes = Math.max(1, Math.round((info.closeAt - Date.now()) / 60_000));
    chrome.notifications.create(WARN_PREFIX + tabId, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: `Closing in ${minutes} min: ${info.name}`,
      message: info.title || info.url,
      buttons: [{ title: 'Keep open' }],
      priority: 0
    });
    return;
  }

  if (!alarm.name.startsWith(CLOSE_PREFIX)) return;
  const tabId = Number(alarm.name.slice(CLOSE_PREFIX.length));
  const info = (await getPending())[tabId];

  if (!info) {
    // Alarm with no pending entry (stale alarm from an earlier session, or a
    // race with cancel). Never close a tab we are not tracking.
    console.warn(`[AutoClose] Ignoring alarm for untracked tab ${tabId}`);
    return;
  }
  if (await isPaused()) return;
  if (await tabIsInFront(tabId)) {
    await resetTimer(tabId, 'tab is active and focused');
    return;
  }

  console.log(`[AutoClose] Closing tab ${tabId} (${info.name})`);
  try {
    await chrome.tabs.remove(tabId);
    await recordClosed(info);
  } catch (err) {
    console.warn(`[AutoClose] Could not close tab ${tabId}:`, err.message);
  }
  chrome.notifications.clear(WARN_PREFIX + tabId);
  await withPending((pending) => { delete pending[tabId]; });
});

chrome.notifications.onButtonClicked.addListener((notificationId) => {
  if (!notificationId.startsWith(WARN_PREFIX)) return;
  chrome.notifications.clear(notificationId);
  cancelClose(Number(notificationId.slice(WARN_PREFIX.length)), 'kept from notification');
});

chrome.notifications.onClicked.addListener(async (notificationId) => {
  if (!notificationId.startsWith(WARN_PREFIX)) return;
  chrome.notifications.clear(notificationId);
  const tabId = Number(notificationId.slice(WARN_PREFIX.length));
  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tabId, { active: true });   // fires onActivated -> timer reset
  } catch { /* tab gone */ }
});

// ---------------------------------------------------------------------------
// Lifecycle. Tab IDs are not stable across browser sessions, and alarms can
// outlive one, so start every session from a clean slate and rescan.
// ---------------------------------------------------------------------------

async function resetSession() {
  const alarms = await chrome.alarms.getAll();
  await Promise.all(alarms
    .filter(a => a.name.startsWith(CLOSE_PREFIX) || a.name.startsWith(WARN_PREFIX))
    .map(a => chrome.alarms.clear(a.name)));
  await withPending((pending) => { for (const k of Object.keys(pending)) delete pending[k]; });
  await rescanTabs();
}

chrome.runtime.onStartup.addListener(resetSession);
chrome.runtime.onInstalled.addListener(resetSession);

// ---------------------------------------------------------------------------
// Popup messages
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const reply = (p) => p.then(sendResponse).catch(err => sendResponse({ ok: false, error: err.message }));

  switch (msg.type) {
    case 'get_state':
      reply((async () => {
        const config = await loadConfig();
        const { recentlyClosed = [] } = await chrome.storage.local.get('recentlyClosed');
        return {
          ok: true,
          pending: await getPending(),
          paused: await isPaused(),
          idleMin: config.idle_minutes,
          patterns: await getManualPatterns(),
          recentlyClosed
        };
      })());
      return true;

    case 'cancel_tab':
      reply(cancelClose(msg.tabId, 'user cancelled from popup').then(() => ({ ok: true })));
      return true;

    case 'cancel_all':
      reply(cancelAll('cancelled all from popup').then(() => ({ ok: true })));
      return true;

    case 'set_paused':
      reply((async () => {
        const paused = msg.paused === true;
        await chrome.storage.local.set({ paused });
        if (paused) await cancelAll('paused');
        await updateBadge(await getPending());
        if (!paused) await rescanTabs();
        return { ok: true, paused };
      })());
      return true;

    case 'reload_config':
      reply((async () => {
        const config = await loadConfig(true);
        // Fresh timers for everything pending so a new idle_minutes applies now.
        const pending = await getPending();
        const patterns = await getAllPatterns();
        for (const [id, info] of Object.entries(pending)) {
          const match = matchPattern(info.url, info.title, patterns);
          if (match) await scheduleClose(Number(id), match, info.url, info.title);
          else await cancelClose(Number(id), 'no longer matches after reload');
        }
        await rescanTabs();
        return { ok: true, idleMin: config.idle_minutes };
      })());
      return true;

    case 'add_manual_pattern':
      reply((async () => {
        const rule = msg.path
          ? { path: normalisePath(msg.path) }
          : { match: String(msg.match || '').trim().replace(/^https?:\/\//i, '') };
        const key = ruleKey(rule);
        if (!key || key.endsWith(':')) return { ok: false, error: 'Pattern is empty' };
        const manual = await getManualPatterns();
        if (manual.some(p => ruleKey(p) === key)) return { ok: false, error: 'Already in the list' };
        const name = String(msg.name || '').trim() || key.split(':')[1].split('/')[0];
        manual.push({ name, ...rule });
        await chrome.storage.local.set({ manualPatterns: manual });
        await rescanTabs();
        console.log(`[AutoClose] Added manual pattern: ${key}`);
        return { ok: true, patterns: manual };
      })());
      return true;

    case 'remove_manual_pattern':
      reply((async () => {
        const manual = (await getManualPatterns()).filter(p => ruleKey(p) !== msg.key);
        await chrome.storage.local.set({ manualPatterns: manual });
        await rescanTabs();
        return { ok: true, patterns: manual };
      })());
      return true;

    case 'reopen':
      reply((async () => {
        await chrome.tabs.create({ url: msg.url, active: true });
        const { recentlyClosed = [] } = await chrome.storage.local.get('recentlyClosed');
        const remaining = recentlyClosed.filter(r => r.url !== msg.url);
        await chrome.storage.local.set({ recentlyClosed: remaining });
        return { ok: true, recentlyClosed: remaining };
      })());
      return true;

    case 'clear_recent':
      reply(chrome.storage.local.set({ recentlyClosed: [] }).then(() => ({ ok: true })));
      return true;
  }
  return false;
});

// Worker (re)start: badge colour once, restore the count.
chrome.action.setBadgeBackgroundColor({ color: '#ea580c' });
getPending().then(updateBadge);
loadConfig(true);
