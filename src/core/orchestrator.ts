import { EventEmitter } from 'events';
import * as fs from 'fs';
import type { HookEventSummary, SessionInfo, SubagentInfo, TranscriptItem } from '../shared/protocol';
import type { SessionManager } from './sessions';
import { TranscriptTail, listSubagentFiles, readFirstPrompt, subagentDir } from './transcripts';

const AGENT_TOOLS = new Set(['Agent', 'Task']);
const MAX_EVENTS = 300;
const MAX_FINISHED_SUBAGENTS = 200;

function summarizeInput(tool: string, input: any): string {
  if (!input || typeof input !== 'object') return '';
  const pick =
    input.command ?? input.file_path ?? input.pattern ?? input.url ?? input.query ?? input.description ?? input.prompt ?? input.path;
  const s = typeof pick === 'string' ? pick : JSON.stringify(input);
  return s.replace(/\s+/g, ' ').slice(0, 140);
}

interface Watch {
  listeners: Set<(items: TranscriptItem[], reset: boolean, path?: string) => void>;
  tail?: TranscriptTail;
  history: TranscriptItem[];
  resolver?: NodeJS.Timeout;
}

/**
 * Turns hook events into session status + subagent records, and serves live
 * transcript streams for subagents and sessions.
 */
export class Orchestrator extends EventEmitter {
  subagents = new Map<string, SubagentInfo>();
  events: HookEventSummary[] = [];
  lastHookAt?: number;
  private eventSeq = 0;
  private watches = new Map<string, Watch>();
  private changeTimer?: NodeJS.Timeout;

  constructor(private sessions: SessionManager) {
    super();
    setInterval(() => this.resolveSubagents(), 1000).unref();
  }

  // ---------------------------------------------------------------- hooks

  handleHook(p: any, terminusId?: string) {
    const ev: string = p?.hook_event_name;
    const csid: string = p?.session_id;
    if (!ev || !csid) return;
    this.lastHookAt = Date.now();

    let session: SessionInfo | undefined;
    if (terminusId && this.sessions.has(terminusId)) {
      session = this.sessions.get(terminusId);
      this.sessions.update(terminusId, {
        claudeSessionId: csid,
        transcriptPath: p.transcript_path || session?.transcriptPath,
        hooked: true,
      });
    } else {
      session = this.sessions.findByClaudeSession(csid);
      if (!session && ev !== 'SessionEnd') session = this.sessions.addExternal(csid, p.cwd || '', p.transcript_path);
    }
    if (!session) return;
    const sid = session.id;
    const now = Date.now();
    // Hooks fired from inside a subagent carry agent_id; they shouldn't flip the parent's status.
    const fromSubagent = !!p.agent_id && ev !== 'SubagentStart' && ev !== 'SubagentStop';
    let detail = '';

    switch (ev) {
      case 'SessionStart':
        this.sessions.update(sid, { status: 'idle', lastActivity: now, lastEvent: `session ${p.source || 'started'}` });
        detail = p.source || 'startup';
        break;
      case 'SessionEnd':
        detail = p.reason || 'ended';
        if (session.external) this.sessions.update(sid, { status: 'exited', lastActivity: now, lastEvent: `session ended (${detail})` });
        else this.sessions.update(sid, { lastEvent: `session ended (${detail})` });
        break;
      case 'UserPromptSubmit':
        detail = String(p.prompt || '').replace(/\s+/g, ' ').slice(0, 140);
        this.sessions.update(sid, { status: 'active', lastActivity: now, lastEvent: `prompt: ${detail}` });
        break;
      case 'PreToolUse':
        detail = `${p.tool_name}: ${summarizeInput(p.tool_name, p.tool_input)}`;
        if (!fromSubagent) this.sessions.update(sid, { status: 'active', lastActivity: now, lastEvent: detail });
        else this.sessions.update(sid, { lastActivity: now });
        if (AGENT_TOOLS.has(p.tool_name)) this.onAgentToolStart(session, p);
        break;
      case 'PostToolUse':
        detail = `${p.tool_name} done`;
        if (!fromSubagent) this.sessions.update(sid, { status: 'active', lastActivity: now });
        if (AGENT_TOOLS.has(p.tool_name)) this.onAgentToolEnd(p);
        break;
      case 'Notification': {
        detail = String(p.message || p.notification_type || 'notification');
        const idleish = p.notification_type === 'idle_prompt' || /waiting for your input/i.test(detail);
        this.sessions.update(sid, { status: idleish ? 'idle' : 'waiting', lastActivity: now, lastEvent: detail });
        break;
      }
      case 'Stop':
        detail = 'turn finished';
        this.sessions.update(sid, { status: 'idle', lastActivity: now, lastEvent: 'waiting for prompt' });
        break;
      case 'SubagentStart':
        detail = p.agent_type || 'subagent';
        this.onSubagentStart(session, p);
        break;
      case 'SubagentStop':
        detail = p.agent_type || 'subagent';
        this.onSubagentStop(p);
        break;
      default:
        detail = '';
    }

    const summary: HookEventSummary = {
      id: ++this.eventSeq,
      ts: now,
      event: fromSubagent ? `${ev} (subagent)` : ev,
      sessionId: sid,
      sessionTitle: session.title,
      detail,
    };
    this.events.push(summary);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    this.emit('event', summary);
  }

