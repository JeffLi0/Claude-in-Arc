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

const _INTERCEPTOR_VERSION = '0.8.0';

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

const TOOL_HANDLERS = {
  async tabs_context_mcp(args) {
    const { createIfEmpty } = args || {};
    const tabs = await _queryUserTabs();
    if (tabs.length === 0 && createIfEmpty) {
      const newTab = await chrome.tabs.create({ active: false, url: 'about:blank' });
      return _buildTabContext(newTab.id);
    }
    return _buildTabContext(await _getActiveTabId());
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
