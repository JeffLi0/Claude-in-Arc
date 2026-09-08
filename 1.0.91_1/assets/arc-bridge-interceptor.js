/**
 * Arc Bridge Interceptor
 * Intercepts MCP tool_call messages from the bridge WebSocket and executes
 * them using Arc-compatible Chrome APIs, bypassing the official handler
 * which silently fails in Arc.
 *
 * The shim (arc-sidepanel-shim.js) detects tool_call messages and dispatches
 * them here via self._arcBridgeInterceptor.handleBridgeToolCall().
 */

const _INTERCEPTOR_VERSION = '0.7.0';
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

// The tab Claude is working in, so browsing can reuse it instead of either
// taking over the user's current tab or piling up a new one per navigation.
const _OWN_TAB_KEY = 'claude_arc_own_tab';

async function _rememberOwnTab(tabId) {
  try {
    await chrome.storage.session.set({ [_OWN_TAB_KEY]: tabId });
  } catch (e) {}
}

async function _getOwnTab() {
  try {
    const r = await chrome.storage.session.get(_OWN_TAB_KEY);
    const id = r[_OWN_TAB_KEY];
    if (typeof id !== 'number') return null;
    await chrome.tabs.get(id);
    return id;
  } catch (e) {
    // Closed since we last used it.
    return null;
  }
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

async function _runInFrame(tabId, frameId, func, args, world = 'MAIN') {
  const [res] = await chrome.scripting.executeScript({
    target: frameId ? { tabId, frameIds: [frameId] } : { tabId },
    world,
    func,
    args
  });
  return res?.result;
}

async function _runInTab(tabId, func, args, world = 'MAIN') {
  return _runInFrame(tabId, 0, func, args, world);
}

// A click that lands in a cross-origin iframe has to be re-injected into that
// frame, which means turning the <iframe> element the top frame saw into a
// frameId. Pair webNavigation's parent/child structure with a per-frame probe
// for size, so a frame can be identified by its position in the tree even when
// several embeds share a URL.
async function _frameTree(tabId) {
  let nav = [];
  try {
    nav = (await chrome.webNavigation.getAllFrames({ tabId })) || [];
  } catch (e) {
    return [];
  }
  let probes = [];
  try {
    probes = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: 'MAIN',
      func: () => ({ href: location.href, w: innerWidth, h: innerHeight })
    });
  } catch (e) {
    probes = [];
  }
  const sizes = new Map();
  for (const pr of probes) {
    if (pr && pr.result) sizes.set(pr.frameId, pr.result);
  }
  return nav.map(f => Object.assign(
    { frameId: f.frameId, parentFrameId: f.parentFrameId, url: f.url },
    sizes.get(f.frameId) || {}
  ));
}

/** Pick the child frame matching the <iframe> the pointer walk stopped on. */
function _matchFrame(frames, parentFrameId, want) {
  let pool = frames.filter(f => f.parentFrameId === parentFrameId);
  if (!pool.length) pool = frames.filter(f => f.frameId !== parentFrameId);
  if (!pool.length) return null;
  if (pool.length === 1) return pool[0].frameId;

  const byUrl = want.url
    ? pool.filter(f => f.url === want.url || f.href === want.url)
    : [];
  if (byUrl.length === 1) return byUrl[0].frameId;

  // innerWidth counts the scrollbar that the element's clientWidth excludes, so
  // this has to tolerate more than a rounding error.
  const near = (a, b) => typeof a === 'number' && Math.abs(a - b) <= 18;
  const bySize = (byUrl.length ? byUrl : pool)
    .filter(f => near(f.w, want.w) && near(f.h, want.h));
  return bySize.length === 1 ? bySize[0].frameId : null;
}