  // ---------------------------------------------------------------- subagents

  private onAgentToolStart(session: SessionInfo, p: any) {
    const input = p.tool_input || {};
    const id = p.tool_use_id || `tu-${Date.now().toString(36)}`;
    if (this.subagents.has(id)) return;
    const sub: SubagentInfo = {
      id,
      parentId: session.id,
      claudeSessionId: p.session_id,
      toolUseId: p.tool_use_id,
      agentType: input.subagent_type || 'general-purpose',
      description: input.description || '',
      prompt: input.prompt || '',
      cwd: p.cwd || session.cwd,
      status: 'running',
      background: !!input.run_in_background,
      startedAt: Date.now(),
    };
    this.subagents.set(id, sub);
    this.changed();
    this.emit('subagentStarted', sub);
  }

  private onAgentToolEnd(p: any) {
    const sub = p.tool_use_id && this.subagents.get(p.tool_use_id);
    if (!sub || sub.status !== 'running' || sub.background) return;
    // Foreground agent: the tool call returning means the subagent finished.
    const resp = p.tool_response;
    const failed = resp && typeof resp === 'object' && (resp.is_error || resp.error);
    this.finish(sub, failed ? 'failed' : 'done');
  }

  private onSubagentStart(session: SessionInfo, p: any) {
    const agentId: string | undefined = p.agent_id;
    if (!agentId) return;
    if ([...this.subagents.values()].some((s) => s.agentId === agentId)) return;
    const parentTranscript = session.transcriptPath || p.transcript_path;
    const dir = parentTranscript ? subagentDir(parentTranscript, p.session_id) : undefined;
    const file = dir ? `${dir}/agent-${agentId}.jsonl` : undefined;
    let toolUseId: string | undefined;
    if (dir) {
      try {
        toolUseId = JSON.parse(fs.readFileSync(`${dir}/agent-${agentId}.meta.json`, 'utf8')).toolUseId;
      } catch {}
    }
    let sub = toolUseId ? this.subagents.get(toolUseId) : undefined;
    if (!sub) {
      sub = [...this.subagents.values()].find(
        (s) => s.claudeSessionId === p.session_id && !s.agentId && s.status === 'running' && (!p.agent_type || s.agentType === p.agent_type),
      );
    }
    if (sub) {
      sub.agentId = agentId;
      if (file) sub.transcriptPath = file;
      this.changed();
      this.notifyWatchResolved(sub);
      return;
    }
    const created: SubagentInfo = {
      id: `ag-${agentId}`,
      parentId: session.id,
      claudeSessionId: p.session_id,
      agentId,
      agentType: p.agent_type || 'subagent',
      description: '',
      prompt: '',
      cwd: p.cwd || session.cwd,
      status: 'running',
      background: false,
      startedAt: Date.now(),
      transcriptPath: file,
    };
    this.subagents.set(created.id, created);
    this.changed();
    this.emit('subagentStarted', created);
  }

  private onSubagentStop(p: any) {
    const sub = [...this.subagents.values()].find((s) => s.agentId && s.agentId === p.agent_id);
    if (!sub) return;
    if (p.agent_transcript_path) sub.transcriptPath = p.agent_transcript_path;
    this.finish(sub, 'done');
  }

  private finish(sub: SubagentInfo, status: 'done' | 'failed') {
    if (sub.status !== 'running') return;
    sub.status = status;
    sub.endedAt = Date.now();
    this.changed();
  }

