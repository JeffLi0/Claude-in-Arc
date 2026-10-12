/**
 * Arc Pairing Profile — says which Arc profile a "wants to connect" prompt is from.
 *
 * Each Arc profile runs its own copy of the extension, and each opens its own
 * prompt, but Arc can show them side by side. No API tells an extension its
 * profile's name, so name the profile by its most recently used tabs instead.
 */
(function () {
  function truncate(text, max) {
    return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
  }

  chrome.tabs.query({}).then((tabs) => {
    const titles = tabs
      .filter((t) => /^https?:/.test(t.url || '') && t.title)
      .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))
      .slice(0, 3)
      .map((t) => truncate(t.title, 32));

    const banner = document.createElement('div');
    banner.style.cssText = [
      'position:fixed', 'top:12px', 'left:50%', 'transform:translateX(-50%)', 'z-index:10',
      'max-width:calc(100% - 32px)', 'padding:8px 14px', 'border-radius:10px',
      'background:rgba(217,119,87,.12)', 'border:1px solid rgba(217,119,87,.6)', 'color:inherit',
      'font:13px/1.4 -apple-system,BlinkMacSystemFont,system-ui,sans-serif', 'text-align:center',
    ].join(';');
    const label = Object.assign(document.createElement('b'), { textContent: 'From the Arc profile with: ' });
    banner.append(label, titles.length ? titles.join(' · ') : 'no open web pages');
    document.body.append(banner);
  }).catch(() => {});

  // Nothing tells this profile that you connected through another one, so
  // close once Claude has stopped waiting (arc-pairing-space.js sets this).
  const deadline = Number(new URLSearchParams(location.search).get('arc_deadline'));
  if (deadline) {
    setTimeout(() => chrome.tabs.getCurrent((tab) => { if (tab?.id) chrome.tabs.remove(tab.id); }),
      Math.max(0, deadline - Date.now()));
  }
})();
