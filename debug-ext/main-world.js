// Runs in the PAGE's JS context (world: MAIN) at document_start, before any of
// miruro's own scripts. Read-only: it reports every attachShadow call to the
// overlay via window.postMessage so we can watch the player's shadow tree being
// built without devtools. It does NOT mutate the roots (an earlier version
// force-coerced closed->open; that was a needless breakage risk and the target
// <video> lives in the light DOM anyway).
(() => {
  const CHANNEL = 'pbsync-dbg';

  const orig = Element.prototype.attachShadow;
  if (typeof orig !== 'function') return;

  Element.prototype.attachShadow = function (init) {
    try {
      window.postMessage(
        {
          source: CHANNEL,
          type: 'attachShadow',
          tag: (this.tagName || '?').toLowerCase(),
          id: this.id || null,
          mode: (init && init.mode) || 'open',
        },
        '*',
      );
    } catch {
      // postMessage clone failures are non-fatal; keep the page working.
    }
    return orig.call(this, init);
  };

  try {
    window.postMessage({ source: CHANNEL, type: 'ready' }, '*');
  } catch {
    /* ignore */
  }
})();
