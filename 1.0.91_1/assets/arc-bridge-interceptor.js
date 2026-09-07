/**
 * Arc Bridge Interceptor
 * Intercepts MCP tool_call messages from the bridge WebSocket and executes
 * them using Arc-compatible Chrome APIs, bypassing the official handler
 * which silently fails in Arc.
 *
 * The shim (arc-sidepanel-shim.js) detects tool_call messages and dispatches
 * them here via self._arcBridgeInterceptor.handleBridgeToolCall().
 */

const _INTERCEPTOR_VERSION = '0.3.0';
const _MAX_PAGE_TEXT = 50000;
const _STORAGE_KEY = 'claude_arc_mcp_group';

function _ok(text) {
  return { content: [{ type: 'text', text }] };
}

function _err(text) {
  return { content: [{ type: 'text', text }], is_error: true };
}

async function _queryUserTabs() {
  const all = await chrome.tabs.query({});
  return all.filter(t => {
    const u = t.url || '';
    return !u.startsWith('chrome://') &&
           !u.startsWith('chrome-extension://') &&
           !u.startsWith('arc://') &&
           !u.startsWith('about:');
  });
}

async function _buildTabContext(selectedTabId) {
  const tabs = await _queryUserTabs();
  const ctx = {
    availableTabs: tabs.map(t => ({
      tabId: t.id,
      title: t.title || '',
      url: t.url || ''
    }))
  };
  if (selectedTabId !== undefined) {
    ctx.selectedTabId = selectedTabId;
  }
  return _ok(JSON.stringify(ctx));
}

async function _getActiveTabId() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  return active?.id;
}

function _touchSession(tabId) {
  try { self._arcSessionTracker?.touch(tabId); } catch (e) {}
}

async function _resolveTabId(tabId) {
  const id = typeof tabId === 'number' ? tabId : await _getActiveTabId();
  if (!id) return { error: 'No tab available.' };
  try {
    await chrome.tabs.get(id);
  } catch {
    return { error: `Tab ${id} does not exist.` };
  }
  return { id };
}

// --------------------------------------------------------------------------
// Arc replacements for the debugger-backed tools.
//
// The official extension runs javascript_tool and every non-screenshot
// `computer` action through the Chrome Debugger Protocol (chrome.debugger ->
// Runtime.evaluate / Input.dispatch*). Arc never lets the debugger attach and
// the attach promise never settles, so those calls hang until the desktop side
// times out instead of failing fast.
//
// chrome.scripting.executeScript does work in Arc (get_page_text already
// relies on it), so these are rebuilt on top of it: eval for JavaScript, and
// synthesized DOM events for pointer and keyboard input.
// --------------------------------------------------------------------------

const _EVAL_OUTPUT_LIMIT = 51200;
const _SHOT_DIMS_KEY = 'claude_arc_shot_dims';
const _MAX_WAIT_SECONDS = 10;

async function _runInTab(tabId, func, args, world = 'MAIN') {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    world,
    func,
    args
  });
  return res?.result;
}

async function _rememberShotDims(tabId, dims) {
  try {
    const r = await chrome.storage.session.get(_SHOT_DIMS_KEY);
    const map = r[_SHOT_DIMS_KEY] || {};
    map[tabId] = dims;
    await chrome.storage.session.set({ [_SHOT_DIMS_KEY]: map });
  } catch (e) {}
}

async function _getShotDims(tabId) {
  try {
    const r = await chrome.storage.session.get(_SHOT_DIMS_KEY);
    return (r[_SHOT_DIMS_KEY] || {})[tabId] || null;
  } catch (e) {
    return null;
  }
}

/**
 * Model coordinates arrive in screenshot-image pixels. captureVisibleTab
 * renders at devicePixelRatio, so on a retina display that is 2x the CSS
 * pixels elementFromPoint expects. Prefer the ratio measured when the
 * screenshot was taken; fall back to dividing by DPR when a coordinate
 * clearly overflows the viewport.
 */
async function _toCssCoords(tabId, coordinate) {
  const x = Number(coordinate[0]);
  const y = Number(coordinate[1]);
  const dims = await _getShotDims(tabId);
  if (dims?.imgW && dims?.imgH && dims?.cssW && dims?.cssH) {
    return [x * (dims.cssW / dims.imgW), y * (dims.cssH / dims.imgH)];
  }
  const vp = await _runInTab(tabId, _pageViewport, []);
  if (vp && vp.dpr > 1 && (x > vp.w || y > vp.h)) return [x / vp.dpr, y / vp.dpr];
  return [x, y];
}

// The model reads coordinates off the image it is shown, so the image has to
// be small enough that nothing downstream resizes it again. These are the
// official extension's own limits, and _fitImage is a port of its Se(): keep
// both sides under maxTargetPx and the (28px cell) token count under budget.
const _IMG_LIMITS = { pxPerToken: 28, maxTargetPx: 1568, maxTargetTokens: 1568 };

function _imgTokens(w, h, pxPerToken) {
  const cells = (n) => Math.floor((n - 1) / pxPerToken) + 1;
  return cells(w) * cells(h);
}

function _fitImage(w, h, limits = _IMG_LIMITS) {
  const { pxPerToken, maxTargetPx, maxTargetTokens } = limits;
  if (w <= maxTargetPx && h <= maxTargetPx && _imgTokens(w, h, pxPerToken) <= maxTargetTokens) {
    return [w, h];
  }
  if (h > w) {
    const [fh, fw] = _fitImage(h, w, limits);
    return [fw, fh];
  }
  const aspect = w / h;
  let lo = 1;
  let hi = w;
  for (;;) {
    if (lo + 1 === hi) return [lo, Math.max(Math.round(lo / aspect), 1)];
    const mid = Math.floor((lo + hi) / 2);
    const midH = Math.max(Math.round(mid / aspect), 1);
    if (mid <= maxTargetPx && _imgTokens(mid, midH, pxPerToken) <= maxTargetTokens) lo = mid;
    else hi = mid;
  }
}

