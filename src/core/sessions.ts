import * as pty from 'node-pty';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import { findExecutable, shellLaunchArgs } from './env';
import type { SessionConfigPatch, SessionInfo, SpawnOptions } from '../shared/protocol';

const SCROLLBACK_LIMIT = 512 * 1024;
/** Without hooks, a session counts as active if it printed output this recently. */
const OUTPUT_ACTIVE_MS = 2500;
/** How long a graceful close may take before the process is force-killed. */
const CLOSE_GRACE_MS = 4000;
const MAX_PERSISTED = 60;

interface LiveSession {
  info: SessionInfo;
  proc?: pty.IPty;
  buffer: string;
  lastOutput: number;
  /** Set while we are deliberately shutting the process down. */
  closing?: boolean;
  /** Start again as soon as the current process exits (used by restart). */
  restartAfterExit?: boolean;
  /** Claude args that should survive a resume (model, extra flags) — no prompt / resume flags. */
  baseArgs: string[];
  cols: number;
  rows: number;
}

interface PersistedSession {
  id: string;
  kind: SessionInfo['kind'];
  title: string;
  cwd: string;
  createdAt: number;
  lastActivity: number;
  claudeSessionId?: string;
  transcriptPath?: string;
  baseArgs: string[];
  model?: string;
  extraArgs?: string[];
  resumeMode?: SessionInfo['resumeMode'];
}

/** `--model X` + extra args → the claude flags every launch of this session uses. */
function buildBaseArgs(model: string | undefined, extra: string[] | undefined): string[] {
  return [...(model ? ['--model', model] : []), ...(extra || [])];
}

/** Older sessions.json stored only baseArgs; split out --model for the editor. */
function splitBaseArgs(base: string[]): { model?: string; extraArgs: string[] } {
  const extraArgs: string[] = [];
  let model: string | undefined;
  for (let i = 0; i < base.length; i++) {
    if (base[i] === '--model' && base[i + 1]) model = base[++i];
    else if (base[i].startsWith('--model=')) model = base[i].slice(8);
    else extraArgs.push(base[i]);
  }
  return { model, extraArgs };
}

function resolveBinary(name: string): string {
  const home = os.homedir();
  return (
    findExecutable(name, [path.join(home, '.local', 'bin'), path.join(home, '.claude', 'local'), '/usr/local/bin', path.join(home, '.npm-global', 'bin')]) ||
    name
  );
}

function conversationExists(cwd: string, csid: string, transcriptPath?: string): boolean {
  if (transcriptPath && transcriptPath.endsWith(`${csid}.jsonl`) && fs.existsSync(transcriptPath)) return true;
  const dir = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  return fs.existsSync(path.join(dir, `${csid}.jsonl`));
}

