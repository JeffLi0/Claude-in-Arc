/**
 * Arc Session Border
 * Renders an orange border around the page when this tab is part of
 * Claude's current session (tracked by arc-session-tracker.js in the
 * service worker, since real chrome.tabGroups isn't available in Arc).
 */
(function () {
  'use strict';

  if (window.top !== window.self) return;
  if (window.__claudeArcSessionBorder) return;
  window.__claudeArcSessionBorder = true;

  const BORDER_ID = 'claude-arc-session-border';
  let el = null;
  let hideTimer = null;

  function ensureStyle() {
    if (document.getElementById('claude-arc-session-border-style')) return;
    const style = document.createElement('style');
    style.id = 'claude-arc-session-border-style';
    style.textContent = `
      @media (prefers-color-scheme: dark) {
        #${BORDER_ID} { border-color: #ea896a !important; }
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function ensureEl() {
    if (el) return el;
    ensureStyle();
    el = document.createElement('div');
    el.id = BORDER_ID;
    el.style.cssText = `
      position: fixed !important;
      inset: 0 !important;
      pointer-events: none !important;
      z-index: 2147483643 !important;
      box-sizing: border-box !important;
      border: 3px solid #d97757 !important;
      border-radius: 12px !important;
      opacity: 0 !important;
      transition: opacity 220ms ease !important;
      margin: 0 !important;
    `;
    (document.documentElement || document.body).appendChild(el);
    return el;
  }

  function show() {
    clearTimeout(hideTimer);
    ensureEl();
    el.offsetHeight;
    el.style.setProperty('opacity', '1', 'important');
  }

  function hide() {
    if (!el) return;
    el.style.setProperty('opacity', '0', 'important');
    hideTimer = setTimeout(() => {
      if (el && el.parentNode) el.parentNode.removeChild(el);
      el = null;
    }, 260);
  }

  function extOk() {
    try { return !!chrome?.runtime?.id; } catch (e) { return false; }
  }

  if (extOk()) {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.type === 'ARC_SESSION_BORDER_SHOW') show();
      else if (msg.type === 'ARC_SESSION_BORDER_HIDE') hide();
    });

    try {
      chrome.runtime.sendMessage({ type: 'ARC_SESSION_BORDER_QUERY' }, (res) => {
        if (!chrome.runtime.lastError && res?.active) show();
      });
    } catch (e) {}
  }
})();