const _ZOOM_MAX_SIDE = 1568;
const _ZOOM_MAX_UPSCALE = 4;

function _b64ToBytes(base64) {
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function _bytesToB64(bytes) {
  let out = '';
  // btoa takes a string; chunk it so the argument list stays a sane size.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(out);
}

/**
 * Crop a region out of a base64 PNG and rescale it, entirely in the worker.
 * Decoding goes through a Blob rather than fetch(dataUrl) so nothing touches
 * connect-src, which the extension CSP would refuse.
 */
async function _cropPngBase64(base64, sx, sy, sw, sh, dw, dh) {
  const blob = new Blob([_b64ToBytes(base64)], { type: 'image/png' });
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = new OffscreenCanvas(dw, dh);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('OffscreenCanvas 2d context unavailable.');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, dw, dh);
    const outBlob = await canvas.convertToBlob({ type: 'image/png' });
    return _bytesToB64(new Uint8Array(await outBlob.arrayBuffer()));
  } finally {
    bitmap.close();
  }
}

/** Width/height straight out of a base64 PNG's IHDR header. */
function _pngSize(base64) {
  try {
    const bin = atob(base64.slice(0, 64));
    const at = (i) => bin.charCodeAt(i);
    if (at(0) !== 0x89 || at(1) !== 0x50) return null;
    const uint32 = (o) => ((at(o) << 24) | (at(o + 1) << 16) | (at(o + 2) << 8) | at(o + 3)) >>> 0;
    return { w: uint32(16), h: uint32(20) };
  } catch (e) {
    return null;
  }
}

function _pageViewport() {
  // viewport-override.js runs in the MAIN world and rewrites window.innerWidth
  // to hide the panel's width from page scripts, so innerWidth read here is
  // short by exactly that much whenever the panel is squeezing the page. Both
  // captureVisibleTab and elementFromPoint work in the real, unreduced
  // viewport, so the reduction has to go back on before any coordinate maths --
  // otherwise every x is scaled down and clicks land left of their target.
  const el = document.documentElement;
  const reduction = (el && parseInt(el.getAttribute('data-claude-vp-width') || '0', 10)) || 0;
  const inner = window.innerWidth;
  return {
    w: inner + reduction,
    h: window.innerHeight,
    pageW: inner,
    dpr: window.devicePixelRatio || 1
  };
}