  /** Link subagent records to their transcript files via the .meta.json toolUseId. */
  private resolveSubagents() {
    const now = Date.now();
    for (const sub of this.subagents.values()) {
      if (sub.transcriptPath && sub.prompt) {
        if (sub.status === 'running' && sub.agentId) this.checkFinishedMeta(sub);
        continue;
      }
      if (sub.transcriptPath && !sub.prompt) {
        sub.prompt = readFirstPrompt(sub.transcriptPath) || '';
        if (sub.prompt) this.changed();
        continue;
      }
      const parent = this.sessions.get(sub.parentId);
      if (!parent?.transcriptPath) continue;
      const files = listSubagentFiles(subagentDir(parent.transcriptPath, sub.claudeSessionId));
      const match = files.find((f) => sub.toolUseId && f.toolUseId === sub.toolUseId);
      if (match) {
        sub.agentId = match.agentId;
        sub.transcriptPath = match.file;
        if (!sub.description && match.description) sub.description = match.description;
        this.changed();
        this.notifyWatchResolved(sub);
      } else if (sub.status === 'running' && now - sub.startedAt > 120_000) {
        // Never materialised (denied permission, or an old Claude Code without subagent files).
        sub.status = 'failed';
        sub.endedAt = now;
        this.changed();
      }
    }
    // Recompute per-session counters.
    const counts = new Map<string, { r: number; t: number }>();
    for (const s of this.subagents.values()) {
      const c = counts.get(s.parentId) || { r: 0, t: 0 };
      c.t++;
      if (s.status === 'running') c.r++;
      counts.set(s.parentId, c);
    }
    for (const s of this.sessions.list()) {
      const c = counts.get(s.id) || { r: 0, t: 0 };
      if (s.subagentsRunning !== c.r || s.subagentsTotal !== c.t) {
        this.sessions.update(s.id, { subagentsRunning: c.r, subagentsTotal: c.t });
      }
    }
    this.pruneFinished();
  }

  private checkFinishedMeta(sub: SubagentInfo) {
    if (!sub.transcriptPath) return;
    try {
      const meta = JSON.parse(fs.readFileSync(sub.transcriptPath.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
      if (meta.finished) this.finish(sub, 'done');
    } catch {}
  }

  private pruneFinished() {
    const finished = [...this.subagents.values()].filter((s) => s.status !== 'running').sort((a, b) => (a.endedAt || 0) - (b.endedAt || 0));
    const excess = finished.length - MAX_FINISHED_SUBAGENTS;
    for (let i = 0; i < excess; i++) this.subagents.delete(finished[i].id);
  }

  clearFinished() {
    for (const [id, s] of this.subagents) if (s.status !== 'running') this.subagents.delete(id);
    this.changed();
  }

  list(): SubagentInfo[] {
    return [...this.subagents.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  private changed() {
    if (this.changeTimer) return;
    this.changeTimer = setTimeout(() => {
      this.changeTimer = undefined;
      this.emit('changed');
    }, 50);
  }

  // ---------------------------------------------------------------- transcript watches

  /** Keys: `sub:<subagentId>` or `session:<sessionId>`. */
  private resolveWatchPath(key: string): string | undefined {
    if (key.startsWith('sub:')) return this.subagents.get(key.slice(4))?.transcriptPath;
    if (key.startsWith('session:')) return this.sessions.get(key.slice(8))?.transcriptPath;
    return undefined;
  }

  watch(key: string, listener: (items: TranscriptItem[], reset: boolean, path?: string) => void): () => void {
    let w = this.watches.get(key);
    if (!w) {
      w = { listeners: new Set([listener]), history: [] };
      this.watches.set(key, w);
      this.startTail(key, w);
    } else {
      w.listeners.add(listener);
      if (w.tail) listener(w.history, true, w.tail.file);
      else listener([], true);
    }
    return () => {
      const cur = this.watches.get(key);
      if (!cur) return;
      cur.listeners.delete(listener);
      if (cur.listeners.size === 0) {
        cur.tail?.close();
        if (cur.resolver) clearInterval(cur.resolver);
        this.watches.delete(key);
      }
    };
  }

  private startTail(key: string, w: Watch) {
    const file = this.resolveWatchPath(key);
    if (file && fs.existsSync(file)) {
      if (w.resolver) clearInterval(w.resolver);
      w.resolver = undefined;
      w.history = [];
      w.tail = new TranscriptTail(file, (items, reset) => {
        if (reset) w.history = [];
        w.history.push(...items);
        if (w.history.length > 2000) w.history.splice(0, w.history.length - 2000);
        for (const l of w.listeners) l(items, reset, file);
      });
      return;
    }
    // Not available yet — tell listeners and retry until it appears.
    for (const l of w.listeners) l([], true);
    if (!w.resolver) {
      w.resolver = setInterval(() => {
        if (!this.watches.has(key) || w.tail) return;
        const f = this.resolveWatchPath(key);
        if (f && fs.existsSync(f)) this.startTail(key, w);
      }, 1000);
    }
  }

  private notifyWatchResolved(sub: SubagentInfo) {
    const w = this.watches.get(`sub:${sub.id}`);
    if (w && !w.tail) this.startTail(`sub:${sub.id}`, w);
  }
}
