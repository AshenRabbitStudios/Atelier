# Bugfix plan — 2026-07-23 (from bugs.txt)

Three reported bugs. Root cause + fix per bug. bugs.txt is gitignored; entries are
removed there once each fix is verified.

## Bug 1 — "Conversations" dropdown button does nothing

**Symptom:** clicking the ☰ Conversations button at the top opens no menu.

**Root cause:** `.conversation-bar` is the frameless window's custom title bar and sets
`-webkit-app-region: drag` (src/styles.css). Child interactive elements must opt out with
`-webkit-app-region: no-drag` to receive clicks. `.conv-tabs` does (line ~597), which is why
tabs work — but `.conv-dropdown` (which contains the Conversations button and its menu) never
does, so the OS swallows the click as a window-drag. The React state/JSX is correct.

**Fix:** add `-webkit-app-region: no-drag;` to `.conv-dropdown` in src/styles.css.

## Bug 2 — clicking a link navigates the whole app away

**Symptom:** clicking an http link in Atelier navigates the entire app window to that page;
the app is lost until restart.

**Root cause:** `installWebviewGuard` hardens the `<webview>` guest only. The **main window's
own `webContents`** has no `will-navigate` handler and no `setWindowOpenHandler`, so a link
click / `window.open` in the renderer navigates the app frame itself.

**Fix:** in electron/main.ts, add `installMainNavigationGuard(mainWindow)`:

- `setWindowOpenHandler` → `shell.openExternal(url)` for http(s), always `{ action: 'deny' }`.
- `will-navigate` → allow the app's own origin (the dev server URL or the packaged
  `renderer/index.html` file URL); for anything else `preventDefault()` and, if http(s),
  `shell.openExternal`.

## Bug 3 — startup script gives unfollowable instructions on other machines

**Symptom:** on another PC the startup script printed instructions that couldn't be followed
in the terminal the user was actually in.

**Root cause:** scripts/bootstrap.mjs detects only OS (`win = platform === 'win32'`) and then
assumes the terminal is PowerShell: `terminalName = 'PowerShell'`, `runCmdName = 'run.bat'`,
and the Claude installer is the PowerShell-only `irm https://claude.ai/install.ps1 | iex`.
Run from Git Bash, cmd.exe, or WSL, those commands are wrong (Git Bash needs `curl | bash` and
`./run.sh`; cmd can't run `irm|iex` at all).

**Fix:**

- Detect the real shell: honor an `ATELIER_SHELL` env hint set by each launcher, else infer
  from `WSL_DISTRO_NAME`, `MSYSTEM` (Git Bash), `PSModulePath` (PowerShell), falling back to
  cmd on Windows / plain shell elsewhere.
- Build a per-shell profile: friendly name, run command (`run.bat` vs `./run.sh`), node
  install command (winget/brew/apt), and the Claude installer command plus whether it must be
  launched from a _different_ shell (cmd → "open PowerShell").
- Use the profile in every `say`/`fail` instruction. Make the consented auto-install pick
  `bash -c` vs `powershell -c` based on which installer command applies.
- Set `ATELIER_SHELL` from run.bat (cmd), launch.ps1 (powershell), run.sh (bash/git-bash/wsl);
  fix run.sh's node-missing message so a Windows Git Bash user isn't told to `apt install`.
