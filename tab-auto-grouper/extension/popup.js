import { ruleKey } from './rules.js';

const COLOR_HEX = {
  grey: '#5f6368', blue: '#1a73e8', red: '#d93025', yellow: '#f9ab00', green: '#188038',
  pink: '#d01884', purple: '#a142f4', cyan: '#007b83', orange: '#fa903e'
};

let status = { groups: [], manualRules: [] };

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtTime(ts) {
  return ts ? new Date(ts).toLocaleTimeString() : 'never';
}

function setStatus(text) {
  document.getElementById('status').textContent = text;
}

function send(msg) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage(msg, res => {
      if (chrome.runtime.lastError) resolve({ success: false, error: chrome.runtime.lastError.message });
      else resolve(res);
    });
  });
}

function withBusy(btn, busyText, fn) {
  const original = btn.textContent;
  btn.textContent = busyText;
  btn.disabled = true;
  return fn().finally(() => { btn.textContent = original; btn.disabled = false; });
}

// Live tab count per group title, across all windows.
async function groupCounts() {
  const [groups, tabs] = await Promise.all([chrome.tabGroups.query({}), chrome.tabs.query({})]);
  const idToTitle = new Map(groups.map(g => [g.id, g.title]));
  const counts = new Map();
  for (const t of tabs) {
    const title = idToTitle.get(t.groupId);
    if (title !== undefined) counts.set(title, (counts.get(title) || 0) + 1);
  }
  return counts;
}

async function renderGroups() {
  const el = document.getElementById('groups');
  const select = document.getElementById('groupSelect');
  const groups = status.groups || [];

  if (groups.length === 0) {
    el.innerHTML = '<div class="empty">No groups configured</div>';
    select.innerHTML = '';
    document.getElementById('addCurrentBtn').disabled = true;
    return;
  }

  const counts = await groupCounts();
  el.innerHTML = groups.map(g => {
    const n = counts.get(g.name) || 0;
    return `<div class="group-item">
      <span class="swatch" style="background:${COLOR_HEX[g.color] || COLOR_HEX.grey}"></span>
      <span class="group-name">${esc(g.name)}</span>
      <span class="group-count">${n} tab${n === 1 ? '' : 's'}</span>
    </div>`;
  }).join('');

  const previous = select.value;
  select.innerHTML = groups.map(g => `<option value="${esc(g.name)}">${esc(g.name)}</option>`).join('');
  if (groups.some(g => g.name === previous)) select.value = previous;
  document.getElementById('addCurrentBtn').disabled = false;
}

function renderManualRules() {
  const el = document.getElementById('manual-list');
  const rules = status.manualRules || [];
  if (rules.length === 0) {
    el.innerHTML = '<div class="empty">No rules added from the popup</div>';
    return;
  }
  el.innerHTML = rules.map(r => {
    const value = r.domain || r.path;
    return `<div class="manual-item">
      <span class="manual-match" title="${esc(value)}">${esc(value)}</span>
      <span class="manual-group">${esc(r.group)}</span>
      <button class="remove-btn" data-key="${esc(ruleKey(r))}" title="Remove">&times;</button>
    </div>`;
  }).join('');

  el.querySelectorAll('.remove-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const res = await send({ type: 'remove_manual_rule', key: btn.dataset.key });
      if (res?.success) {
        status.manualRules = res.manualRules;
        setStatus(`Rule removed · ${res.movedCount || 0} tab(s) regrouped`);
        await refresh();
      } else {
        setStatus(res?.error || 'Could not remove rule');
      }
    });
  });
}

async function refresh() {
  const res = await send({ type: 'get_status' });
  if (!res || res.success === false) return;
  status = res;
  await renderGroups();
  renderManualRules();
  document.getElementById('loaded-label').textContent = `Config loaded ${fmtTime(res.configLoadedAt)}`;
}

document.getElementById('groupAllBtn').addEventListener('click', () => {
  const btn = document.getElementById('groupAllBtn');
  withBusy(btn, 'Grouping…', async () => {
    const res = await send({ type: 'group_all_now' });
    if (res?.success) {
      const n = res.movedCount || 0;
      setStatus(n === 0 ? 'Already grouped — nothing to move' : `Grouped ${n} tab${n === 1 ? '' : 's'}`);
      await renderGroups();
    }
  });
});

document.getElementById('reloadBtn').addEventListener('click', () => {
  const btn = document.getElementById('reloadBtn');
  withBusy(btn, 'Reloading…', async () => {
    const res = await send({ type: 'reload_config' });
    if (res?.success) {
      const n = res.movedCount || 0;
      setStatus(`Reloaded · ${res.groupCount} group(s) · ${n} tab${n === 1 ? '' : 's'} regrouped`);
      await refresh();
    }
  });
});

document.getElementById('collapseBtn').addEventListener('click', () => {
  const btn = document.getElementById('collapseBtn');
  withBusy(btn, 'Collapsing…', async () => {
    const groups = await chrome.tabGroups.query({});
    await Promise.all(groups.map(g => chrome.tabGroups.update(g.id, { collapsed: true })));
    setStatus(`Collapsed ${groups.length} group(s)`);
  });
});

document.getElementById('addCurrentBtn').addEventListener('click', () => {
  const btn = document.getElementById('addCurrentBtn');
  withBusy(btn, 'Adding…', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url || !/^https?:/i.test(tab.url)) {
      setStatus('Current tab has no groupable URL');
      return;
    }
    const group = document.getElementById('groupSelect').value;
    const domain = new URL(tab.url).hostname.replace(/^www\./, '');
    const res = await send({ type: 'add_manual_rule', group, domain });
    if (res?.success) {
      status.manualRules = res.manualRules;
      setStatus(`${domain} → ${group} · ${res.movedCount || 0} tab(s) grouped`);
      await refresh();
    } else {
      setStatus(res?.error || 'Could not add rule');
    }
  });
});

document.getElementById('snapshotBtn').addEventListener('click', () => {
  const btn = document.getElementById('snapshotBtn');
  withBusy(btn, 'Copying…', async () => {
    const res = await send({ type: 'snapshot_yaml' });
    if (!res?.success) { setStatus(res?.error || 'Snapshot failed'); return; }
    try {
      await navigator.clipboard.writeText(res.yaml);
      setStatus('YAML copied — paste into config.yaml');
    } catch {
      setStatus('Clipboard blocked — open the console to copy');
      console.log(res.yaml);
    }
  });
});

refresh();
