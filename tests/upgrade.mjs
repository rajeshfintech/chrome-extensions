// Upgrade-path checks in a real Chromium (Chrome for Testing).
//
//   CHROME_BIN=... node tests/upgrade.mjs banner  <oldExtCopy> <newExtDir> "<name>"
//       An old version is running; new files are copied over it without a
//       reload (what `tabgroups install` / `tabclose install` do). The new popup
//       must detect the old worker and offer "Reload extension".
//   CHROME_BIN=... node tests/upgrade.mjs selfupd <extCopy> "<name>"
//       The current worker must reload itself exactly once when manifest.json on
//       disk carries a different version, and never when it matches.
//
// Both modes modify the directory they are given: always pass a throwaway copy.
// CI runs these in the `integration` workflow.
import { spawn } from 'node:child_process';
import { mkdtempSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [mode, ...args] = process.argv.slice(2);
const name = args.at(-1);
const ext = args[0];
const port = 9350 + Math.floor(Math.random() * 500), sleep = ms => new Promise(r => setTimeout(r, ms));
const chrome = spawn(process.env.CHROME_BIN, [`--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'ver-'))}`,
  '--no-first-run', `--load-extension=${ext}`, '--headless=new', '--disable-gpu',
  ...(process.env.CI ? ['--no-sandbox', '--disable-dev-shm-usage'] : []), 'about:blank'], { stdio: 'ignore' });

// Poll until fn() is truthy or the deadline passes; returns the last value.
async function waitFor(fn, ms = 10000, step = 250) {
  const end = Date.now() + ms; let v;
  while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(step); }
  return v;
}

let id = 0;
async function connect(ws) {
  const s = new WebSocket(ws); await new Promise(r => s.onopen = r); const w = new Map(); const logs = [];
  s.onmessage = m => { const d = JSON.parse(m.data); if (w.has(d.id)) { w.get(d.id)(d); w.delete(d.id); } else if (d.method === 'Runtime.consoleAPICalled') logs.push(d.params.args.map(a => a.value).join(' ')); };
  const call = (method, params = {}) => new Promise(r => { const i = ++id; w.set(i, r); s.send(JSON.stringify({ id: i, method, params })); });
  const ev = async e => { const r = await call('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) return 'EXC: ' + (r.result.exceptionDetails.exception?.description || '').split('\n')[0];
    return r.result?.result?.value; };
  return { call, ev, logs, close: () => s.close() };
}
const list = async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
let failures = 0;
const check = (label, cond, detail = '') => { console.log(`${cond ? 'PASS' : 'FAIL'} ${label}${detail ? ' — ' + detail : ''}`); if (!cond) failures++; };

async function findWorker() {
  for (let i = 0; i < 80; i++) {
    await sleep(250);
    for (const t of (await list().catch(() => []))) {
      if (t.type !== 'service_worker' || !t.url.endsWith('/background.js')) continue;
      try { const c = await connect(t.webSocketDebuggerUrl); await c.call('Runtime.enable');
        if (await c.ev('chrome.runtime.getManifest().name') === name) return { c, extId: new URL(t.url).host }; c.close(); } catch {}
    }
  }
  throw new Error('worker not found');
}

try {
  const { c: worker, extId } = await findWorker();
  const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const b = await connect(ver.webSocketDebuggerUrl);

  if (mode === 'banner') {
    cpSync(args[1], ext, { recursive: true });  // install new files, no reload
    const { result } = await b.call('Target.createTarget', { url: `chrome-extension://${extId}/popup.html` });
    const target = await waitFor(async () => (await list()).find(t => t.id === result.targetId && t.url.endsWith('popup.html')));
    const p = await connect(target.webSocketDebuggerUrl);
    const hidden = await waitFor(async () => (await p.ev("document.getElementById('reload-banner')?.hidden")) === false ? false : null, 10000)
      ?? await p.ev("document.getElementById('reload-banner')?.hidden");
    check(`${name}: old worker detected, reload banner shown`, hidden === false, `banner hidden=${hidden}`);
    // Clicking the button must call chrome.runtime.reload (stubbed so the harness survives)
    await p.ev("window.close = () => {}; chrome.runtime.reload = () => { window.__reloadCalled = true; }; document.getElementById('selfReloadBtn').click(); true");
    check(`${name}: "Reload extension" button calls chrome.runtime.reload`, await p.ev('window.__reloadCalled === true'));
  }

  if (mode === 'selfupd') {
    // Stub reload in the worker so we can observe the call without Chrome unloading it.
    await worker.ev("globalThis.__reloads = 0; chrome.runtime.reload = () => { globalThis.__reloads++; }; true");
    const running = await worker.ev('chrome.runtime.getManifest().version');
    // 1. No change on disk: an event must NOT trigger a reload. Wait past the
    //    longer of the two config TTLs (grouper 5 s, closer 10 s) so a check runs.
    await sleep(11000);
    await worker.ev("chrome.tabs.create({ url: 'https://example.com/', active: false }).then(() => true)");
    await sleep(2000);
    check(`${name}: no reload while disk matches running v${running}`, await worker.ev('globalThis.__reloads') === 0);
    // 2. Simulate an install of a newer version.
    const mf = join(ext, 'manifest.json');
    const m = JSON.parse(readFileSync(mf, 'utf8')); m.version = '9.9.9'; writeFileSync(mf, JSON.stringify(m, null, 2));
    await sleep(11000);  // past both extensions' config TTLs
    await worker.ev("chrome.tabs.create({ url: 'https://example.org/', active: false }).then(() => true)");
    await waitFor(async () => (await worker.ev('globalThis.__reloads')) >= 1, 10000);
    await sleep(1000);   // give any duplicate reload a chance to show up
    check(`${name}: reloads itself when disk has v9.9.9`, await worker.ev('globalThis.__reloads') === 1,
      `reloads=${await worker.ev('globalThis.__reloads')} log=${JSON.stringify(worker.logs.filter(l => /reload|Update/i.test(l)))}`);
    // 3. Same worker, later event: must not reload again (in-memory flag; the
    //    storage-backed once-a-minute guard is unit-tested in rules.test.mjs).
    await sleep(11000);
    await worker.ev("chrome.tabs.create({ url: 'https://example.net/', active: false }).then(() => true)");
    await sleep(2500);
    check(`${name}: guard prevents a reload loop`, await worker.ev('globalThis.__reloads') === 1);
  }
} catch (e) {
  console.log('ERROR', e.message); failures++;
} finally {
  chrome.kill();
}
process.exit(failures ? 1 : 0);
