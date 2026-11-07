// Shared by Tab Auto Grouper and Auto Tab Closer (identical copy in each;
// tests/rules.test.mjs fails if they drift apart).
//
// Unpacked extensions read popup files from disk on every open, but the
// background service worker keeps running the code it started with until the
// extension is reloaded. After `tabgroups install` / `tabclose install` that
// leaves a new popup talking to an old worker. The worker calls
// reloadIfUpdatedOnDisk() whenever it re-reads its config; when manifest.json
// on disk carries a different version from the one running, it reloads itself.

const GUARD_KEY = 'lastSelfReloadAt';
const GUARD_MS = 60_000; // never reload more than once a minute

// Several tab events can re-read config at the same moment; they share one
// in-flight check so the guard below cannot be raced, and once a reload has
// been requested every later call is a no-op.
let inFlight = null;
let reloadRequested = false;

export function reloadIfUpdatedOnDisk(tag) {
  if (reloadRequested) return Promise.resolve(true);
  if (!inFlight) inFlight = check(tag).finally(() => { inFlight = null; });
  return inFlight;
}

async function check(tag) {
  try {
    const resp = await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' });
    const onDisk = (await resp.json()).version;
    const running = chrome.runtime.getManifest().version;
    if (!onDisk || onDisk === running) return false;

    const { [GUARD_KEY]: last = 0 } = await chrome.storage.local.get(GUARD_KEY);
    if (Date.now() - last < GUARD_MS) return false;
    await chrome.storage.local.set({ [GUARD_KEY]: Date.now() });

    reloadRequested = true;
    console.log(`[${tag}] v${onDisk} installed on disk, running v${running}: reloading`);
    chrome.runtime.reload();
    return true;
  } catch (err) {
    console.warn(`[${tag}] Update check failed:`, err.message);
    return false;
  }
}

// Popup side: true when a reply shows the worker is not the code this popup
// was written for (old worker after an update, or no worker at all).
export function isStaleWorkerReply(reply, expectedKey) {
  if (!reply) return true;
  if (typeof reply.error === 'string' &&
      /message port closed|Receiving end does not exist/i.test(reply.error)) return true;
  return reply[expectedKey] === undefined && reply.error === undefined;
}
