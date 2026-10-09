/**
 * Arc Activity — tells the updater when a Claude task is running.
 *
 * The panel runs the agent loop, and every step is a request to the Messages
 * API. Recording when the last one started or finished lets
 * arc-update-check.js hold a reload until no task has run for a while, even
 * in a panel that's hidden or in a background tab. Loaded before the panel's
 * bundle so the SDK picks up the wrapped fetch.
 */
(function () {
  const KEY = 'arc_last_agent_activity';
  let lastWrite = 0;

  function mark() {
    const now = Date.now();
    if (now - lastWrite < 30 * 1000) return;
    lastWrite = now;
    chrome.storage.session.set({ [KEY]: now }).catch(() => {});
  }

  const originalFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input?.url || String(input);
    if (!/\/v1\/messages\b/.test(url)) return originalFetch.apply(this, arguments);
    mark();
    const response = originalFetch.apply(this, arguments);
    response.then(mark, mark);
    return response;
  };
})();