function _pageEval(code, limit) {
  const SENSITIVE = [
    /password/i, /secret/i, /api[_-]?key/i, /credential/i,
    /private[_-]?key/i, /access[_-]?key/i, /bearer/i, /oauth/i, /token/i
  ];

  function scrubString(s) {
    if (/^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/.test(s)) return '[BLOCKED: JWT]';
    if (/^[a-f0-9]{40,}$/i.test(s)) return '[BLOCKED: hex credential]';
    if (s.length > 2000) return s.slice(0, 2000) + '[TRUNCATED]';
    return s;
  }

  function describe(v, depth, seen) {
    if (v === null) return null;
    const t = typeof v;
    if (t === 'string') return scrubString(v);
    if (t === 'number' || t === 'boolean') return v;
    if (t === 'undefined') return '[undefined]';
    if (t === 'bigint') return String(v) + 'n';
    if (t === 'symbol') return String(v);
    if (t === 'function') return '[Function' + (v.name ? ': ' + v.name : '') + ']';
    if (depth > 5) return '[TRUNCATED: max depth]';
    if (typeof Node !== 'undefined' && v instanceof Node) {
      const id = v.id ? '#' + v.id : '';
      const cls = v.classList && v.classList.length
        ? '.' + Array.from(v.classList).slice(0, 3).join('.')
        : '';
      const txt = (v.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);
      return '<' + String(v.nodeName).toLowerCase() + id + cls + '>' + (txt ? ' ' + txt : '');
    }
    if (v instanceof Error) return '[' + v.name + ': ' + v.message + ']';
    if (v instanceof Date) return v.toISOString();
    if (seen.has(v)) return '[Circular]';
    seen.add(v);
    try {
      if (v instanceof Map) {
        return describe(Array.from(v.entries()).slice(0, 100), depth + 1, seen);
      }
      if (v instanceof Set) {
        return describe(Array.from(v.values()).slice(0, 100), depth + 1, seen);
      }
      const listLike = Array.isArray(v) ||
        (typeof v.length === 'number' && typeof v.item === 'function');
      if (listLike) {
        const arr = Array.from(v);
        const out = arr.slice(0, 100).map(x => describe(x, depth + 1, seen));
        if (arr.length > 100) out.push('[TRUNCATED: ' + (arr.length - 100) + ' more items]');
        return out;
      }
      const out = {};
      for (const k of Object.keys(v)) {
        if (k === 'cookie' || k === 'cookies') out[k] = '[BLOCKED: cookie access]';
        else if (SENSITIVE.some(p => p.test(k))) out[k] = '[BLOCKED: sensitive key]';
        else out[k] = describe(v[k], depth + 1, seen);
      }
      return out;
    } finally {
      seen.delete(v);
    }
  }

  const finish = (value) => {
    let out;
    try {
      out = JSON.stringify(describe(value, 0, new Set()), null, 2);
    } catch (e) {
      out = String(value);
    }
    if (out === undefined) out = 'undefined';
    if (out.length > limit) out = out.slice(0, limit) + '\n[TRUNCATED at ' + limit + ' characters]';
    return { output: out };
  };

  // Positions of `;` that end a statement, skipping those inside brackets,
  // strings and comments.
  function statementBreaks(src) {
    const stops = [];
    let depth = 0;
    let quote = null;
    let i = 0;
    while (i < src.length) {
      const c = src[i];
      if (quote) {
        if (c === '\\') { i += 2; continue; }
        if (c === quote) quote = null;
        i++;
        continue;
      }
      if (c === '/' && src[i + 1] === '/') {
        while (i < src.length && src[i] !== '\n') i++;
        continue;
      }
      if (c === '/' && src[i + 1] === '*') {
        i += 2;
        while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
        i += 2;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') { quote = c; i++; continue; }
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth--;
      else if (c === ';' && depth === 0) stops.push(i);
      i++;
    }
    return stops;
  }

  // Indirect eval returns the completion value of the last statement, which is
  // the contract this tool advertises, but it rejects top-level `await`. Code
  // that needs await is compiled as an async function body instead, with the
  // trailing expression rewritten into a return so the value still comes back.
  function compileAsync(src) {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    try {
      return new AsyncFunction('return (' + src + '\n);');
    } catch (e) {
      if (e instanceof EvalError) throw e;
    }
    const stops = statementBreaks(src);
    for (let k = stops.length - 1; k >= 0 && k >= stops.length - 3; k--) {
      const head = src.slice(0, stops[k] + 1);
      const tail = src.slice(stops[k] + 1).trim().replace(/;+$/, '');
      if (!tail) continue;
      try {
        return new AsyncFunction(head + '\nreturn (' + tail + '\n);');
      } catch (e) {
        if (e instanceof EvalError) throw e;
      }
    }
    return new AsyncFunction(src);
  }

  let value;
  try {
    value = /\bawait\b/.test(code) ? compileAsync(code)() : (0, eval)(code);
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (e instanceof EvalError || /unsafe-eval|Content Security Policy/i.test(msg)) {
      return { cspBlocked: true, message: msg };
    }
    return { thrown: (e && e.stack) || msg };
  }

  if (value && typeof value.then === 'function') {
    return Promise.resolve(value).then(finish, (e) => ({
      thrown: String((e && e.stack) || (e && e.message) || e)
    }));
  }
  return finish(value);
}

function _pagePointer(x, y, kind) {
  let el = document.elementFromPoint(x, y);
  if (!el) {
    return {
      error: 'No element at (' + Math.round(x) + ', ' + Math.round(y) +
        '). The coordinate may be outside the viewport, or the page may have scrolled since the screenshot.'
    };
  }

  // elementFromPoint stops at a shadow host, so a click dispatched there never
  // reaches the control inside it. Walk down until the point resolves to itself.
  for (let hops = 0; hops < 10 && el.shadowRoot; hops++) {
    const inner = el.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === el) break;
    el = inner;
  }

  const tag = String(el.nodeName).toLowerCase();
  if (tag === 'iframe' || tag === 'frame') {
    return {
      error: 'The element at (' + Math.round(x) + ', ' + Math.round(y) + ') is an <' + tag +
        '>. Clicks are dispatched in the top frame only, so this one cannot be delivered. ' +
        'Use javascript_tool inside the frame, or interact with the page outside it.'
    };
  }

  const describeEl = (node) => {
    const id = node.id ? '#' + node.id : '';
    const txt = (node.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    return '<' + String(node.nodeName).toLowerCase() + id + '>' + (txt ? ' "' + txt + '"' : '');
  };

  const isRight = kind === 'right_click';
  const base = {
    bubbles: true, cancelable: true, composed: true, view: window,
    clientX: x, clientY: y, screenX: x, screenY: y,
    button: isRight ? 2 : 0, buttons: isRight ? 2 : 1
  };
  const mouse = (type, extra) => el.dispatchEvent(new MouseEvent(type, Object.assign({}, base, extra)));
  const pointer = (type, extra) => {
    if (typeof PointerEvent !== 'function') return;
    el.dispatchEvent(new PointerEvent(type, Object.assign(
      { pointerId: 1, pointerType: 'mouse', isPrimary: true }, base, extra
    )));
  };

  pointer('pointerover', { buttons: 0 });
  mouse('mouseover', { buttons: 0 });
  pointer('pointermove', { buttons: 0 });
  mouse('mousemove', { buttons: 0 });

  if (kind === 'hover') return { ok: 'Hovered ' + describeEl(el) };

  const clicks = kind === 'triple_click' ? 3 : kind === 'double_click' ? 2 : 1;
  for (let i = 1; i <= clicks; i++) {
    pointer('pointerdown', { detail: i });
    mouse('mousedown', { detail: i });
    if (i === 1 && typeof el.focus === 'function') {
      try { el.focus({ preventScroll: true }); } catch (e) { try { el.focus(); } catch (e2) {} }
    }
    pointer('pointerup', { detail: i });
    mouse('mouseup', { detail: i });
    mouse('click', { detail: i });
  }
  if (kind === 'double_click') mouse('dblclick', { detail: 2 });
  if (isRight) mouse('contextmenu', { detail: 1 });

  // Synthetic clicks don't carry the native text selection a triple-click makes.
  if (kind === 'triple_click') {
    try {
      const sel = document.getSelection();
      if (sel) { sel.removeAllRanges(); sel.selectAllChildren(el); }
    } catch (e) {}
  }

  const ACTIVATABLE = 'a[href], button, input, select, textarea, label, summary, ' +
    '[role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="checkbox"], ' +
    '[onclick], [tabindex]';
  const activation = typeof el.closest === 'function' ? el.closest(ACTIVATABLE) : null;
  const where = ' at (' + Math.round(x) + ', ' + Math.round(y) + ') on ' + describeEl(el);
  if (!activation) {
    const inside = typeof el.querySelector === 'function' ? el.querySelector(ACTIVATABLE) : null;
    return {
      ok: kind + where + '. Nothing clickable is at that point or above it, so the page ' +
        'ignored it' +
        (inside
          ? '. There is a ' + describeEl(inside) + ' inside that element but the point missed it — ' +
            'call read_page and click by ref instead of by coordinate.'
          : ' — take a fresh screenshot and check the coordinate.')
    };
  }
  return {
    ok: kind + where +
      (activation === el ? '' : ' (handled by ' + describeEl(activation) + ')')
  };
}

function _pageType(text) {
  const el = document.activeElement;
  const tag = el && el.tagName ? el.tagName.toLowerCase() : '';
  const isField = tag === 'input' || tag === 'textarea';
  if (!el || (!isField && !el.isContentEditable)) {
    return { error: 'No text field is focused. Click the field first, then type.' };
  }

  if (isField) {
    const proto = tag === 'textarea'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    // Frameworks like React shadow the instance `value` setter to track edits;
    // going through the prototype setter keeps their state in sync.
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    const start = typeof el.selectionStart === 'number' ? el.selectionStart : el.value.length;
    const end = typeof el.selectionEnd === 'number' ? el.selectionEnd : el.value.length;
    const next = el.value.slice(0, start) + text + el.value.slice(end);

    el.dispatchEvent(new InputEvent('beforeinput', {
      bubbles: true, cancelable: true, composed: true, inputType: 'insertText', data: text
    }));
    if (desc && desc.set) desc.set.call(el, next); else el.value = next;
    try { el.setSelectionRange(start + text.length, start + text.length); } catch (e) {}
    el.dispatchEvent(new InputEvent('input', {
      bubbles: true, composed: true, inputType: 'insertText', data: text
    }));
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    return { ok: 'Typed ' + text.length + ' characters into <' + tag + '>' };
  }

  document.execCommand('insertText', false, text);
  return { ok: 'Typed ' + text.length + ' characters into a contenteditable element' };
}

function _pageKey(combo) {
  const NAMES = {
    enter: 'Enter', return: 'Enter', tab: 'Tab', backspace: 'Backspace',
    delete: 'Delete', escape: 'Escape', esc: 'Escape', space: ' ',
    up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
    arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft',
    arrowright: 'ArrowRight', pageup: 'PageUp', pagedown: 'PageDown',
    home: 'Home', end: 'End'
  };

  const parts = String(combo).split('+').map(p => p.trim().toLowerCase()).filter(Boolean);
  const mods = { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };
  let keyName = null;
  for (const p of parts) {
    if (p === 'ctrl' || p === 'control') mods.ctrlKey = true;
    else if (p === 'cmd' || p === 'meta' || p === 'command') mods.metaKey = true;
    else if (p === 'alt' || p === 'option') mods.altKey = true;
    else if (p === 'shift') mods.shiftKey = true;
    else keyName = NAMES[p] || (p.length === 1 ? p : p.charAt(0).toUpperCase() + p.slice(1));
  }
  if (!keyName) return { error: 'No key found in "' + combo + '".' };

  const el = document.activeElement || document.body;
  let code = keyName;
  if (keyName.length === 1) {
    if (/[a-z]/i.test(keyName)) code = 'Key' + keyName.toUpperCase();
    else if (/[0-9]/.test(keyName)) code = 'Digit' + keyName;
    else if (keyName === ' ') code = 'Space';
  }
  const init = Object.assign({
    key: keyName, code, bubbles: true, cancelable: true, composed: true, view: window
  }, mods);

  const notPrevented = el.dispatchEvent(new KeyboardEvent('keydown', init));

  // Synthetic key events never mutate a field, so apply the common edits here.
  const tag = (el.tagName || '').toLowerCase();
  const isField = tag === 'input' || tag === 'textarea';
  if (notPrevented) {
    if ((mods.metaKey || mods.ctrlKey) && String(keyName).toLowerCase() === 'a') {
      if (isField && typeof el.select === 'function') el.select();
      else { try { document.getSelection()?.selectAllChildren(el); } catch (e) {} }
    } else if (isField && (keyName === 'Backspace' || keyName === 'Delete')) {
      const s = el.selectionStart;
      const e = el.selectionEnd;
      if (typeof s === 'number' && typeof e === 'number') {
        if (s !== e) el.setRangeText('', s, e, 'end');
        else if (keyName === 'Backspace' && s > 0) el.setRangeText('', s - 1, s, 'end');
        else if (keyName === 'Delete' && s < el.value.length) el.setRangeText('', s, s + 1, 'end');
        el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      }
    } else if (el.isContentEditable && (keyName === 'Backspace' || keyName === 'Delete')) {
      document.execCommand(keyName === 'Backspace' ? 'delete' : 'forwardDelete');
    }
  }

  el.dispatchEvent(new KeyboardEvent('keyup', init));
  return { ok: 'Pressed ' + combo };
}

function _pageScroll(x, y, direction, amount) {
  const step = 100 * (amount || 3);
  let dx = 0;
  let dy = 0;
  if (direction === 'up') dy = -step;
  else if (direction === 'down') dy = step;
  else if (direction === 'left') dx = -step;
  else if (direction === 'right') dx = step;
  else return { error: 'scroll_direction must be up, down, left, or right.' };

  const at = document.elementFromPoint(x, y);
  if (at) {
    at.dispatchEvent(new WheelEvent('wheel', {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: x, clientY: y, deltaX: dx, deltaY: dy, deltaMode: 0
    }));
  }

  const scrollable = (el) => {
    if (!el || el === document.body || el === document.documentElement) return false;
    const s = getComputedStyle(el);
    if (dy !== 0) {
      return (s.overflowY === 'auto' || s.overflowY === 'scroll') &&
        el.scrollHeight > el.clientHeight + 1;
    }
    return (s.overflowX === 'auto' || s.overflowX === 'scroll') &&
      el.scrollWidth > el.clientWidth + 1;
  };

  let scroller = null;
  let node = at;
  while (node && node !== document.body) {
    if (scrollable(node)) { scroller = node; break; }
    node = node.parentElement;
  }

  const readTop = () => (scroller ? scroller.scrollTop : window.scrollY);
  const before = readTop();
  if (scroller) scroller.scrollBy(dx, dy); else window.scrollBy(dx, dy);
  const after = readTop();

  return {
    ok: 'Scrolled ' + direction + ' on the ' + (scroller ? 'inner container' : 'page') +
      ' (' + Math.round(before) + ' -> ' + Math.round(after) + ')'
  };
}

function _pageDrag(x0, y0, x1, y1) {
  const start = document.elementFromPoint(x0, y0);
  if (!start) {
    return { error: 'No element at drag start (' + Math.round(x0) + ', ' + Math.round(y0) + ').' };
  }
  const fire = (el, suffix, x, y, buttons) => {
    const init = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: x, clientY: y, screenX: x, screenY: y, button: 0, buttons
    };
    if (typeof PointerEvent === 'function') {
      el.dispatchEvent(new PointerEvent('pointer' + suffix, Object.assign(
        { pointerId: 1, pointerType: 'mouse', isPrimary: true }, init
      )));
    }
    el.dispatchEvent(new MouseEvent('mouse' + suffix, init));
  };

  fire(start, 'down', x0, y0, 1);
  const steps = 10;
  for (let i = 1; i <= steps; i++) {
    const x = x0 + ((x1 - x0) * i) / steps;
    const y = y0 + ((y1 - y0) * i) / steps;
    fire(document.elementFromPoint(x, y) || start, 'move', x, y, 1);
  }
  fire(document.elementFromPoint(x1, y1) || start, 'up', x1, y1, 0);

  return {
    ok: 'Dragged from (' + Math.round(x0) + ', ' + Math.round(y0) + ') to (' +
      Math.round(x1) + ', ' + Math.round(y1) + ')'
  };
}

