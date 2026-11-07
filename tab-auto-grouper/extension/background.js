// Tab Auto Grouper - background service worker
// Reads config.json (generated from config.yaml via the CLI), merges in rules
// added from the popup, and keeps tabs in the right groups.

import { matchGroup, urlParts, usesTitles, ruleKey, normaliseDomain } from './rules.js';
import { reloadIfUpdatedOnDisk } from './self-update.js';

// The 9 colors Chrome's tabGroups API accepts. Anything else falls back to grey.
const VALID_COLORS = new Set(['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange']);
const CONFIG_TTL_MS = 5000;       // re-read config.json at most every 5 s
const DEDUPE_WINDOW_MS = 5000;    // a tab counts as "new" for this long after creation
const TAB_GROUP_ID_NONE = chrome.tabGroups?.TAB_GROUP_ID_NONE ?? -1;

let configCache = null;
let configLoadedAt = 0;
let configStamp = null;           // identity of the last config seen by this worker

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function stampOf(config) {
  // djb2 over the JSON text: cheap, stable, good enough to detect edits
  const s = JSON.stringify(config);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `${config.generated_at || ''}:${h}`;
}

async function loadConfig(force = false) {
  const now = Date.now();
  if (!force && configCache && (now - configLoadedAt) < CONFIG_TTL_MS) return configCache;
  try {
    const resp = await fetch(chrome.runtime.getURL('config.json'));
    const config = await resp.json();
    configCache = config;
    configLoadedAt = now;
    // `tabgroups install` replaced the extension files: pick up the new code.
    await reloadIfUpdatedOnDisk('TabGrouper');

    const stamp = stampOf(config);
    if (stamp !== configStamp) {
      const stored = configStamp ?? (await chrome.storage.local.get('configStamp')).configStamp;
      configStamp = stamp;
      await chrome.storage.local.set({
        configStamp: stamp,
        configLoadedAt: now,
        groupCount: (config.groups || []).length,
        groupNames: (config.groups || []).map(g => g.name)
      });
      // Config changed since this profile last saw it (e.g. `tabgroups sync`
      // ran while the worker was asleep): regroup everything once.
      if (stored && stored !== stamp) {
        console.log('[TabGrouper] Config changed, regrouping all tabs');
        processAllTabs().catch(err => console.warn('[TabGrouper] Regroup failed:', err.message));
      }
    }
    return config;
  } catch (err) {
    console.error('[TabGrouper] Failed to load config:', err);
    return configCache || { groups: [] };
  }
}

// Rules added from the popup live in chrome.storage so they survive syncs.
// Shape: [{ group: "Work", domain: "example.com" }]
async function getManualRules() {
  const { manualRules = [] } = await chrome.storage.local.get('manualRules');
  return manualRules;
}

// Config groups with popup-added rules merged in. A manual rule naming a
// group that is not in config.yaml creates a grey group of that name.
function effectiveGroups(config, manualRules) {
  const groups = (config.groups || []).map(g => ({ ...g, rules: [...(g.rules || [])] }));
  const byName = new Map(groups.map(g => [g.name, g]));
  for (const r of manualRules) {
    const { group: name, ...rule } = r;
    if (!name || !ruleKey(rule)) continue;
    if (!byName.has(name)) {
      const g = { name, color: 'grey', collapsed: false, rules: [] };
      groups.push(g);
      byName.set(name, g);
    }
    byName.get(name).rules.push(rule);
  }
  return groups;
}

async function effectiveConfig() {
  const config = await loadConfig();
  const manual = await getManualRules();
  const groups = effectiveGroups(config, manual);
  return {
    groups,
    excludes: config.exclude || [],
    managedNames: new Set(groups.map(g => g.name)),
    titleRules: usesTitles(groups.flatMap(g => g.rules)) || usesTitles(config.exclude),
    sortGroups: config.sort_groups === true,
    dedupeTabs: config.dedupe_tabs === true,
  };
}

function colorFor(group) {
  return VALID_COLORS.has(group.color) ? group.color : 'grey';
}

// ---------------------------------------------------------------------------
// Per-window serialisation. Chrome fires tab events concurrently; two tabs
// that match the same group would otherwise both see "no group yet" and each
// create their own. Everything that mutates groups runs through here.
// ---------------------------------------------------------------------------

const windowQueues = new Map();

