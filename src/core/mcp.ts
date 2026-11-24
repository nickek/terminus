import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { McpHealth, McpServer, McpServerConfig } from '../shared/protocol';
import { claudeBinary } from './sessions';
import { patchSettings, readSettings } from './settings';

/**
 * MCP servers come from several places:
 *   user     ~/.claude.json → mcpServers                      (all projects, private)
 *   local    ~/.claude.json → projects[<path>].mcpServers     (one project, private)
 *   project  <project>/.mcp.json → mcpServers                 (one project, shared via git)
 *   claude.ai connectors / plugins                            (reported by `claude mcp list`)
 *
 * Reads parse those files directly; writes go through `claude mcp add-json/remove`
 * because ~/.claude.json is rewritten constantly by running Claude sessions.
 */

function globalConfigPath() {
  return process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(os.homedir(), '.claude.json');
}

function readJson(p: string): any {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return undefined;
  }
}

function normalize(cfg: any): McpServerConfig {
  const type = cfg?.type || (cfg?.url ? 'http' : 'stdio');
  return { ...cfg, type };
}

export function listMcpServers(projects: string[]): McpServer[] {
  const out: McpServer[] = [];
  const global = readJson(globalConfigPath()) || {};
  for (const [name, cfg] of Object.entries(global.mcpServers || {})) {
    out.push({ name, scope: 'user', config: normalize(cfg), source: 'User' });
  }
  // Local-scope servers for every project that has any, plus the projects we were asked about.
  const projEntries = (global.projects || {}) as Record<string, any>;
  const projectSet = new Set(projects);
  for (const [p, v] of Object.entries(projEntries)) if (v?.mcpServers && Object.keys(v.mcpServers).length) projectSet.add(p);
  for (const p of projectSet) {
    for (const [name, cfg] of Object.entries(projEntries[p]?.mcpServers || {})) {
      out.push({ name, scope: 'local', project: p, config: normalize(cfg), source: p });
    }
    const mcpJson = readJson(path.join(p, '.mcp.json'));
    if (mcpJson?.mcpServers) {
      const approval = approvalState(p, projEntries[p]);
      for (const [name, cfg] of Object.entries(mcpJson.mcpServers)) {
        out.push({ name, scope: 'project', project: p, config: normalize(cfg), source: p, approval: approval(name) });
      }
    }
  }
  return out;
}

/** Whether a .mcp.json server is approved, rejected or still pending for a project. */
function approvalState(project: string, globalProject: any) {
  const local = readSettings('local', project).data as any;
  const shared = readSettings('project', project).data as any;
  const user = readSettings('user').data as any;
  const enabled = new Set<string>([...(local.enabledMcpjsonServers || []), ...(shared.enabledMcpjsonServers || []), ...(globalProject?.enabledMcpjsonServers || [])]);
  const disabled = new Set<string>([...(local.disabledMcpjsonServers || []), ...(shared.disabledMcpjsonServers || []), ...(globalProject?.disabledMcpjsonServers || [])]);
  const all = local.enableAllProjectMcpServers ?? shared.enableAllProjectMcpServers ?? user.enableAllProjectMcpServers;
  return (name: string): McpServer['approval'] => (disabled.has(name) ? 'rejected' : enabled.has(name) || all === true ? 'approved' : 'pending');
}

function runClaude(args: string[], cwd: string, timeout = 60_000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.ELECTRON_RUN_AS_NODE;
    execFile(claudeBinary(), args, { cwd, env, timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || stdout || err.message).toString().trim().split('\n').slice(-4).join('\n')));
      else resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
    });
  });
}

