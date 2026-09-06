/**
 * Arc SidePanel Shim
 * Polyfills chrome.sidePanel for Arc Browser where the API is unavailable.
 * Must be imported BEFORE the official service worker bundle so that all
 * references to chrome.sidePanel resolve to our polyfill.
 */

/** When true: write verbose diagnostics to chrome.storage.local (`claude_arc_debug_ring`). Ship with false. */
const ARC_SHIM_DEBUG = false;

// #region optional diagnostics (WebSocket / debugger / tabGroups)
const _SHIM_RING_KEY = 'claude_arc_debug_ring';
const _SHIM_RING_MAX = 200;
async function _shimRingAppend(payload) {
  if (!ARC_SHIM_DEBUG) return;
  try {
    const r = await chrome.storage.local.get(_SHIM_RING_KEY);
    const arr = Array.isArray(r[_SHIM_RING_KEY]) ? r[_SHIM_RING_KEY] : [];
    arr.push(payload);
    while (arr.length > _SHIM_RING_MAX) arr.shift();
    await chrome.storage.local.set({ [_SHIM_RING_KEY]: arr });
  } catch (e) {}
}
function _shimLog(hid, msg, data = {}) {
  if (!ARC_SHIM_DEBUG) return;
  const payload = {
    hypothesisId: hid,
    location: 'arc-sidepanel-shim.js',
    message: msg,
    data: { ...data, swTs: Date.now() },
    timestamp: Date.now(),
    runId: 'arc-shim-debug'
  };
  _shimRingAppend(payload).catch(() => {});
}

