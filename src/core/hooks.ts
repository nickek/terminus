import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { HOOK_MARKER, type HooksStatus } from '../shared/protocol';

export const HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop',
  'SubagentStart',
  'SubagentStop',
] as const;

const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse']);

export function settingsPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(dir, 'settings.json');
}

export function hookCommand(port: number): string {
  // Posts the hook payload (stdin) to the Terminus core. Never blocks or fails Claude:
  // short timeout, all output discarded, always exits 0.
  return (
    `curl -s -m 2 -o /dev/null -H 'Content-Type: application/json' ` +
    `-H "X-Terminus-Session: \${TERMINUS_SESSION_ID:-}" --data-binary @- ` +
    `http://127.0.0.1:${port}/hook >/dev/null 2>&1 || true ${HOOK_MARKER}`
  );
}

function readSettings(file: string): any {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`Could not parse ${file}: ${(e as Error).message}. Fix it manually before installing hooks.`);
  }
}

function isOurs(h: any): boolean {
  return typeof h?.command === 'string' && h.command.includes(HOOK_MARKER);
}

function stripOurs(settings: any) {
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== 'object') return;
  for (const ev of Object.keys(hooks)) {
    const groups = Array.isArray(hooks[ev]) ? hooks[ev] : [];
    const kept = groups
      .map((g: any) => ({ ...g, hooks: Array.isArray(g?.hooks) ? g.hooks.filter((h: any) => !isOurs(h)) : g?.hooks }))
      .filter((g: any) => !Array.isArray(g.hooks) || g.hooks.length > 0);
    if (kept.length) hooks[ev] = kept;
    else delete hooks[ev];
  }
  if (Object.keys(hooks).length === 0) delete settings.hooks;
}

function backup(file: string) {
  if (!fs.existsSync(file)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(file, `${file}.terminus-backup-${stamp}`);
  // Keep only the 5 most recent backups.
  const dir = path.dirname(file);
  const prefix = `${path.basename(file)}.terminus-backup-`;
  const old = fs
    .readdirSync(dir)
    .filter((n) => n.startsWith(prefix))
    .sort()
    .slice(0, -5);
  for (const n of old) fs.rmSync(path.join(dir, n), { force: true });
}

function writeSettings(file: string, settings: any) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.terminus-tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

export function hooksStatus(port: number, lastHookAt?: number): HooksStatus {
  const file = settingsPath();
  let events: string[] = [];
  try {
    const s = readSettings(file);
    const hooks = s.hooks || {};
    events = HOOK_EVENTS.filter((ev) =>
      (hooks[ev] || []).some((g: any) => (g?.hooks || []).some((h: any) => isOurs(h) && h.command.includes(`:${port}/hook`))),
    );
  } catch {}
  return {
    installed: events.length === HOOK_EVENTS.length,
    partial: events.length > 0 && events.length < HOOK_EVENTS.length,
    settingsPath: file,
    port,
    events,
    lastHookAt,
  };
}

export function installHooks(port: number) {
  const file = settingsPath();
  const settings = readSettings(file);
  backup(file);
  stripOurs(settings);
  settings.hooks = settings.hooks || {};
  const cmd = hookCommand(port);
  for (const ev of HOOK_EVENTS) {
    const group: any = { hooks: [{ type: 'command', command: cmd, timeout: 5 }] };
    if (TOOL_EVENTS.has(ev)) group.matcher = '*';
    settings.hooks[ev] = [...(Array.isArray(settings.hooks[ev]) ? settings.hooks[ev] : []), group];
  }
  writeSettings(file, settings);
}

export function uninstallHooks() {
  const file = settingsPath();
  if (!fs.existsSync(file)) return;
  const settings = readSettings(file);
  backup(file);
  stripOurs(settings);
  writeSettings(file, settings);
}
