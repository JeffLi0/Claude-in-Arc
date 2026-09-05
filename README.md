# Claude in Arc

A deep patching toolkit designed to inject Anthropic's Official Claude Chrome Extension natively into Arc Browser's visual structure.

Because Arc doesn't officially support Chrome's `chrome.sidePanel` APIs natively yet, this project intercepts the extension's unpacked local files and re-wires them to run as an injected iFrame, matching Arc's aesthetic perfectly.

## What's New in v0.2

- Added **View Mode** selection — switch between two sidepanel injection modes: Squeeze (Default) and Overlay (iFrame)
- Established connection with Claude Desktop via Native Messaging
- Bug fixes

![View Mode setting location](view-mode.png)

### Fork changes (this fork)

Arc has no real `chrome.tabGroups` support, so the official extension's multi-tab
session tracking (which tabs currently belong to a Claude task) silently fails —
there was no way to tell which tabs Claude was working across. This fork adds a
lightweight, Arc-only replacement:

- **Session border** (`assets/arc-session-border.js`) — draws a rounded orange
  border (`#d97757`, matching Claude's brand color and the official extension's
  own "active tab" glow) around any tab that's part of the current session.
- **Session tracker** (`assets/arc-session-tracker.js`) — a service-worker-side
  tracker (backed by `chrome.storage.session` so it survives the MV3 worker
  being killed and restarted) that marks a tab as in-session when its side
  panel is open, or when a tool call (navigate, new tab, screenshot, page
  read) touches it. Touched-but-not-open tabs auto-expire after 10 minutes of
  inactivity.
- Wired into `claude-panel-injector.js` (panel open/close), `arc-bridge-interceptor.js`
  (bridge/MCP tool calls), and `arc-adapter.js` (generic tab commands).

**Known limitation:** tool calls that arrive through the native-messaging
(local Claude Desktop app) transport bypass the two interceptor files above
and go straight to the official CDP-based executor, so a *new* tab opened
mid-task through that specific path won't get auto-bordered — only the anchor
tab (wherever the panel is open) is guaranteed to border regardless of
transport. Bridge/cloud-relay and adapter-driven tool calls are fully covered.

## Installation

Download the ZIP from [Releases](https://github.com/chxsong/Claude-in-Arc/releases), or download the `1.0.66_0` folder directly from this repository and load it as an unpacked extension.

## Uninstallation

Go to `arc://extensions` and click **Remove Extension**.