// Where the last click landed, so a follow-up type/key reaches the field it
// focused rather than the top document.
const _LAST_FRAME = new Map();

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
async function _cropPngBase64(base64, sx, sy, sw, sh, dw, dh, opts) {
  const type = opts?.type || 'image/png';
  const blob = new Blob([_b64ToBytes(base64)], { type: 'image/png' });
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = new OffscreenCanvas(dw, dh);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('OffscreenCanvas 2d context unavailable.');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    if (type !== 'image/png') {
      // JPEG carries no alpha, so anything the capture left transparent would
      // come out black. Lay down the page's own white first.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, dw, dh);
    }
    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, dw, dh);
    const outBlob = await canvas.convertToBlob(
      type === 'image/png' ? { type } : { type, quality: opts?.quality ?? 0.85 }
    );
    return _bytesToB64(new Uint8Array(await outBlob.arrayBuffer()));
  } finally {
    bitmap.close();
  }
}

// The bridge refuses any tool result over 1MB and the image is nearly all of
// it, so budget the base64 -- that is the form that gets counted -- and leave
// headroom for the JSON around it. Fitting the token budget is not enough on
// its own: a screenshot of a dense page is well inside 1568px and still encodes
// past a megabyte as PNG.
const _MAX_IMAGE_B64 = 700000;

const _ENCODE_LADDER = [
  { type: 'image/png' },
  { type: 'image/jpeg', quality: 0.85 },
  { type: 'image/jpeg', quality: 0.6 }
];

/**
 * Encode a capture at the requested size, then keep degrading until it fits
 * the result cap: PNG first, then JPEG at falling quality, then smaller
 * dimensions. Returns the frame it settled on, because coordinates map
 * proportionally off the recorded frame -- a shrunk image is still clickable
 * as long as the caller records what came back.
 */
async function _encodeWithinBudget(raw, sx, sy, sw, sh, dw, dh) {
  let w = Math.max(1, Math.round(dw));
  let h = Math.max(1, Math.round(dh));
  for (;;) {
    for (const opt of _ENCODE_LADDER) {
      const data = await _cropPngBase64(raw, sx, sy, sw, sh, w, h, opt);
      if (data.length <= _MAX_IMAGE_B64) {
        return { data, mediaType: opt.type, w, h };
      }
    }
    if (w <= 400 || h <= 400) {
      throw new Error('capture will not fit the 1MB result limit even at minimum size');
    }
    w = Math.max(1, Math.round(w * 0.75));
    h = Math.max(1, Math.round(h * 0.75));
  }
}