{
  const OrigWS = self.WebSocket;
  self.WebSocket = function PatchedWebSocket(url, protocols) {
    const ws = protocols !== undefined ? new OrigWS(url, protocols) : new OrigWS(url);
    const isBridge = typeof url === 'string' && url.includes('bridge.claudeusercontent.com');
    if (!isBridge) return ws;

    _shimLog('H3', 'bridge_ws_created', { url: url.replace(/\/[^/]{20,}$/, '/[TOKEN]') });

    const origSend = ws.send.bind(ws);
    self._arcBridgeWS = ws;
    self._arcBridgeSend = origSend;

    // Captured from the outgoing `connect` frame. The official worker ignores a
    // tool_call addressed to another device (the Claude Desktop app, say), so
    // the interceptor must scope itself the same way.
    let localDeviceId = null;

    const shouldIntercept = (parsed) => {
      if (!parsed || parsed.type !== 'tool_call') return false;
      if (parsed.target_device_id && parsed.target_device_id !== localDeviceId) return false;
      return !!self._arcBridgeInterceptor?.canHandle(parsed.tool);
    };

    ws.send = function(data) {
      try {
        const parsed = JSON.parse(data);
        const sendLog = { type: parsed.type, client_type: parsed.client_type };
        if (parsed.type === 'connect' && parsed.device_id) {
          localDeviceId = parsed.device_id;
          sendLog.local_device_id = parsed.device_id.slice(0, 12);
        }
        if (parsed.type === 'tool_result') {
          sendLog.tool_use_id = parsed.tool_use_id;
          sendLog.hasError = !!parsed.error;
          if (self._arcToolCallTracker) self._arcToolCallTracker.onToolResult();
        }
        _shimLog('H3', 'bridge_ws_send', sendLog);
      } catch (e) {
        _shimLog('H3', 'bridge_ws_send_raw', { len: data?.length });
      }
      return origSend(data);
    };

    ws.addEventListener('open', () => { _shimLog('H3', 'bridge_ws_open', {}); });
    ws.addEventListener('message', (evt) => {
      try {
        const parsed = JSON.parse(evt.data);
        const logData = { type: parsed.type };
        if (parsed.type === 'tool_call') {
          logData.tool = parsed.tool;
          logData.tool_use_id = parsed.tool_use_id;
          logData.target_device_id_prefix = parsed.target_device_id ? parsed.target_device_id.slice(0, 12) : '[none]';
          if (self._arcToolCallTracker) self._arcToolCallTracker.onToolCall(parsed.tool, parsed.tool_use_id);

          if (shouldIntercept(parsed)) {
            logData.intercepted = true;
            _shimLog('INTERCEPT', 'dispatching_tool_call', {
              tool: parsed.tool, tool_use_id: parsed.tool_use_id
            });
            self._arcBridgeInterceptor.handleBridgeToolCall(parsed, origSend)
              .then(() => {
                _shimLog('INTERCEPT', 'tool_call_completed', {
                  tool: parsed.tool, tool_use_id: parsed.tool_use_id
                });
                if (self._arcToolCallTracker) self._arcToolCallTracker.onToolResult();
              })
              .catch(e => {
                _shimLog('INTERCEPT', 'tool_call_error', {
                  tool: parsed.tool, tool_use_id: parsed.tool_use_id, error: String(e)
                });
                // The official handler no longer sees this call, so nothing else
                // will answer it. Reply, or the desktop side waits for a timeout.
                try {
                  origSend(JSON.stringify({
                    type: 'tool_result',
                    tool_use_id: parsed.tool_use_id,
                    content: [{ type: 'text', text: `Arc interceptor failed: ${String(e)}` }],
                    is_error: true
                  }));
                } catch (sendErr) {}
              });
          }
        }
        _shimLog('H3', 'bridge_ws_message', logData);
      } catch (e) {}
    });
    // The official worker installs its own `ws.onmessage` and answers every
    // tool_call it sees, so an intercepted call was being handled twice and two
    // tool_results were racing for one tool_use_id. The official one usually won
    // for anything slow (`computer` screenshot activates the tab and waits before
    // capturing), and in Arc it always loses immediately: `chrome.tabs.group` is a
    // stub, so no tab ever carries the session's group id and the confinement
    // check rejects the target with "Tab N is not in Claude's tab group for this
    // session". Filter those messages out of the official handler's view so the
    // interceptor's result is the only one sent.
    const onmessageDesc = Object.getOwnPropertyDescriptor(OrigWS.prototype, 'onmessage');
    if (onmessageDesc?.set) {
      let officialHandler = null;
      Object.defineProperty(ws, 'onmessage', {
        configurable: true,
        enumerable: true,
        get() { return officialHandler; },
        set(handler) {
          officialHandler = handler;
          if (typeof handler !== 'function') {
            onmessageDesc.set.call(ws, handler);
            return;
          }
          onmessageDesc.set.call(ws, function (evt) {
            try {
              if (shouldIntercept(JSON.parse(evt.data))) return undefined;
            } catch (e) {}
            return handler.apply(this, arguments);
          });
        }
      });
    }

    ws.addEventListener('close', (evt) => {
      _shimLog('H3', 'bridge_ws_close', { code: evt.code, reason: evt.reason, wasClean: evt.wasClean });
    });
    ws.addEventListener('error', () => { _shimLog('H3', 'bridge_ws_error', {}); });

    return ws;
  };
  self.WebSocket.prototype = OrigWS.prototype;
  self.WebSocket.CONNECTING = OrigWS.CONNECTING;
  self.WebSocket.OPEN = OrigWS.OPEN;
  self.WebSocket.CLOSING = OrigWS.CLOSING;
  self.WebSocket.CLOSED = OrigWS.CLOSED;
  _shimLog('H3', 'websocket_wrap_ok', {});
}

// Diagnostics only — these replace the real chrome.debugger methods.
if (ARC_SHIM_DEBUG) {
  const dbg = chrome.debugger;
  if (dbg) {
    const origAttach = dbg.attach.bind(dbg);
    const origDetach = dbg.detach.bind(dbg);
    const origSend = dbg.sendCommand.bind(dbg);

    dbg.attach = function(target, version, cb) {
      _shimLog('H4', 'debugger_attach_called', { target, version });
      if (cb) {
        return origAttach(target, version, (...args) => {
          const err = chrome.runtime.lastError?.message || null;
          _shimLog('H4', 'debugger_attach_cb', { target, error: err });
          cb(...args);
        });
      }
      const p = origAttach(target, version);
      if (p && typeof p.then === 'function') {
        return p.then(r => {
          _shimLog('H4', 'debugger_attach_ok', { target });
          return r;
        }).catch(e => {
          _shimLog('H4', 'debugger_attach_fail', { target, error: String(e) });
          throw e;
        });
      }
      return p;
    };

    dbg.detach = function(target, cb) {
      _shimLog('H4', 'debugger_detach_called', { target });
      if (cb) {
        return origDetach(target, (...args) => {
          _shimLog('H4', 'debugger_detach_cb', { target, error: chrome.runtime.lastError?.message || null });
          cb(...args);
        });
      }
      const p = origDetach(target);
      if (p && typeof p.then === 'function') {
        return p.then(r => { _shimLog('H4', 'debugger_detach_ok', { target }); return r; })
               .catch(e => { _shimLog('H4', 'debugger_detach_fail', { target, error: String(e) }); throw e; });
      }
      return p;
    };

    dbg.sendCommand = function(target, method, params, cb) {
      _shimLog('H4', 'debugger_sendCommand', { target, method });
      if (cb) {
        return origSend(target, method, params, (...args) => {
          _shimLog('H4', 'debugger_sendCommand_cb', { target, method, error: chrome.runtime.lastError?.message || null });
          cb(...args);
        });
      }
      const p = origSend(target, method, params);
      if (p && typeof p.then === 'function') {
        return p.then(r => { _shimLog('H4', 'debugger_cmd_ok', { target, method }); return r; })
               .catch(e => { _shimLog('H4', 'debugger_cmd_fail', { target, method, error: String(e) }); throw e; });
      }
      return p;
    };

    _shimLog('H4', 'debugger_wrap_ok', {});
  } else {
    _shimLog('H4', 'debugger_api_missing', {});
  }
}