/** Remove flags that pick a conversation, so a resume can add its own `--resume <id>`. */
function stripSessionFlags(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--continue' || a === '-c' || a === '--fork-session') continue;
    if (a === '--session-id' || a === '--resume' || a === '-r') {
      if (args[i + 1] && !args[i + 1].startsWith('-')) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

let cachedClaudeBin: string | undefined;
/** Path to the claude CLI (resolved once through a login shell so PATH matches the user's). */
export function claudeBinary(): string {
  if (!cachedClaudeBin) cachedClaudeBin = process.env.TERMINUS_CLAUDE_BIN || resolveBinary('claude');
  return cachedClaudeBin;
}

export class SessionManager extends EventEmitter {
  private sessions = new Map<string, LiveSession>();
  private claudeBin: string;
  private changeTimer?: NodeJS.Timeout;
  private persistTimer?: NodeJS.Timeout;
  private persistFile = path.join(process.env.TERMINUS_HOME || path.join(os.homedir(), '.terminus'), 'sessions.json');

  constructor(private port: number) {
    super();
    this.claudeBin = claudeBinary();
    this.load();
    // Output-based activity fallback for sessions without hook events.
    setInterval(() => this.tickActivity(), 1000).unref();
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => s.info);
  }

  get(id: string): SessionInfo | undefined {
    return this.sessions.get(id)?.info;
  }

  has(id: string) {
    return this.sessions.has(id);
  }

  isRunning(id: string) {
    return !!this.sessions.get(id)?.proc;
  }

  scrollback(id: string): string {
    return this.sessions.get(id)?.buffer ?? '';
  }

  spawn(opts: SpawnOptions): SessionInfo {
    const id = randomUUID().slice(0, 8);
    let cwd = opts.cwd || os.homedir();
    if (cwd.startsWith('~')) cwd = os.homedir() + cwd.slice(1);
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      throw new Error(`Working directory does not exist: ${cwd}`);
    }
    const baseArgs: string[] = [];
    if (opts.kind === 'claude') {
      if (opts.model) baseArgs.push('--model', opts.model);
      if (opts.args) baseArgs.push(...opts.args);
    }
    const launch = [...baseArgs];
    let claudeSessionId = opts.resumeId;
    if (opts.kind === 'claude') {
      const userPicked = baseArgs.some((a) => ['--session-id', '--resume', '-r', '--continue', '-c'].includes(a));
      // `claude mcp login x` etc.: a subcommand, not a conversation — no session id.
      const subcommand = !!baseArgs[0] && !baseArgs[0].startsWith('-');
      if (opts.continueLast) launch.push('--continue');
      else if (opts.resumeId) launch.push('--resume', opts.resumeId);
      else if (!userPicked && !subcommand) {
        // Pin the conversation id up front so "resume" is exact even without hooks.
        claudeSessionId = randomUUID();
        launch.push('--session-id', claudeSessionId);
      }
      if (opts.initialPrompt) launch.push(opts.initialPrompt);
    }

    const now = Date.now();
    const base = cwd.split('/').filter(Boolean).pop() || cwd;
    const info: SessionInfo = {
      id,
      kind: opts.kind,
      title: opts.title || (opts.kind === 'claude' ? `claude · ${base}` : `shell · ${base}`),
      cwd,
      status: 'starting',
      external: false,
      createdAt: now,
      lastActivity: now,
      args: launch,
      hooked: false,
      subagentsRunning: 0,
      subagentsTotal: 0,
      claudeSessionId,
      ...(opts.kind === 'claude'
        ? { model: opts.model || undefined, extraArgs: opts.args || [], resumeMode: opts.resumeMode || 'resume' }
        : {}),
    };
    const live: LiveSession = { info, buffer: '', lastOutput: now, baseArgs, cols: opts.cols || 120, rows: opts.rows || 32 };
    this.sessions.set(id, live);
    try {
      this.start(live, launch);
    } catch (e) {
      this.sessions.delete(id);
      throw e;
    }
    return info;
  }

  private start(live: LiveSession, args: string[]) {
    const { info } = live;
    const file = info.kind === 'claude' ? this.claudeBin : process.env.SHELL || '/bin/bash';
    if (info.kind === 'claude' && !file.includes('/')) {
      // Fail with a readable message instead of node-pty's "execvp(3) failed".
      const found = findExecutable(file);
      if (!found) {
        throw new Error(
          `Could not find the "claude" command. Terminus looked in PATH and ~/.local/bin. Install Claude Code in WSL, or set TERMINUS_CLAUDE_BIN to its full path.`,
        );
      }
      this.claudeBin = cachedClaudeBin = found;
    }
    const procArgs = info.kind === 'claude' ? args : shellLaunchArgs(file);

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.CLAUDECODE; // don't make child claude think it is nested
    // Don't let shells think they're inside another terminal app we were launched from.
    for (const k of ['WT_SESSION', 'WT_PROFILE_ID', 'TERM_PROGRAM_VERSION', 'VSCODE_INJECTION', 'VTE_VERSION']) delete env[k];
    env.TERMINAL_EMULATOR = 'Terminus';
    env.TERM_PROGRAM = 'Terminus';
    env.COLORTERM = 'truecolor';
    env.TERMINUS_SESSION_ID = info.id;
    env.TERMINUS_PORT = String(this.port);

    const proc = pty.spawn(file, procArgs, {
      name: 'xterm-256color',
      cols: live.cols,
      rows: live.rows,
      cwd: info.cwd,
      env,
    });
    live.proc = proc;
    live.closing = false;
    live.lastOutput = Date.now();
    info.pid = proc.pid;
    info.args = procArgs;
    info.status = 'starting';
    info.exitCode = undefined;
    info.hooked = false;
    info.startedAt = Date.now();
    info.lastActivity = Date.now();
    info.lastEvent = undefined;

    proc.onData((data) => {
      if (live.proc !== proc) return;
      live.buffer += data;
      if (live.buffer.length > SCROLLBACK_LIMIT) live.buffer = live.buffer.slice(-SCROLLBACK_LIMIT);
      live.lastOutput = Date.now();
      if (info.status === 'starting') {
        info.status = 'idle';
        this.changed();
      }
      this.emit('data', info.id, data);
    });
    proc.onExit(({ exitCode, signal }) => {
      if (live.proc !== proc) return;
      live.proc = undefined;
      info.pid = undefined;
      info.exitCode = exitCode;
      info.lastActivity = Date.now();
      if (live.closing) {
        info.status = 'closed';
        info.lastEvent = info.kind === 'claude' ? 'closed · click to resume' : 'closed';
      } else {
        info.status = exitCode === 0 || signal === 1 || signal === 15 ? 'exited' : 'failed';
        info.lastEvent = exitCode === 0 ? 'process exited' : `process exited with code ${exitCode}${signal ? ` (signal ${signal})` : ''}`;
      }
      const msg = `\r\n\x1b[90m[terminus] ${live.closing ? 'session closed' : `process exited (code ${exitCode})`}\x1b[0m\r\n`;
      live.buffer += msg;
      this.emit('data', info.id, msg);
      this.changed();
      if (live.restartAfterExit) {
        live.restartAfterExit = false;
        try {
          this.resume(info.id);
        } catch (e) {
          info.lastEvent = `restart failed: ${(e as Error).message}`;
          this.changed();
        }
      }
    });
    this.changed();
  }

  /** Gracefully shut a session down (SIGHUP, like closing a terminal), keeping it resumable. */
  close(id: string) {
    const s = this.sessions.get(id);
    if (!s?.proc) return;
    s.closing = true;
    const proc = s.proc;
    try {
      proc.kill('SIGHUP');
    } catch {}
    setTimeout(() => {
      if (s.proc === proc) {
        try {
          proc.kill('SIGKILL');
        } catch {}
      }
    }, CLOSE_GRACE_MS);
  }

  /** Start a stopped session again: `claude --resume <id>` (or a fresh shell). */
  resume(id: string): SessionInfo {
    const s = this.sessions.get(id);
    if (!s) throw new Error('Unknown session');
    if (s.info.external) throw new Error('External sessions cannot be resumed from Terminus');
    if (s.proc) return s.info;
    if (!fs.existsSync(s.info.cwd)) throw new Error(`Working directory no longer exists: ${s.info.cwd}`);
    let args: string[] = [];
    if (s.info.kind === 'claude') {
      // Strip any session-selection flags the user originally passed; we resume the known id.
      const base = stripSessionFlags(s.baseArgs);
      const csid = s.info.claudeSessionId;
      const subcommand = !!base[0] && !base[0].startsWith('-');
      if (subcommand) args = base;
      else if (s.info.resumeMode === 'new') {
        // "Always start a new conversation": fresh pinned id each time it's opened.
        s.info.claudeSessionId = randomUUID();
        s.info.transcriptPath = undefined;
        args = [...base, '--session-id', s.info.claudeSessionId];
      } else if (!csid) args = [...base, '--continue'];
      else if (conversationExists(s.info.cwd, csid, s.info.transcriptPath)) args = [...base, '--resume', csid];
      // Closed before the first message: nothing to resume, so start fresh under the same id.
      else args = [...base, '--session-id', csid];
    }
    s.buffer = '';
    this.emit('reset', id);
    this.start(s, args);
    return s.info;
  }

  /** Edit a session's configuration. Launch settings apply the next time it starts (see restart). */
  configure(id: string, patch: SessionConfigPatch): SessionInfo {
    const s = this.sessions.get(id);
    if (!s) throw new Error('Unknown session');
    if (s.info.external) throw new Error('External sessions are not managed by Terminus');
    const info = s.info;
    if (patch.title !== undefined) {
      const t = patch.title.trim();
      if (!t) throw new Error('Title cannot be empty');
      info.title = t.slice(0, 80);
    }
    if (patch.cwd !== undefined) {
      let cwd = patch.cwd.trim();
      if (cwd.startsWith('~')) cwd = os.homedir() + cwd.slice(1);
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error(`Working directory does not exist: ${cwd}`);
      if (cwd !== info.cwd && info.kind === 'claude' && info.resumeMode !== 'new') {
        // Claude stores conversations per folder; resuming in a different folder won't find it.
        info.lastEvent = 'folder changed · next open starts a new conversation';
        info.claudeSessionId = randomUUID();
        info.transcriptPath = undefined;
      }
      info.cwd = cwd;
    }
    if (info.kind === 'claude') {
      if (patch.model !== undefined) info.model = patch.model || undefined;
      if (patch.extraArgs !== undefined) {
        if (!Array.isArray(patch.extraArgs) || patch.extraArgs.some((a) => typeof a !== 'string')) throw new Error('Arguments must be a list of strings');
        info.extraArgs = patch.extraArgs;
      }
      if (patch.resumeMode !== undefined) {
        if (patch.resumeMode !== 'resume' && patch.resumeMode !== 'new') throw new Error('resumeMode must be "resume" or "new"');
        info.resumeMode = patch.resumeMode;
      }
      s.baseArgs = buildBaseArgs(info.model, info.extraArgs);
    }
    this.changed();
    return info;
  }

  /** Stop (gracefully) and start again with the current configuration. */
  restart(id: string): SessionInfo {
    const s = this.sessions.get(id);
    if (!s) throw new Error('Unknown session');
    if (!s.proc) return this.resume(id);
    s.restartAfterExit = true;
    this.close(id);
    return s.info;
  }

  /** Register a session seen only through hook events. */
  addExternal(claudeSessionId: string, cwd: string, transcriptPath?: string): SessionInfo {
    const id = `ext-${claudeSessionId.slice(0, 8)}`;
    const existing = this.sessions.get(id);
    if (existing) return existing.info;
    const now = Date.now();
    const base = cwd.split('/').filter(Boolean).pop() || cwd;
    const info: SessionInfo = {
      id,
      kind: 'claude',
      title: `external · ${base}`,
      cwd,
      status: 'idle',
      external: true,
      createdAt: now,
      lastActivity: now,
      args: [],
      hooked: true,
      claudeSessionId,
      transcriptPath,
      subagentsRunning: 0,
      subagentsTotal: 0,
    };
    this.sessions.set(id, { info, buffer: '', lastOutput: 0, baseArgs: [], cols: 120, rows: 32 });
    this.changed();
    return info;
  }

  findByClaudeSession(claudeSessionId: string): SessionInfo | undefined {
    let found: SessionInfo | undefined;
    for (const s of this.sessions.values()) {
      if (s.info.claudeSessionId !== claudeSessionId) continue;
      // Prefer the running one if an old closed entry shares the id.
      if (!found || s.proc) found = s.info;
    }
    return found;
  }

  write(id: string, data: string) {
    this.sessions.get(id)?.proc?.write(data);
  }

  resize(id: string, cols: number, rows: number) {
    const s = this.sessions.get(id);
    if (!s || cols < 2 || rows < 2) return;
    s.cols = Math.floor(cols);
    s.rows = Math.floor(rows);
    if (s.proc) {
      try {
        s.proc.resize(s.cols, s.rows);
      } catch {}
    }
  }

  /** Hard kill (not resumable-flagged; shows as exited/failed). */
  kill(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    if (s.proc) {
      const proc = s.proc;
      try {
        proc.kill('SIGTERM');
      } catch {}
      setTimeout(() => {
        if (s.proc === proc) {
          try {
            proc.kill('SIGKILL');
          } catch {}
        }
      }, 3000);
    } else if (s.info.external) {
      s.info.status = 'exited';
      this.changed();
    }
  }

  remove(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    if (s.proc) this.close(id);
    this.sessions.delete(id);
    this.changed();
  }

  rename(id: string, title: string) {
    const s = this.sessions.get(id);
    if (s && title.trim()) {
      s.info.title = title.trim().slice(0, 80);
      this.changed();
    }
  }

  /** Called on core shutdown: close everything gracefully so it can be resumed next time. */
  closeAll() {
    for (const s of this.sessions.values()) {
      if (!s.proc) continue;
      s.closing = true;
      try {
        s.proc.kill('SIGHUP');
      } catch {}
    }
    this.persistNow(true);
  }

  /** Mutate a session's info (from hook events) and broadcast. */
  update(id: string, patch: Partial<SessionInfo>) {
    const s = this.sessions.get(id);
    if (!s) return;
    // A stopped session's status is owned by the process lifecycle, not by late hook events.
    if (!s.info.external && !s.proc && patch.status) {
      patch = { ...patch };
      delete patch.status;
    }
    Object.assign(s.info, patch);
    this.changed();
  }

  private tickActivity() {
    const now = Date.now();
    let dirty = false;
    for (const s of this.sessions.values()) {
      const info = s.info;
      if (info.external) {
        // External sessions we haven't heard from in an hour are presumed gone.
        if ((info.status === 'idle' || info.status === 'waiting') && now - info.lastActivity > 60 * 60 * 1000) {
          info.status = 'exited';
          info.lastEvent = 'no activity for 1h';
          dirty = true;
        }
        continue;
      }
      if (!s.proc || info.hooked) continue;
      const next = now - s.lastOutput < OUTPUT_ACTIVE_MS ? 'active' : 'idle';
      if (info.status !== next && info.status !== 'starting') {
        info.status = next;
        if (next === 'active') info.lastActivity = now;
        dirty = true;
      }
    }
    if (dirty) this.changed();
  }

  changed() {
    if (!this.changeTimer) {
      this.changeTimer = setTimeout(() => {
        this.changeTimer = undefined;
        this.emit('changed');
      }, 50);
    }
    if (!this.persistTimer) {
      this.persistTimer = setTimeout(() => {
        this.persistTimer = undefined;
        this.persistNow(false);
      }, 1000);
    }
  }

  // ---------------------------------------------------------------- persistence

  private persistNow(_final: boolean) {
    const rows: PersistedSession[] = [...this.sessions.values()]
      .filter((s) => !s.info.external)
      .sort((a, b) => b.info.lastActivity - a.info.lastActivity)
      .slice(0, MAX_PERSISTED)
      .map((s) => ({
        id: s.info.id,
        kind: s.info.kind,
        title: s.info.title,
        cwd: s.info.cwd,
        createdAt: s.info.createdAt,
        lastActivity: s.info.lastActivity,
        claudeSessionId: s.info.claudeSessionId,
        transcriptPath: s.info.transcriptPath,
        baseArgs: s.baseArgs,
        model: s.info.model,
        extraArgs: s.info.extraArgs,
        resumeMode: s.info.resumeMode,
      }));
    try {
      fs.mkdirSync(path.dirname(this.persistFile), { recursive: true });
      fs.writeFileSync(this.persistFile, JSON.stringify(rows, null, 2));
    } catch {}
  }

  private load() {
    let rows: PersistedSession[] = [];
    try {
      rows = JSON.parse(fs.readFileSync(this.persistFile, 'utf8'));
    } catch {
      return;
    }
    for (const r of rows) {
      if (!r?.id || this.sessions.has(r.id)) continue;
      const info: SessionInfo = {
        id: r.id,
        kind: r.kind,
        title: r.title,
        cwd: r.cwd,
        status: 'closed',
        external: false,
        createdAt: r.createdAt,
        lastActivity: r.lastActivity,
        lastEvent: r.kind === 'claude' ? 'closed · click to resume' : 'closed',
        args: [],
        hooked: false,
        claudeSessionId: r.claudeSessionId,
        transcriptPath: r.transcriptPath,
        subagentsRunning: 0,
        subagentsTotal: 0,
      };
      if (r.kind === 'claude') {
        const split = r.model !== undefined || r.extraArgs ? { model: r.model, extraArgs: r.extraArgs || [] } : splitBaseArgs(r.baseArgs || []);
        info.model = split.model;
        info.extraArgs = split.extraArgs;
        info.resumeMode = r.resumeMode || 'resume';
      }
      this.sessions.set(r.id, { info, buffer: '', lastOutput: 0, baseArgs: r.baseArgs || [], cols: 120, rows: 32 });
    }
  }
}
