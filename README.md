# Claude in Arc

**Anthropic's Claude for Chrome extension, patched to actually work in [Arc Browser](https://arc.net).**


> A fork of **[chxsong/Claude-in-Arc](https://github.com/chxsong/Claude-in-Arc)**, which did the original work of getting the panel to render inside Arc. This fork repairs Claude's page-interaction tools, fixes sign-in, and adds a session border. See [Credits](#credits).

---

## Installation

1. Download **`Claude-in-Arc-<version>.zip`** from the [latest release](https://github.com/JeffLi0/Claude-in-Arc/releases/latest) and unzip it somewhere permanent, such as your Documents folder
2. Open `arc://extensions`, turn on **Developer mode**, click **Load unpacked**, and choose the unzipped `Claude-in-Arc` folder
3. A tab asks *Keep Claude in Arc up to date?* Click **Turn on automatic updates**, pick that same `Claude-in-Arc` folder, and click **Select**. (An extension can't find out which folder it was loaded from, so this is the one thing it has to ask.)

Press **⌘E** or click the toolbar icon to open Claude. To remove it, click **Remove Extension** in `arc://extensions` and delete the folder.

## Staying up to date

Usually there's nothing to do. Every release is the official Claude in Chrome build of the same version number with the Arc patches applied on top, and it reaches you on its own:

- **Releases are automatic.** A GitHub Action checks the Chrome Web Store every day and publishes a new release when Anthropic ships one, or refreshes the current one when the patches change.
- **The extension updates its own folder.** Once a day it checks for a newer release and writes it into the folder you picked.
- **It reloads when nothing is happening.** The new version takes over once you've been away from the computer for 30 minutes and no Claude task has run for 15, so a panel or a running task is never cut off. It then re-attaches to the tabs you already had open. Your sign-in and settings are kept, because the extension ID doesn't change.

Arc lets an extension write to its folder only while one of its pages is open, so when an update is ready after Arc has dropped that access, you'll get a notification: *A Claude in Arc update is ready*. Click it, then **Install update**; the folder window opens at the right folder, so just click **Select**. If you chose **Not now** during setup, it won't ask again; open `chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/arc-setup.html` to turn updates on later.

**Several Arc profiles?** Load the folder in each one; each runs its own copy and shows up as a separate browser for Claude Desktop and Claude Code. When Claude asks which browser to use, each profile's "wants to connect" prompt opens in that profile's own space: you see the one for the space you're in, and switching spaces brings up the other. Click Connect in the one you want; the rest close by themselves after two minutes. Each prompt also lists a few of its profile's tabs, for the rare case where Arc shows two together. Tabs Claude opens appear in whichever space is on screen, since Arc gives extensions no way to switch spaces, but they still belong to the profile you picked, with its accounts.

The model list is set by Anthropic for your claude.ai account and fetched by the extension at runtime, so it's the same list Chrome shows. This repo doesn't choose it.

Arc can't update an unpacked extension the usual way. The build has no `update_url` on purpose: with one, Arc would replace it with the store version and drop the patches. And a packed `.crx` from outside the Web Store needs its own signing key, which changes the extension ID and breaks claude.ai sign-in.

### Building it yourself

```sh
python3 scripts/build.py          # latest upstream -> dist/Claude-in-Arc
```

Load `dist/Claude-in-Arc` once, in as many Arc profiles as you like, and pick that folder when it asks to keep itself up to date. A local build keeps itself current with Anthropic too: it's replaced by the GitHub release only when Anthropic ships a newer Claude in Chrome, never over a build of the same version, so your rebuilds aren't overwritten. After you edit `arc/` or `scripts/`, re-run the script: every profile with the folder loaded switches to the new build within a minute or two, as soon as no Claude task is running. Click reload in `arc://extensions` to apply it immediately. It needs only Python 3 and `curl`.

---

## What was broken, and how it's fixed

Arc doesn't implement two of the extension APIs Claude is built on, and it hosts the panel differently than the extension assumes.

| What's missing | What broke | Fix |
| --- | --- | --- |
| `chrome.sidePanel` | The panel never opened | Renders as an injected iframe beside the page |
| `chrome.tabGroups` | Tool calls were rejected as *"not in Claude's tab group"*, and opening a tab for Claude hung | Tab confinement can't exist in Arc, so it's switched off, and [`arc-bridge-interceptor.js`](arc/arc-bridge-interceptor.js) answers the tab tools without groups |
| A real side panel | Sign-in reported *"Can't reach the Claude extension"* despite valid tokens | Defaults back to the classic panel, which doesn't need one |

Clicks, typing, screenshots, `find`, `read_page` and JavaScript all run on Anthropic's own code. Older Arc releases never let `chrome.debugger` attach, and this fork used to reimplement those tools without it; current Arc does, so they now work as they do in Chrome, site permissions included.

---

## How the build works

The repo stores only the Arc patches, never a copy of Anthropic's extension. [`scripts/build.py`](scripts/build.py) works in four steps:

1. It downloads the current release from the Chrome Web Store.
2. It copies the scripts in [`arc/`](arc/) into the extension.
3. It loads those scripts through the manifest, the service-worker loader and `sidepanel.html`.
4. It makes nine small edits to Anthropic's minified code. Each edit is marked with an `ARC PATCH` comment:

| Edit | Why |
| --- | --- |
| Turns off the three tab-group checks on tool calls | Arc has no tab groups, so these checks can only reject |
| Keeps the classic panel instead of the new claude.ai-embedded one | The embed needs claude.ai's cookies, which Arc partitions away inside the injected panel, so it always shows *"Sign in to Claude"* |
| Tags onboarding prompts with their tab, and has panels ignore other tabs' prompts | Hidden panels stay loaded in other tabs, and one of them could take the "Start challenge" prompt, leaving the new panel empty |
| Hands the "wants to connect" prompt to [`arc-pairing-space.js`](arc/arc-pairing-space.js) | Arc opens every profile's prompt in the space on screen; this opens each in its own profile's space |
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
- This fork adds the session border, self-updating, and the sign-in and tool-routing fixes above.
