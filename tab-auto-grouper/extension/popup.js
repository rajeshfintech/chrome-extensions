function fmtTime(ts) {
  if (!ts) return 'never';
  return new Date(ts).toLocaleTimeString();
}

function setStatus(text) {
  document.getElementById('status').textContent = text;
}

function renderGroups(names) {
  const el = document.getElementById('groups');
  if (!names || names.length === 0) {
    el.innerHTML = '<div class="empty">No groups configured</div>';
    return;
  }
  el.innerHTML = names.map(n =>
    `<div class="group-item"><span class="group-name">${n}</span></div>`
  ).join('');
}

function refresh() {
  chrome.runtime.sendMessage({ type: 'get_status' }, (data) => {
    if (chrome.runtime.lastError || !data) return;
    renderGroups(data.groupNames);
    setStatus(`Config loaded: ${fmtTime(data.configLoadedAt)} · ${data.groupCount || 0} group(s)`);
  });
}

function withButtonBusy(btn, busyText, fn) {
  const original = btn.textContent;
  btn.textContent = busyText;
  btn.disabled = true;
  fn(() => {
    btn.textContent = original;
    btn.disabled = false;
  });
}

document.getElementById('groupAllBtn').addEventListener('click', () => {
  const btn = document.getElementById('groupAllBtn');
  withButtonBusy(btn, 'Grouping…', (done) => {
    chrome.runtime.sendMessage({ type: 'group_all_now' }, (res) => {
      done();
      if (res && res.success) {
        const n = res.movedCount || 0;
        setStatus(n === 0
          ? 'Already grouped — no tabs to move'
          : `Grouped ${n} tab${n === 1 ? '' : 's'} at ${fmtTime(Date.now())}`);
      }
    });
  });
});

document.getElementById('reloadBtn').addEventListener('click', () => {
  const btn = document.getElementById('reloadBtn');
  withButtonBusy(btn, 'Reloading…', (done) => {
    chrome.runtime.sendMessage({ type: 'reload_config' }, (res) => {
      done();
      if (res && res.success) {
        const moved = res.movedCount || 0;
        setStatus(`Reloaded · ${res.groupCount} group(s) · ${moved} tab${moved === 1 ? '' : 's'} regrouped`);
        refresh();
      }
    });
  });
});

document.getElementById('collapseBtn').addEventListener('click', async () => {
  const btn = document.getElementById('collapseBtn');
  btn.textContent = 'Collapsing…';
  btn.disabled = true;

  const groups = await chrome.tabGroups.query({});
  await Promise.all(groups.map(g => chrome.tabGroups.update(g.id, { collapsed: true })));

  btn.textContent = 'Collapse All';
  btn.disabled = false;
  document.getElementById('status').textContent =
    `Collapsed ${groups.length} group(s) at ${fmtTime(Date.now())}`;
});

refresh();
