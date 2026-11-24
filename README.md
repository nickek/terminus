# Terminus

A desktop GUI for running and organizing Claude Code sessions. It runs inside WSL and shows up on the Windows desktop through WSLg.

- **Terminal**: each `claude` (or shell) session gets its own real terminal panel. Drag tabs to split or regroup panels, drag the dividers to resize, and use the buttons on each group to maximize it or float it as a separate window. The layout is saved between runs.
- **Close and resume**: closing a terminal tab shuts its session down gracefully (SIGHUP). It stays in the sidebar under "Closed", and clicking it runs `claude --resume <id>` with the same flags. Every new session gets a fixed `--session-id`, so resume always picks the right conversation. The session list survives restarts (`~/.terminus/sessions.json`).
- **Subagent popups**: when Claude starts a subagent, a popup offers three choices: open its live transcript in a side panel, fork it into its own interactive `claude` session, or dismiss. The first subagent opens to the right of its parent; each additional one gets its own side panel stacked in that column.
- **Dashboard**: counts of active, needs-input, idle, failed and exited sessions, a sessions table, subagent history and a live feed of hook events. It can also include Claude sessions started outside Terminus.
- **Skills**: browse every skill Claude Code can see: user (`~/.claude/skills`), per-project (`<project>/.claude/skills`), synced from your Claude account, and plugin skills. Create, edit, rename and delete your own skills, including their supporting files (scripts, references). Synced and plugin skills are read-only, but you can copy one into your user skills and edit the copy.
- **MCP**: every MCP server Claude Code can use, with live connection status (from `claude mcp list`). Add, edit, rename and remove servers at user, local or project (`.mcp.json`) scope with a form or raw JSON. Approve or reject shared project servers, and sign in to OAuth servers. claude.ai connectors and plugin servers are listed read-only. Changes go through the official `claude mcp` CLI.
- **Settings → Claude Code**: edit the settings files for each scope (user, project, project-local, plus read-only managed). The form is generated from the official settings schema (`src/renderer/data/claude-settings.schema.json`, a snapshot from schemastore.org), with search, categories, an "also set in another scope" hint, and a raw JSON view. Saves keep the last 5 backups and refuse to overwrite a file changed by something else.
- **Agents**: a form editor for Claude Code subagent files (`~/.claude/agents/*.md` and `<project>/.claude/agents/*.md`), covering name, description, model, tools, color and system prompt. Advanced options cover permission mode, disallowed tools and extra frontmatter.

## Set up

```bash
bash scripts/bootstrap.sh          # or: npm run bootstrap
```

The bootstrap checks for everything Terminus needs and installs what's missing, asking first (`--yes` skips the questions):

- base tools (`curl`, which the Claude Code hooks use, plus `unzip`, `tar`)
- Node.js `^20.19 || >=22.12` (installed per-user with nvm if missing or too old)
- a C++ toolchain for `node-pty` (it compiles on Linux)
- the Claude Code CLI (official installer; optional)
- exact dependency versions (`npm ci`) and the build
- a self-test: a real terminal spawns and the core service starts
- Electron's Linux libraries (for the Linux/WSLg window)
- on WSL, the native Windows app

Supports apt, dnf/yum, pacman, zypper, apk and Homebrew. Tested from scratch on Ubuntu 24.04 and Rocky Linux 9. Options: `--check` (report only), `--yes`, `--no-system` (never use sudo, just print commands), `--windows` / `--no-windows`, `--config FILE` (bring your `config.json`), `--skip-claude`. Safe to re-run.

Then start it: the **Terminus** Start Menu entry on Windows/WSL, or `npm start` on Linux/macOS. Turn on the hooks in **Settings → Terminus → Claude Code hooks**.

## Configuration

Everything Terminus remembers lives in `~/.terminus/` (override with `TERMINUS_HOME`):

