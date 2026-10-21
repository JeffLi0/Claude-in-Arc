/**
 * Arc Bridge Interceptor
 * Answers the tab tools for Claude Code and Claude Desktop in Arc.
 *
 * Upstream keeps Claude's tabs in a Chrome tab group: tabs_create_mcp groups
 * the new tab and tabs_context_mcp lists the group. Arc's chrome.tabs.group
 * never settles, so those calls hang or come back empty. Everything else --
 * clicks, typing, screenshots, find, read_page, JavaScript -- runs on
 * upstream's own tools, which work in Arc now that chrome.debugger attaches.
 *
 * The shim (arc-sidepanel-shim.js) detects tool_call messages and dispatches
 * them here via self._arcBridgeInterceptor.handleBridgeToolCall().
 */

const _INTERCEPTOR_VERSION = '0.9.0';

function _ok(text) {
  return { content: [{ type: 'text', text }] };
}

function _err(text) {
  return { content: [{ type: 'text', text }], is_error: true };
}

// Where a tab is, or is going: while a navigation loads, `url` still holds the
// page it's leaving and the new address is in `pendingUrl`.
function _tabUrl(t) {
  return t.pendingUrl || t.url || '';
}

async function _queryUserTabs() {
  const all = await chrome.tabs.query({});
  // about:blank stays: it's what tabs_create_mcp opens, and leaving it out had
  // Claude Code lose track of a new tab until its first page committed
  // ("Couldn't determine which page this action targets").
  return all.filter(t => {
    const u = _tabUrl(t);
    return !u.startsWith('chrome://') &&
           !u.startsWith('chrome-extension://') &&
           !u.startsWith('arc://') &&
           !(u.startsWith('about:') && u !== 'about:blank');
  });
}

async function _buildTabContext(selectedTabId) {
  const tabs = await _queryUserTabs();
  const ctx = {
    availableTabs: tabs.map(t => ({
      tabId: t.id,
      title: t.title || '',
      url: _tabUrl(t)
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

// Tabs Claude opened: by tabs_create_mcp, or from a page in one of them (a
// link with target=_blank, a popup). In Chrome these are the tabs in Claude's
// group, the only ones its tools can reach. Arc has no groups, so every tab
// is reachable, and this list is what keeps navigate off the user's own.
// Kept in storage.session so a service-worker restart doesn't forget it.
const _OWNED_KEY = 'arc_claude_owned_tabs';
let _ownedTail = Promise.resolve();

function _updateOwned(fn) {
  const run = _ownedTail.then(async () => {
    const r = await chrome.storage.session.get(_OWNED_KEY);
    const next = fn(new Set(r[_OWNED_KEY] || []));
    if (next) await chrome.storage.session.set({ [_OWNED_KEY]: [...next] });
  });
  _ownedTail = run.catch(() => {});
  return run;
}

async function _ownedTabs() {
  await _ownedTail;
  const r = await chrome.storage.session.get(_OWNED_KEY);
  return new Set(r[_OWNED_KEY] || []);
}

function _ownTab(tabId) {
  return _updateOwned(owned => owned.add(tabId));
}

chrome.tabs.onCreated.addListener((tab) => {
  if (tab.openerTabId === undefined) return;
  _updateOwned(owned => owned.has(tab.openerTabId) ? owned.add(tab.id) : null).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  _updateOwned(owned => owned.delete(tabId) ? owned : null).catch(() => {});
});

// Tools that don't act on a page.
const _TAB_FREE_TOOLS = new Set(['tabs_context_mcp', 'tabs_create_mcp', 'shortcuts_list']);

// Same parsing upstream applies to a tool's tabId.
function _tabIdArg(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (!Number.isNaN(n)) return n;
  }
  return undefined;
}

// Called by upstream's MCP tool executor before it resolves the target tab
// (the "no implicit tab" patch in scripts/build.py). Given no tabId, upstream
// falls back to the first tab in Claude's group, which in Chrome is always
// Claude's own. In Arc it can be any of the user's tabs, and a navigate sent
// without a tabId replaced whatever page the user had open there. Returns an
// error message to reject the call, or null to let it run.
async function _checkToolTab(call) {
  // The panel's own agent works on the tab it's open in; only Claude Code and
  // Claude Desktop come in over these.
  if (call?.source !== 'bridge' && call?.source !== 'native-messaging') return null;
  const isBatch = call.toolName === 'browser_batch';
  if (isBatch && !Array.isArray(call.args?.actions)) return null;
  const steps = isBatch
    ? call.args.actions.map(a => ({ name: a?.name, args: a?.input }))
    : [{ name: call.toolName, args: call.args }];

  let owned;
  for (const [i, step] of steps.entries()) {
    if (typeof step.name !== 'string' || _TAB_FREE_TOOLS.has(step.name)) continue;
    const where = isBatch ? `browser_batch actions[${i}] (${step.name})` : step.name;
    const tabId = _tabIdArg(step.args?.tabId);
    if (tabId === undefined) {
      return `${where} needs a tabId. In Arc there is no default tab: without one, ` +
        `the action could land in one of the user's own tabs. Call tabs_create_mcp ` +
        `to open a tab for this task and pass its tabId.`;
    }
    if (step.name === 'navigate') {
      owned ??= await _ownedTabs();
      if (!owned.has(tabId)) {
        return `${where} can't change tab ${tabId}: it's one of the user's own tabs, ` +
          `not one opened for this task. Call tabs_create_mcp and navigate the new ` +
          `tab instead. Reading and interacting with the user's tabs still works.`;
      }
    }
  }
  return null;
}

self._arcCheckToolTab = _checkToolTab;

const TOOL_HANDLERS = {
  async tabs_context_mcp(args) {
    const { createIfEmpty } = args || {};
    const tabs = await _queryUserTabs();
    if (tabs.length === 0 && createIfEmpty) {
      const newTab = await chrome.tabs.create({ active: false, url: 'about:blank' });
      await _ownTab(newTab.id);
      return _buildTabContext(newTab.id);
    }
    return _buildTabContext(await _getActiveTabId());
  },

  async tabs_create_mcp(_args) {
    const newTab = await chrome.tabs.create({ active: false, url: 'about:blank' });
    await _ownTab(newTab.id);
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
