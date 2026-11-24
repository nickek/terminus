/**
 * Terminus core service: owns PTY sessions, receives Claude Code hook events,
 * tails transcripts, and serves GUI clients over a token-protected WebSocket.
 *
 * Run standalone with `npm run core`, or let the Electron app spawn it.
 */
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { DEFAULT_PORT, type ClientMessage, type ServerMessage } from '../shared/protocol';
import { SessionManager } from './sessions';
import { adoptUserShellPath } from './env';
import { ConfigStore } from './config';
import { Orchestrator } from './orchestrator';
import { hooksStatus, installHooks, uninstallHooks } from './hooks';
import { deleteAgent, listAgents, previewAgent, saveAgent, userAgentsDir } from './agents';
import {
  copySkill,
  deleteSkill,
  deleteSkillFile,
  listSkills,
  readSkillFile,
  saveSkill,
  serializeSkill,
  userSkillsDir,
  writeSkillFile,
} from './skills';
import { listMcpServers, mcpHealth, removeMcpServer, saveMcpServer, setMcpApproval } from './mcp';
import { readAllSettings, readSettings, writeSettings } from './settings';

const VERSION = '0.1.0';
// Must run before anything resolves binaries (claude) or spawns sessions.
adoptUserShellPath();

const port = Number(process.env.TERMINUS_PORT || DEFAULT_PORT);
const stateDir = process.env.TERMINUS_HOME || path.join(os.homedir(), '.terminus');
const infoFile = path.join(stateDir, 'core.json');
const token = randomBytes(24).toString('hex');

const config = new ConfigStore(stateDir);
const sessions = new SessionManager(port);
const orch = new Orchestrator(sessions);
const clients = new Set<WebSocket>();

function send(ws: WebSocket, msg: ServerMessage) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}
function broadcast(msg: ServerMessage) {
  const s = JSON.stringify(msg);
  for (const ws of clients) if (ws.readyState === WebSocket.OPEN) ws.send(s);
}

const configMessage = (): ServerMessage => ({
  t: 'config',
  config: config.getConfig(),
  state: config.getState(),
  path: config.configPath,
  error: config.configError,
});
config.on('changed', () => broadcast(configMessage()));
sessions.on('changed', () => broadcast({ t: 'sessions', sessions: sessions.list() }));
sessions.on('data', (id: string, data: string) => broadcast({ t: 'data', id, data }));
sessions.on('reset', (id: string) => broadcast({ t: 'scrollback', id, data: '' }));
orch.on('changed', () => broadcast({ t: 'subagents', subagents: orch.list() }));
orch.on('event', (event) => broadcast({ t: 'event', event }));
orch.on('subagentStarted', (subagent) => broadcast({ t: 'subagentStarted', subagent }));

const rpc: Record<string, (params: any) => any> = {
  'config.patch': (patch) => config.patchConfig(patch),
  'state.patch': (patch) => config.patchState(patch),
  'sessions.kill': ({ id }) => sessions.kill(id),
  'sessions.close': ({ id }) => sessions.close(id),
  'sessions.resume': ({ id }) => sessions.resume(id),
  'sessions.remove': ({ id }) => sessions.remove(id),
  'sessions.rename': ({ id, title }) => sessions.rename(id, title),
  'sessions.configure': ({ id, patch }) => sessions.configure(id, patch),
  'sessions.restart': ({ id }) => sessions.restart(id),
  'sessions.removeFinished': () => {
    for (const s of sessions.list()) if (s.status === 'exited' || s.status === 'failed' || s.status === 'closed') sessions.remove(s.id);
  },
  'subagents.clearFinished': () => orch.clearFinished(),
  'events.list': () => orch.events,
  'hooks.status': () => hooksStatus(port, orch.lastHookAt),
  'hooks.install': () => {
    installHooks(port);
    return hooksStatus(port, orch.lastHookAt);
  },
  'hooks.uninstall': () => {
    uninstallHooks();
    return hooksStatus(port, orch.lastHookAt);
  },
  'agents.list': ({ projects }) => ({ userDir: userAgentsDir(), agents: listAgents(projects || []) }),
  'agents.save': (params) => saveAgent(params),
  'agents.delete': ({ path: p }) => deleteAgent(p),
  'agents.preview': ({ def }) => previewAgent(def),
  'skills.list': ({ projects }) => ({ userDir: userSkillsDir(), skills: listSkills(projects || []) }),
  'skills.save': (params) => saveSkill(params),
  'skills.delete': ({ dir }) => deleteSkill(dir),
  'skills.copy': (params) => copySkill(params),
  'skills.preview': ({ def }) => serializeSkill(def),
  'skills.readFile': (params) => readSkillFile(params),
  'skills.writeFile': (params) => writeSkillFile(params),
  'skills.deleteFile': (params) => deleteSkillFile(params),
  'mcp.list': ({ projects }) => listMcpServers(projects || []),
  'mcp.health': ({ project }) => mcpHealth(project),
  'mcp.save': (params) => saveMcpServer(params),
  'mcp.remove': (params) => removeMcpServer(params),
  'mcp.approve': (params) => setMcpApproval(params),
  'settings.read': ({ scope, project }) => readSettings(scope, project),
  'settings.readAll': ({ project }) => readAllSettings(project),
  'settings.write': (params) => writeSettings(params),
  'fs.isDir': ({ path: p }) => {
    try {
      return fs.statSync(p.replace(/^~/, os.homedir())).isDirectory();
    } catch {
      return false;
    }
  },
};

