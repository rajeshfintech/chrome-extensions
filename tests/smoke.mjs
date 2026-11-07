// End-to-end smoke test: launches a Chromium build with both extensions loaded and
// drives their service workers and popups over the DevTools protocol.
//
//   CHROME_BIN="/path/to/Chromium" node tests/smoke.mjs
//
// Needs a Chromium / Chrome for Testing binary: Google Chrome itself ignores
// --load-extension since v137. Playwright's cached build works, e.g.
//   ~/Library/Caches/ms-playwright/chromium-*/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing
// Not part of CI; run it locally before tagging a release.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME_BIN;
if (!CHROME) { console.error('Set CHROME_BIN to a Chromium / Chrome for Testing binary'); process.exit(2); }
const repo = process.cwd();
const exts = [join(repo, 'tab-auto-grouper/extension'), join(repo, 'auto-tab-closer/extension')];
const port = 9333;
const udd = mkdtempSync(join(tmpdir(), 'ext-smoke-'));

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${port}`, `--user-data-dir=${udd}`, '--no-first-run', '--no-default-browser-check',
  `--load-extension=${exts.join(',')}`, '--headless=new', '--disable-gpu',
  ...(process.env.CI ? ['--no-sandbox', '--disable-dev-shm-usage'] : []), 'about:blank'
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function targets() { return (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); }

let id = 0;
async function connect(ws) {
  const sock = new WebSocket(ws);
  await new Promise((res, rej) => { sock.onopen = res; sock.onerror = rej; });
  const waiting = new Map();
  const events = [];
  sock.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
    else events.push(msg);
  };
  const call = (method, params = {}) => new Promise(res => { const i = ++id; waiting.set(i, res); sock.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expr) => {
    const r = await call('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails));
    return r.result?.result?.value;
  };
  return { call, evaluate, events, close: () => sock.close() };
}

let failures = 0;
function check(name, cond, detail = '') { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); if (!cond) failures++; }

try {
  let list = [];
  const ours = l => l.filter(t => t.type === 'service_worker' && t.url.endsWith('/background.js'));
  for (let i = 0; i < 80 && ours(list).length < 2; i++) { await sleep(250); try { list = await targets(); } catch {} }
  const workers = ours(list);
  check('both service workers registered', workers.length === 2, workers.map(w => w.url).join(', '));

  const byName = {};
  for (const w of workers) {
    const c = await connect(w.webSocketDebuggerUrl);
    await c.call('Runtime.enable');
    const name = await c.evaluate('chrome.runtime.getManifest().name');
    byName[name] = c;
  }
  const grouper = byName['Tab Auto Grouper'];
  const closer = byName['Auto Tab Closer'];

  // Open each popup as a page so we can sendMessage from a real extension context.
  const popups = {};
  for (const w of workers) {
    const extId = new URL(w.url).host;
    const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const browser = await connect(ver.webSocketDebuggerUrl);
    const created = await browser.call('Target.createTarget', { url: `chrome-extension://${extId}/popup.html` });
    await sleep(1000);
    const page = (await targets()).find(t => t.id === created.result.targetId);
    const c = await connect(page.webSocketDebuggerUrl);
    await c.call('Runtime.enable');
    const name = await c.evaluate('document.title');
    popups[name] = c;
    browser.close();
  }
  const gpop = popups['Tab Auto Grouper'];
  const cpop = popups['Auto Tab Closer'];
  check('both popups open', !!gpop && !!cpop, Object.keys(popups).join(','));
  const msg = (c, m) => c.evaluate(`new Promise(r => chrome.runtime.sendMessage(${JSON.stringify(m)}, r))`);
  check('grouper worker reachable', !!grouper);
  check('closer worker reachable', !!closer);

  // Grouper: open tabs matching Work and AI groups, plus a non-matching one.
  const urls = ['https://github.com/login', 'https://api.github.com/', 'https://gemini.google.com/app', 'https://mail.google.com/', 'https://example.com/'];
  await grouper.evaluate(`Promise.all(${JSON.stringify(urls)}.map(u => chrome.tabs.create({ url: u, active: false })))`);
  await sleep(4000);
  const groups = await grouper.evaluate(`(async () => {
    const gs = await chrome.tabGroups.query({});
    const ts = await chrome.tabs.query({});
    return gs.map(g => ({ title: g.title, color: g.color, tabs: ts.filter(t => t.groupId === g.id).map(t => t.url) }));
  })()`);
  console.log('groups:', JSON.stringify(groups));
  const work = groups.find(g => g.title === 'Work');
  const ai = groups.find(g => g.title === 'AI');
  const google = groups.find(g => g.title === 'Google');
  check('one Work group with both github tabs (no duplicate groups)', groups.filter(g => g.title === 'Work').length === 1 && work?.tabs.length === 2);
  check('gemini.google.com lands in AI, not Google', ai?.tabs.some(u => u.includes('gemini')) && !google?.tabs.some(u => u.includes('gemini')));
  check('mail.google.com lands in Google', google?.tabs.some(u => u.includes('mail.google')));
  check('example.com stays ungrouped', !groups.some(g => g.tabs.some(u => u.includes('example.com'))));
  check('group colours applied', work?.color === 'blue' && ai?.color === 'purple');

  // Manual rule via message: example.com -> Shopping
  const add = await msg(gpop, { type: 'add_manual_rule', group: 'Shopping', domain: 'example.com' });
  await sleep(1500);
  const groups2 = await grouper.evaluate(`(async () => { const gs = await chrome.tabGroups.query({}); const ts = await chrome.tabs.query({}); return gs.map(g => ({ title: g.title, tabs: ts.filter(t => t.groupId === g.id).map(t => t.url) })); })()`);
  check('manual rule groups example.com into Shopping', add?.success && groups2.find(g => g.title === 'Shopping')?.tabs.some(u => u.includes('example.com')), JSON.stringify(add));
  const snap = await msg(gpop, { type: 'snapshot_yaml' });
  check('snapshot yaml lists groups', snap?.success && snap.yaml.includes('- name: "Work"') && snap.yaml.includes('- domain: github.com'));

  // Closer: github.com/login should be pending; api.github.com should not.
  await sleep(500);
  const state = await msg(cpop, { type: 'get_state' });
  const pend = Object.values(state.pending || {});
  console.log('pending:', JSON.stringify(pend.map(p => [p.name, p.url, p.idleMin])));
  check('github.com/login is pending closure', pend.some(p => p.url.startsWith('https://github.com/login')));
  check('api.github.com is not pending', !pend.some(p => p.url.includes('api.github.com')));
  const alarms = await closer.evaluate(`chrome.alarms.getAll()`);
  check('close + warn alarms armed', alarms.some(a => a.name.startsWith('close-tab-')) && alarms.some(a => a.name.startsWith('warn-tab-')), alarms.map(a => a.name).join(','));
  const badge = await closer.evaluate(`chrome.action.getBadgeText({})`);
  check('badge shows pending count', badge === String(pend.length), badge);

  // Pause clears alarms, resume rescans.
  await msg(cpop, { type: 'set_paused', paused: true });
  const paused = await msg(cpop, { type: 'get_state' });
  check('pause clears pending and shows II', Object.keys(paused.pending).length === 0 && (await closer.evaluate(`chrome.action.getBadgeText({})`)) === 'II');
  await msg(cpop, { type: 'set_paused', paused: false });
  await sleep(1000);
  const resumed = await msg(cpop, { type: 'get_state' });
  check('resume rescans and re-arms', Object.keys(resumed.pending).length === pend.length);

  // Navigate the login tab away: pending entry must go.
  const loginTabId = Number(Object.keys(resumed.pending)[0]);
  await closer.evaluate(`chrome.tabs.update(${loginTabId}, { url: 'https://example.org/' })`);
  await sleep(2500);
  const after = await msg(cpop, { type: 'get_state' });
  check('navigating away cancels the timer', !after.pending[loginTabId]);

  // Popup DOM rendered? (reload so the grouper popup picks up the manual rule added above)
  await gpop.evaluate('location.reload()');
  await sleep(1500);
  const gdom = await gpop.evaluate(`({ groups: document.querySelectorAll('#groups .group-item').length, options: document.querySelectorAll('#groupSelect option').length, manual: document.querySelectorAll('#manual-list .manual-item').length })`);
  check('grouper popup renders groups, select and manual rule', gdom.groups >= 5 && gdom.options >= 5 && gdom.manual === 1, JSON.stringify(gdom));
  const cdom = await cpop.evaluate(`({ pending: document.querySelectorAll('#tabs-list .tab-item').length, pause: document.getElementById('pauseBtn').textContent, idle: document.getElementById('idle-label').textContent })`);
  check('closer popup renders pending list and idle label', cdom.idle === '10 min idle' && cdom.pause === 'Pause', JSON.stringify(cdom));
  for (const [name, c] of Object.entries(popups)) {
    const errs = c.events.filter(e => e.method === 'Runtime.exceptionThrown' || (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error'));
    check(`${name} popup: no runtime errors`, errs.length === 0, JSON.stringify(errs.slice(0, 3)));
  }

  // Console errors from either worker?
  for (const [name, c] of Object.entries(byName)) {
    const errs = c.events.filter(e => e.method === 'Runtime.exceptionThrown' || (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error'));
    check(`${name}: no runtime errors`, errs.length === 0, JSON.stringify(errs.slice(0, 3)));
  }
} catch (e) {
  console.error('SMOKE ERROR', e);
  failures++;
} finally {
  chrome.kill();
}
process.exit(failures ? 1 : 0);