function enqueue(windowId, fn) {
  const prev = windowQueues.get(windowId) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  windowQueues.set(windowId, next);
  next.finally(() => { if (windowQueues.get(windowId) === next) windowQueues.delete(windowId); }).catch(() => {});
  return next;
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

function isGroupableUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}

async function ensureGroup(windowId, group, tabIds, existingGroups) {
  const existing = existingGroups.find(g => g.title === group.name);
  const color = colorFor(group);
  if (existing) {
    if (existing.color !== color) {
      try { await chrome.tabGroups.update(existing.id, { color }); }
      catch (e) { console.warn(`[TabGrouper] Recolor "${group.name}" failed:`, e.message); }
    }
    if (tabIds.length) await chrome.tabs.group({ tabIds, groupId: existing.id });
    return existing.id;
  }
  const groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
  await chrome.tabGroups.update(groupId, {
    title: group.name,
    color,
    collapsed: group.collapsed === true
  });
  return groupId;
}

async function processTabNow(tab, cfg) {
  if (!tab || !tab.id) return;
  // Re-read the tab: the event snapshot may be stale by the time the queue
  // reaches it (an earlier bulk pass may already have moved it).
  try { tab = await chrome.tabs.get(tab.id); } catch { return; }
  if (tab.pinned || !isGroupableUrl(tab.url)) return;

  const match = matchGroup(tab.url, tab.title, cfg.groups, cfg.excludes);
  const existingGroups = await chrome.tabGroups.query({ windowId: tab.windowId });

  // Case 1: URL matches a group. Make sure the tab lives in it.
  if (match) {
    try {
      const current = existingGroups.find(g => g.id === tab.groupId);
      if (current && current.title === match.name) {
        // Already in the right group; keep its colour in sync and stop.
        await ensureGroup(tab.windowId, match, [], existingGroups);
        return;
      }
      await ensureGroup(tab.windowId, match, [tab.id], existingGroups);
    } catch (err) {
      console.warn('[TabGrouper] Could not group tab:', err.message);
    }
    return;
  }

  // Case 2: no rule matches. Evict only from groups we manage (names in the
  // config). User-created groups with other names are never touched.
  if (!tab.groupId || tab.groupId === TAB_GROUP_ID_NONE) return;
  try {
    const current = existingGroups.find(g => g.id === tab.groupId);
    if (current && cfg.managedNames.has(current.title)) {
      await chrome.tabs.ungroup([tab.id]);
    }
  } catch (err) {
    console.warn('[TabGrouper] Could not evict stale tab:', err.message);
  }
}

async function processTab(tab) {
  if (!tab || tab.windowId === undefined) return;
  const cfg = await effectiveConfig();
  return enqueue(tab.windowId, () => processTabNow(tab, cfg));
}

// Bulk pass over one window. Returns how many tabs were moved or evicted.
async function processAllTabsInWindowNow(windowId, cfg) {
  const tabs = await chrome.tabs.query({ windowId });
  let existingGroups = await chrome.tabGroups.query({ windowId });
  const groupIdToTitle = new Map(existingGroups.map(g => [g.id, g.title]));

  const targets = new Map();   // group name -> { group, entries: [{id, groupId}] }
  const toEvict = [];

  for (const tab of tabs) {
    if (tab.pinned || !isGroupableUrl(tab.url)) continue;
    const match = matchGroup(tab.url, tab.title, cfg.groups, cfg.excludes);
    if (match) {
      if (!targets.has(match.name)) targets.set(match.name, { group: match, entries: [] });
      targets.get(match.name).entries.push({ id: tab.id, groupId: tab.groupId });
    } else if (tab.groupId && tab.groupId !== TAB_GROUP_ID_NONE) {
      const title = groupIdToTitle.get(tab.groupId);
      if (title && cfg.managedNames.has(title)) toEvict.push(tab.id);
    }
  }

  let touched = 0;

  if (toEvict.length) {
    try {
      await chrome.tabs.ungroup(toEvict);
      touched += toEvict.length;
      existingGroups = await chrome.tabGroups.query({ windowId }); // empty groups vanish
    } catch (err) {
      console.warn('[TabGrouper] Failed to ungroup stale tabs:', err.message);
    }
  }

  for (const [name, { group, entries }] of targets) {
    try {
      const existing = existingGroups.find(g => g.title === name);
      const ids = entries.filter(e => !existing || e.groupId !== existing.id).map(e => e.id);
      const groupId = await ensureGroup(windowId, group, ids, existingGroups);
      touched += ids.length;
      if (!existing) existingGroups.push({ id: groupId, title: name, color: colorFor(group) });
    } catch (err) {
      console.warn(`[TabGrouper] Failed to group "${name}":`, err.message);
    }
  }

  if (cfg.sortGroups) await sortGroupsInWindow(windowId, cfg);
  return touched;
}