{
  if (!chrome.tabGroups) {
    chrome.tabGroups = {
      Color: { GREY: "grey", BLUE: "blue", RED: "red", YELLOW: "yellow", GREEN: "green", PINK: "pink", PURPLE: "purple", CYAN: "cyan", ORANGE: "orange" },
      TAB_GROUP_ID_NONE: -1,
      get: async () => ({}),
      update: async () => ({}),
      query: async () => ([]),
      move: async () => ({})
    };
  }
  if (!chrome.tabs.group) chrome.tabs.group = async () => -1;
  if (!chrome.tabs.ungroup) chrome.tabs.ungroup = async () => {};

  if (chrome.tabGroups && chrome.tabGroups.get && chrome.tabGroups.get.toString().includes('native code')) {
    const origGet = chrome.tabGroups.get.bind(chrome.tabGroups);
    const origUpdate = chrome.tabGroups.update.bind(chrome.tabGroups);
    chrome.tabGroups.get = function(groupId) {
      _shimLog('H5', 'tabGroups_get_called', { groupId });
      return origGet(groupId).then(r => {
        _shimLog('H5', 'tabGroups_get_ok', { groupId });
        return r;
      }).catch(e => {
        _shimLog('H5', 'tabGroups_get_fail', { groupId, error: String(e) });
        throw e;
      });
    };
    chrome.tabGroups.update = function(groupId, props) {
      _shimLog('H5', 'tabGroups_update_called', { groupId, props });
      return origUpdate(groupId, props).then(r => {
        _shimLog('H5', 'tabGroups_update_ok', { groupId });
        return r;
      }).catch(e => {
        _shimLog('H5', 'tabGroups_update_fail', { groupId, error: String(e) });
        throw e;
      });
    };
    _shimLog('H5', 'tabGroups_wrap_ok', {});
  } else {
    _shimLog('H5', 'tabGroups_api_missing', {});
  }
}

{
  chrome.storage.local.get('bridgeDeviceId').then(r => {
    _shimLog('H7', 'stored_bridgeDeviceId', {
      prefix: r.bridgeDeviceId ? r.bridgeDeviceId.slice(0, 12) : '[none]'
    });
  }).catch(() => {});
}

