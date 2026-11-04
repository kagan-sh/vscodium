# VSCodium

Open a thread's folder in VSCodium, in the right panel.

## What you get

- A **VSCodium** panel on the right. It opens the folder of the thread on screen.
- The panel follows the thread you are looking at. Switch threads and it shows that thread's folder.
- One editor server runs for the whole app. Every thread shares it, and the editor keeps its theme and window state between restarts.
- An agent tool, `editor_open`, opens a file at a line, and at a column if you give one.
  If the thread is not on screen, the file opens the next time you show the panel.
- `VSCodium: open` opens the panel from the command palette.
- `kg vscodium open [--environment <id>] [<folder>]` opens the panel for a folder that is not the
  thread on screen. The panel keeps that folder until you switch threads.

## Before you install

- Install VSCodium. Then, in VSCodium, run **Shell Command: Install 'codium' command in PATH**.
- Works on macOS only for now.
- The editor runs on this computer only, at `127.0.0.1`, behind a random connection token.

## What the install screen asks you to allow

- Runs `codium`, to start the editor server.
- Runs `realpath`, to check where a file really is before it opens.
- Runs `git`, to find the worktrees of the folders you have open.
- Talks to programs on this computer, on ports 47321 to 47323, to check the editor server is up.

## Which paths open

- A relative path stays inside the thread's folder.
- An absolute path opens inside the thread's folder, inside another project or environment the window lists,
  or inside a git worktree of one of those folders.
- Every other path is refused, including one that leads out of those folders through a link.

## Limits

- The panel shows one folder at a time. Switching to another thread's folder reloads the page.
- Only `editor_open` is here. The agent cannot yet select text, read the editor, run editor commands, or press keys.
- The editor's own defaults are not changed. The panel is your VSCodium server, and its settings are yours.
- The file opener that other bb plugins use is not part of a kagan plugin, so nothing else can ask this
  panel to show a file.

## Stop

Quit the app, or turn the plugin off. The editor server stops with it.