// Arrange managed groups left-to-right in config order, after pinned tabs.
async function sortGroupsInWindow(windowId, cfg) {
  const [tabs, groups] = await Promise.all([
    chrome.tabs.query({ windowId }),
    chrome.tabGroups.query({ windowId })
  ]);
  const byTitle = new Map(groups.map(g => [g.title, g]));
  const sizes = new Map();
  for (const t of tabs) sizes.set(t.groupId, (sizes.get(t.groupId) || 0) + 1);

  let index = tabs.filter(t => t.pinned).length;
  for (const group of cfg.groups) {
    const g = byTitle.get(group.name);
    if (!g) continue;
    try { await chrome.tabGroups.move(g.id, { index }); }
    catch (err) { console.warn(`[TabGrouper] Could not move "${group.name}":`, err.message); }
    index += sizes.get(g.id) || 0;
  }
}

// Bulk passes are coalesced: install, startup and a config change can all
// ask for one within the same tick. A request made while a pass is running
// queues exactly one more pass (with fresh config) once it finishes.
let bulkRun = null;
let bulkRerun = false;

function processAllTabs() {
  if (bulkRun) { bulkRerun = true; return bulkRun; }
  bulkRun = (async () => {
    let total = 0;
    do {
      bulkRerun = false;
      const cfg = await effectiveConfig();
      const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
      for (const w of windows) {
        total += await enqueue(w.id, () => processAllTabsInWindowNow(w.id, cfg));
      }
    } while (bulkRerun);
    return total;
  })().finally(() => { bulkRun = null; });
  return bulkRun;
}

// ---------------------------------------------------------------------------
// Duplicate tabs (opt-in via `dedupe_tabs: true`): when a freshly created tab
// lands on a URL that is already open in the same window, focus the existing
// tab and close the new one. Only brand-new tabs qualify, so navigating an
// existing tab never destroys its history.
// ---------------------------------------------------------------------------

const createdAt = new Map();

function dedupeKey(url) {
  try { const u = new URL(url); u.hash = ''; return u.href; } catch { return null; }
}