// Diagnostics only. These replace real Chrome APIs, so they stay out of the
// way unless ARC_SHIM_DEBUG is on — and they forward every argument, since
// callers may pass a callback the promise form doesn't have.
if (ARC_SHIM_DEBUG) {
  const origQuery = chrome.tabs.query.bind(chrome.tabs);
  const origGet = chrome.tabs.get.bind(chrome.tabs);
  const origStorageGet = chrome.storage.local.get.bind(chrome.storage.local);
  let _toolCallPending = null;

  chrome.tabs.query = function(queryInfo, ...rest) {
    if (_toolCallPending) {
      _shimLog('H8', 'tabs_query_during_tool', { queryInfo: JSON.stringify(queryInfo)?.slice(0, 100), tool: _toolCallPending });
    }
    return origQuery(queryInfo, ...rest);
  };
  chrome.tabs.get = function(tabId, ...rest) {
    if (_toolCallPending) {
      _shimLog('H8', 'tabs_get_during_tool', { tabId, tool: _toolCallPending });
    }
    return origGet(tabId, ...rest);
  };

  chrome.storage.local.get = function(keys, ...rest) {
    if (_toolCallPending) {
      const keyStr = typeof keys === 'string' ? keys : Array.isArray(keys) ? keys.join(',') : JSON.stringify(keys)?.slice(0, 80);
      if (keyStr && !keyStr.includes('claude_arc_debug_ring')) {
        _shimLog('H9', 'storage_get_during_tool', { keys: keyStr, tool: _toolCallPending });
      }
    }
    return origStorageGet(keys, ...rest);
  };

  self._arcToolCallTracker = {
    onToolCall(tool, toolUseId) {
      _toolCallPending = tool;
      setTimeout(() => {
        if (_toolCallPending === tool) {
          _shimLog('H7', 'tool_call_stalled_5s', { tool, toolUseId });
          // Force recovery
          _toolCallPending = null;
        }
      }, 5000);
    },
    onToolResult() { _toolCallPending = null; }
  };
  _shimLog('H7_H8', 'tabs_and_tracker_wrap_ok', {});
}
// #endregion

// #region agent log
_shimLog('H15', 'polyfill_decision', {
  nativeSidePanelExists: !!chrome.sidePanel,
  nativeOpenType: typeof chrome.sidePanel?.open
});
// #endregion
// Disable native openPanelOnActionClick so the browser doesn't swallow icon clicks
if (chrome.sidePanel?.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
}

// Default to the classic panel rather than the Cowork experience, which
// defaults on in 1.0.91. Cowork embeds claude.ai in a child iframe, and that
// page's `get_sidepanel_host_info` request is only answered when the worker
// sees `sender.tab === undefined` — true of a real side panel, never true
// here, since this panel always lives in a tab. Without this, Cowork reports
// "Can't reach the Claude extension" and renders logged out even with valid
// tokens stored. An explicit choice by the user is left alone.
chrome.storage.local.get('preferCoworkExperience').then((stored) => {
  if (stored.preferCoworkExperience === undefined) {
    return chrome.storage.local.set({ preferCoworkExperience: false });
  }
}).catch(() => {});
const _needsPolyfill = true;

if (_needsPolyfill) {
  const _options = {};
  const _behavior = { openPanelOnActionClick: false };

  // Register action click unconditionally so the toolbar icon always works
  chrome.action?.onClicked.addListener(async (tab) => {
    _shimLog('H12', 'action_clicked', { tabId: tab?.id || null, url: tab?.url || '' });
    if (!tab?.id) return;
    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: 'TOGGLE_INJECTED_PANEL',
        tabId: tab.id
      });
      _shimLog('H12', 'action_toggle_sent', { tabId: tab.id });
    } catch (e) {
      _shimLog('H12', 'action_toggle_fail', { tabId: tab.id, error: String(e) });
    }
  });
  _shimLog('H12', 'action_listener_registered_unconditional', {});

  chrome.sidePanel = {
    async open(opts) {
      const tabId = opts?.tabId;
      _shimLog('H12', 'sidePanel_open_called', { tabId: tabId || null });
      if (!tabId) return;
      try {
        await chrome.tabs.sendMessage(tabId, {
          type: 'SHOW_INJECTED_PANEL',
          tabId
        });
        _shimLog('H12', 'sidePanel_open_dispatched', { tabId });
      } catch (e) {
        _shimLog('H12', 'sidePanel_open_send_fail', { tabId, error: String(e) });
        // Content script not ready
      }
    },

    async close(opts) {
      const tabId = opts?.tabId;
      if (!tabId) return;
      try {
        await chrome.tabs.sendMessage(tabId, {
          type: 'HIDE_INJECTED_PANEL',
          tabId
        });
      } catch (e) {}
    },

    async setOptions(opts) {
      Object.assign(_options, opts);
    },

    async getOptions(_query) {
      return { ..._options };
    },

    async setPanelBehavior(behavior) {
      Object.assign(_behavior, behavior);
      _shimLog('H12', 'setPanelBehavior_called', { behavior });
    },

    async getPanelBehavior() {
      return { ..._behavior };
    },

    onStateChanged: {
      addListener() {},
      removeListener() {},
      hasListener() { return false; }
    }
  };

  console.log('[Arc SidePanel Shim] Polyfill installed');
}
