import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import YAML from 'yaml';
import type { SkillDefinition, SkillInfo } from '../shared/protocol';

/**
 * Claude Code skills are folders containing a SKILL.md (YAML frontmatter +
 * markdown instructions) plus optional supporting files (scripts, references).
 *
 *   user     ~/.claude/skills/<name>/SKILL.md                  (editable)
 *   project  <project>/.claude/skills/<name>/SKILL.md          (editable)
 *   synced   ~/.claude/skills/synced/<bucket>/<name>/SKILL.md  (managed by your Claude account — read-only)
 *   plugin   ~/.claude/plugins/.../skills/<name>/SKILL.md      (managed by plugins — read-only)
 */

const KNOWN = new Set(['name', 'description', 'allowed-tools', 'model', 'argument-hint', 'disable-model-invocation']);
const MAX_FILE = 1024 * 1024;
const MAX_LISTED_FILES = 200;

function claudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}
export function userSkillsDir() {
  return path.join(claudeDir(), 'skills');
}
export function projectSkillsDir(project: string) {
  return path.join(project, '.claude', 'skills');
}

function toList(v: unknown): string[] | undefined {
  if (v == null || v === '') return undefined;
  if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean);
  return String(v)
    .split(/[,\s]+(?![^()]*\))/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function parseSkill(raw: string): SkillDefinition {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) return { name: '', description: '', body: raw };
  const fm = (YAML.parse(m[1]) ?? {}) as Record<string, unknown>;
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fm)) if (!KNOWN.has(k)) extra[k] = v;
  return {
    name: String(fm.name ?? ''),
    description: String(fm.description ?? ''),
    allowedTools: toList(fm['allowed-tools']),
    model: fm.model != null ? String(fm.model) : undefined,
    // `argument-hint: [file]` parses as a YAML list; keep the bracketed form the author wrote.
    argumentHint: Array.isArray(fm['argument-hint'])
      ? `[${(fm['argument-hint'] as unknown[]).join(', ')}]`
      : fm['argument-hint'] != null
        ? String(fm['argument-hint'])
        : undefined,
    disableModelInvocation: fm['disable-model-invocation'] === true || fm['disable-model-invocation'] === 'true',
    extraYaml: Object.keys(extra).length ? YAML.stringify(extra).trimEnd() : undefined,
    body: m[2].replace(/^\r?\n/, ''),
  };
}

export function serializeSkill(def: SkillDefinition): string {
  const fm: Record<string, unknown> = { name: def.name, description: def.description };
  if (def.allowedTools?.length) fm['allowed-tools'] = def.allowedTools.join(', ');
  if (def.model) fm.model = def.model;
  if (def.argumentHint) fm['argument-hint'] = def.argumentHint;
  if (def.disableModelInvocation) fm['disable-model-invocation'] = true;
  if (def.extraYaml?.trim()) {
    const extra = YAML.parse(def.extraYaml);
    if (!extra || typeof extra !== 'object' || Array.isArray(extra)) throw new Error('Extra frontmatter must be a YAML mapping (key: value)');
    for (const [k, v] of Object.entries(extra)) if (!KNOWN.has(k)) fm[k] = v;
  }
  return `---\n${YAML.stringify(fm, { lineWidth: 0 }).trimEnd()}\n---\n\n${def.body.trim()}\n`;
}

function listFiles(dir: string): { rel: string; size: number }[] {
  const out: { rel: string; size: number }[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 4 || out.length >= MAX_LISTED_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === '__pycache__') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && !(d === dir && e.name === 'SKILL.md')) {
        try {
          out.push({ rel: path.relative(dir, p), size: fs.statSync(p).size });
        } catch {}
      }
    }
  };
  walk(dir, 0);
  return out;
}

function readSkillDir(dir: string, scope: SkillInfo['scope'], source: string, readonly: boolean): SkillInfo | undefined {
  const file = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(file)) return undefined;
  const base: Omit<SkillInfo, keyof SkillDefinition> = { scope, source, readonly, dir, parentDir: path.dirname(dir), folder: path.basename(dir), files: listFiles(dir) };
  try {
    return { ...base, ...parseSkill(fs.readFileSync(file, 'utf8')) };
  } catch (e) {
    return { ...base, name: path.basename(dir), description: '', body: '', parseError: (e as Error).message };
  }
}

function readParent(parent: string, scope: SkillInfo['scope'], source: string, readonly: boolean): SkillInfo[] {
  let names: string[];
  try {
    names = fs.readdirSync(parent);
  } catch {
    return [];
  }
  return names
    .filter((n) => !n.startsWith('.') && n !== 'synced')
    .sort()
    .map((n) => readSkillDir(path.join(parent, n), scope, source, readonly))
    .filter((s): s is SkillInfo => !!s);
}

/** Find `skills/` folders under the plugins dir (bounded depth) and name them after their plugin. */
function pluginSkills(): SkillInfo[] {
  const root = path.join(claudeDir(), 'plugins');
  const out: SkillInfo[] = [];
  const visit = (d: string, depth: number) => {
    if (depth > 6) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name === 'node_modules' || e.name.startsWith('.git')) continue;
      const p = path.join(d, e.name);
      if (e.name === 'skills') out.push(...readParent(p, 'plugin', pluginName(d), true));
      else visit(p, depth + 1);
    }
  };
  visit(root, 0);
  return out;
}

