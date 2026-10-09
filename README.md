# Claude in Arc

**Anthropic's Claude for Chrome extension, patched to actually work in [Arc Browser](https://arc.net).**


> A fork of **[chxsong/Claude-in-Arc](https://github.com/chxsong/Claude-in-Arc)**, which did the original work of getting the panel to render inside Arc. This fork repairs Claude's page-interaction tools, fixes sign-in, and adds a session border. See [Credits](#credits).

---

## Installation

1. Download **`Claude-in-Arc-<version>.zip`** from the [latest release](https://github.com/JeffLi0/Claude-in-Arc/releases/latest) and unzip it somewhere permanent, such as your Documents folder
2. Open `arc://extensions`, turn on **Developer mode**, click **Load unpacked**, and choose the unzipped `Claude-in-Arc` folder
3. A setup tab opens. Click **Choose folder** and pick that same `Claude-in-Arc` folder, so the extension can update itself

Press **⌘E** or click the toolbar icon to open Claude. To remove it, click **Remove Extension** in `arc://extensions` and delete the folder.

## Staying up to date

There's nothing to do. Every release is the official Claude in Chrome build of the same version number with the Arc patches applied on top, and it reaches you on its own:

- **Releases are automatic.** A GitHub Action checks the Chrome Web Store every six hours and publishes a new release when Anthropic ships one, or refreshes the current one when the patches change.
- **The extension updates its own folder.** Every six hours it checks for a newer release and writes it into the folder you chose during setup.
- **It reloads when nothing is happening.** The new version takes over once you've been away from the computer for 30 minutes and no Claude task has run for 15, so a panel or a running task is never cut off. It then re-attaches to the tabs you already had open. Your sign-in and settings are kept, because the extension ID doesn't change.

If Arc forgets the folder permission, which can happen after a restart, you'll get a notification and a **!** on the toolbar icon. Click the notification, then **Allow updates**.

The model list is set by Anthropic for your claude.ai account and fetched by the extension at runtime, so it's the same list Chrome shows. This repo doesn't choose it.

Arc can't update an unpacked extension the usual way. The build has no `update_url` on purpose: with one, Arc would replace it with the store version and drop the patches. And a packed `.crx` from outside the Web Store needs its own signing key, which changes the extension ID and breaks claude.ai sign-in.

### Building it yourself

```sh
python3 scripts/build.py          # latest upstream -> dist/Claude-in-Arc
```

Load `dist/Claude-in-Arc` once. Local builds never download releases over your work. Re-run the script to update: the extension picks up the rebuilt folder the next time you're away, or click reload in `arc://extensions` to apply it now. It needs only Python 3 and `curl`.

---

## What was broken, and how it's fixed

Arc doesn't implement three of the extension APIs Claude is built on, and it hosts the panel differently than the extension assumes.

| What's missing | What broke | Fix |
| --- | --- | --- |
| `chrome.sidePanel` | The panel never opened | Renders as an injected iframe beside the page |
| `chrome.debugger` | Every click, keystroke and script hung until it timed out | Tool calls are intercepted and re-run on `chrome.scripting`, which Arc supports |
| `chrome.tabGroups` | Tool calls were rejected as *"not in Claude's tab group"* | Tab confinement can't exist in Arc, so it's switched off |
| A real side panel | Sign-in reported *"Can't reach the Claude extension"* despite valid tokens | Defaults back to the classic panel, which doesn't need one |

The `chrome.debugger` gap is the one that matters. The official extension drives every page interaction through the Chrome Debugger Protocol, and in Arc the `attach` call never settles — no error, no result, just a timeout. [`arc-bridge-interceptor.js`](arc/arc-bridge-interceptor.js) catches those calls as they arrive over the bridge WebSocket and reimplements them on `chrome.scripting.executeScript`: clicks and keystrokes as synthesized DOM events, `read_page` by injecting Anthropic's own accessibility-tree builder, `zoom` by cropping the screenshot in the service worker with `OffscreenCanvas`.

Screenshots are resized to match the CSS viewport before they're sent, so a coordinate read off the image is a coordinate on the page — no conversion, and none of the drift that comes with one.

---

## How the build works

The repo stores only the Arc patches, never a copy of Anthropic's extension. [`scripts/build.py`](scripts/build.py) works in four steps:

1. It downloads the current release from the Chrome Web Store.
2. It copies the scripts in [`arc/`](arc/) into the extension.
3. It loads those scripts through the manifest, the service-worker loader and `sidepanel.html`.
4. It makes seven small edits to Anthropic's minified code. Each edit is marked with an `ARC PATCH` comment:

| Edit | Why |
| --- | --- |
| Turns off the two tab-group checks on tool calls | Arc has no tab groups, so these checks can only reject |
| Keeps the classic panel instead of the new claude.ai-embedded one | The embed needs claude.ai's cookies, which Arc partitions away inside the injected panel, so it always shows *"Sign in to Claude"* |
| Tags onboarding prompts with their tab, and has panels ignore other tabs' prompts | Hidden panels stay loaded in other tabs, and one of them could take the "Start challenge" prompt, leaving the new panel empty |
| Extends the permission-prompt timeout from 30s to 110s | An unanswered prompt is reported to Claude as a refusal |
| Extends the side-panel retry loop from 5 to 60 tries | The injected panel takes longer to start than a real side panel |

The edits match on the shape of the code, not on minified names or file hashes, so they keep working across most releases. If an upstream release changes code one of them depends on, the build stops with an error naming the edit, the Release workflow fails, and GitHub emails the repo owner. That's the only case that needs a person.

---

## Session border

Arc has no tab groups, so there was no way to see which tabs Claude was working across. Tabs in the current session get a thin orange band drawn inside them ([`arc-session-border.js`](arc/arc-session-border.js)), tracked in the service worker and stored in `chrome.storage.session` so it survives the worker restarting. Tabs Claude merely touched expire after 10 minutes; the tab with the panel open stays marked.

---

## Credits

- **[Anthropic](https://claude.ai)** — Claude for Chrome, the extension all of this patches.
- **[chxsong/Claude-in-Arc](https://github.com/chxsong/Claude-in-Arc)** — the upstream project, which established the panel-injection approach this fork builds on.
- This fork adds the debugger-free interaction tools, the session border, and the sign-in and tool-routing fixes above.