// --------------------------------------------------------------------------
// read_page / find.
//
// Both official tools call window.__generateAccessibilityTree, which the
// accessibility-tree content script defines. Routed through the official
// executor in Arc they come back "Page script returned empty result", so they
// are rebuilt here on the injection path the rest of this file already uses:
// inject Anthropic's own tree builder, then call it. MAIN world first (proven
// to work in Arc), ISOLATED as the fallback for pages whose CSP blocks it --
// where the content script's own copy usually already lives.
// --------------------------------------------------------------------------

const _AXTREE_FILE = 'assets/accessibility-tree.js-B-oUarrX.js';
const _AXTREE_WORLDS = ['MAIN', 'ISOLATED'];
const _FIND_MAX_HITS = 25;

function _pageAxTree(filter, depth, maxChars, refId) {
  if (typeof window.__generateAccessibilityTree !== 'function') {
    return { error: 'The accessibility tree builder is not present on this page.' };
  }
  try {
    return window.__generateAccessibilityTree(filter, depth, maxChars, refId);
  } catch (e) {
    return { error: (e && e.message) || String(e) };
  }
}

function _pageRefRect(ref) {
  const map = window.__claudeElementMap;
  const holder = map && map[ref];
  const el = holder && typeof holder.deref === 'function' ? holder.deref() : null;
  if (!el || !document.contains(el)) {
    return { error: `No element found for ${ref}. It may have been removed — call read_page again.` };
  }
  el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) {
    return { error: `Element ${ref} has no size on screen, so there is nothing to click.` };
  }
  return { ok: { x: r.left + r.width / 2, y: r.top + r.height / 2 } };
}

