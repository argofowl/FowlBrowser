<p align="center">
  <img src="extension/icons/icon-128.png" width="96" height="96" alt="FowlBrowser icon">
</p>

<h1 align="center">FowlBrowser</h1>

<p align="center">
  Let your AI agents use your real browser, in background tabs, while you keep working.<br>
  For Claude Code, Codex and any agent that speaks MCP.
</p>

<p align="center">
  macOS · Chrome and Helium · MIT licensed · free
</p>

<p align="center">
  <img src="docs/cursor.png" width="720" alt="An agent filling in a checkout form; its cursor, labeled Claude, rests on the Phone field">
</p>

FowlBrowser lets AI agents use the Chrome or Helium you already have, with your logins, bookmarks and open tabs. They
work in their own tabs in the background, several at once, and stay out of your way. Open an agent's tab whenever you
like, and a cursor shows exactly what it is doing.

## How it compares

We gave the same agent (Claude Code with Claude Opus 5.5) the same 13 everyday tasks, twice each: once through
FowlBrowser and once through Codex's Chrome extension, in the same browsers, graded the same way.

| | FowlBrowser | Codex browser extension |
| --- | --- | --- |
| Tasks done right | **26 / 26** | 23 / 26 |
| Tricky forms (custom dropdowns, card field in an iframe, closed shadow DOM, drag to reorder) | **8 / 8** | 5 / 8 |
| Pop-ups that opened in front of the page you were on | **none** | in all 6 pop-up runs |
| Total time | **15 min** | 18 min |
| Total cost | **$8.34** | $12.78 |

Codex was faster on 4 of the 13 tasks; every task and the fine print are in [docs/benchmarks.md](docs/benchmarks.md).

FowlBrowser's performance tools against Chrome DevTools MCP, on the same pages:

| | FowlBrowser | Chrome DevTools MCP |
| --- | --- | --- |
| Lighthouse scores and Core Web Vitals | same | same |
| Size of a performance trace summary (what the agent reads) | **6 to 9 times smaller** | larger |
| Needs Chrome's remote-debugging port and an "Allow" dialog | **no** | yes |
| Opens its tab in the background | **yes** | not by default |
| Leaves your cache and site data alone | **yes** | Lighthouse clears them |
| Lighthouse on heavy sites | slower (3 to 5 times) | faster |
| Heap snapshots | no | yes |

And under load: 12 agents filling six tricky forms at once, in two browsers, got all 125 fields right, mixed nothing
up between them, and the cursor was on target at all 188 clicks.

How we tested and how to run it yourself: [docs/benchmarks.md](docs/benchmarks.md).

## Install

