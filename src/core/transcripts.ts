import * as fs from 'fs';
import * as path from 'path';
import type { TranscriptItem } from '../shared/protocol';

const MAX_TEXT = 20000;

function clip(s: string): string {
  return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + `\n… [${s.length - MAX_TEXT} more chars]` : s;
}

function contentToText(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((x: any) => (x?.type === 'text' ? x.text : x?.type === 'image' ? '[image]' : typeof x === 'string' ? x : ''))
      .filter(Boolean)
      .join('\n');
  }
  return c == null ? '' : JSON.stringify(c);
}

/** Convert one JSONL line of a Claude Code transcript into display items. */
export function parseTranscriptLine(line: string): TranscriptItem[] {
  let o: any;
  try {
    o = JSON.parse(line);
  } catch {
    return [];
  }
  if (o.type !== 'user' && o.type !== 'assistant') return [];
  if (o.isMeta) return [];
  const msg = o.message;
  if (!msg) return [];
  const base = o.uuid || Math.random().toString(36).slice(2);
  const ts = o.timestamp;
  const out: TranscriptItem[] = [];

  if (typeof msg.content === 'string') {
    const text = msg.content;
    if (o.type === 'user') {
      // Skip pure system-reminder / command noise.
      if (/^\s*<(system-reminder|local-command|command-name)/.test(text)) {
        out.push({ id: base, ts, kind: 'system', text: clip(text) });
      } else {
        out.push({ id: base, ts, kind: 'prompt', text: clip(text) });
      }
    } else {
      out.push({ id: base, ts, kind: 'text', text: clip(text) });
    }
    return out;
  }
  if (!Array.isArray(msg.content)) return out;

  msg.content.forEach((part: any, i: number) => {
    const id = `${base}:${i}`;
    switch (part?.type) {
      case 'text':
        if (!part.text?.trim()) return;
        if (o.type === 'user' && /^\s*<system-reminder>/.test(part.text)) {
          out.push({ id, ts, kind: 'system', text: clip(part.text) });
        } else {
          out.push({ id, ts, kind: o.type === 'user' ? 'prompt' : 'text', text: clip(part.text) });
        }
        break;
      case 'thinking':
        if (part.thinking?.trim()) out.push({ id, ts, kind: 'thinking', text: clip(part.thinking) });
        break;
      case 'tool_use':
        out.push({ id, ts, kind: 'tool_use', toolName: part.name, toolUseId: part.id, input: part.input });
        break;
      case 'tool_result':
        out.push({
          id,
          ts,
          kind: 'tool_result',
          toolUseId: part.tool_use_id,
          isError: !!part.is_error,
          text: clip(contentToText(part.content)),
        });
        break;
    }
  });
  return out;
}

/** Follows a JSONL file as it grows, emitting parsed items. */
export class TranscriptTail {
  private offset = 0;
  private partial = '';
  private watcher?: fs.FSWatcher;
  private poll?: NodeJS.Timeout;
  private closed = false;
  private reading = false;

  constructor(
    public readonly file: string,
    private onItems: (items: TranscriptItem[], reset: boolean) => void,
  ) {
    this.readMore(true);
    try {
      this.watcher = fs.watch(file, () => this.readMore(false));
    } catch {}
    // fs.watch is unreliable on some filesystems (e.g. WSL mounts), so also poll.
    this.poll = setInterval(() => this.readMore(false), 1000);
  }

  private readMore(initial: boolean) {
    if (this.closed || this.reading) return;
    this.reading = true;
    try {
      const st = fs.statSync(this.file);
      if (st.size < this.offset) {
        this.offset = 0;
        this.partial = '';
        initial = true;
      }
      if (st.size === this.offset) {
        if (initial) this.onItems([], true);
        return;
      }
      const fd = fs.openSync(this.file, 'r');
      const len = st.size - this.offset;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, this.offset);
      fs.closeSync(fd);
      this.offset = st.size;
      const text = this.partial + buf.toString('utf8');
      const lines = text.split('\n');
      this.partial = lines.pop() ?? '';
      const items = lines.filter(Boolean).flatMap(parseTranscriptLine);
      if (items.length || initial) this.onItems(items, initial);
    } catch {
      if (initial) this.onItems([], true);
    } finally {
      this.reading = false;
    }
  }

  close() {
    this.closed = true;
    this.watcher?.close();
    if (this.poll) clearInterval(this.poll);
  }
}

/** Directory where Claude Code keeps subagent transcripts for a session. */
export function subagentDir(parentTranscriptPath: string, claudeSessionId: string): string {
  return path.join(path.dirname(parentTranscriptPath), claudeSessionId, 'subagents');
}

export interface SubagentMeta {
  agentId: string;
  file: string;
  agentType?: string;
  description?: string;
  toolUseId?: string;
  finished?: boolean;
}

/** List subagent transcripts (with their .meta.json) for a parent session. */
export function listSubagentFiles(dir: string): SubagentMeta[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: SubagentMeta[] = [];
  for (const n of names) {
    const m = /^agent-(.+)\.jsonl$/.exec(n);
    if (!m) continue;
    const agentId = m[1];
    const meta: SubagentMeta = { agentId, file: path.join(dir, n) };
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, `agent-${agentId}.meta.json`), 'utf8'));
      meta.agentType = j.agentType;
      meta.description = j.description;
      meta.toolUseId = j.toolUseId;
      meta.finished = j.finished;
    } catch {}
    out.push(meta);
  }
  return out;
}

/** First user prompt in a transcript file (used for subagent prompts). */
export function readFirstPrompt(file: string): string | undefined {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(256 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    for (const line of buf.subarray(0, n).toString('utf8').split('\n')) {
      const items = parseTranscriptLine(line);
      const p = items.find((i) => i.kind === 'prompt');
      if (p?.text) return p.text;
    }
  } catch {}
  return undefined;
}
