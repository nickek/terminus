import { useEffect, useMemo, useRef, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import type { TranscriptItem } from '../../shared/protocol';
import { client } from '../client';
import { useCore } from '../store';
import { duration } from '../util';
import { openSession } from '../workspace';

interface Params {
  key: string;
  subagentId?: string;
  sessionId?: string;
}

function toolSummary(name: string | undefined, input: any): string {
  if (!input || typeof input !== 'object') return '';
  const v = input.command ?? input.file_path ?? input.pattern ?? input.url ?? input.query ?? input.description ?? input.path;
  return typeof v === 'string' ? v : '';
}

function Item({ item, results }: { item: TranscriptItem; results: Map<string, TranscriptItem> }) {
  const [open, setOpen] = useState(false);
  switch (item.kind) {
    case 'prompt':
      return (
        <div className="tx-item tx-prompt">
          <div className="tx-label">prompt</div>
          <div className={`tx-text ${open ? '' : 'clamp'}`} onClick={() => setOpen(!open)}>
            {item.text}
          </div>
        </div>
      );
    case 'text':
      return (
        <div className="tx-item tx-assistant">
          <div className="tx-text">{item.text}</div>
        </div>
      );
    case 'thinking':
      return (
        <div className="tx-item tx-thinking" onClick={() => setOpen(!open)}>
          <div className="tx-label">thinking {open ? '▾' : '▸'}</div>
          {open && <div className="tx-text">{item.text}</div>}
        </div>
      );
    case 'system':
      return null;
    case 'tool_use': {
      const res = item.toolUseId ? results.get(item.toolUseId) : undefined;
      const summary = toolSummary(item.toolName, item.input);
      return (
        <div className={`tx-item tx-tool ${res?.isError ? 'error' : ''}`}>
          <div className="tx-tool-head" onClick={() => setOpen(!open)}>
            <span className="tx-caret">{open ? '▾' : '▸'}</span>
            <span className="tx-tool-name">{item.toolName}</span>
            <span className="tx-tool-summary">{summary}</span>
            <span className={`tx-tool-state ${res ? (res.isError ? 'err' : 'ok') : 'run'}`}>
              {res ? (res.isError ? 'error' : 'done') : 'running'}
            </span>
          </div>
          {open && (
            <div className="tx-tool-body">
              <pre className="tx-pre">{JSON.stringify(item.input, null, 2)}</pre>
              {res && <pre className="tx-pre result">{res.text || '(empty result)'}</pre>}
            </div>
          )}
        </div>
      );
    }
    case 'tool_result':
      return null; // rendered with its tool_use
  }
}

export function TranscriptPanel(props: IDockviewPanelProps<Params>) {
  const { key, subagentId, sessionId } = props.params;
  const { subagents, sessions } = useCore();
  const sub = subagentId ? subagents.find((s) => s.id === subagentId) : undefined;
  const session = sessionId ? sessions.find((s) => s.id === sessionId) : undefined;
  const [items, setItems] = useState<TranscriptItem[]>([]);
  const [path, setPath] = useState<string>();
  const [follow, setFollow] = useState(true);
  const [showPrompt, setShowPrompt] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [, tick] = useState(0);

  useEffect(() => {
    return client.watchTranscript(key, (newItems, reset, p) => {
      if (p) setPath(p);
      setItems((prev) => (reset ? [...newItems] : [...prev, ...newItems]));
    });
  }, [key]);

  useEffect(() => {
    if (sub?.status !== 'running') return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [sub?.status]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && follow) el.scrollTop = el.scrollHeight;
  }, [items, follow]);

  const results = useMemo(() => {
    const m = new Map<string, TranscriptItem>();
    for (const i of items) if (i.kind === 'tool_result' && i.toolUseId) m.set(i.toolUseId, i);
    return m;
  }, [items]);

  const toolCount = items.filter((i) => i.kind === 'tool_use').length;
  const visible = items.filter((i) => i.kind !== 'system' && i.kind !== 'tool_result');
  // The subagent's prompt is shown in the header, not repeated as the first item.
  const body = sub && visible[0]?.kind === 'prompt' ? visible.slice(1) : visible;
  const prompt = sub?.prompt || (sub && visible[0]?.kind === 'prompt' ? visible[0].text : undefined);

  const fork = async () => {
    if (!sub) return;
    const s = await client.spawn({
      kind: 'claude',
      cwd: sub.cwd,
      title: `fork · ${sub.description || sub.agentType}`,
      initialPrompt: prompt,
    });
    openSession(s.id);
  };

  return (
    <div className="tx-panel">
      <div className="tx-header">
        {sub ? (
          <>
            <div className="tx-title">
              <span className={`badge sub-${sub.status}`}>{sub.status}</span>
              <span className="tx-agent-type">{sub.agentType}</span>
              <span className="tx-desc">{sub.description}</span>
            </div>
            <div className="tx-meta">
              <span>{duration(sub.startedAt, sub.endedAt)}</span>
              <span>{toolCount} tool calls</span>
              {sub.background && <span>background</span>}
              {session && (
                <button className="link" onClick={() => openSession(session.id)}>
                  parent: {session.title}
                </button>
              )}
            </div>
          </>
        ) : (
          <div className="tx-title">
            <span className="tx-agent-type">transcript</span>
            <span className="tx-desc">{session?.title || key}</span>
          </div>
        )}
        <div className="tx-actions">
          {sub && prompt && (
            <button className="btn small" onClick={() => setShowPrompt(!showPrompt)}>
              {showPrompt ? 'Hide prompt' : 'Prompt'}
            </button>
          )}
          {sub && (
            <button className="btn small primary" onClick={fork} title="Start an interactive claude session with this subagent's task">
              Fork to interactive
            </button>
          )}
          <label className="check small">
            <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> follow
          </label>
        </div>
        {showPrompt && prompt && <pre className="tx-prompt-box">{prompt}</pre>}
      </div>
      <div
        className="tx-scroll"
        ref={scrollRef}
        onWheel={() => {
          const el = scrollRef.current!;
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          if (follow !== atBottom) setFollow(atBottom);
        }}
      >
        {!path && (
          <div className="tx-empty">
            {sub?.status === 'failed' ? 'This subagent never produced a transcript.' : 'Waiting for the transcript to appear…'}
          </div>
        )}
        {body.map((i) => (
          <Item key={i.id} item={i} results={results} />
        ))}
        {sub?.status === 'running' && path && <div className="tx-working">working…</div>}
      </div>
    </div>
  );
}
