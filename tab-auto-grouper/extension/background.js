// Tab Auto Grouper - background service worker
// Reads config.json (generated from config.yaml via CLI) and groups tabs by URL rules.

// The 9 colors Chrome's tabGroups API accepts. Any other value is rejected
// by the browser, so we fall back to 'grey' when a config color is unknown.
const VALID_COLORS = new Set(['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange']);
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

function configuredGroupNames(config) {
  return new Set((config.groups || []).map(g => g.name));
}

const TAB_GROUP_ID_NONE = chrome.tabGroups?.TAB_GROUP_ID_NONE ?? -1;

async function processTab(tab) {
  if (!tab || !tab.id || !isGroupableUrl(tab.url)) return;

  const config = await loadConfig();
  const match = matchTab(tab.url, config.groups || [], config.exclude || []);

  // Case 1: URL matches a configured group → make sure the tab lives in it.
  if (match) {
    try {
      const existing = await chrome.tabGroups.query({ windowId: tab.windowId });
      const existingGroup = existing.find(g => g.title === match.name);

      if (existingGroup) {
        const desiredColor = VALID_COLORS.has(match.color) ? match.color : 'grey';
        if (existingGroup.color !== desiredColor) {
          try { await chrome.tabGroups.update(existingGroup.id, { color: desiredColor }); }
          catch (e) { console.warn('[TabGrouper] Recolor failed:', e.message); }
        }
        if (tab.groupId === existingGroup.id) return;
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
      console.warn('[TabGrouper] Could not group tab:', err.message);
    }
    return;
  }

  // Case 2: URL no longer matches anything. Evict ONLY if the tab is sitting
  // in one of our managed groups (matches a configured group name). Tabs in
  // user-created groups with unrelated names are left alone — never blow
  // away manual grouping the user did themselves.
  if (!tab.groupId || tab.groupId === TAB_GROUP_ID_NONE) return;
  try {
    const currentGroup = (await chrome.tabGroups.query({ windowId: tab.windowId }))
      .find(g => g.id === tab.groupId);
    if (!currentGroup) return;
    if (configuredGroupNames(config).has(currentGroup.title)) {
      await chrome.tabs.ungroup([tab.id]);
    }
  } catch (err) {
    console.warn('[TabGrouper] Could not evict stale tab:', err.message);
  }
}

// Bulk pass: walk every tab in a window. Returns count of tabs that were
// either moved into a group or evicted from a stale managed group.
async function processAllTabsInWindow(windowId, config) {
  const tabs = await chrome.tabs.query({ windowId });
  const groups = config.groups || [];
  const excludes = config.exclude || [];
  const managedNames = configuredGroupNames(config);

  let existingGroups = await chrome.tabGroups.query({ windowId });
  const groupIdToTitle = new Map(existingGroups.map(g => [g.id, g.title]));

  // Map<groupName, { entries: [{id, groupId}], group }>
  const targets = new Map();
  const toEvict = [];

  for (const tab of tabs) {
    if (!isGroupableUrl(tab.url)) continue;
    const match = matchTab(tab.url, groups, excludes);

    if (match) {
      if (!targets.has(match.name)) {
        targets.set(match.name, { entries: [], group: match });
      }
      targets.get(match.name).entries.push({ id: tab.id, groupId: tab.groupId });
    } else if (tab.groupId && tab.groupId !== TAB_GROUP_ID_NONE) {
      const title = groupIdToTitle.get(tab.groupId);
      if (title && managedNames.has(title)) {
        toEvict.push(tab.id);
      }
    }
  }

  let touched = 0;

  if (toEvict.length) {
    try {
      await chrome.tabs.ungroup(toEvict);
      touched += toEvict.length;
      // Re-query: Chrome auto-removes groups that became empty.
      existingGroups = await chrome.tabGroups.query({ windowId });
    } catch (err) {
      console.warn('[TabGrouper] Failed to ungroup stale tabs:', err.message);
    }
  }

  for (const [name, { entries, group }] of targets) {
    try {
      const existingGroup = existingGroups.find(g => g.title === name);
      if (existingGroup) {
        const desiredColor = VALID_COLORS.has(group.color) ? group.color : 'grey';
        if (existingGroup.color !== desiredColor) {
          try { await chrome.tabGroups.update(existingGroup.id, { color: desiredColor }); }
          catch (e) { console.warn(`[TabGrouper] Failed to recolor "${name}":`, e.message); }
        }
        const idsToMove = entries
          .filter(e => e.groupId !== existingGroup.id)
          .map(e => e.id);
        if (idsToMove.length) {
          await chrome.tabs.group({ tabIds: idsToMove, groupId: existingGroup.id });
          touched += idsToMove.length;
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
        touched += ids.length;
      }
    } catch (err) {
      console.warn(`[TabGrouper] Failed to group "${name}":`, err.message);
    }
  }
  return touched;
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

// Fires on full page load AND on SPA URL changes (pushState/replaceState).
// The latter is important: a Single-Page App can navigate from a matching
// URL to a non-matching one without ever firing status='complete'.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' || changeInfo.url) processTab(tab);
});

chrome.tabs.onCreated.addListener((tab) => {
  setTimeout(() => {
    chrome.tabs.get(tab.id, (t) => {
      if (!chrome.runtime.lastError && t) processTab(t);
    });
  }, 600);
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'reload_config') {
    loadConfig(true).then(async (config) => {
      const touched = await processAllTabs();
      sendResponse({
        success: true,
        groupCount: (config.groups || []).length,
        movedCount: touched
      });
    });
    return true;
  }
  if (msg.type === 'group_all_now') {
    processAllTabs().then(touched => {
      sendResponse({ success: true, movedCount: touched });
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

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'collapse-all-groups') {
    const groups = await chrome.tabGroups.query({});
    await Promise.all(groups.map(g => chrome.tabGroups.update(g.id, { collapsed: true })));
  }
});

chrome.runtime.onInstalled.addListener(() => { processAllTabs(); });
chrome.runtime.onStartup.addListener(() => { processAllTabs(); });

loadConfig(true);