function pluginName(pluginRoot: string): string {
  for (const f of ['.claude-plugin/plugin.json', 'plugin.json']) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(pluginRoot, f), 'utf8'));
      if (j.name) return String(j.name);
    } catch {}
  }
  return path.basename(pluginRoot);
}

export function listSkills(projects: string[]): SkillInfo[] {
  const user = userSkillsDir();
  const out = readParent(user, 'user', 'User', false);
  for (const p of [...new Set(projects)]) out.push(...readParent(projectSkillsDir(p), 'project', p, false));
  // Skills synced from the Claude account.
  try {
    for (const bucket of fs.readdirSync(path.join(user, 'synced'))) {
      if (bucket.startsWith('.')) continue;
      out.push(...readParent(path.join(user, 'synced', bucket), 'synced', 'Claude account', true));
    }
  } catch {}
  out.push(...pluginSkills());
  return out;
}

// ---------------------------------------------------------------- safety

/** Editable skill folders are exactly <...>/skills/<name>, never synced or plugin-managed. */
function assertEditableSkillDir(dir: string) {
  const r = path.resolve(dir);
  const synced = path.join(path.resolve(userSkillsDir()), 'synced') + path.sep;
  const plugins = path.resolve(claudeDir(), 'plugins') + path.sep;
  if (path.basename(path.dirname(r)) !== 'skills' || r.startsWith(synced) || r.startsWith(plugins)) {
    throw new Error(`Not an editable skill folder: ${dir}`);
  }
}

function safeJoin(dir: string, rel: string): string {
  const p = path.resolve(dir, rel);
  if (!p.startsWith(path.resolve(dir) + path.sep)) throw new Error('Path escapes the skill folder');
  return p;
}

function validName(name: string) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new Error('Name must be lowercase letters, digits and hyphens (max 64 chars)');
}

// ---------------------------------------------------------------- mutations

export function saveSkill(params: { parentDir: string; originalDir?: string; def: SkillDefinition }): string {
  const { parentDir, originalDir, def } = params;
  validName(def.name);
  if (!def.description.trim()) throw new Error('Description is required (Claude uses it to decide when to load the skill)');
  const target = path.join(parentDir, def.name);
  assertEditableSkillDir(target);
  const content = serializeSkill(def);
  if (originalDir && path.resolve(originalDir) !== path.resolve(target)) {
    assertEditableSkillDir(originalDir);
    if (fs.existsSync(target)) throw new Error(`A skill named "${def.name}" already exists here`);
    fs.renameSync(originalDir, target); // keeps supporting files
  } else if (!originalDir && fs.existsSync(target)) {
    throw new Error(`A skill named "${def.name}" already exists here`);
  }
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'SKILL.md'), content);
  return target;
}

export function deleteSkill(dir: string) {
  assertEditableSkillDir(dir);
  if (!fs.existsSync(path.join(dir, 'SKILL.md'))) throw new Error('Folder has no SKILL.md; refusing to delete');
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Copy any skill (including read-only ones) into an editable location so it can be customised. */
export function copySkill(params: { fromDir: string; parentDir: string; name: string }): string {
  validName(params.name);
  const target = path.join(params.parentDir, params.name);
  assertEditableSkillDir(target);
  if (fs.existsSync(target)) throw new Error(`A skill named "${params.name}" already exists there`);
  fs.mkdirSync(params.parentDir, { recursive: true });
  fs.cpSync(params.fromDir, target, { recursive: true });
  const skillFile = path.join(target, 'SKILL.md');
  const def = parseSkill(fs.readFileSync(skillFile, 'utf8'));
  fs.writeFileSync(skillFile, serializeSkill({ ...def, name: params.name }));
  return target;
}

export function readSkillFile(params: { dir: string; rel: string }): { content: string; binary: boolean } {
  const p = safeJoin(params.dir, params.rel);
  const st = fs.statSync(p);
  if (st.size > MAX_FILE) return { content: `(file is ${Math.round(st.size / 1024)} KB — too large to edit here)`, binary: true };
  const buf = fs.readFileSync(p);
  if (buf.includes(0)) return { content: '(binary file)', binary: true };
  return { content: buf.toString('utf8'), binary: false };
}

export function writeSkillFile(params: { dir: string; rel: string; content: string }) {
  assertEditableSkillDir(params.dir);
  if (!params.rel.trim() || params.rel === 'SKILL.md') throw new Error('Use the SKILL.md editor for the main file');
  const p = safeJoin(params.dir, params.rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, params.content);
}

export function deleteSkillFile(params: { dir: string; rel: string }) {
  assertEditableSkillDir(params.dir);
  if (params.rel === 'SKILL.md') throw new Error('Delete the whole skill instead');
  fs.rmSync(safeJoin(params.dir, params.rel), { force: true });
}