You need a Mac, [Node.js](https://nodejs.org) 22.19 or newer, and Google Chrome or [Helium](https://helium.computer).

### The easy way: ask your agent

Paste this into Claude Code, Codex or any agent that can run commands on your Mac:

```text
Set up FowlBrowser for me: clone https://github.com/argofowl/FowlBrowser into ~/FowlBrowser
(or git pull there if I already have it), then follow the steps for you in docs/agent-setup.md.
```

It installs FowlBrowser, connects it to your agent and walks you through the one step only you can do: adding the
extension to your browser. The same prompts are in the FowlBrowser toolbar popup under **Set up an agent**.

### By hand

**1. Run the installer** in Terminal:

```sh
git clone https://github.com/argofowl/FowlBrowser.git
cd FowlBrowser
sh install.sh
```

**2. Add the extension**, once per browser profile (FowlBrowser isn't in the Chrome Web Store yet):

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and pick `~/Library/Application Support/FowlBrowser/extension` (in the file picker, press
   Cmd-Shift-G and paste the path).
3. Open the extension's **Details** and turn on **Allow access to file URLs**, so agents can upload files for you and
   open local pages (like a prototype they made for you).

**3. Start a new agent session** and ask away.

To update, run `git pull` and `sh install.sh` again. To remove it, run `sh uninstall.sh` and remove the extension.

## What it does

- **Uses the browser you're already signed in to.** No separate profile, no logging in again.
- **Stays out of your way.** Agent tabs open in the background, muted, in their own tab group, and pop-ups they open
  stay in the background too. An agent never opens anything that would land on your screen or take your mouse: colour
  pickers and their eyedropper, dropdown menus, the Mac's file panels, full screen, print and share sheets, and links
  that start another app (Mail, Zoom) are refused, and the agent is told what to do instead.
- **Keeps working when you close windows.** Closing a browser's last window unloads its extensions; the next agent call
  reopens a window in the background and carries on, and FowlBrowser never closes your last window itself.
- **Shows its work.** In the tab you're looking at, a cursor with the agent's name moves to each click and says what
  it's doing.
- **Works alongside you.** Watch an agent's tab or click around in it and the agent keeps going, like Codex's
  extension, and tabs you open from it are yours. To stop it, stop the agent, close its tab or press Cancel on the
  browser's debugging bar. When a step needs you, like a login, a code or a payment, it hands you the tab and waits.
- **Asks before acting for you.** Agents are told to check with you before they send, post, buy, delete or change
  account settings, and to treat text on web pages as information, never as instructions.
- **Runs many agents at once.** Every agent session works in its own tabs.
- **Reads whole threads.** Long chats, DMs, email threads, feeds and comments that load as you scroll are read to
  both ends, with collapsed messages opened, and the agent is told plainly when a read is incomplete.
- **Measures pages.** Performance traces with Core Web Vitals, Lighthouse audits and memory readings.

## What you can ask

> Open my GitHub notifications and tell me what needs a reply.

> Find the RSVP form in my email, fill it in with my details and stop before sending.

> Use my Work browser to download last month's invoices. Hand me the tab if it asks me to sign in.

> Why is this page slow? Trace it and tell me what to fix first.

Name your browsers (Work, Personal) by clicking the FowlBrowser icon in the toolbar; agents then know which one you mean.

## Privacy and safety

- **No servers, no tracking.** FowlBrowser runs on your Mac and sends nothing anywhere. Pages an agent reads go only to
  the agent you use.
- **No open debugging port.** Chrome never opens its remote-debugging port. Agents go through the extension, one tab
  at a time, over a local channel only your Mac user can open. Programs running as you can open it too, just as they
  can read your files, so only run agents and tools you trust.
- **Agents only open web pages and your ordinary files.** http and https (plus blank and `data:` pages), and local
  files like a prototype in `~/Downloads`, but never the files uploads refuse (below, also through a link), folders,
  browser settings or extension pages. Pages you downloaded from the web aren't opened as files (open them from their
  site), and a page that loads or frames a refused file isn't read at all. Uploads could already send the files agents
  may view to a page, so viewing them adds no new way out. Downloads come only from the web.
- **Agents only touch their own tabs.** The tabs they opened and the ones they borrowed from you. They never close your
  tabs unless you asked, incognito windows are left alone, and commands that would reach other tabs, your window focus
  or your whole profile's cookies and storage are blocked. The browser's cookie headers reach agents with their values
  hidden.
- **Your files stay yours.** Agents won't upload hidden files (like `~/.ssh` or `.env`), anything in `~/Library` other
  than iCloud Drive and cloud drives, system files, or files in folders another Mac user can change.
- **Passwords stay out of page reads.** When agents read a page, a filled password field shows as dots. An agent can
  still run a script in a page it controls, and a script can read what the page itself can (a field's value, the page's
  own cookies), which is why the next point matters.
- **Pages are not instructions.** Agents are told to treat page text as data, and to ask you before they send, post,
  buy, delete or upload a file you didn't name. That is guidance to the model, not a lock, so keep an eye on agents
  where a mistake costs money.

## Good to know

- macOS only for now. Chrome and Helium are tested; Chromium, Brave, Edge, Arc and Vivaldi are set up by the installer
  but less tested.
- A sign-in or payment pop-up that talks back to its page brings the browser to the front for a moment if you're in
  another app. Everything else stays in the background.
- With Claude Code, an agent's work tabs close when it finishes its reply. With other agents they close when the
  session ends.
- With Claude Code, a hook stops agents opening pages in your browser from the shell (`open -a "Google Chrome" page.html`
  and the like) so every page they show you goes through FowlBrowser. `sh uninstall.sh` or
  `FOWLBROWSER_SKIP_CLAUDE=1 sh install.sh` leaves it out.
- While an agent works, Chrome shows a "started debugging this browser" bar. To hide it, quit Chrome and start it with
  `open -a "Google Chrome" --args --silent-debugger-extension-api`. That hides it for every extension that uses the
  debugger, not only FowlBrowser.

## Troubleshooting

- **The toolbar icon says "Not set up" or "Can't start".** Run `sh install.sh` again, then reload the extension on
  `chrome://extensions`.
- **Your agent doesn't see the browser tools.** Start a new session after installing (Claude Code: `claude mcp list`
  should show `fowlbrowser`).