function _pageScrollToRef(ref) {
  const map = window.__claudeElementMap;
  const holder = map && map[ref];
  const el = holder && typeof holder.deref === 'function' ? holder.deref() : null;
  if (!el) return { error: `Element ${ref} is not on this page any more. Call read_page again.` };
  el.scrollIntoView({ block: 'center', inline: 'nearest' });
  return { ok: `Scrolled to ${ref}.` };
}

/** Centre of a read_page ref, from whichever world holds the element map. */
async function _refPoint(tabId, ref) {
  let last = null;
  for (const world of _AXTREE_WORLDS) {
    last = await _runInTab(tabId, _pageRefRect, [String(ref)], world);
    if (last && last.ok) return last.ok;
  }
  return { error: last?.error || `Could not resolve ${ref}.` };
}

/** Build the tree, trying each world until one produces it. */
async function _axTree(tabId, { filter, depth, maxChars, refId }) {
  let lastError = 'no result';
  for (const world of _AXTREE_WORLDS) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, world, files: [_AXTREE_FILE] });
      const res = await _runInTab(
        tabId, _pageAxTree,
        [filter || null, depth ?? null, maxChars ?? _MAX_PAGE_TEXT, refId ?? null],
        world
      );
      if (res && !res.error && typeof res.pageContent === 'string') return { tree: res, world };
      lastError = res?.error || 'the page script returned nothing';
    } catch (e) {
      lastError = e.message || String(e);
    }
  }
  return { error: lastError };
}

