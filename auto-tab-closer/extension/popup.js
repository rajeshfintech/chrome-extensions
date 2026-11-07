let state = { pending: {}, paused: false, patterns: [], recentlyClosed: [] };

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function send(msg) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage(msg, res => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(res);
    });
  });
}

function fmtCountdown(closeAt) {
  const ms = closeAt - Date.now();
  if (ms <= 0) return '0:00';
  const totalSec = Math.ceil(ms / 1000);
  return `${Math.floor(totalSec / 60)}:${(totalSec % 60).toString().padStart(2, '0')}`;
}

function fmtAgo(ts) {
  const min = Math.round((Date.now() - ts) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 24 ? `${h} h ago` : new Date(ts).toLocaleDateString();
}

function truncate(str, max = 38) {
  return str.length > max ? str.slice(0, max) + '…' : str;
}

function setStatus(text) {
  document.getElementById('status').textContent = text;
}

function patternValue(p) {
  return p.domain || p.path || p.match || p.pattern || p.title || '';
}

function patternKey(p) {
  for (const k of ['domain', 'path', 'match', 'pattern', 'title']) {
    if (p[k]) return `${k}:${String(p[k]).trim().toLowerCase()}`;
  }
  return '';
}

function renderTabs() {
  const el = document.getElementById('tabs-list');
  const entries = Object.entries(state.pending);
  document.getElementById('cancelAllBtn').disabled = entries.length === 0;

  if (entries.length === 0) {
    el.innerHTML = `<div class="empty">${state.paused ? 'Paused — nothing will be closed' : 'No tabs pending closure'}</div>`;
    return;
  }

  el.innerHTML = entries.map(([tabId, info]) => {
    const urgent = (info.closeAt - Date.now()) < 60_000 ? ' urgent' : '';
    return `
      <div class="tab-item">
        <div class="tab-info">
          <div class="tab-site">${esc(info.name)}</div>
          <div class="tab-title">${esc(truncate(info.title || info.url))}</div>
        </div>
        <span class="tab-countdown${urgent}" data-close-at="${info.closeAt}">closes in ${fmtCountdown(info.closeAt)}</span>
        <button class="cancel-btn" data-tab-id="${tabId}">Keep</button>
      </div>`;
  }).join('');

  el.querySelectorAll('.cancel-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const tabId = parseInt(btn.dataset.tabId, 10);
      btn.textContent = '…';
      btn.disabled = true;
      await send({ type: 'cancel_tab', tabId });
      delete state.pending[tabId];
      renderTabs();
    });
  });
}

function tickCountdowns() {
  document.querySelectorAll('.tab-countdown[data-close-at]').forEach(el => {
    const closeAt = parseInt(el.dataset.closeAt, 10);
    el.textContent = `closes in ${fmtCountdown(closeAt)}`;
    el.classList.toggle('urgent', (closeAt - Date.now()) < 60_000);
  });
}

function renderPaused() {
  const btn = document.getElementById('pauseBtn');
  btn.textContent = state.paused ? 'Resume' : 'Pause';
  btn.classList.toggle('paused', state.paused);
  document.body.classList.toggle('is-paused', state.paused);
}

function renderManualList() {
  const el = document.getElementById('manual-list');
  const patterns = state.patterns || [];
  if (patterns.length === 0) {
    el.innerHTML = '<div class="empty">No manual links</div>';
    return;
  }
  el.innerHTML = patterns.map(p => {
    const v = patternValue(p);
    return `<div class="manual-item">
      <span class="manual-match" title="${esc(v)}">${esc(v)}</span>
      <button class="remove-btn" data-key="${esc(patternKey(p))}" title="Remove">&times;</button>
    </div>`;
  }).join('');

  el.querySelectorAll('.remove-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const res = await send({ type: 'remove_manual_pattern', key: btn.dataset.key });
      if (res?.ok) {
        state.patterns = res.patterns;
        renderManualList();
        setStatus('Link removed from watch list');
        await refresh();
      }
    });
  });
}

function renderRecent() {
  const el = document.getElementById('recent-list');
  const items = state.recentlyClosed || [];
  document.getElementById('clearRecentBtn').style.display = items.length ? '' : 'none';
  if (items.length === 0) {
    el.innerHTML = '<div class="empty">Nothing closed yet</div>';
    return;
  }
  el.innerHTML = items.map(r => `
    <div class="recent-item">
      <div class="tab-info">
        <div class="recent-title" title="${esc(r.url)}">${esc(truncate(r.title || r.url, 34))}</div>
        <div class="recent-meta">${esc(r.name)} · ${esc(fmtAgo(r.closedAt))}</div>
      </div>
      <button class="reopen-btn" data-url="${esc(r.url)}">Reopen</button>
    </div>`).join('');

  el.querySelectorAll('.reopen-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const res = await send({ type: 'reopen', url: btn.dataset.url });
      if (res?.ok) { state.recentlyClosed = res.recentlyClosed; renderRecent(); }
    });
  });
}

async function refresh() {
  const res = await send({ type: 'get_state' });
  if (!res?.ok) return;
  state = res;
  document.getElementById('idle-label').textContent = `${res.idleMin} min idle`;
  renderPaused();
  renderTabs();
  renderManualList();
  renderRecent();
}

async function addPattern(fields) {
  const res = await send({ type: 'add_manual_pattern', ...fields });
  if (res?.ok) {
    state.patterns = res.patterns;
    renderManualList();
    setStatus('Link added — matching tabs are now on the timer');
    await refresh();
  } else {
    setStatus(res?.error || 'Could not add link');
  }
  return res?.ok;
}

document.getElementById('cancelAllBtn').addEventListener('click', async () => {
  const btn = document.getElementById('cancelAllBtn');
  btn.textContent = 'Cancelling…';
  btn.disabled = true;
  await send({ type: 'cancel_all' });
  state.pending = {};
  renderTabs();
  btn.textContent = 'Cancel All';
  setStatus(`All cancelled at ${new Date().toLocaleTimeString()}`);
});

document.getElementById('pauseBtn').addEventListener('click', async () => {
  const res = await send({ type: 'set_paused', paused: !state.paused });
  if (res?.ok) {
    setStatus(res.paused ? 'Paused — timers cleared until you resume' : 'Resumed — open tabs rescanned');
    await refresh();
  }
});

document.getElementById('reloadBtn').addEventListener('click', async () => {
  const btn = document.getElementById('reloadBtn');
  btn.textContent = 'Reloading…';
  btn.disabled = true;
  const res = await send({ type: 'reload_config' });
  btn.textContent = 'Reload Config';
  btn.disabled = false;
  if (res?.ok) {
    setStatus(`Config reloaded — idle: ${res.idleMin} min`);
    await refresh();
  }
});

document.getElementById('addPatternBtn').addEventListener('click', async () => {
  const input = document.getElementById('patternInput');
  if (await addPattern({ match: input.value })) input.value = '';
});

document.getElementById('patternInput').addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return;
  const input = document.getElementById('patternInput');
  if (await addPattern({ match: input.value })) input.value = '';
});

document.getElementById('addCurrentBtn').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || !/^https?:/i.test(tab.url)) {
    setStatus('Current tab has no watchable URL');
    return;
  }
  const u = new URL(tab.url);
  await addPattern({ path: u.hostname + u.pathname, name: u.hostname.replace(/^www\./, '') });
});

document.getElementById('clearRecentBtn').addEventListener('click', async () => {
  await send({ type: 'clear_recent' });
  state.recentlyClosed = [];
  renderRecent();
});

refresh();
setInterval(refresh, 5000);
setInterval(tickCountdowns, 1000);
