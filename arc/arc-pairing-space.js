/**
 * Arc Pairing Space — shows a "wants to connect" prompt in its own profile.
 *
 * Claude Code sends the request to every browser, and each Arc profile opens
 * its prompt. Arc puts a new tab in whatever space is on screen, so all the
 * prompts landed together and nothing said which profile each was for. Open
 * this profile's prompt only once its space is the one showing: the prompt
 * you see is always for the space you're in, and switching spaces brings up
 * that profile's prompt there.
 *
 * Nothing tells a profile that you picked another one, so an unanswered
 * prompt closes when Claude stops waiting for it.
 *
 * No event says which space is showing (window focus only says Arc is the
 * front app), but a page knows whether it's on screen, and switching to a
 * space marks its tab as just used. A page scripts can't reach (a new tab,
 * arc://extensions) gives neither, so a profile showing one opens its prompt
 * straight away: right when that space is in front, and an extra, labelled
 * prompt in the current space when it isn't.
 */

const _PAIRING_WAIT_MS = 2 * 60 * 1000; // Claude Code waits this long for an answer
let _pairing = null; // { url, deadline }

async function _activeTabs() {
  return chrome.tabs.query({ active: true, windowType: 'normal' });
}

// Whether this profile's space is on screen: 'yes', 'no', or 'unknown' when
// its page is one scripts can't reach. `since` is when the request arrived.
async function _profileOnScreen(since) {
  const tabs = await _activeTabs();
  // Switching to a space marks its tab as just used, even a page scripts can't
  // reach (arc://extensions, a new tab), so a switch here after the request
  // means this space is showing.
  if (tabs.some(t => t.lastAccessed > since)) return 'yes';
  let hidden = false;
  for (const tab of tabs) {
    try {
      const [r] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => document.visibilityState === 'visible',
      });
      if (r?.result) return 'yes';
      hidden = true;
    } catch (e) {} // arc:// and other pages scripts can't reach
  }
  return hidden ? 'no' : 'unknown';
}

self._arcOpenPairing = async (url) => {
  // A newer request replaces one still waiting.
  const since = Date.now();
  const request = _pairing = { url, deadline: since + _PAIRING_WAIT_MS };
  let first = true;
  while (_pairing === request && Date.now() < request.deadline) {
    const onScreen = await _profileOnScreen(since);
    // Can't tell at first: open now rather than leave a blank tab with no
    // prompt. If this space isn't the one showing, the prompt lands in the
    // other profile's space, labelled with this profile's tabs.
    if (onScreen === 'yes' || (first && onScreen === 'unknown')) {
      if (_pairing !== request) return;
      // The page closes itself at the deadline (arc-pairing-profile.js); a
      // timer here could be lost when the worker goes idle.
      await chrome.tabs.create({ url: `${url}&arc_deadline=${request.deadline}`, active: true });
      return;
    }
    first = false;
    await new Promise((r) => setTimeout(r, 1000));
  }
};

chrome.runtime.onMessage.addListener((msg) => {
  // Answered here, so stop waiting to show it.
  if (msg?.type === 'pairing_confirmed' || msg?.type === 'pairing_dismissed') _pairing = null;
  return false;
});

