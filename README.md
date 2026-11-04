# VSCodium

Open a thread's folder in VSCodium, in the right panel.

## What you get

- A **VSCodium** panel on the right. It opens the folder of the thread on screen.
- The panel follows the thread you are looking at. Switch threads and it shows that thread's folder.
- One editor server runs for the whole app. Every thread shares it.
- An agent tool, `editor_open`, opens a file at a line, and at a column if you give one.
  If the thread is not on screen, the file opens the next time you show the panel.

## Before you install

- Install VSCodium. Then, in VSCodium, run **Shell Command: Install 'codium' command in PATH**.
- Works on macOS only for now.
- The editor runs on this computer only, at `127.0.0.1`, behind a random connection token.

## What the install screen asks you to allow

- Runs `codium`, to start the editor server.
- Runs `git`, to list a repo's other worktrees, so files in them can open.
- Talks to programs on this computer, on ports 47321 to 47323, to check the editor server is up.

## Limits

- The panel shows one folder at a time. Switching to another thread's folder reloads the page.
- Only `editor_open` is here. The agent cannot yet select text, read the editor, run editor commands, or press keys.
- Settings in the editor are not kept between app restarts yet.

## Stop

Quit the app, or turn the plugin off. The editor server stops with it.
