import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import YAML from 'yaml';
import type { AgentDefinition, AgentFile, AgentScope } from '../shared/protocol';

const KNOWN_KEYS = new Set(['name', 'description', 'model', 'tools', 'disallowedTools', 'color', 'permissionMode']);

export function userAgentsDir(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(dir, 'agents');
}

export function projectAgentsDir(project: string): string {
  return path.join(project, '.claude', 'agents');
}

function toList(v: unknown): string[] | undefined {
  if (v == null || v === '') return undefined;
  if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean);
  return String(v)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function parseAgent(raw: string): AgentDefinition {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!m) throw new Error('Missing YAML frontmatter (--- ... ---)');
  const fm = (YAML.parse(m[1]) ?? {}) as Record<string, unknown>;
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fm)) if (!KNOWN_KEYS.has(k)) extra[k] = v;
  return {
    name: String(fm.name ?? ''),
    description: String(fm.description ?? ''),
    model: fm.model != null ? String(fm.model) : undefined,
    tools: toList(fm.tools),
    disallowedTools: toList(fm.disallowedTools),
    color: fm.color != null ? String(fm.color) : undefined,
    permissionMode: fm.permissionMode != null ? String(fm.permissionMode) : undefined,
    extraYaml: Object.keys(extra).length ? YAML.stringify(extra).trimEnd() : undefined,
    systemPrompt: m[2].replace(/^\r?\n/, ''),
  };
}

export function serializeAgent(def: AgentDefinition): string {
  const fm: Record<string, unknown> = { name: def.name, description: def.description };
  if (def.tools?.length) fm.tools = def.tools.join(', ');
  if (def.disallowedTools?.length) fm.disallowedTools = def.disallowedTools.join(', ');
  if (def.model && def.model !== 'inherit-default') fm.model = def.model;
  if (def.color) fm.color = def.color;
  if (def.permissionMode) fm.permissionMode = def.permissionMode;
  if (def.extraYaml?.trim()) {
    const extra = YAML.parse(def.extraYaml);
    if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
      for (const [k, v] of Object.entries(extra)) if (!KNOWN_KEYS.has(k)) fm[k] = v;
    } else {
      throw new Error('Extra frontmatter must be a YAML mapping (key: value)');
    }
  }
  const yaml = YAML.stringify(fm, { lineWidth: 0 }).trimEnd();
  return `---\n${yaml}\n---\n\n${def.systemPrompt.trim()}\n`;
}

function readDir(dir: string, scope: AgentScope): AgentFile[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.md'));
  } catch {
    return [];
  }
  return names.sort().map((n) => {
    const p = path.join(dir, n);
    try {
      return { ...parseAgent(fs.readFileSync(p, 'utf8')), scope, dir, path: p };
    } catch (e) {
      return {
        name: n.replace(/\.md$/, ''),
        description: '',
        systemPrompt: '',
        scope,
        dir,
        path: p,
        parseError: (e as Error).message,
      };
    }
  });
}

export function listAgents(projects: string[]): AgentFile[] {
  const out = readDir(userAgentsDir(), 'user');
  for (const p of [...new Set(projects)]) out.push(...readDir(projectAgentsDir(p), 'project'));
  return out;
}

function assertAgentPath(p: string) {
  const resolved = path.resolve(p);
  if (!resolved.endsWith('.md') || path.basename(path.dirname(resolved)) !== 'agents') {
    throw new Error(`Refusing to touch ${p}: not an agents/*.md file`);
  }
}

export function saveAgent(params: { dir: string; originalPath?: string; def: AgentDefinition }): string {
  const { dir, originalPath, def } = params;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(def.name)) {
    throw new Error('Name must be lowercase letters, digits and hyphens (e.g. "code-reviewer")');
  }
  if (!def.description.trim()) throw new Error('Description is required (Claude uses it to decide when to delegate)');
  const target = path.join(dir, `${def.name}.md`);
  assertAgentPath(target);
  if (originalPath) assertAgentPath(originalPath);
  if (target !== originalPath && fs.existsSync(target)) throw new Error(`An agent named "${def.name}" already exists here`);
  const content = serializeAgent(def);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(target, content);
  if (originalPath && originalPath !== target && fs.existsSync(originalPath)) fs.rmSync(originalPath);
  return target;
}

export function deleteAgent(p: string) {
  assertAgentPath(p);
  fs.rmSync(p, { force: true });
}

export function previewAgent(def: AgentDefinition): string {
  return serializeAgent(def);
}