/** PNG dimensions, falling back to a decode when the header can't be read. */
async function _imageSize(base64) {
  const header = _pngSize(base64);
  if (header) return header;
  const bitmap = await createImageBitmap(
    new Blob([_b64ToBytes(base64)], { type: 'image/png' })
  );
  try {
    return { w: bitmap.width, h: bitmap.height };
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
  let doc = document;
  let win = window;
  let el = doc.elementFromPoint(x, y);
  if (!el) {
    return {
      error: 'No element at (' + Math.round(x) + ', ' + Math.round(y) +
        '). The coordinate may be outside the viewport, or the page may have scrolled since the screenshot.'
    };
  }

  // elementFromPoint stops at whatever hosts the real target -- a shadow host or
  // an iframe -- so a click dispatched there never reaches the control. Keep
  // descending: into shadow roots directly, and into same-origin frames by
  // switching document. A cross-origin frame can't be reached from here, so hand
  // the caller what it needs to re-inject into that frame instead.
  for (let hops = 0; hops < 12; hops++) {
    if (el.shadowRoot) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (inner && inner !== el) { el = inner; continue; }
    }
    const tag = String(el.nodeName).toLowerCase();
    if (tag !== 'iframe' && tag !== 'frame') break;

    // The frame's content origin, not its border box: a bordered or padded
    // iframe would otherwise shift every coordinate inside it.
    const rect = el.getBoundingClientRect();
    let ox = rect.left;
    let oy = rect.top;
    try {
      const cs = win.getComputedStyle(el);
      ox += (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.paddingLeft) || 0);
      oy += (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.paddingTop) || 0);
    } catch (e) {}
    const fx = x - ox;
    const fy = y - oy;

    let childDoc = null;
    try { childDoc = el.contentDocument; } catch (e) { childDoc = null; }
    if (childDoc && typeof childDoc.elementFromPoint === 'function') {
      const inner = childDoc.elementFromPoint(fx, fy);
      if (!inner) break;
      doc = childDoc;
      win = el.contentWindow || win;
      el = inner;
      x = fx;
      y = fy;
      continue;
    }
    return {
      frame: { url: el.src || '', x: fx, y: fy, w: el.clientWidth, h: el.clientHeight }
    };
  }

  const describeEl = (node) => {
    const id = node.id ? '#' + node.id : '';
    const txt = (node.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    return '<' + String(node.nodeName).toLowerCase() + id + '>' + (txt ? ' "' + txt + '"' : '');
  };

  const isRight = kind === 'right_click';
  const base = {
    bubbles: true, cancelable: true, composed: true, view: win,
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
    if (i === 1) {
      // Focus the thing that can hold focus, not the leaf the point landed on.
      // Inside a rich editor that leaf is usually a <span>, and focusing it does
      // nothing -- the editable host never becomes activeElement, so every
      // keystroke afterwards goes to the body.
      const FOCUSABLE = 'input, textarea, select, button, a[href], ' +
        '[contenteditable=""], [contenteditable="true"], [tabindex]';
      const target = (typeof el.closest === 'function' && el.closest(FOCUSABLE)) || el;
      if (typeof target.focus === 'function') {
        try { target.focus({ preventScroll: true }); } catch (e) {
          try { target.focus(); } catch (e2) {}
        }
      }
      // A real click also places the caret, and editors built on a model --
      // Slate, ProseMirror, Quill -- derive their internal selection from the
      // DOM selection. Without one they have nowhere to apply an edit: text can
      // still land in the DOM while the model stays empty, so the editor
      // serialises nothing and the visible text is discarded.
      if (target.isContentEditable) {
        try {
          let range = null;
          if (typeof doc.caretRangeFromPoint === 'function') {
            range = doc.caretRangeFromPoint(x, y);
          } else if (typeof doc.caretPositionFromPoint === 'function') {
            const pos = doc.caretPositionFromPoint(x, y);
            if (pos) {
              range = doc.createRange();
              range.setStart(pos.offsetNode, pos.offset);
              range.collapse(true);
            }
          }
          const sel = win.getSelection ? win.getSelection() : doc.getSelection();
          if (range && sel) { sel.removeAllRanges(); sel.addRange(range); }
          else if (sel && typeof sel.collapse === 'function') {
            // No caret at that exact point (padding, say) -- land in the host.
            try { sel.collapse(target, target.childNodes.length); } catch (e) {}
          }
        } catch (e) {}
      }
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
      const sel = doc.getSelection();
      if (sel) { sel.removeAllRanges(); sel.selectAllChildren(el); }
    } catch (e) {}
  }

  // A rich-text editor is a contenteditable <div>, which matched nothing here,
  // so clicking Discord's or Notion's composer reported "nothing clickable" even
  // though the click had landed and focused it.
  const ACTIVATABLE = 'a[href], button, input, select, textarea, label, summary, ' +
    '[contenteditable=""], [contenteditable="true"], ' +
    '[role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="checkbox"], ' +
    '[role="textbox"], [role="searchbox"], [role="combobox"], [role="switch"], ' +
    '[role="radio"], [role="option"], [role="menuitemcheckbox"], [role="menuitemradio"], ' +
    '[role="treeitem"], [onclick], [tabindex]';
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
  const el = document.activeElement || document.body;
  const tag = el && el.tagName ? el.tagName.toLowerCase() : '';
  const isField = tag === 'input' || tag === 'textarea';
  const editable = isField || !!(el && el.isContentEditable);
  if (!el) return { error: 'The page has no focused element to type into.' };

  // Not every target is a field. Games, editors and shortcut layers capture
  // keystrokes off the document and keep their own state, so refusing to type
  // without a field made those unreachable -- the keys are the whole point
  // there, and there is simply nothing to insert into.

  // Frameworks like React shadow the instance `value` setter to track edits;
  // going through the prototype setter keeps their state in sync.
  const proto = isField
    ? (tag === 'textarea' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype)
    : null;
  const desc = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null;

  // Not every input type supports selection -- number, email and colour raise
  // on read rather than returning null -- so a failure here means "append".
  const caret = () => {
    try {
      const s = el.selectionStart;
      const e = el.selectionEnd;
      if (typeof s === 'number' && typeof e === 'number') return [s, e];
    } catch (err) {}
    return [el.value.length, el.value.length];
  };

  const insert = (chunk) => {
    if (!editable) return false;
    if (!isField) return document.execCommand('insertText', false, chunk);
    const [start, end] = caret();
    const next = el.value.slice(0, start) + chunk + el.value.slice(end);
    el.dispatchEvent(new InputEvent('beforeinput', {
      bubbles: true, cancelable: true, composed: true, inputType: 'insertText', data: chunk
    }));
    if (desc && desc.set) desc.set.call(el, next); else el.value = next;
    try { el.setSelectionRange(start + chunk.length, start + chunk.length); } catch (err) {}
    el.dispatchEvent(new InputEvent('input', {
      bubbles: true, composed: true, inputType: 'insertText', data: chunk
    }));
    return true;
  };

  // Real typing is a key event per character, and a lot of UI is built on that
  // rather than on `input`: autocompletes, search-as-you-type, input masks,
  // character counters, single-key shortcuts. Setting `value` in one shot fires
  // none of it, so the field fills in and nothing downstream reacts. Replay the
  // per-character sequence, up to a length where the event traffic stops paying
  // for itself.
  // KeyboardEvent's constructor defaults keyCode/charCode to 0, and anything
  // that captures raw keystrokes instead of hosting a field -- games, editors,
  // shortcut layers -- still identifies letters by keyCode. A 0 reads as "no
  // key" and gets dropped, which is why arrows worked (matched by name) and
  // letters silently did not. Chrome accepts these as legacy init members.
  const physical = (ch) => {
    if (/^[a-zA-Z]$/.test(ch)) return ch.toUpperCase().charCodeAt(0);
    if (/^[0-9]$/.test(ch)) return ch.charCodeAt(0);
    if (ch === ' ') return 32;
    return ch.charCodeAt(0) || 0;
  };

  const chars = Array.from(text);
  if (chars.length <= 250 || !editable) {
    for (const ch of chars) {
      const kc = physical(ch);
      const init = {
        key: ch,
        code: /^[a-zA-Z]$/.test(ch) ? 'Key' + ch.toUpperCase()
          : /^[0-9]$/.test(ch) ? 'Digit' + ch
          : ch === ' ' ? 'Space' : '',
        bubbles: true, cancelable: true, composed: true, view: window,
        shiftKey: /^[A-Z]$/.test(ch),
        keyCode: kc, charCode: 0, which: kc
      };
      const allowed = el.dispatchEvent(new KeyboardEvent('keydown', init));
      // Real typing fires keypress between keydown and the edit, carrying the
      // character's own code rather than the physical key's.
      if (allowed) {
        const cc = ch.charCodeAt(0);
        el.dispatchEvent(new KeyboardEvent('keypress', Object.assign(
          {}, init, { keyCode: cc, charCode: cc, which: cc }
        )));
      }
      // A plain field calling preventDefault is rejecting the character, the
      // same as it would a real keystroke -- a digits-only mask, say. Rich
      // editors also preventDefault, but then insert through their own logic,
      // which a synthetic event won't reach; there, honouring it would type
      // nothing at all.
      if (allowed || !isField) insert(ch);
      el.dispatchEvent(new KeyboardEvent('keyup', init));
    }
  } else {
    insert(text);
  }

  if (isField) el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  if (editable) {
    return {
      ok: 'Typed ' + chars.length + ' characters into ' +
        (isField ? '<' + tag + '>' : 'a contenteditable element')
    };
  }
  return {
    ok: 'Sent ' + chars.length + ' keystrokes to <' + tag + '>. No text field is focused, ' +
      'so nothing was inserted directly. A page with its own keystroke capture receives input ' + 
      'this way; otherwise click a field first and check the result.'
  };
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

  // Keep the token's own case: lowercasing everything turned Shift+A into 'a'.
  const raw = String(combo).split('+').map(p => p.trim()).filter(Boolean);
  const mods = { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };
  let keyName = null;
  for (const token of raw) {
    const p = token.toLowerCase();
    if (p === 'ctrl' || p === 'control') mods.ctrlKey = true;
    else if (p === 'cmd' || p === 'meta' || p === 'command') mods.metaKey = true;
    else if (p === 'alt' || p === 'option') mods.altKey = true;
    else if (p === 'shift') mods.shiftKey = true;
    else keyName = NAMES[p] || (token.length === 1 ? token : p.charAt(0).toUpperCase() + p.slice(1));
  }
  if (!keyName) return { error: 'No key found in "' + combo + '".' };
  if (mods.shiftKey && /^[a-z]$/.test(keyName)) keyName = keyName.toUpperCase();

  const el = document.activeElement || document.body;
  let code = keyName;
  if (keyName.length === 1) {
    if (/[a-z]/i.test(keyName)) code = 'Key' + keyName.toUpperCase();
    else if (/[0-9]/.test(keyName)) code = 'Digit' + keyName;
    else if (keyName === ' ') code = 'Space';
  }

  // Without these the event carries keyCode 0, and anything identifying keys
  // the legacy way -- games and editors that capture keystrokes rather than
  // host a field -- discards it. Chrome honours them as init members.
  const CODES = {
    Enter: 13, Tab: 9, Backspace: 8, Delete: 46, Escape: 27, ' ': 32,
    ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39,
    PageUp: 33, PageDown: 34, Home: 36, End: 35
  };
  let keyCode = CODES[keyName] || 0;
  if (!keyCode && keyName.length === 1) {
    keyCode = /^[a-z]$/i.test(keyName)
      ? keyName.toUpperCase().charCodeAt(0)
      : keyName.charCodeAt(0);
  }

  const init = Object.assign({
    key: keyName, code, bubbles: true, cancelable: true, composed: true, view: window,
    keyCode, charCode: 0, which: keyCode
  }, mods);

  const notPrevented = el.dispatchEvent(new KeyboardEvent('keydown', init));

  // Synthetic key events never mutate a field, so apply the common edits here.
  const tag = (el.tagName || '').toLowerCase();
  const isField = tag === 'input' || tag === 'textarea';
  if (notPrevented) {
    const printable = keyName.length === 1 && !mods.ctrlKey && !mods.metaKey && !mods.altKey;
    if ((mods.metaKey || mods.ctrlKey) && String(keyName).toLowerCase() === 'a') {
      if (isField && typeof el.select === 'function') el.select();
      else { try { document.getSelection()?.selectAllChildren(el); } catch (e) {} }
    } else if (printable) {
      // keypress carries the character's code, not the physical key's.
      const cc = keyName.charCodeAt(0);
      el.dispatchEvent(new KeyboardEvent('keypress', Object.assign(
        {}, init, { keyCode: cc, charCode: cc, which: cc }
      )));
      // Only modifiers and editing keys were ever applied, so a bare character
      // fired keydown/keyup and inserted nothing: `key: "a"` reported success
      // and left the field empty. `space` did the same.
      if (isField) {
        let s = el.value.length;
        let e = s;
        try {
          if (typeof el.selectionStart === 'number') {
            s = el.selectionStart;
            e = el.selectionEnd;
          }
        } catch (err) {}
        const proto = tag === 'textarea'
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, 'value');
        const next = el.value.slice(0, s) + keyName + el.value.slice(e);
        if (desc && desc.set) desc.set.call(el, next); else el.value = next;
        try { el.setSelectionRange(s + 1, s + 1); } catch (err) {}
        el.dispatchEvent(new InputEvent('input', {
          bubbles: true, composed: true, inputType: 'insertText', data: keyName
        }));
      } else if (el.isContentEditable) {
        document.execCommand('insertText', false, keyName);
      }
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
      await _rememberOwnTab(newTab.id);
      return _buildTabContext(newTab.id);
    }
    const activeId = await _getActiveTabId();
    return _buildTabContext(activeId);
  },

  async tabs_create_mcp(_args) {
    const newTab = await chrome.tabs.create({ active: false, url: 'about:blank' });
    await _rememberOwnTab(newTab.id);
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
    // Read the record before removing: _getOwnTab verifies the tab still
    // exists, so afterwards it could never match.
    let own = null;
    try {
      const r = await chrome.storage.session.get(_OWN_TAB_KEY);
      own = r[_OWN_TAB_KEY];
    } catch (e) {}
    await chrome.tabs.remove(tabId);
    if (own === tabId) {
      try { await chrome.storage.session.remove(_OWN_TAB_KEY); } catch (e) {}
    }
    return _buildTabContext(await _getActiveTabId());
  },

  async navigate(args) {
    const { url, tabId, force } = args || {};
    if (!url) return _err('url is required.');
    let targetTabId = tabId;
    if (typeof targetTabId !== 'number') {
      // With no tab named, this used to take whatever the user had in front of
      // them and navigate it away. Reuse the tab Claude already works in, and
      // otherwise open one -- so browsing never replaces the page being read.
      // Passing an explicit tabId still targets that tab, which is how a
      // deliberate "navigate this tab" is expressed.
      targetTabId = await _getOwnTab();
      if (targetTabId == null) {
        const t = await chrome.tabs.create({ url, active: true });
        await _rememberOwnTab(t.id);
        _touchSession(t.id);
        return _ok(`Opened new tab ${t.id} at ${url}`);
      }
    }
    try {
      await chrome.tabs.get(targetTabId);
    } catch {
      return _err(`Tab ${targetTabId} does not exist.`);
    }
    // Deliberately not recorded as Claude's tab: an explicit tabId is a one-off
    // instruction to navigate that tab, and adopting it would mean every later
    // implicit navigation took over the user's tab too.
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

    // Dispatch a pointer event, following the coordinate down through nested
    // frames until it reaches the document that actually owns the target.
    const pointerInFrames = async (x, y, kind) => {
      let frameId = 0;
      let fx = x;
      let fy = y;
      let frames = null;
      for (let hop = 0; hop < 4; hop++) {
        let r;
        try {
          r = await _runInFrame(targetTabId, frameId, _pagePointer, [fx, fy, kind]);
        } catch (e) {
          return _err(`${kind} failed: ${e.message}`);
        }
        if (!r) return _err(`${kind} returned no result.`);
        if (!r.frame) {
          _touchSession(targetTabId);
          _LAST_FRAME.set(targetTabId, frameId);
          if (r.error) return _err(r.error);
          return _ok(frameId ? `${r.ok} [inside frame ${frameId}]` : r.ok);
        }
        if (!frames) frames = await _frameTree(targetTabId);
        const next = _matchFrame(frames, frameId, r.frame);
        if (next == null) {
          return _err(
            `The element at (${Math.round(x)}, ${Math.round(y)}) is inside a cross-origin ` +
            `<iframe>${r.frame.url ? ` (${r.frame.url})` : ''} that could not be matched to a ` +
            'live frame. Use javascript_tool, or interact with the page outside the frame.'
          );
        }
        frameId = next;
        fx = r.frame.x;
        fy = r.frame.y;
      }
      return _err('Gave up after 4 nested frames without reaching a clickable element.');
    };

    // Typing follows the click: focus lives in whichever frame was last clicked,
    // and the top document's activeElement would just be the <iframe>.
    const runFocused = async (func, fnArgs) => {
      const frameId = _LAST_FRAME.get(targetTabId) || 0;
      if (!frameId) return run(func, fnArgs);
      let result;
      try {
        result = await _runInFrame(targetTabId, frameId, func, fnArgs);
      } catch (e) {
        // The frame navigated or went away; fall back to the top document.
        _LAST_FRAME.delete(targetTabId);
        return run(func, fnArgs);
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
          const size = await _imageSize(raw).catch(() => null);
          let base64 = raw;
          let mediaType = 'image/png';
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
            // `scale` (0.1-1) shrinks further, matching the official tool. The
            // model reaches for it the moment a result comes back too large, so
            // it has to actually do something -- ignoring it left the retry
            // failing exactly like the call before it.
            const n = Number(scale);
            const shrink = Number.isFinite(n) && n >= 0.1 && n <= 1 ? n : 1;
            const wantW = Math.max(1, Math.round(fitW * shrink));
            const wantH = Math.max(1, Math.round(fitH * shrink));
            const resized = wantW !== size.w || wantH !== size.h;
            if (resized || raw.length > _MAX_IMAGE_B64) {
              try {
                const enc = await _encodeWithinBudget(
                  raw, 0, 0, size.w, size.h, wantW, wantH
                );
                base64 = enc.data;
                mediaType = enc.mediaType;
                outW = enc.w;
                outH = enc.h;
              } catch (e) {
                if (raw.length > _MAX_IMAGE_B64) {
                  return _err(
                    `Could not encode the screenshot small enough to return: ${e.message || String(e)}`
                  );
                }
                // Otherwise the untouched capture is still a valid answer.
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
                text: `Successfully captured screenshot (${outW}x${outH}, ${mediaType === 'image/png' ? 'png' : 'jpeg'})`
              },
              {
                type: 'image',
                source: { type: 'base64', media_type: mediaType, data: base64 }
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
          const result = await pointerInFrames(x, y, action);
          if (result.is_error) return result;
          const note = await frameNote();
          const block = result.content?.[0];
          if (note && block) block.text += note;
          return result;
        }

        case 'type': {
          if (!text) return _err('text is required for the type action.');
          return runFocused(_pageType, [String(text)]);
        }

        case 'key': {
          if (!text) return _err('text is required for the key action.');
          let last = null;
          for (const key of String(text).trim().split(/\s+/)) {
            last = await runFocused(_pageKey, [key]);
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
          let cropType = 'image/png';
          let cropW = dw;
          let cropH = dh;
          try {
            const enc = await _encodeWithinBudget(shot, sx, sy, sw, sh, dw, dh);
            cropped = enc.data;
            cropType = enc.mediaType;
            cropW = enc.w;
            cropH = enc.h;
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
          // Only when nothing is on record: a real screenshot may have been
          // shrunk to fit the size cap, and overwriting its frame with this
          // hypothetical one would misplace clicks aimed off that image.
          if (!(await _getShotDims(targetTabId))?.imgW) {
            await _rememberShotDims(targetTabId, {
              imgW: frameW, imgH: frameH, cssW: vp.w, cssH: vp.h
            });
          }
          _touchSession(targetTabId);

          return {
            content: [
              {
                type: 'text',
                text: `Successfully captured zoomed screenshot of region ` +
                      `(${Math.round(region[0])}, ${Math.round(region[1])}) to ` +
                      `(${Math.round(region[2])}, ${Math.round(region[3])}) - ${cropW}x${cropH} pixels. ` +
                      'Click coordinates still come from a full screenshot, not this crop.'
              },
              {
                type: 'image',
                source: { type: 'base64', media_type: cropType, data: cropped }
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