/** Run `claude mcp list` (connects to every server) and parse each line's status. */
export async function mcpHealth(project?: string): Promise<McpHealth[]> {
  const cwd = project && fs.existsSync(project) ? project : os.homedir();
  const { stdout } = await runClaude(['mcp', 'list'], cwd, 120_000);
  const out: McpHealth[] = [];
  for (const line of stdout.split('\n')) {
    const m = /^(.+?): (.*) - (.+)$/.exec(line.trim());
    if (!m) continue;
    const statusText = m[3].trim();
    const status: McpHealth['status'] = /✔|connected/i.test(statusText) && !/fail|not/i.test(statusText)
      ? 'connected'
      : /pending|⏸/i.test(statusText)
        ? 'pending'
        : /auth/i.test(statusText)
          ? 'needs-auth'
          : /disabled/i.test(statusText)
            ? 'disabled'
            : 'failed';
    out.push({ name: m[1].trim(), target: m[2].trim(), status, statusText });
  }
  return out;
}

function validName(name: string) {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw new Error('Server name may only contain letters, digits, "_" and "-"');
}

function cwdFor(scope: string, project?: string) {
  if (scope === 'user') return project && fs.existsSync(project) ? project : os.homedir();
  if (!project || !fs.existsSync(project)) throw new Error('Pick a project folder for local/project servers');
  return project;
}

function cleanConfig(cfg: McpServerConfig): Record<string, unknown> {
  const c: Record<string, unknown> = { type: cfg.type };
  if (cfg.type === 'stdio') {
    if (!cfg.command?.trim()) throw new Error('Command is required');
    c.command = cfg.command.trim();
    if (cfg.args?.length) c.args = cfg.args;
    if (cfg.env && Object.keys(cfg.env).length) c.env = cfg.env;
  } else {
    if (!cfg.url?.trim() || !/^(https?|wss?):\/\//.test(cfg.url.trim())) throw new Error('A valid URL (https://…) is required');
    c.url = cfg.url.trim();
    if (cfg.headers && Object.keys(cfg.headers).length) c.headers = cfg.headers;
  }
  // Preserve any other keys the user had (e.g. oauth settings, timeouts).
  for (const [k, v] of Object.entries(cfg)) if (!(k in c) && !['command', 'args', 'env', 'url', 'headers'].includes(k)) c[k] = v;
  return c;
}

export async function saveMcpServer(params: {
  scope: 'user' | 'local' | 'project';
  project?: string;
  name: string;
  config: McpServerConfig;
  original?: { scope: 'user' | 'local' | 'project'; project?: string; name: string; config: McpServerConfig };
}) {
  const { scope, project, name, config, original } = params;
  validName(name);
  const json = JSON.stringify(cleanConfig(config));
  if (original) {
    await runClaude(['mcp', 'remove', original.name, '-s', original.scope], cwdFor(original.scope, original.project));
  }
  try {
    await runClaude(['mcp', 'add-json', name, json, '-s', scope], cwdFor(scope, project));
  } catch (e) {
    // Put the original back so an invalid edit doesn't lose the server.
    if (original) {
      await runClaude(['mcp', 'add-json', original.name, JSON.stringify(cleanConfig(original.config)), '-s', original.scope], cwdFor(original.scope, original.project)).catch(() => {});
    }
    throw e;
  }
}

export async function removeMcpServer(params: { scope: 'user' | 'local' | 'project'; project?: string; name: string }) {
  await runClaude(['mcp', 'remove', params.name, '-s', params.scope], cwdFor(params.scope, params.project));
}

/** Approve / reject / reset a project (.mcp.json) server via the project's settings.local.json. */
export function setMcpApproval(params: { project: string; name: string; approval: 'approved' | 'rejected' | 'pending' }) {
  const { project, name, approval } = params;
  patchSettings('local', project, (d) => {
    const en = new Set<string>(d.enabledMcpjsonServers || []);
    const dis = new Set<string>(d.disabledMcpjsonServers || []);
    en.delete(name);
    dis.delete(name);
    if (approval === 'approved') en.add(name);
    if (approval === 'rejected') dis.add(name);
    if (en.size) d.enabledMcpjsonServers = [...en];
    else delete d.enabledMcpjsonServers;
    if (dis.size) d.disabledMcpjsonServers = [...dis];
    else delete d.disabledMcpjsonServers;
  });
}
