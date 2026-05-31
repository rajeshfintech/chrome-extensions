function fmtTime(ts) {
  if (!ts) return 'never';
  return new Date(ts).toLocaleTimeString();
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
    document.getElementById('status').textContent =
      `Config loaded: ${fmtTime(data.configLoadedAt)} · ${data.groupCount || 0} group(s)`;
  });
}

document.getElementById('reloadBtn').addEventListener('click', () => {
  const btn = document.getElementById('reloadBtn');
  btn.textContent = 'Reloading…';
  btn.disabled = true;

  chrome.runtime.sendMessage({ type: 'reload_config' }, (res) => {
    btn.textContent = 'Reload Config';
    btn.disabled = false;
    if (res && res.success) {
      document.getElementById('status').textContent =
        `Reloaded at ${fmtTime(Date.now())} · ${res.groupCount} group(s)`;
      refresh();
    }
  });
});

refresh();