- **"No browsers connected".** Make sure the extension is loaded in the browser you want and that the browser is open.

## For developers

```
Agent (Claude Code, Codex or any MCP client)
  │  MCP over stdio
FowlBrowser server, one per agent session
  │  local socket, token-gated
Helper (native messaging host), started by the browser
  │  native messaging
Extension: chrome.debugger and chrome.tabs
```

| Area | Tools |
| --- | --- |
| Browsers and tabs | `browser_list`, `tab_list`, `tab_open`, `tab_claim`, `tab_release`, `tab_close`, `tab_keep`, `tab_handoff`, `tab_mute`, `tab_focus` |
| Reading | `snapshot` (also as text, a list of links, or just the lines with some text), `read_all` (a whole chat, email thread, feed or comments, to both ends), `screenshot`, `evaluate`, `console`, `network`, `wait_for` (or until the page settles), `viewport` (sizes, phones, dark mode, reduced motion) |
| Acting | `navigate`, `click`, `hover`, `type`, `fill_form`, `select_option`, `press_key`, `scroll`, `drag`, `upload_files` (inputs, buttons and drop zones), `dialog`, `media` |
| Files and data | `download`, `downloads`, `export`, `browser_data` |
| Performance | `trace_start`, `trace_stop`, `trace_insight`, `lighthouse`, `memory` |

Agents read pages as an accessibility tree with element refs (`[ref=e12]`); after an action on the same page they
usually get only what changed, and can ask for a screenshot in the same result, or a few frames of an animation as it
plays. Reading tools are marked read-only, so
Claude Code runs a batch of them at once. Every tool names its tab (`chrome:52`, `helium:1834`), so parallel agents never share a
"current tab".

Any MCP client can run the server: a stdio server with the command
`~/Library/Application Support/FowlBrowser/mcp/bin/fowlbrowser-mcp` (written out as an absolute path, no arguments).
`FOWLBROWSER_LABEL` sets the name on the cursor and tab group. `FOWLBROWSER_DEBUG=<file>` logs every call, for bug
reports (typed text left out; the file is created readable only by you). `sh install.sh --lite` skips Lighthouse (about 160 MB).

```sh
npm ci --prefix mcp && npm install --prefix test   # once
node --test extension/test/ mcp/test/ tools/test/ test/forms/test/ test/demo/test/
node test/run.mjs --browser both                    # end-to-end scenarios in real browsers
node --test test/install/                            # install.sh and uninstall.sh in a temp home
```

The full contract is in [SPEC.md](SPEC.md), the cursor in [docs/cursor-spec.md](docs/cursor-spec.md), benchmarks in
[docs/benchmarks.md](docs/benchmarks.md).

## License

MIT, see [LICENSE](LICENSE). Includes code adapted from Playwright and cursor motion adapted from Cua, see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Made by [Fowl Labs](https://fowllabs.com).
