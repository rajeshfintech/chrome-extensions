// Tab Auto Grouper - background service worker
// Reads config.json (generated from config.yaml via CLI) and groups tabs by URL rules.

const VALID_COLORS = new Set(['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan']);
const CONFIG_TTL_MS = 5000; // re-read config.json at most every 5s

let configCache = null;
let configLoadedAt = 0;

async function loadConfig(force = false) {
  const now = Date.now();
  if (!force && configCache && (now - configLoadedAt) < CONFIG_TTL_MS) {
    return configCache;
  }
  try {
    const resp = await fetch(chrome.runtime.getURL('config.json'));
    const config = await resp.json();
    configCache = config;
    configLoadedAt = now;
    await chrome.storage.local.set({
      configLoadedAt: now,
      groupCount: (config.groups || []).length,
      groupNames: (config.groups || []).map(g => g.name)
    });
    return config;
  } catch (err) {
    console.error('[TabGrouper] Failed to load config:', err);
    return configCache || { groups: [] };
  }
}

function urlParts(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const fullPath = (host + u.pathname).toLowerCase();
    return { host, fullPath };
  } catch { return null; }
}

function matchesRules(parts, rules) {
  for (const rule of (rules || [])) {
    if (rule.domain) {
      const d = rule.domain.toLowerCase().replace(/^www\./, '');
      if (parts.host === d || parts.host.endsWith('.' + d)) return true;
    }
    if (rule.path) {
      const p = rule.path.toLowerCase().replace(/^www\./, '');
      if (parts.fullPath === p || parts.fullPath.startsWith(p + '/') || parts.fullPath.startsWith(p + '?')) return true;
    }
  }
  return false;
}

function isGroupableUrl(url) {
  if (!url) return false;
  if (url.startsWith('chrome://') || url.startsWith('chrome-extension://') ||
      url.startsWith('about:') || url === 'chrome://newtab/') return false;
  return true;
}

function matchTab(url, groups, excludes) {
  const parts = urlParts(url);
  if (!parts) return null;
  if (excludes && excludes.length && matchesRules(parts, excludes)) return null;
  for (const group of groups) {
    if (matchesRules(parts, group.rules)) return group;
  }
  return null;
}

async function processTab(tab) {
  if (!tab || !tab.id || !isGroupableUrl(tab.url)) return;

  const config = await loadConfig();
  const match = matchTab(tab.url, config.groups || [], config.exclude || []);
  if (!match) return;

  try {
    const existing = await chrome.tabGroups.query({ windowId: tab.windowId });
    const existingGroup = existing.find(g => g.title === match.name);

    if (existingGroup) {
      if (tab.groupId === existingGroup.id) return; // already correctly grouped
      await chrome.tabs.group({ tabIds: [tab.id], groupId: existingGroup.id });
    } else {
      const color = VALID_COLORS.has(match.color) ? match.color : 'grey';
      const groupId = await chrome.tabs.group({ tabIds: [tab.id] });
      await chrome.tabGroups.update(groupId, {
        title: match.name,
        color,
        collapsed: match.collapsed === true
      });
    }
  } catch (err) {
    // Tab may have been closed or moved between windows; not a fatal error
    console.warn('[TabGrouper] Could not group tab:', err.message);
  }
}

// Bulk pass: walk every tab in a window and fold matching tabs into their
// target groups, regardless of current position or current group membership.
// Chrome's tabs.group() will move non-adjacent tabs next to the group for us.
async function processAllTabsInWindow(windowId, config) {
  const tabs = await chrome.tabs.query({ windowId });
  const groups = config.groups || [];
  const excludes = config.exclude || [];

  // Map<groupName, { entries: [{id, groupId}], group }>
  const targets = new Map();
  for (const tab of tabs) {
    if (!isGroupableUrl(tab.url)) continue;
    const match = matchTab(tab.url, groups, excludes);
    if (!match) continue;
    if (!targets.has(match.name)) {
      targets.set(match.name, { entries: [], group: match });
    }
    targets.get(match.name).entries.push({ id: tab.id, groupId: tab.groupId });
  }
  if (targets.size === 0) return 0;

  const existingGroups = await chrome.tabGroups.query({ windowId });
  let moved = 0;

  for (const [name, { entries, group }] of targets) {
    try {
      const existingGroup = existingGroups.find(g => g.title === name);
      if (existingGroup) {
        const idsToMove = entries
          .filter(e => e.groupId !== existingGroup.id)
          .map(e => e.id);
        if (idsToMove.length) {
          await chrome.tabs.group({ tabIds: idsToMove, groupId: existingGroup.id });
          moved += idsToMove.length;
        }
      } else {
        const ids = entries.map(e => e.id);
        const groupId = await chrome.tabs.group({ tabIds: ids });
        const color = VALID_COLORS.has(group.color) ? group.color : 'grey';
        await chrome.tabGroups.update(groupId, {
          title: name,
          color,
          collapsed: group.collapsed === true
        });
        moved += ids.length;
      }
    } catch (err) {
      console.warn(`[TabGrouper] Failed to group "${name}":`, err.message);
    }
  }
  return moved;
}

async function processAllTabs() {
  const config = await loadConfig();
  const windows = await chrome.windows.getAll();
  let total = 0;
  for (const w of windows) {
    total += await processAllTabsInWindow(w.id, config);
  }
  return total;
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete') processTab(tab);
});

chrome.tabs.onCreated.addListener((tab) => {
  // Wait briefly for the URL to populate after creation
  setTimeout(() => {
    chrome.tabs.get(tab.id, (t) => {
      if (!chrome.runtime.lastError && t) processTab(t);
    });
  }, 600);
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'reload_config') {
    loadConfig(true).then(async (config) => {
      const moved = await processAllTabs();
      sendResponse({
        success: true,
        groupCount: (config.groups || []).length,
        movedCount: moved
      });
    });
    return true;
  }
  if (msg.type === 'group_all_now') {
    processAllTabs().then(moved => {
      sendResponse({ success: true, movedCount: moved });
    });
    return true;
  }
  if (msg.type === 'get_status') {
    chrome.storage.local.get(['configLoadedAt', 'groupCount', 'groupNames'], (data) => {
      sendResponse(data);
    });
    return true;
  }
});

// Group any already-open tabs when the extension is installed/updated or
// when Chrome starts up — without this, pre-existing tabs are invisible
// to the per-tab listeners above.
chrome.runtime.onInstalled.addListener(() => { processAllTabs(); });
chrome.runtime.onStartup.addListener(() => { processAllTabs(); });

// Eager load on service-worker wake-up
loadConfig(true);
