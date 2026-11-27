// fresh.js: the app always runs its newest version. Load it in <head>, before everything else: <script src="/fresh.js"></script>
// The server stamps its build into <meta name="build" content="..."> and serves the live build at /api/version (no-store).
//   - On every open, and every time the app comes back to the screen, it asks for the live build. If it is newer than this
//     page, it empties the saved copies (service worker caches), asks the service worker to update, and reloads.
//   - window.freshOK = () => false holds the reload back (for example in the middle of a question); call window.freshCheck()
//     later to try again.
//   - Self-repair: the app calls window.appReady() once it has started. If it has not within 8 seconds (a stale or broken
//     file), the page empties the caches and reloads once. <script src="/fresh.js" data-ready="load"> counts the page's
//     load event as started instead (for simple pages that do not call appReady).
//   - <script src="/fresh.js" data-on="open"> checks only when the page opens, not when the app comes back to the screen
//     (for live games, where a reload would end the game).
//   - Never while someone is typing: no reload while a text field holds text that was typed and not sent.
(() => {
  const meta = document.querySelector('meta[name="build"]');
  const mine = meta ? meta.content : '';
  const me = document.currentScript || {}, opt = (k) => (me.dataset ? me.dataset[k] : '');
  const typing = () => {                                   // a reload would lose what is being typed
    const a = document.activeElement;
    if (a && a.isContentEditable && a.textContent.trim()) return true;
    for (const f of document.querySelectorAll('textarea, input:not([type]), input[type=text], input[type=search], input[type=email], input[type=url], input[type=number]')) {
      if (f.value && f.value !== f.defaultValue) return true;
    }
    return false;
  };
  const KEY = 'fresh:reloads';
  let busy = false;

  async function hardReload(to) {
    if (busy) return;
    let done = {};
    try { done = JSON.parse(sessionStorage.getItem(KEY) || '{}'); } catch (e) { /* none */ }
    if (done[to]) return;                                  // each build (and the repair) gets one forced reload per session: never a loop
    done[to] = Date.now();
    try { sessionStorage.setItem(KEY, JSON.stringify(done)); } catch (e) { /* private window */ }
    busy = true;
    try { if (window.caches) for (const k of await caches.keys()) await caches.delete(k); } catch (e) { /* no caches */ }
    try {
      const regs = navigator.serviceWorker && navigator.serviceWorker.getRegistrations ? await navigator.serviceWorker.getRegistrations() : [];
      await Promise.all(regs.map((r) => r.update().catch(() => {})));
    } catch (e) { /* no service worker */ }
    const u = new URL(location.href);
    u.searchParams.set('v', to);                           // a new address, so no cache anywhere can hand back the old page
    location.replace(u.toString());
  }

  async function check() {
    if (!mine || busy || navigator.onLine === false) return;
    try {
      const r = await fetch('/api/version', { cache: 'no-store', credentials: 'same-origin' });
      if (!r.ok) return;
      const { build } = await r.json();
      if (build && build !== mine && !typing() && (!window.freshOK || window.freshOK())) hardReload(build);
    } catch (e) { /* offline: keep running this copy */ }
  }
  window.freshCheck = check;

  if (/[?&]v=/.test(location.search)) {                    // tidy the address bar after a forced reload
    const u = new URL(location.href); u.searchParams.delete('v');
    history.replaceState(history.state, '', u.pathname + u.search + u.hash);
  }
  check();
  if (opt('on') !== 'open') {
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
    addEventListener('pageshow', (e) => { if (e.persisted) check(); });
    addEventListener('online', check);
  }

  let ready = false;
  window.appReady = () => { ready = true; };
  if (opt('ready') === 'load') addEventListener('load', () => { ready = true; });
  addEventListener('load', () => setTimeout(() => { if (!ready) hardReload('repair'); }, 8000));
})();