const TOOL_HANDLERS = {
  async tabs_context_mcp(args) {
    const { createIfEmpty } = args || {};
    const tabs = await _queryUserTabs();
    if (tabs.length === 0 && createIfEmpty) {
      const newTab = await chrome.tabs.create({ active: false, url: 'about:blank' });
      return _buildTabContext(newTab.id);
    }
    const activeId = await _getActiveTabId();
    return _buildTabContext(activeId);
  },

  async tabs_create_mcp(_args) {
    const newTab = await chrome.tabs.create({ active: false, url: 'about:blank' });
    _touchSession(newTab.id);
    return _buildTabContext(newTab.id);
  },

  async tabs_close_mcp(args) {
    const { tabId } = args || {};
    if (typeof tabId !== 'number' || !Number.isInteger(tabId)) {
      return _err('tabId must be an integer.');
    }
    try {
      await chrome.tabs.get(tabId);
    } catch {
      return _err(`Tab ${tabId} does not exist.`);
    }
    await chrome.tabs.remove(tabId);
    return _buildTabContext(await _getActiveTabId());
  },

  async navigate(args) {
    const { url, tabId, force } = args || {};
    if (!url) return _err('url is required.');
    let targetTabId = tabId;
    if (typeof targetTabId !== 'number') {
      targetTabId = await _getActiveTabId();
      if (!targetTabId) {
        const t = await chrome.tabs.create({ url, active: true });
        _touchSession(t.id);
        return _ok(`Navigated new tab ${t.id} to ${url}`);
      }
    }
    try {
      await chrome.tabs.get(targetTabId);
    } catch {
      return _err(`Tab ${targetTabId} does not exist.`);
    }
    await chrome.tabs.update(targetTabId, { url });
    if (force !== false) {
      await chrome.tabs.update(targetTabId, { active: true });
    }
    _touchSession(targetTabId);
    return _ok(`Navigated tab ${targetTabId} to ${url}`);
  },

  async get_page_text(args) {
    const { tabId, max_chars } = args || {};
    const limit = typeof max_chars === 'number' ? max_chars : _MAX_PAGE_TEXT;
    let targetTabId = tabId;
    if (typeof targetTabId !== 'number') {
      targetTabId = await _getActiveTabId();
    }
    if (!targetTabId) return _err('No tab available to read.');
    try {
      await chrome.tabs.get(targetTabId);
    } catch {
      return _err(`Tab ${targetTabId} does not exist.`);
    }
    try {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: targetTabId },
        func: () => document.body?.innerText || '',
        world: 'MAIN'
      });
      let text = result?.result || '';
      if (text.length > limit) {
        text = text.slice(0, limit) + `\n\n[Truncated at ${limit} characters]`;
      }
      _touchSession(targetTabId);
      return _ok(text);
    } catch (e) {
      return _err(`Failed to read page text: ${e.message}`);
    }
  },

  async read_page(args) {
    const { tabId, filter, depth, ref_id, max_chars } = args || {};
    const resolved = await _resolveTabId(tabId);
    if (resolved.error) return _err(resolved.error);

    const { tree, error } = await _axTree(resolved.id, {
      filter, depth, maxChars: max_chars, refId: ref_id
    });
    if (error) return _err(`Failed to read page: ${error}`);
    if (tree.error) return _err(tree.error);

    _touchSession(resolved.id);
    const vp = tree.viewport || {};
    return _ok(`${tree.pageContent}\n\nViewport: ${vp.width}x${vp.height}`);
  },

  /**
   * The official find asks a small model to pick elements out of the tree.
   * That inference isn't reachable from here, so this matches the query
   * literally against the tree instead and hands back the lines it hit,
   * refs included. Narrower than the real thing, and it says so.
   */
  async find(args) {
    const { tabId, query } = args || {};
    if (!query || !String(query).trim()) return _err('query is required for find.');
    const resolved = await _resolveTabId(tabId);
    if (resolved.error) return _err(resolved.error);

    const { tree, error } = await _axTree(resolved.id, { filter: 'all', maxChars: 400000 });
    if (error) return _err(`Failed to find element: ${error}`);
    if (tree.error) return _err(tree.error);

    const terms = String(query).toLowerCase().split(/\s+/).filter(Boolean);
    const hits = [];
    for (const line of tree.pageContent.split('\n')) {
      const hay = line.toLowerCase();
      let score = 0;
      for (const t of terms) if (hay.includes(t)) score++;
      if (score > 0) hits.push({ line, score });
    }
    hits.sort((a, b) => b.score - a.score);

    _touchSession(resolved.id);
    if (hits.length === 0) {
      return _ok(
        `No element matched "${query}". This is a literal match over the accessibility ` +
        'tree, not the model-backed finder, so try single distinctive words, or call ' +
        'read_page and pick the element yourself.'
      );
    }
    const shown = hits.slice(0, _FIND_MAX_HITS).map(h => h.line.trim()).join('\n');
    const more = hits.length > _FIND_MAX_HITS ? `\n[${hits.length - _FIND_MAX_HITS} more matches not shown]` : '';
    return _ok(
      `Literal matches for "${query}" (Arc build: text match, not the model-backed finder):\n${shown}${more}`
    );
  },

  async javascript_tool(args) {
    const { action, text, tabId } = args || {};
    if (action && action !== 'javascript_exec') {
      return _err(`Unsupported action "${action}". javascript_tool only supports "javascript_exec".`);
    }
    if (!text) return _err('text is required — pass the JavaScript expression to evaluate.');

    const resolved = await _resolveTabId(tabId);
    if (resolved.error) return _err(resolved.error);

    // MAIN sees the page's own variables but is bound by the page's CSP.
    // ISOLATED shares the same DOM, so retry there when eval is blocked.
    let blockedMessage = null;
    for (const world of ['MAIN', 'ISOLATED']) {
      let result;
      try {
        result = await _runInTab(resolved.id, _pageEval, [text, _EVAL_OUTPUT_LIMIT], world);
      } catch (e) {
        return _err(`Failed to run JavaScript: ${e.message}`);
      }
      if (!result) return _err('JavaScript ran but returned no result.');
      if (result.cspBlocked) { blockedMessage = result.message; continue; }
      _touchSession(resolved.id);
      if (result.thrown) return _err(`JavaScript threw: ${result.thrown}`);
      return _ok(result.output);
    }

    return _err(
      `This page's Content Security Policy blocks eval in both the page and extension worlds ` +
      `(${blockedMessage}). Use get_page_text or read_page to inspect this page instead.`
    );
  },

  async computer(args) {
    const {
      action, tabId, coordinate, start_coordinate,
      text, duration, scroll_direction, scroll_amount,
      region, scale, ref
    } = args || {};

    const resolved = await _resolveTabId(tabId);
    if (resolved.error) return _err(resolved.error);
    const targetTabId = resolved.id;

    // Clicks are aimed in screenshot pixels and dispatched in CSS pixels. When a
    // click misses, the first thing worth knowing is which frames were involved,
    // so say so rather than making it something to reverse-engineer from ratios.
    const frameNote = async () => {
      if (ref) return '';
      const dims = await _getShotDims(targetTabId);
      if (!dims?.imgW) return ' [no screenshot on record for this tab; coordinates used as-is]';
      return ` [screenshot frame ${dims.imgW}x${dims.imgH} -> viewport ${Math.round(dims.cssW)}x${Math.round(dims.cssH)}]`;
    };

    const run = async (func, fnArgs) => {
      let result;
      try {
        result = await _runInTab(targetTabId, func, fnArgs);
      } catch (e) {
        return _err(`${action} failed: ${e.message}`);
      }
      if (!result) return _err(`${action} returned no result.`);
      _touchSession(targetTabId);
      if (result.error) return _err(result.error);
      return _ok(result.ok);
    };

    const cssCoordinate = async (name) => {
      // A ref from read_page beats a coordinate: it hits the element's own centre,
      // so activation lands on the anchor rather than the cell padding around it.
      if (ref) {
        const point = await _refPoint(targetTabId, ref);
        if (point.error) throw new Error(point.error);
        return [point.x, point.y];
      }
      if (!Array.isArray(coordinate) || coordinate.length < 2) {
        throw new Error(`coordinate [x, y] or ref is required for ${name}.`);
      }
      return _toCssCoords(targetTabId, coordinate);
    };

    try {
      switch (action) {
        case 'screenshot': {
          const tab = await chrome.tabs.get(targetTabId);
          await chrome.tabs.update(targetTabId, { active: true });
          if (tab.windowId) {
            await chrome.windows.update(tab.windowId, { focused: true });
          }
          await new Promise(r => setTimeout(r, 300));
          const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
          const raw = dataUrl.replace(/^data:image\/png;base64,/, '');

          // captureVisibleTab renders at devicePixelRatio, so on a retina display
          // the PNG is twice the CSS viewport. Sent as-is it gets resized again
          // before the model sees it, and the coordinates it reads back are then
          // in a frame nothing here knows about -- clicks land at a fraction of
          // where they were aimed. Resize here instead, and record the frame.
          const vp = await _runInTab(targetTabId, _pageViewport, []);
          const size = _pngSize(raw);
          let base64 = raw;
          let outW = size?.w;
          let outH = size?.h;
          if (size) {
            // Aim at the CSS viewport rather than the largest image the budget
            // allows. A retina capture fitted to the cap comes out *bigger* than
            // the viewport, so every coordinate then needs a conversion that buys
            // nothing. At CSS size the mapping is 1:1 -- what the model reads is
            // what elementFromPoint gets -- and it only shrinks further when the
            // viewport itself is too large for the budget.
            const [fitW, fitH] = _fitImage(
              Math.min(size.w, Math.round(vp?.w || size.w)),
              Math.min(size.h, Math.round(vp?.h || size.h))
            );
            if (fitW !== size.w || fitH !== size.h) {
              try {
                base64 = await _cropPngBase64(raw, 0, 0, size.w, size.h, fitW, fitH);
                outW = fitW;
                outH = fitH;
              } catch (e) {
                // Fall back to the full-size capture rather than failing outright.
              }
            }
          }
          if (vp && outW && outH) {
            await _rememberShotDims(targetTabId, {
              imgW: outW, imgH: outH, cssW: vp.w, cssH: vp.h
            });
          }

          _touchSession(targetTabId);
          return {
            content: [
              {
                type: 'text',
                text: `Successfully captured screenshot (${outW}x${outH}, png)`
              },
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: base64 }
              }
            ]
          };
        }

        case 'wait': {
          const seconds = Math.min(Math.max(Number(duration) || 1, 0), _MAX_WAIT_SECONDS);
          await new Promise(r => setTimeout(r, seconds * 1000));
          return _ok(`Waited ${seconds} second${seconds === 1 ? '' : 's'}.`);
        }

        case 'left_click':
        case 'right_click':
        case 'double_click':
        case 'triple_click':
        case 'hover': {
          const [x, y] = await cssCoordinate(action);
          const result = await run(_pagePointer, [x, y, action]);
          if (result.is_error) return result;
          const note = await frameNote();
          const block = result.content?.[0];
          if (note && block) block.text += note;
          return result;
        }

        case 'type': {
          if (!text) return _err('text is required for the type action.');
          return run(_pageType, [String(text)]);
        }

        case 'key': {
          if (!text) return _err('text is required for the key action.');
          let last = null;
          for (const key of String(text).trim().split(/\s+/)) {
            last = await run(_pageKey, [key]);
            if (last.is_error) return last;
          }
          return last;
        }

        case 'scroll': {
          let x;
          let y;
          if (Array.isArray(coordinate) && coordinate.length >= 2) {
            [x, y] = await _toCssCoords(targetTabId, coordinate);
          } else {
            const vp = await _runInTab(targetTabId, _pageViewport, []);
            if (!vp) return _err('Could not measure the viewport to scroll.');
            x = (vp.pageW || vp.w) / 2;
            y = vp.h / 2;
          }
          return run(_pageScroll, [x, y, scroll_direction, scroll_amount]);
        }

        case 'left_click_drag': {
          if (!Array.isArray(start_coordinate) || start_coordinate.length < 2) {
            return _err('start_coordinate [x, y] is required for left_click_drag.');
          }
          if (!Array.isArray(coordinate) || coordinate.length < 2) {
            return _err('coordinate [x, y] is required for left_click_drag.');
          }
          const [x0, y0] = await _toCssCoords(targetTabId, start_coordinate);
          const [x1, y1] = await cssCoordinate('left_click_drag');
          return run(_pageDrag, [x0, y0, x1, y1]);
        }

        case 'scroll_to': {
          if (!ref) return _err('ref is required for the scroll_to action.');
          let last = null;
          for (const world of _AXTREE_WORLDS) {
            last = await _runInTab(targetTabId, _pageScrollToRef, [String(ref)], world);
            if (last && last.ok) {
              _touchSession(targetTabId);
              return _ok(last.ok);
            }
          }
          return _err(last?.error || 'Could not resolve that element reference.');
        }

        case 'zoom': {
          // The official zoom clips Page.captureScreenshot through the debugger.
          // Arc never attaches, so capture the whole viewport and crop it here.
          if (!Array.isArray(region) || region.length !== 4) {
            return _err('region [x0, y0, x1, y1] is required for the zoom action.');
          }
          const [rx0, ry0] = await _toCssCoords(targetTabId, [region[0], region[1]]);
          const [rx1, ry1] = await _toCssCoords(targetTabId, [region[2], region[3]]);
          if (rx0 < 0 || ry0 < 0 || rx1 <= rx0 || ry1 <= ry0) {
            return _err('Invalid region: x0 and y0 must be >= 0, x1 > x0 and y1 > y0.');
          }

          const vp = await _runInTab(targetTabId, _pageViewport, []);
          if (!vp) return _err('Could not measure the viewport to zoom.');
          if (rx1 > vp.w + 1 || ry1 > vp.h + 1) {
            return _err(
              `Region exceeds the viewport (${Math.round(vp.w)}x${Math.round(vp.h)} CSS px). ` +
              'Choose a region inside the visible area, or scroll first.'
            );
          }

          const tab = await chrome.tabs.get(targetTabId);
          await chrome.tabs.update(targetTabId, { active: true });
          if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
          await new Promise(r => setTimeout(r, 300));
          const shotUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
          const shot = shotUrl.replace(/^data:image\/png;base64,/, '');

          // captureVisibleTab renders at devicePixelRatio; the region is in CSS px.
          const size = _pngSize(shot);
          const ratio = size && vp.w ? size.w / vp.w : (vp.dpr || 1);
          const sx = Math.max(0, Math.round(rx0 * ratio));
          const sy = Math.max(0, Math.round(ry0 * ratio));
          const sw = Math.max(1, Math.min(Math.round((rx1 - rx0) * ratio), (size?.w || Infinity) - sx));
          const sh = Math.max(1, Math.min(Math.round((ry1 - ry0) * ratio), (size?.h || Infinity) - sy));

          // Scale up so small regions are actually legible, but stay inside the
          // model's image budget. `scale` (0.1-1) shrinks, matching the official tool.
          const shrink = Number.isFinite(Number(scale)) && Number(scale) >= 0.1 && Number(scale) <= 1
            ? Number(scale)
            : 1;
          const fit = Math.min(_ZOOM_MAX_SIDE / sw, _ZOOM_MAX_SIDE / sh, _ZOOM_MAX_UPSCALE);
          const factor = Math.max(0.1, Math.min(fit, _ZOOM_MAX_UPSCALE)) * shrink;
          const dw = Math.max(1, Math.round(sw * factor));
          const dh = Math.max(1, Math.round(sh * factor));

          let cropped;
          try {
            cropped = await _cropPngBase64(shot, sx, sy, sw, sh, dw, dh);
          } catch (e) {
            return _err(`Could not crop the zoomed region: ${e.message || String(e)}`);
          }

          // Record the frame a full screenshot would have used, not the crop's
          // own size: coordinates for later clicks still come from full shots.
          const capW = size?.w || Math.round(vp.w * ratio);
          const capH = size?.h || Math.round(vp.h * ratio);
          const [frameW, frameH] = _fitImage(
            Math.min(capW, Math.round(vp.w)),
            Math.min(capH, Math.round(vp.h))
          );
          await _rememberShotDims(targetTabId, {
            imgW: frameW, imgH: frameH, cssW: vp.w, cssH: vp.h
          });
          _touchSession(targetTabId);

          return {
            content: [
              {
                type: 'text',
                text: `Successfully captured zoomed screenshot of region ` +
                      `(${Math.round(region[0])}, ${Math.round(region[1])}) to ` +
                      `(${Math.round(region[2])}, ${Math.round(region[3])}) - ${dw}x${dh} pixels. ` +
                      'Click coordinates still come from a full screenshot, not this crop.'
              },
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: cropped }
              }
            ]
          };
        }

        default:
          return _err(`Unknown computer action "${action}".`);
      }
    } catch (e) {
      return _err(e.message || String(e));
    }
  }
};

const INTERCEPTED_TOOL_NAMES = new Set(Object.keys(TOOL_HANDLERS));

self._arcBridgeInterceptor = {
  canHandle(toolName) {
    return INTERCEPTED_TOOL_NAMES.has(toolName);
  },

  async handleBridgeToolCall(parsed, sendFn) {
    const toolUseId = parsed.tool_use_id;
    const toolName = parsed.tool;
    const args = parsed.args ?? {};

    const handler = TOOL_HANDLERS[toolName];
    if (!handler) {
      const msg = { type: 'tool_result', tool_use_id: toolUseId, ..._err(`Unknown tool: ${toolName}`) };
      sendFn(JSON.stringify(msg));
      return;
    }

    try {
      const result = await handler(args);
      const msg = { type: 'tool_result', tool_use_id: toolUseId, ...result };
      sendFn(JSON.stringify(msg));
    } catch (e) {
      const msg = { type: 'tool_result', tool_use_id: toolUseId, ..._err(e.message || String(e)) };
      sendFn(JSON.stringify(msg));
    }
  }
};

console.log(
  `[Arc Bridge Interceptor] v${_INTERCEPTOR_VERSION} loaded. Handling tools:`,
  [...INTERCEPTED_TOOL_NAMES].join(', ')
);
