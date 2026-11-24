import { useCallback, useEffect, useMemo, useState } from 'react';
import type { McpHealth, McpServer, McpServerConfig } from '../../shared/protocol';
import { client } from '../client';
import { setPrefs, useCore, usePrefs } from '../store';
import { ago, shortPath } from '../util';
import { openSession } from '../workspace';
import { Icon } from './Icon';

type Scope = McpServer['scope'];
interface KV {
  k: string;
  v: string;
}
interface Draft {
  name: string;
  scope: Scope;
  project: string;
  type: 'stdio' | 'http' | 'sse';
  command: string;
  args: string;
  env: KV[];
  url: string;
  headers: KV[];
  extra: Record<string, unknown>;
}

const SCOPE_INFO: Record<Scope, { label: string; hint: string }> = {
  user: { label: 'User', hint: 'Available in every project, private to you (~/.claude.json)' },
  local: { label: 'Local', hint: 'Only this project, private to you (~/.claude.json)' },
  project: { label: 'Project', hint: 'Only this project, shared with your team via .mcp.json' },
};

const toKV = (o?: Record<string, string>): KV[] => Object.entries(o || {}).map(([k, v]) => ({ k, v }));
const fromKV = (rows: KV[]) => Object.fromEntries(rows.filter((r) => r.k.trim()).map((r) => [r.k.trim(), r.v]));

function toDraft(s?: McpServer, defaultProject = ''): Draft {
  const c = s?.config || ({ type: 'stdio' } as McpServerConfig);
  const { type, command, args, env, url, headers, ...extra } = c;
  return {
    name: s?.name || '',
    scope: s?.scope || 'user',
    project: s?.project || defaultProject,
    type: (['stdio', 'http', 'sse'].includes(type) ? type : 'stdio') as Draft['type'],
    command: command || '',
    args: (args || []).join('\n'),
    env: toKV(env),
    url: url || '',
    headers: toKV(headers),
    extra,
  };
}

function toConfig(d: Draft): McpServerConfig {
  const base: McpServerConfig = { ...d.extra, type: d.type };
  if (d.type === 'stdio') {
    base.command = d.command.trim();
    const args = d.args.split('\n').map((a) => a.trim()).filter(Boolean);
    if (args.length) base.args = args;
    const env = fromKV(d.env);
    if (Object.keys(env).length) base.env = env;
  } else {
    base.url = d.url.trim();
    const headers = fromKV(d.headers);
    if (Object.keys(headers).length) base.headers = headers;
  }
  return base;
}

function KVEditor({ rows, onChange, keyPh, valPh, secretHint }: { rows: KV[]; onChange: (r: KV[]) => void; keyPh: string; valPh: string; secretHint?: boolean }) {
  return (
    <div className="kv">
      {rows.map((r, i) => (
        <div className="kv-row" key={i}>
          <input value={r.k} placeholder={keyPh} spellCheck={false} onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, k: e.target.value } : x)))} />
          <input
            value={r.v}
            placeholder={valPh}
            spellCheck={false}
            type={secretHint && /key|token|secret|auth|password/i.test(r.k) ? 'password' : 'text'}
            onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)))}
          />
          <button className="icon-btn danger" onClick={() => onChange(rows.filter((_, j) => j !== i))} title="Remove">
            <Icon name="close" size={13} />
          </button>
        </div>
      ))}
      <button className="btn small ghost" onClick={() => onChange([...rows, { k: '', v: '' }])}>
        <Icon name="plus" size={13} /> Add
      </button>
    </div>
  );
}

function statusOf(h?: McpHealth) {
  if (!h) return { cls: 'unknown', label: 'not checked' };
  return {
    cls: h.status === 'connected' ? 'active' : h.status === 'needs-auth' || h.status === 'pending' ? 'waiting' : h.status === 'disabled' ? 'closed' : 'failed',
    label: h.statusText.replace(/^[^\w]+\s*/, ''),
  };
}

