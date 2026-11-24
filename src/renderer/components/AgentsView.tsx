import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AgentDefinition, AgentFile } from '../../shared/protocol';
import { client } from '../client';
import { setPrefs, useCore, usePrefs } from '../store';
import { shortPath } from '../util';
import { Icon } from './Icon';

const TOOLS = [
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'Bash',
  'WebFetch',
  'WebSearch',
  'NotebookEdit',
  'TodoWrite',
  'Agent',
  'Skill',
];
const MODELS = [
  { v: '', l: 'Default (inherit from session)' },
  { v: 'inherit', l: 'inherit' },
  { v: 'opus', l: 'opus' },
  { v: 'sonnet', l: 'sonnet' },
  { v: 'haiku', l: 'haiku' },
  { v: 'fable', l: 'fable' },
];
const COLORS = ['', 'red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'pink'];
const PERMISSION_MODES = ['', 'default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'];

const EMPTY: AgentDefinition = { name: '', description: '', systemPrompt: '' };

interface Selection {
  dir: string;
  originalPath?: string;
}

export function AgentsView() {
  const { home, sessions, connected } = useCore();
  const prefs = usePrefs();
  const [agents, setAgents] = useState<AgentFile[]>([]);
  const [userDir, setUserDir] = useState('');
  const [sel, setSel] = useState<Selection>();
  const [draft, setDraft] = useState<AgentDefinition>(EMPTY);
  const [saved, setSaved] = useState<AgentDefinition>(EMPTY);
  const [preview, setPreview] = useState('');
  const [tab, setTab] = useState<'form' | 'raw'>('form');
  const [advanced, setAdvanced] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [customTool, setCustomTool] = useState('');

  const projects = useMemo(() => {
    const fromSessions = sessions.filter((s) => !s.external).map((s) => s.cwd);
    return [...new Set([...prefs.agentProjects, ...fromSessions])];
  }, [prefs.agentProjects, sessions]);

  const reload = useCallback(async () => {
    try {
      const r = await client.rpc<{ userDir: string; agents: AgentFile[] }>('agents.list', { projects });
      setAgents(r.agents);
      setUserDir(r.userDir);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [projects.join('|')]);

  useEffect(() => {
    if (connected) reload();
  }, [connected, reload]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);

  // Live preview of the file that will be written.
  useEffect(() => {
    if (!sel) return;
    const t = setTimeout(() => {
      client
        .rpc<string>('agents.preview', { def: draft })
        .then((p) => setPreview(p))
        .catch((e) => setPreview(`# ${e.message}`));
    }, 200);
    return () => clearTimeout(t);
  }, [draft, sel]);

  const select = (a: AgentFile) => {
    if (dirty && !confirm('Discard unsaved changes?')) return;
    const def: AgentDefinition = {
      name: a.name,
      description: a.description,
      model: a.model,
      tools: a.tools,
      disallowedTools: a.disallowedTools,
      color: a.color,
      permissionMode: a.permissionMode,
      extraYaml: a.extraYaml,
      systemPrompt: a.systemPrompt,
    };
    setSel({ dir: a.dir, originalPath: a.path });
    setDraft(def);
    setSaved(def);
    setAdvanced(!!(a.permissionMode || a.disallowedTools?.length || a.extraYaml));
    setError(a.parseError ? `Could not parse this file: ${a.parseError}` : '');
    setNotice('');
  };

  const create = (dir: string) => {
    if (dirty && !confirm('Discard unsaved changes?')) return;
    const def = { ...EMPTY, systemPrompt: 'You are a specialist that…\n' };
    setSel({ dir });
    setDraft(def);
    setSaved(EMPTY);
    setError('');
    setNotice('');
  };

  const save = async () => {
    if (!sel) return;
    setError('');
    try {
      const path = await client.rpc<string>('agents.save', { dir: sel.dir, originalPath: sel.originalPath, def: draft });
      setSel({ dir: sel.dir, originalPath: path });
      setSaved(draft);
      setNotice(`Saved ${shortPath(path, home)}. Claude Code picks it up in new sessions (or via /agents).`);
      reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const remove = async () => {
    if (!sel?.originalPath || !confirm(`Delete ${sel.originalPath}?`)) return;
    try {
      await client.rpc('agents.delete', { path: sel.originalPath });
      setSel(undefined);
      setDraft(EMPTY);
      setSaved(EMPTY);
      reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const addProject = async () => {
    const p = await window.terminus?.pickDirectory();
    if (p) setPrefs({ agentProjects: [...new Set([...prefs.agentProjects, p])] });
  };

  const set = (patch: Partial<AgentDefinition>) => setDraft((d) => ({ ...d, ...patch }));
  const allTools = !draft.tools || draft.tools.length === 0;
  const toggleTool = (t: string) => {
    const cur = draft.tools || [];
    set({ tools: cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t] });
  };
  const extraTools = (draft.tools || []).filter((t) => !TOOLS.includes(t));

  const groups: { label: string; dir: string; items: AgentFile[]; removable?: string }[] = [
    { label: 'User (all projects)', dir: userDir, items: agents.filter((a) => a.scope === 'user') },
    ...projects.map((p) => ({
      label: shortPath(p, home),
      dir: `${p}/.claude/agents`,
      items: agents.filter((a) => a.scope === 'project' && a.dir === `${p}/.claude/agents`),
      removable: prefs.agentProjects.includes(p) ? p : undefined,
    })),
  ];

  return (
    <div className="agents">
      <aside className="agents-list">
        <div className="sl-head">
          <span>Agents</span>
          <div>
            <button className="icon-btn" title="Reload" onClick={reload}>
              <Icon name="refresh" />
            </button>
            <button className="icon-btn" title="Add a project folder" onClick={addProject}>
              <Icon name="folder" />
            </button>
          </div>
        </div>
        <div className="sl-scroll">
          {groups.map((g) => (
            <div key={g.dir} className="agent-group">
              <div className="agent-group-head">
                <span title={g.dir}>{g.label}</span>
                <span>
                  {g.removable && (
                    <button
                      className="icon-btn"
                      title="Remove project from list"
                      onClick={() => setPrefs({ agentProjects: prefs.agentProjects.filter((p) => p !== g.removable) })}
                    >
                      <Icon name="close" size={12} />
                    </button>
                  )}
                  <button className="icon-btn" title="New agent here" onClick={() => create(g.dir)} disabled={!g.dir}>
                    <Icon name="plus" size={14} />
                  </button>
                </span>
              </div>
              {g.items.length === 0 && <div className="sl-empty">No agents</div>}
              {g.items.map((a) => (
                <div
                  key={a.path}
                  className={`sl-item ${sel?.originalPath === a.path ? 'selected' : ''}`}
                  onClick={() => select(a)}
                  title={a.description}
                >
                  <span className="agent-color" style={{ background: colorVar(a.color) }} />
                  <div className="sl-main">
                    <div className="sl-title">
                      {a.name}
                      {a.parseError && <span className="tag err">error</span>}
                    </div>
                    <div className="sl-sub">{a.model || 'default model'}</div>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      </aside>

      <div className="agent-editor">
        {!sel ? (
          <div className="placeholder">
            <h2>Custom agents</h2>
            <p>
              These are Claude Code subagent definitions (<code>.claude/agents/*.md</code>). Claude delegates to them based on their
              description, or you can ask for one by name.
            </p>
            <p className="muted">
              Claude Code agents can't set sampling options like temperature, top_p or top_k. Those only exist when calling the API
              directly. You can control the model, tools, permission mode and system prompt.
            </p>
            <button className="btn primary" onClick={() => create(userDir)} disabled={!userDir}>
              New user agent
            </button>
          </div>
        ) : (
          <>
            <div className="editor-head">
              <div>
                <h2>{draft.name || 'New agent'}</h2>
                <div className="muted mono">{shortPath(sel.originalPath || `${sel.dir}/${draft.name || '<name>'}.md`, home)}</div>
              </div>
              <div className="seg small">
                <button className={tab === 'form' ? 'on' : ''} onClick={() => setTab('form')}>
                  Form
                </button>
                <button className={tab === 'raw' ? 'on' : ''} onClick={() => setTab('raw')}>
                  File preview
                </button>
              </div>
            </div>

            {tab === 'form' ? (
              <div className="editor-body">
                <div className="grid2">
                  <label className="field">
                    <span>Name</span>
                    <input
                      value={draft.name}
                      onChange={(e) => set({ name: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') })}
                      placeholder="code-reviewer"
                      spellCheck={false}
                    />
                  </label>
                  <div className="grid2">
                    <label className="field">
                      <span>Model</span>
                      <select value={MODELS.some((m) => m.v === (draft.model || '')) ? draft.model || '' : '__custom'} onChange={(e) => set({ model: e.target.value === '__custom' ? 'claude-' : e.target.value || undefined })}>
                        {MODELS.map((m) => (
                          <option key={m.v} value={m.v}>
                            {m.l}
                          </option>
                        ))}
                        <option value="__custom">Custom model ID…</option>
                      </select>
                    </label>
                    <label className="field">
                      <span>Color</span>
                      <select value={draft.color || ''} onChange={(e) => set({ color: e.target.value || undefined })}>
                        {COLORS.map((c) => (
                          <option key={c} value={c}>
                            {c || 'none'}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                </div>
                {draft.model && !MODELS.some((m) => m.v === draft.model) && (
                  <label className="field">
                    <span>Custom model ID</span>
                    <input value={draft.model} onChange={(e) => set({ model: e.target.value })} spellCheck={false} />
                  </label>
                )}
                <label className="field">
                  <span>Description — when should Claude use this agent?</span>
                  <textarea
                    rows={2}
                    value={draft.description}
                    onChange={(e) => set({ description: e.target.value })}
                    placeholder="Use proactively after code changes to review for bugs and style issues."
                  />
                </label>

                <div className="field">
                  <span>Tools</span>
                  <label className="check">
                    <input type="checkbox" checked={allTools} onChange={(e) => set({ tools: e.target.checked ? undefined : ['Read', 'Grep', 'Glob'] })} />
                    Inherit all tools from the session (including MCP tools)
                  </label>
                  {!allTools && (
                    <div className="tool-grid">
                      {TOOLS.map((t) => (
                        <label key={t} className="check">
                          <input type="checkbox" checked={draft.tools!.includes(t)} onChange={() => toggleTool(t)} /> {t}
                        </label>
                      ))}
                      {extraTools.map((t) => (
                        <label key={t} className="check">
                          <input type="checkbox" checked onChange={() => toggleTool(t)} /> <span className="mono">{t}</span>
                        </label>
                      ))}
                      <div className="row">
                        <input
                          placeholder="Other tool, e.g. mcp__github__create_issue"
                          value={customTool}
                          onChange={(e) => setCustomTool(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && customTool.trim()) {
                              e.preventDefault();
                              toggleTool(customTool.trim());
                              setCustomTool('');
                            }
                          }}
                        />
                      </div>
                    </div>
                  )}
                </div>

                <label className="field grow">
                  <span>System prompt</span>
                  <textarea className="mono prompt" value={draft.systemPrompt} onChange={(e) => set({ systemPrompt: e.target.value })} spellCheck={false} />
                </label>

                <button className="disclosure" onClick={() => setAdvanced(!advanced)}>
                  {advanced ? '▾' : '▸'} Advanced
                </button>
                {advanced && (
                  <div className="advanced">
                    <div className="grid2">
                      <label className="field">
                        <span>Permission mode</span>
                        <select value={draft.permissionMode || ''} onChange={(e) => set({ permissionMode: e.target.value || undefined })}>
                          {PERMISSION_MODES.map((m) => (
                            <option key={m} value={m}>
                              {m || 'inherit from session'}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="field">
                        <span>Disallowed tools (comma separated)</span>
                        <input
                          value={(draft.disallowedTools || []).join(', ')}
                          onChange={(e) =>
                            set({
                              disallowedTools: e.target.value
                                .split(',')
                                .map((s) => s.trim())
                                .filter(Boolean),
                            })
                          }
                          placeholder="Write, Edit"
                          spellCheck={false}
                        />
                      </label>
                    </div>
                    <label className="field">
                      <span>Extra frontmatter (YAML), e.g. skills, mcpServers, hooks, maxTurns</span>
                      <textarea
                        className="mono"
                        rows={5}
                        value={draft.extraYaml || ''}
                        onChange={(e) => set({ extraYaml: e.target.value })}
                        placeholder={'skills:\n  - my-skill\nmaxTurns: 20'}
                        spellCheck={false}
                      />
                    </label>
                    <p className="muted small">
                      Sampling options (temperature, top_p, top_k) can't be set for Claude Code agents, so they aren't offered here.
                    </p>
                  </div>
                )}
              </div>
            ) : (
              <pre className="raw-preview">{preview}</pre>
            )}

            {error && <div className="error">{error}</div>}
            {notice && !dirty && <div className="notice">{notice}</div>}
            <div className="editor-foot">
              {sel.originalPath && (
                <button className="btn danger" onClick={remove}>
                  Delete
                </button>
              )}
              <span className="spacer" />
              {dirty && (
                <button className="btn ghost" onClick={() => setDraft(saved)}>
                  Revert
                </button>
              )}
              <button className="btn primary" onClick={save} disabled={!dirty && !!sel.originalPath}>
                {sel.originalPath ? 'Save' : 'Create agent'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function colorVar(c?: string) {
  const m: Record<string, string> = {
    red: '#e06c75',
    orange: '#d19a66',
    yellow: '#e5c07b',
    green: '#98c379',
    cyan: '#56b6c2',
    blue: '#61afef',
    purple: '#c678dd',
    pink: '#f472b6',
  };
  return (c && m[c]) || '#4b5263';
}
