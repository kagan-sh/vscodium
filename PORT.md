```
Plugin: VSCodium
Source: bb-kit plugins/vscodium
kagan id: dev.kagan.vscodium

Moved as-is:
- The VSCodium panel for the thread on screen, following the thread
- editor_open with line and column, and the off-screen queue kept for ten minutes, one request per thread
- The "outside the workspace" refusal, decided on real locations so a link cannot lead out
- Absolute paths in another project or environment the window lists, or a git worktree of one
- A command and a CLI command to open the panel
- Plain install/start messages, with the raw output and the token kept to the log
- The editor keeps its theme and window state across opens (WebView store(true))
- One server for the whole app, stopped when the plugin unloads

Close (what differs):
- One long-lived `codium serve-web` from the installed VSCodium, not a downloaded reh-web build
- The page is a declared right panel with a WebView, not an iframe overlay in the app window
- The panel can be opened for an explicit folder (`kg vscodium open`), which the bb plugin only did for its file opener
- The plugin is one script, so "open the panel" and "show the file" are direct host calls and need no claim/settle
- Tool labels are not in the manifest; the guidance lives in the plugin-level instructions and each tool description

Gaps (workaround, or cannot move):
- Pinned release download with its sha256 check and staging/rename: a fetch is capped at 8 MiB and
  there is no downloads or spawn power, so a ~130 MB build cannot be fetched. The build's own `node`
  also sits at a versioned path, and a run grant names a program on PATH. Needs a download/install
  power, or a spawn grant for a program inside the plugin data folder.
- The local bridge and its helper extension: a plugin declares no HTTP routes and `powers.serve` is
  refused, and a WebView has only `url` and `store` — no message channel and no way to run script in
  the page. Needs a page-to-plugin channel (postMessage or evaluate) on WebView.
- editor_select, editor_state, editor_command, editor_keys: all four run through that bridge and the
  page script. Same gap: they need a page-to-plugin channel.
- reveal and show_file for other plugins (Diff, Board): there is no plugin-to-plugin RPC, and another
  plugin cannot call this one's CLI without a run power of its own. Needs a cross-plugin RPC.
- File opener slot, app-wide overlay and the three-editor budget: `ui.file-opener` is refused and there
  is no app overlay. Kagan keeps a WebView page on a host global, so the page already survives tab
  switches without reloading; there is one panel rather than up to three editors.
- Editor defaults from an extension (Source Control as a tree, hidden secondary sidebar, no startup
  editor): a plugin cannot contribute configuration defaults, and writing them into the serve-web data
  folder did not apply in a local check. The panel starts with the editor's own defaults.
- Remote or enrolled hosts: bb refuses them too; the editor runs on the machine running the app.

Powers asked:
- areas: process, threads
- run: codium, realpath, git
- fetch: 127.0.0.1 ports 47321-47323, GET

Right panel: supported
Theme: no theme
kg plugin check: passed
Tried: npm test (80 tests), kg plugin check, and codium serve-web page loads with a file at a line and column (npm run test:e2e)
```