export function McpView() {
  const { home, sessions, connected } = useCore();
  const prefs = usePrefs();
  const [servers, setServers] = useState<McpServer[]>([]);
  const [health, setHealth] = useState<McpHealth[]>();
  const [healthAt, setHealthAt] = useState<number>();
  const [checking, setChecking] = useState(false);
  const [sel, setSel] = useState<{ key?: string; connector?: string }>();
  const [draft, setDraft] = useState<Draft>(toDraft());
  const [original, setOriginal] = useState<McpServer>();
  const [tab, setTab] = useState<'form' | 'json'>('form');
  const [jsonText, setJsonText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const projects = useMemo(() => {
    const fromSessions = sessions.filter((s) => !s.external).map((s) => s.cwd);
    return [...new Set([...prefs.agentProjects, ...fromSessions])];
  }, [prefs.agentProjects, sessions]);
  const [healthProject, setHealthProject] = useState('');

  const reload = useCallback(async () => {
    try {
      setServers(await client.rpc<McpServer[]>('mcp.list', { projects }));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [projects.join('|')]);

  const checkHealth = useCallback(async () => {
    setChecking(true);
    try {
      setHealth(await client.rpc<McpHealth[]>('mcp.health', { project: healthProject || undefined }));
      setHealthAt(Date.now());
    } catch (e) {
      setError(`Status check failed: ${(e as Error).message}`);
    } finally {
      setChecking(false);
    }
  }, [healthProject]);

  useEffect(() => {
    if (!connected) return;
    reload();
  }, [connected, reload]);
  useEffect(() => {
    if (connected) checkHealth();
  }, [connected, healthProject]);

  const keyOf = (s: McpServer) => `${s.scope}|${s.project || ''}|${s.name}`;
  const healthFor = (name: string) => health?.find((h) => h.name === name);
  const configuredNames = new Set(servers.map((s) => s.name));
  const connectors = (health || []).filter((h) => !configuredNames.has(h.name));
  const isNew = !!sel && !sel.key && !sel.connector;
  const dirty = !!sel && !sel.connector && (isNew || JSON.stringify(toDraft(original, draft.project)) !== JSON.stringify(draft));

  const guard = () => !dirty || confirm('Discard unsaved changes?');

  const select = (s: McpServer) => {
    if (!guard()) return;
    setSel({ key: keyOf(s) });
    setOriginal(s);
    setDraft(toDraft(s));
    setTab('form');
    setError('');
    setNotice('');
  };
  const create = () => {
    if (!guard()) return;
    setSel({});
    setOriginal(undefined);
    setDraft(toDraft(undefined, projects[0] || ''));
    setTab('form');
    setError('');
    setNotice('');
  };

  useEffect(() => {
    if (tab === 'json') setJsonText(JSON.stringify(toConfig(draft), null, 2));
  }, [tab]);

  const applyJson = (): boolean => {
    try {
      const cfg = JSON.parse(jsonText);
      if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error('Must be a JSON object');
      const d = toDraft({ name: draft.name, scope: draft.scope, project: draft.project, source: '', config: { type: cfg.type || (cfg.url ? 'http' : 'stdio'), ...cfg } });
      setDraft(d);
      return true;
    } catch (e) {
      setError(`Invalid JSON: ${(e as Error).message}`);
      return false;
    }
  };

  const save = async () => {
    setError('');
    let d = draft;
    if (tab === 'json') {
      try {
        const cfg = JSON.parse(jsonText);
        d = toDraft({ name: draft.name, scope: draft.scope, project: draft.project, source: '', config: { type: cfg.type || (cfg.url ? 'http' : 'stdio'), ...cfg } });
      } catch (e) {
        setError(`Invalid JSON: ${(e as Error).message}`);
        return;
      }
    }
    setBusy(true);
    try {
      await client.rpc('mcp.save', {
        scope: d.scope,
        project: d.scope === 'user' ? undefined : d.project,
        name: d.name.trim(),
        config: toConfig(d),
        original: original ? { scope: original.scope, project: original.project, name: original.name, config: original.config } : undefined,
      });
      const list = await client.rpc<McpServer[]>('mcp.list', { projects });
      setServers(list);
      const saved = list.find((s) => s.name === d.name.trim() && s.scope === d.scope && (d.scope === 'user' || s.project === d.project));
      if (saved) {
        setSel({ key: keyOf(saved) });
        setOriginal(saved);
        setDraft(toDraft(saved));
      }
      setNotice('Saved. Running Claude sessions pick up MCP changes after a restart (or /mcp → reconnect).');
      checkHealth();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!original || !confirm(`Remove MCP server "${original.name}" (${SCOPE_INFO[original.scope].label})?`)) return;
    setBusy(true);
    try {
      await client.rpc('mcp.remove', { scope: original.scope, project: original.project, name: original.name });
      setSel(undefined);
      setOriginal(undefined);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const approve = async (s: McpServer, approval: 'approved' | 'rejected' | 'pending') => {
    try {
      await client.rpc('mcp.approve', { project: s.project, name: s.name, approval });
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const login = async (name: string, project?: string) => {
    const s = await client.spawn({ kind: 'claude', cwd: project || home, title: `mcp login · ${name}`, args: ['mcp', 'login', name] });
    openSession(s.id);
  };

  const addProject = async () => {
    const p = await window.terminus?.pickDirectory();
    if (p) setPrefs({ agentProjects: [...new Set([...prefs.agentProjects, p])] });
  };

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  const groups: { key: string; label: string; items: McpServer[] }[] = [
    { key: 'user', label: 'User (all projects)', items: servers.filter((s) => s.scope === 'user') },
    ...[...new Set(servers.filter((s) => s.scope !== 'user').map((s) => s.project!))].map((p) => ({
      key: p,
      label: shortPath(p, home),
      items: servers.filter((s) => s.project === p),
    })),
  ];

  const selectedConnector = sel?.connector ? connectors.find((c) => c.name === sel.connector) : undefined;
  const selHealth = original ? healthFor(original.name) : undefined;

  return (
    <div className="agents">
      <aside className="agents-list">
        <div className="sl-head">
          <span>MCP servers</span>
          <div>
            <button className="icon-btn" title="Add a project folder" onClick={addProject}>
              <Icon name="folder" />
            </button>
            <button className="icon-btn" title="Add server" onClick={create}>
              <Icon name="plus" />
            </button>
          </div>
        </div>
        <div className="health-bar">
          <select value={healthProject} onChange={(e) => setHealthProject(e.target.value)} title="Status is checked from this folder (project servers depend on it)">
            <option value="">Status from ~</option>
            {projects.map((p) => (
              <option key={p} value={p}>
                Status from {shortPath(p, home)}
              </option>
            ))}
          </select>
          <button className="btn small" onClick={checkHealth} disabled={checking} title="Runs `claude mcp list`, which connects to each server">
            <span className={checking ? 'spin' : ''}>
              <Icon name="refresh" size={13} />
            </span>
            {checking ? 'Checking…' : 'Check'}
          </button>
        </div>
        <div className="sl-scroll">
          {groups.map((g) => (
            <div key={g.key} className="agent-group">
              <div className="agent-group-head">
                <span title={g.key}>{g.label}</span>
              </div>
              {g.items.length === 0 && <div className="sl-empty">No servers</div>}
              {g.items.map((s) => {
                const st = statusOf(healthFor(s.name));
                return (
                  <div key={keyOf(s)} className={`sl-item ${sel?.key === keyOf(s) ? 'selected' : ''}`} onClick={() => select(s)}>
                    <span className={`dot ${st.cls}`} title={st.label} />
                    <div className="sl-main">
                      <div className="sl-title">
                        {s.name}
                        <span className="tag">{s.config.type}</span>
                        {s.scope !== 'user' && <span className="tag">{SCOPE_INFO[s.scope].label.toLowerCase()}</span>}
                      </div>
                      <div className="sl-sub">
                        {s.approval && s.approval !== 'approved' ? `${s.approval} approval · ` : ''}
                        {s.config.type === 'stdio' ? [s.config.command, ...(s.config.args || [])].join(' ') : s.config.url}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
          <div className="agent-group">
            <div className="agent-group-head">
              <span>Connectors &amp; plugins</span>
            </div>
            {!health && <div className="sl-empty">{checking ? 'Checking…' : 'Run a status check to list them'}</div>}
            {health && connectors.length === 0 && <div className="sl-empty">None</div>}
            {connectors.map((c) => {
              const st = statusOf(c);
              return (
                <div
                  key={c.name}
                  className={`sl-item ${sel?.connector === c.name ? 'selected' : ''}`}
                  onClick={() => guard() && (setSel({ connector: c.name }), setOriginal(undefined), setError(''), setNotice(''))}
                >
                  <span className={`dot ${st.cls}`} title={st.label} />
                  <div className="sl-main">
                    <div className="sl-title">{c.name}</div>
                    <div className="sl-sub">{c.target}</div>
                  </div>
                </div>
              );
            })}
          </div>
          {healthAt && <div className="sl-empty">Status checked {ago(healthAt)}</div>}
        </div>
      </aside>

      <div className="agent-editor">
        {!sel ? (
          <div className="placeholder">
            <h2>MCP servers &amp; connectors</h2>
            <p>
              MCP servers give Claude extra tools, such as databases, issue trackers, browsers or internal APIs. Add one here, or edit and
              remove existing ones, at any of the three scopes:
            </p>
            <p className="muted">
              <b>User</b>: every project, just you. <b>Local</b>: one project, just you. <b>Project</b>: one project, shared with your
              team in <code>.mcp.json</code>, and each person approves it before it runs. Connectors from claude.ai and plugins show up too.
              Manage those on claude.ai or with <code>/plugin</code>.
            </p>
            <button className="btn primary" onClick={create}>
              Add MCP server
            </button>
          </div>
        ) : selectedConnector ? (
          <>
            <div className="editor-head">
              <div>
                <h2>{selectedConnector.name}</h2>
                <div className="muted mono">{selectedConnector.target}</div>
              </div>
              <span className={`pill ${statusOf(selectedConnector).cls}`}>
                <span className={`dot ${statusOf(selectedConnector).cls}`} />
                {statusOf(selectedConnector).label}
              </span>
            </div>
            <div className="card">
              <p>
                {selectedConnector.name.startsWith('claude.ai')
                  ? 'This connector comes from your claude.ai account. Add or remove connectors on claude.ai under Settings → Connectors. You can turn off all claude.ai connectors for Claude Code with the "disableClaudeAiConnectors" setting in Settings → Claude Code.'
                  : 'This server comes from an installed plugin or another source Terminus does not edit. Manage it with /plugin in Claude Code.'}
              </p>
              <div className="btn-row">
                <button className="btn" onClick={() => login(selectedConnector.name, healthProject || undefined)}>
                  Authenticate…
                </button>
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="editor-head">
              <div>
                <h2>{isNew ? 'New MCP server' : original?.name}</h2>
                <div className="muted">{SCOPE_INFO[draft.scope].hint}</div>
              </div>
              <div className="head-right">
                {selHealth && (
                  <span className={`pill ${statusOf(selHealth).cls}`}>
                    <span className={`dot ${statusOf(selHealth).cls}`} />
                    {statusOf(selHealth).label}
                  </span>
                )}
                <div className="seg small">
                  <button className={tab === 'form' ? 'on' : ''} onClick={() => (tab === 'json' ? applyJson() && setTab('form') : null)}>
                    Form
                  </button>
                  <button className={tab === 'json' ? 'on' : ''} onClick={() => setTab('json')}>
                    JSON
                  </button>
                </div>
              </div>
            </div>

            {original?.scope === 'project' && original.approval !== 'approved' && (
              <div className="banner warn">
                <div>
                  {original.approval === 'rejected'
                    ? 'You rejected this project server, so Claude Code will not start it.'
                    : 'This project server has not been approved yet, so Claude Code will ask before using it.'}
                </div>
                <span className="btn-row">
                  <button className="btn small primary" onClick={() => approve(original, 'approved')}>
                    Approve
                  </button>
                  {original.approval !== 'rejected' && (
                    <button className="btn small" onClick={() => approve(original, 'rejected')}>
                      Reject
                    </button>
                  )}
                </span>
              </div>
            )}
            {original?.scope === 'project' && original.approval === 'approved' && (
              <div className="muted small">
                Approved for this project.{' '}
                <button className="link" onClick={() => approve(original, 'rejected')}>
                  Reject
                </button>{' '}
                ·{' '}
                <button className="link" onClick={() => approve(original, 'pending')}>
                  Reset
                </button>
              </div>
            )}

            <div className="editor-body">
              <div className="grid3">
                <label className="field">
                  <span>Name</span>
                  <input value={draft.name} onChange={(e) => set({ name: e.target.value.replace(/[^a-zA-Z0-9_-]/g, '-') })} placeholder="github" spellCheck={false} />
                </label>
                <label className="field">
                  <span>Scope</span>
                  <select value={draft.scope} onChange={(e) => set({ scope: e.target.value as Scope })}>
                    {(Object.keys(SCOPE_INFO) as Scope[]).map((s) => (
                      <option key={s} value={s}>
                        {SCOPE_INFO[s].label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Project</span>
                  <select value={draft.project} disabled={draft.scope === 'user'} onChange={(e) => set({ project: e.target.value })}>
                    {draft.scope === 'user' && <option value="">—</option>}
                    {[...new Set([draft.project, ...projects].filter(Boolean))].map((p) => (
                      <option key={p} value={p}>
                        {shortPath(p, home)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              {tab === 'form' ? (
                <>
                  <div className="field">
                    <span>Transport</span>
                    <div className="seg small">
                      {(['stdio', 'http', 'sse'] as const).map((t) => (
                        <button key={t} className={draft.type === t ? 'on' : ''} onClick={() => set({ type: t })}>
                          {t === 'stdio' ? 'Local command (stdio)' : t === 'http' ? 'Remote (HTTP)' : 'Remote (SSE)'}
                        </button>
                      ))}
                    </div>
                  </div>
                  {draft.type === 'stdio' ? (
                    <>
                      <label className="field">
                        <span>Command</span>
                        <input value={draft.command} onChange={(e) => set({ command: e.target.value })} placeholder="npx" spellCheck={false} className="mono" />
                      </label>
                      <label className="field">
                        <span>Arguments (one per line)</span>
                        <textarea
                          className="mono"
                          rows={4}
                          value={draft.args}
                          onChange={(e) => set({ args: e.target.value })}
                          placeholder={'-y\n@modelcontextprotocol/server-github'}
                          spellCheck={false}
                        />
                      </label>
                      <div className="field">
                        <span>Environment variables</span>
                        <KVEditor rows={draft.env} onChange={(env) => set({ env })} keyPh="GITHUB_TOKEN" valPh="value" secretHint />
                      </div>
                    </>
                  ) : (
                    <>
                      <label className="field">
                        <span>URL</span>
                        <input value={draft.url} onChange={(e) => set({ url: e.target.value })} placeholder="https://mcp.example.com/mcp" spellCheck={false} className="mono" />
                      </label>
                      <div className="field">
                        <span>Headers</span>
                        <KVEditor rows={draft.headers} onChange={(headers) => set({ headers })} keyPh="Authorization" valPh="Bearer …" secretHint />
                      </div>
                      <p className="muted small">
                        For servers that sign in with OAuth, save the server and then click <b>Authenticate</b>.
                      </p>
                    </>
                  )}
                  {Object.keys(draft.extra).length > 0 && (
                    <p className="muted small">
                      Other options kept as they are: <code>{Object.keys(draft.extra).join(', ')}</code> (edit them in the JSON tab).
                    </p>
                  )}
                </>
              ) : (
                <label className="field grow">
                  <span>Server config (JSON)</span>
                  <textarea className="mono prompt" value={jsonText} onChange={(e) => setJsonText(e.target.value)} spellCheck={false} />
                </label>
              )}
            </div>

            {error && <div className="error">{error}</div>}
            {notice && !dirty && <div className="notice">{notice}</div>}
            <div className="editor-foot">
              {original && (
                <button className="btn danger" onClick={remove} disabled={busy}>
                  Remove
                </button>
              )}
              {original && draft.type !== 'stdio' && (
                <button className="btn" onClick={() => login(original.name, original.project)}>
                  Authenticate…
                </button>
              )}
              <span className="spacer" />
              {dirty && original && (
                <button className="btn ghost" onClick={() => setDraft(toDraft(original))}>
                  Revert
                </button>
              )}
              <button className="btn primary" onClick={save} disabled={busy || (!dirty && !isNew)}>
                {busy ? 'Saving…' : isNew ? 'Add server' : 'Save'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
