import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Claude Code settings files, by scope (highest precedence last-but-managed):
 *   user     ~/.claude/settings.json
 *   project  <project>/.claude/settings.json        (shared, committed)
 *   local    <project>/.claude/settings.local.json  (personal, git-ignored)
 *   managed  /etc/claude-code/managed-settings.json (enterprise, read-only)
 * Precedence: managed > local > project > user.
 */
export type SettingsScope = 'user' | 'project' | 'local' | 'managed';

export interface SettingsFile {
  scope: SettingsScope;
  path: string;
  exists: boolean;
  readonly: boolean;
  mtimeMs?: number;
  data: Record<string, unknown>;
  raw: string;
  error?: string;
}

export function claudeConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

export function settingsPathFor(scope: SettingsScope, project?: string): string {
  switch (scope) {
    case 'user':
      return path.join(claudeConfigDir(), 'settings.json');
    case 'managed':
      return '/etc/claude-code/managed-settings.json';
    case 'project':
    case 'local':
      if (!project) throw new Error('Pick a project for project/local settings');
      return path.join(project, '.claude', scope === 'project' ? 'settings.json' : 'settings.local.json');
  }
}

export function readSettings(scope: SettingsScope, project?: string): SettingsFile {
  const p = settingsPathFor(scope, project);
  const base = { scope, path: p, readonly: scope === 'managed' };
  if (!fs.existsSync(p)) return { ...base, exists: false, data: {}, raw: '{}\n' };
  const raw = fs.readFileSync(p, 'utf8');
  const mtimeMs = fs.statSync(p).mtimeMs;
  try {
    const data = raw.trim() ? JSON.parse(raw) : {};
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Top level must be a JSON object');
    return { ...base, exists: true, mtimeMs, data, raw };
  } catch (e) {
    return { ...base, exists: true, mtimeMs, data: {}, raw, error: (e as Error).message };
  }
}

/** All scopes at once, so the UI can show where else a key is set. */
export function readAllSettings(project?: string): SettingsFile[] {
  const scopes: SettingsScope[] = project ? ['user', 'project', 'local', 'managed'] : ['user', 'managed'];
  return scopes.map((s) => readSettings(s, project));
}

function backup(file: string) {
  if (!fs.existsSync(file)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(file, `${file}.terminus-backup-${stamp}`);
  const dir = path.dirname(file);
  const prefix = `${path.basename(file)}.terminus-backup-`;
  for (const n of fs.readdirSync(dir).filter((x) => x.startsWith(prefix)).sort().slice(0, -5)) fs.rmSync(path.join(dir, n), { force: true });
}

export function writeSettings(params: { scope: SettingsScope; project?: string; data: unknown; expectedMtimeMs?: number }): SettingsFile {
  const { scope, project, data, expectedMtimeMs } = params;
  if (scope === 'managed') throw new Error('Managed settings are read-only');
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Settings must be a JSON object');
  const p = settingsPathFor(scope, project);
  if (expectedMtimeMs && fs.existsSync(p) && Math.abs(fs.statSync(p).mtimeMs - expectedMtimeMs) > 1) {
    throw new Error(`${p} was changed by something else since you opened it. Reload to see the latest version, then reapply your edits.`);
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  backup(p);
  const tmp = `${p}.terminus-tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, p);
  return readSettings(scope, project);
}

/** Update a few keys in a settings file without touching the rest (used by MCP approvals). */
export function patchSettings(scope: SettingsScope, project: string | undefined, patch: (d: Record<string, any>) => void) {
  const cur = readSettings(scope, project);
  if (cur.error) throw new Error(`Cannot update ${cur.path}: ${cur.error}`);
  const data = structuredClone(cur.data) as Record<string, any>;
  patch(data);
  return writeSettings({ scope, project, data });
}
