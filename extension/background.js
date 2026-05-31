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
  if (!tab || !tab.id || !tab.url) return;
  if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') ||
      tab.url.startsWith('about:') || tab.url === 'chrome://newtab/') return;

  const config = await loadConfig();
  const match = matchTab(tab.url, config.groups || [], config.exclude || []);
  if (!match) return;

  try {
    const existing = await chrome.tabGroups.query({ windowId: tab.windowId });
    const existingGroup = existing.find(g => g.title === match.name);

    if (existingGroup) {
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
    loadConfig(true).then(config => {
      sendResponse({ success: true, groupCount: (config.groups || []).length });
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

// Eager load on startup
loadConfig(true);