async function dedupeNewTab(tab) {
  const born = createdAt.get(tab.id);
  if (!born || Date.now() - born > DEDUPE_WINDOW_MS) return false;
  const key = dedupeKey(tab.url);
  if (!key || !isGroupableUrl(tab.url)) return false;

  const siblings = await chrome.tabs.query({ windowId: tab.windowId });
  const twin = siblings.find(t => t.id !== tab.id && dedupeKey(t.url) === key);
  if (!twin) return false;

  try {
    await chrome.tabs.update(twin.id, { active: true });
    await chrome.tabs.remove(tab.id);
    console.log(`[TabGrouper] Deduplicated tab ${tab.id} onto ${twin.id}`);
    return true;
  } catch (err) {
    console.warn('[TabGrouper] Dedupe failed:', err.message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

// onUpdated fires several times per navigation (url, loading, title, complete).
// Remember what we last processed per tab so one navigation is handled once.
const lastProcessed = new Map();

chrome.tabs.onCreated.addListener((tab) => {
  createdAt.set(tab.id, Date.now());
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  const relevant = changeInfo.url !== undefined
    || changeInfo.status === 'complete'
    || changeInfo.title !== undefined;
  if (!relevant || !tab.url) return;

  const cfg = await effectiveConfig();
  const key = cfg.titleRules ? `${tab.url}\n${tab.title || ''}` : tab.url;
  if (lastProcessed.get(tabId) === key) return;
  lastProcessed.set(tabId, key);

  if (cfg.dedupeTabs && changeInfo.url !== undefined && await dedupeNewTab(tab)) return;
  await enqueue(tab.windowId, () => processTabNow(tab, cfg));
});

chrome.tabs.onRemoved.addListener((tabId) => {
  lastProcessed.delete(tabId);
  createdAt.delete(tabId);
});

chrome.tabs.onDetached.addListener((tabId) => {
  lastProcessed.delete(tabId); // re-evaluate once it lands in the new window
});

chrome.tabs.onAttached.addListener(async (tabId) => {
  try { await processTab(await chrome.tabs.get(tabId)); } catch { /* gone */ }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const reply = (p) => p.then(sendResponse).catch(err => sendResponse({ success: false, error: err.message }));

  switch (msg.type) {
    case 'reload_config':
      reply((async () => {
        const config = await loadConfig(true);
        const moved = await processAllTabs();
        return { success: true, groupCount: (config.groups || []).length, movedCount: moved };
      })());
      return true;

    case 'group_all_now':
      reply(processAllTabs().then(moved => ({ success: true, movedCount: moved })));
      return true;

    case 'get_status':
      reply((async () => {
        const data = await chrome.storage.local.get(['configLoadedAt', 'groupCount']);
        const cfg = await effectiveConfig();
        return {
          ...data,
          groups: cfg.groups.map(g => ({ name: g.name, color: colorFor(g) })),
          manualRules: await getManualRules()
        };
      })());
      return true;

    case 'add_manual_rule':
      reply((async () => {
        const name = String(msg.group || '').trim();
        const rule = msg.path ? { path: String(msg.path).trim() } : { domain: normaliseDomain(msg.domain || '') };
        const key = ruleKey(rule);
        if (!name) return { success: false, error: 'Pick a group' };
        if (!key || key.endsWith(':')) return { success: false, error: 'Nothing to add' };
        const manual = await getManualRules();
        if (manual.some(r => ruleKey(r) === key)) return { success: false, error: 'Already in the list' };
        manual.push({ group: name, ...rule });
        await chrome.storage.local.set({ manualRules: manual });
        const moved = await processAllTabs();
        return { success: true, manualRules: manual, movedCount: moved };
      })());
      return true;

    case 'remove_manual_rule':
      reply((async () => {
        const manual = (await getManualRules()).filter(r => ruleKey(r) !== msg.key);
        await chrome.storage.local.set({ manualRules: manual });
        const moved = await processAllTabs();
        return { success: true, manualRules: manual, movedCount: moved };
      })());
      return true;

    case 'snapshot_yaml':
      reply(snapshotYaml().then(yaml => ({ success: true, yaml })));
      return true;
  }
  return false;
});

// Turn the groups currently open in Chrome into config.yaml text, one domain
// rule per distinct host, so a config can be bootstrapped from real usage.
async function snapshotYaml() {
  const [groups, tabs] = await Promise.all([chrome.tabGroups.query({}), chrome.tabs.query({})]);
  const hostsByTitle = new Map();
  const colorByTitle = new Map();
  for (const g of groups) {
    const title = g.title || 'Untitled';
    if (!hostsByTitle.has(title)) { hostsByTitle.set(title, new Set()); colorByTitle.set(title, g.color); }
  }
  const idToTitle = new Map(groups.map(g => [g.id, g.title || 'Untitled']));
  for (const t of tabs) {
    const title = idToTitle.get(t.groupId);
    if (!title || !isGroupableUrl(t.url)) continue;
    const parts = urlParts(t.url);
    if (parts) hostsByTitle.get(title).add(parts.host);
  }
  const q = s => JSON.stringify(String(s));
  const lines = ['# Snapshot of current Chrome tab groups', 'version: 1', '', 'groups:'];
  for (const [title, hosts] of hostsByTitle) {
    lines.push(`  - name: ${q(title)}`, `    color: ${colorByTitle.get(title)}`, '    rules:');
    if (!hosts.size) lines.push('      []');
    for (const h of [...hosts].sort()) lines.push(`      - domain: ${h}`);
    lines.push('');
  }
  return lines.join('\n');
}

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'collapse-all-groups') {
    const groups = await chrome.tabGroups.query({});
    await Promise.all(groups.map(g => chrome.tabGroups.update(g.id, { collapsed: true })));
  }
});

chrome.runtime.onInstalled.addListener(() => { loadConfig(true).then(processAllTabs); });
chrome.runtime.onStartup.addListener(() => { loadConfig(true).then(processAllTabs); });

loadConfig(true);