function handleClientMessage(ws: WebSocket, msg: ClientMessage, unwatchers: Map<string, () => void>) {
  switch (msg.t) {
    case 'spawn':
      try {
        const info = sessions.spawn(msg.opts);
        if (msg.reqId != null) send(ws, { t: 'rpcResult', reqId: msg.reqId, result: info });
      } catch (e) {
        if (msg.reqId != null) send(ws, { t: 'rpcResult', reqId: msg.reqId, error: (e as Error).message });
      }
      break;
    case 'input':
      sessions.write(msg.id, msg.data);
      break;
    case 'resize':
      sessions.resize(msg.id, msg.cols, msg.rows);
      break;
    case 'attach':
      send(ws, { t: 'scrollback', id: msg.id, data: sessions.scrollback(msg.id) });
      break;
    case 'watch': {
      if (unwatchers.has(msg.key)) break;
      const key = msg.key;
      unwatchers.set(
        key,
        orch.watch(key, (items, reset, p) => send(ws, { t: 'transcript', key, items, reset, path: p })),
      );
      break;
    }
    case 'unwatch':
      unwatchers.get(msg.key)?.();
      unwatchers.delete(msg.key);
      break;
    case 'rpc': {
      const fn = rpc[msg.method];
      if (!fn) {
        send(ws, { t: 'rpcResult', reqId: msg.reqId, error: `Unknown method ${msg.method}` });
        break;
      }
      Promise.resolve()
        .then(() => fn(msg.params || {}))
        .then(
          (result) => send(ws, { t: 'rpcResult', reqId: msg.reqId, result }),
          (e) => send(ws, { t: 'rpcResult', reqId: msg.reqId, error: (e as Error).message }),
        );
      break;
    }
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/health') {
    const ok = url.searchParams.get('token') === token;
    res.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok, version: VERSION }));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/hook') {
    // Hooks come from curl; reject anything a browser page could send cross-origin.
    if (req.headers.origin) {
      res.writeHead(403).end();
      return;
    }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => {
      body += c;
      if (body.length > 4 * 1024 * 1024) req.destroy();
    });
    req.on('end', () => {
      res.writeHead(204).end();
      try {
        const payload = JSON.parse(body);
        const tid = String(req.headers['x-terminus-session'] || '') || undefined;
        orch.handleHook(payload, tid);
      } catch {}
    });
    return;
  }
  res.writeHead(404).end();
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', 'http://localhost');
  if (url.pathname !== '/ws' || url.searchParams.get('token') !== token) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws) => {
  clients.add(ws);
  const unwatchers = new Map<string, () => void>();
  send(ws, { t: 'hello', version: VERSION, home: os.homedir(), port });
  send(ws, configMessage()); // before sessions, so the UI has prefs + layout when it restores
  send(ws, { t: 'sessions', sessions: sessions.list() });
  send(ws, { t: 'subagents', subagents: orch.list() });
  ws.on('message', (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    handleClientMessage(ws, msg, unwatchers);
  });
  ws.on('close', () => {
    clients.delete(ws);
    for (const u of unwatchers.values()) u();
  });
});

server.on('error', (e: NodeJS.ErrnoException) => {
  console.error(`TERMINUS_ERROR ${JSON.stringify({ message: e.code === 'EADDRINUSE' ? `Port ${port} is already in use` : e.message })}`);
  process.exit(1);
});

server.listen(port, '127.0.0.1', () => {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(infoFile, JSON.stringify({ port, token, pid: process.pid }), { mode: 0o600 });
  console.log(`TERMINUS_READY ${JSON.stringify({ port, token })}`);
});

function shutdown() {
  sessions.closeAll();
  config.flush();
  try {
    const cur = JSON.parse(fs.readFileSync(infoFile, 'utf8'));
    if (cur.pid === process.pid) fs.rmSync(infoFile);
  } catch {}
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
// If the parent (Electron) goes away and we were spawned attached, exit with it.
if (process.env.TERMINUS_EXIT_WITH_PARENT === '1') {
  process.stdin.on('end', shutdown);
  process.stdin.resume();
}