| File | What | Portable? |
|---|---|---|
| `config.json` | Preferences: color scheme, font, popups, sidebar, default folder/args, project list | Yes. Copy it to another machine, or pass it with `bootstrap.sh --config` |
| `state.json` | Panel layout and per-session zoom | No (refers to this machine's sessions) |
| `sessions.json` | Sessions you can resume | No |
| `core.json` | Port + access token of the running core | No (recreated on each start) |
| `shell/bash-init.sh` | Generated shell startup file (loads your login files + `~/.bashrc`) | No (regenerated) |

`config.json` is plain, documented JSON. Edit it by hand and open windows update immediately. Shells always load your own dotfiles, so a new machine gets its own prompt, aliases and PATH with nothing copied.

Shortcuts: `Ctrl+Shift+T` new session, `Ctrl+Shift+1..6` switch views, `Ctrl+Shift+B` collapse/expand the sidebar, `Ctrl+Shift+C/V` copy/paste in a terminal (plain `Ctrl+C` also copies when text is selected; with nothing selected it interrupts as usual), `Ctrl + mouse wheel` zoom a terminal (per pane), `Ctrl+0` reset its zoom.

## Native Windows window (recommended on WSL)

Runs the window as a real Windows app with full GPU acceleration, while sessions, hooks and Claude Code stay in WSL:

```bash
npm run win:install   # build, then install/update %LOCALAPPDATA%\Terminus + Start Menu shortcut
npm run win           # same, then launch it
```

The installer downloads the official Electron Windows build (checked against Electron's published SHA-256 sums), sets the Terminus icon with rcedit, and copies in the app. On start, `TerminusApp.exe` (not `Terminus.exe`, which Discord mistakes for a game) attaches to the core in WSL if it's running, or starts it with `wsl.exe -d <distro>`, then connects over `localhost`. Folder pickers show Windows dialogs and convert paths (`\\wsl.localhost\<distro>\…` → `/…`, `C:\…` → `/mnt/c/…`). Re-run `npm run win:install` after changing the code. Uninstall by deleting `%LOCALAPPDATA%\Terminus` and the Start Menu shortcut.

## Architecture

```
src/core/     background service (plain Node): node-pty sessions, hook receiver, transcript tailing, agent files
              HTTP + WebSocket on 127.0.0.1:47821 (WebSocket requires a token written to ~/.terminus/core.json)
src/main/     Electron main process: reuses a running core or starts one, opens the window
src/renderer/ React UI: dockview (panels), xterm.js (terminals)
src/shared/   protocol types
```

The GUI talks to the core only over the WebSocket, so you could later add a Windows-native client that connects to the core in WSL over SSH or a forwarded port. `npm run core` runs the core on its own. Quitting the app shuts all sessions down gracefully; they show as Closed next time and resume on click. Set `TERMINUS_KEEP_CORE=1` to keep them running after the window closes instead.

### How subagent detection works

Hooks post every event to `POST /hook`. Sessions started by Terminus carry `TERMINUS_SESSION_ID` in their environment, which the hook sends as a header, so each event is matched to the right terminal. Any other Claude session shows up as "external".

A `PreToolUse` event for the `Agent` tool triggers the popup. `SubagentStart` and `SubagentStop` events, plus the `.meta.json` file next to each subagent log, link the popup to the log file under `~/.claude/projects/<project>/<session>/subagents/`, which the side panel follows live.

### Limits

- Subagents run inside their parent `claude` process, so the side panel is a read-only live view. Use **Fork to interactive** to get a session you can type into.
- Claude Code agent files can't set sampling options (temperature, top_p, top_k), so the Agents editor doesn't offer them.

### Environment variables

`TERMINUS_PORT` (default 47821), `TERMINUS_HOME` (state folder, default `~/.terminus`), `TERMINUS_USER_DATA` (Electron profile folder), `TERMINUS_NODE` (Node binary used for the core), `TERMINUS_CLAUDE_BIN` (path to claude), `TERMINUS_KEEP_CORE`, `TERMINUS_GPU=1` (use the GPU; only helps on distros whose Mesa includes the WSL `d3d12` driver, e.g. Ubuntu — Rocky/RHEL Mesa does not, so Terminus uses software rendering by default).

## Third-party

- `src/renderer/data/claude-settings.schema.json` is a snapshot of the Claude Code settings schema from [SchemaStore](https://www.schemastore.org/claude-code-settings.json) (Apache-2.0). Replace it with a newer copy to pick up new settings.
- The Inter and JetBrains Mono fonts are bundled into the built app from npm (`@fontsource`), under the SIL Open Font License 1.1.
- Electron, rcedit and npm dependencies are downloaded at install time, not stored in this repo.

## License

[MIT](LICENSE). Use it, fork it, ship it.
