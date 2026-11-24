import { useCallback, useEffect, useMemo, useState } from 'react';
import schemaJson from '../data/claude-settings.schema.json';
import { client } from '../client';
import { useCore, usePrefs } from '../store';
import { shortPath } from '../util';
import { Icon } from './Icon';

/*
 * Settings editor generated from the official Claude Code settings JSON schema
 * (bundled snapshot from schemastore.org). Every key gets a control matching its
 * type; anything complex falls back to an inline JSON editor, and the whole file
 * can always be edited as raw JSON.
 */

type Schema = Record<string, any>;
const ROOT = schemaJson as Schema;
const PROPS: Record<string, Schema> = ROOT.properties || {};

type Scope = 'user' | 'project' | 'local' | 'managed';
interface SettingsFile {
  scope: Scope;
  path: string;
  exists: boolean;
  readonly: boolean;
  mtimeMs?: number;
  data: Record<string, unknown>;
  raw: string;
  error?: string;
}

const SCOPES: { id: Scope; label: string; hint: string }[] = [
  { id: 'user', label: 'User', hint: 'Applies to all your projects' },
  { id: 'project', label: 'Project', hint: 'Shared with your team (commit it)' },
  { id: 'local', label: 'Project · local', hint: 'Just you, in this project (git-ignored)' },
  { id: 'managed', label: 'Managed', hint: 'Set by your organization (read-only)' },
];

const CATEGORIES: { id: string; label: string; match: RegExp }[] = [
  { id: 'model', label: 'Model & reasoning', match: /^(model|availableModels|modelOverrides|effortLevel|fastMode.*|alwaysThinkingEnabled|fallbackModel|advisorModel|agent|outputStyle|language|teammateDefaultModel|showThinkingSummaries)$/ },
  { id: 'permissions', label: 'Permissions & safety', match: /^(permissions|sandbox|disableAutoMode|useAutoModeDuringPlan|autoMode|skipDangerousModePermissionPrompt|permissionExplainerEnabled|askUserQuestionTimeout|disableSkillShellExecution)$/ },
  { id: 'env', label: 'Environment & auth', match: /^(env|apiKeyHelper|aws.*|gcp.*|otelHeadersHelper|forceLogin.*|processWrapper)$/ },
  { id: 'mcp', label: 'MCP, plugins & skills', match: /(Mcp|mcp|Plugin|plugin|Marketplace|marketplace|skill|Skill|ClaudeAiConnectors)/ },
  { id: 'hooks', label: 'Hooks & status line', match: /^(hooks|disableAllHooks|statusLine|subagentStatusLine|httpHook.*|allowedHttpHookUrls|fileSuggestion)$/ },
  { id: 'memory', label: 'Memory, context & files', match: /^(autoMemory.*|claudeMdExcludes|cleanupPeriodDays|plansDirectory|respectGitignore|fileCheckpointingEnabled|autoCompactEnabled|includeGitInstructions)$/ },
  { id: 'git', label: 'Git & attribution', match: /^(attribution|includeCoAuthoredBy|prUrlTemplate|worktree)$/ },
  { id: 'ui', label: 'Interface', match: /^(theme|tui|viewMode|editorMode|spinner.*|showTurnDuration|prefersReducedMotion|terminalProgressBarEnabled|syntaxHighlightingDisabled|verbose|axScreenReader|vimInsertModeRemaps|emojiCompletionEnabled|wheelScrollAccelerationEnabled|autoScrollEnabled|footerLinksRegexes|showClearContextOnPlanAccept|awaySummaryEnabled|preferredNotifChannel|diffTool|externalEditorContext|companyAnnouncements|defaultShell|respondToBashCommands)$/ },
  { id: 'updates', label: 'Updates & IDE', match: /^(autoUpdatesChannel|minimumVersion|autoConnectIde|autoInstallIdeExtension)$/ },
];

const isManagedOnly = (s: Schema) => /^\((Managed|Admin|Windows managed)[^)]*\)/i.test(s?.description || '') || /^\(Managed settings/i.test(s?.description || '');

function categoryOf(key: string, s: Schema): string {
  if (isManagedOnly(s)) return 'managed';
  return CATEGORIES.find((c) => c.match.test(key))?.id || 'other';
}

function resolve(s: Schema | undefined): Schema {
  if (s && s.$ref && typeof s.$ref === 'string' && s.$ref.startsWith('#/$defs/')) return resolve(ROOT.$defs?.[s.$ref.slice(8)]);
  return s || {};
}

function typeOf(s: Schema): string {
  s = resolve(s);
  if (Array.isArray(s.type)) return s.type.find((t: string) => t !== 'null') || 'string';
  if (s.type) return s.type;
  if (s.enum) return 'string';
  if (s.const !== undefined) return typeof s.const;
  const alts = s.anyOf || s.oneOf;
  if (alts?.every((a: Schema) => typeOf(a) === 'string')) return 'string';
  return 'json';
}

function enumOf(s: Schema): string[] | undefined {
  s = resolve(s);
  if (s.enum) return s.enum.map(String);
  const alts = s.anyOf || s.oneOf;
  if (alts) {
    const vals = alts.flatMap((a: Schema) => resolve(a).enum || []);
    if (vals.length) return vals.map(String);
  }
  return undefined;
}

function Desc({ text }: { text?: string }) {
  if (!text) return null;
  const clean = text.replace(/\s*See https?:\/\/\S+/g, '').replace(/https?:\/\/[^\s)]+/g, 'the docs').trim();
  const link = /https?:\/\/[^\s)]+/.exec(text)?.[0];
  return (
    <div className="set-desc">
      {clean}
      {link && (
        <>
          {' '}
          <button className="link" onClick={() => window.terminus?.openExternal(link)}>
            docs ↗
          </button>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- field editors

function TriBool({ value, onChange, disabled }: { value: unknown; onChange: (v: unknown) => void; disabled?: boolean }) {
  const v = value === true ? 'on' : value === false ? 'off' : 'default';
  return (
    <div className="seg small">
      {(['default', 'on', 'off'] as const).map((o) => (
        <button key={o} disabled={disabled} className={v === o ? 'on' : ''} onClick={() => onChange(o === 'default' ? undefined : o === 'on')}>
          {o === 'default' ? 'Default' : o === 'on' ? 'On' : 'Off'}
        </button>
      ))}
    </div>
  );
}

function StringList({ value, onChange, disabled, placeholder }: { value: unknown; onChange: (v: unknown) => void; disabled?: boolean; placeholder?: string }) {
  const list = Array.isArray(value) ? value.map(String) : [];
  const [add, setAdd] = useState('');
  const push = () => {
    const v = add.trim();
    if (!v) return;
    onChange([...list, v]);
    setAdd('');
  };
  return (
    <div className="str-list">
      {list.map((item, i) => (
        <div className="str-item" key={i}>
          <input
            className="mono"
            value={item}
            disabled={disabled}
            onChange={(e) => onChange(list.map((x, j) => (j === i ? e.target.value : x)))}
            spellCheck={false}
          />
          {!disabled && (
            <button className="icon-btn danger" onClick={() => onChange(list.length > 1 ? list.filter((_, j) => j !== i) : undefined)} title="Remove">
              <Icon name="close" size={13} />
            </button>
          )}
        </div>
      ))}
      {!disabled && (
        <div className="str-item">
          <input
            className="mono"
            value={add}
            placeholder={placeholder || 'Add…'}
            onChange={(e) => setAdd(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && push()}
            onBlur={push}
            spellCheck={false}
          />
        </div>
      )}
    </div>
  );
}

function KVObject({ value, onChange, disabled, suggestions }: { value: unknown; onChange: (v: unknown) => void; disabled?: boolean; suggestions: Record<string, Schema> }) {
  const obj = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const entries = Object.entries(obj);
  const [k, setK] = useState('');
  const [v, setV] = useState('');
  const listId = useMemo(() => `kv-${Math.random().toString(36).slice(2)}`, []);
  const commit = (next: Record<string, unknown>) => onChange(Object.keys(next).length ? next : undefined);
  return (
    <div className="kv">
      <datalist id={listId}>
        {Object.entries(suggestions).map(([name, s]) => (
          <option key={name} value={name}>
            {(s.description || '').slice(0, 90)}
          </option>
        ))}
      </datalist>
      {entries.map(([key, val]) => (
        <div className="kv-row" key={key}>
          <input className="mono" value={key} disabled title={suggestions[key]?.description} />
          <input
            className="mono"
            value={String(val ?? '')}
            disabled={disabled}
            type={/key|token|secret|password/i.test(key) ? 'password' : 'text'}
            onChange={(e) => commit({ ...obj, [key]: e.target.value })}
            spellCheck={false}
          />
          {!disabled && (
            <button
              className="icon-btn danger"
              onClick={() => {
                const next = { ...obj };
                delete next[key];
                commit(next);
              }}
            >
              <Icon name="close" size={13} />
            </button>
          )}
        </div>
      ))}
      {!disabled && (
        <div className="kv-row">
          <input className="mono" list={listId} value={k} placeholder="NAME" onChange={(e) => setK(e.target.value)} spellCheck={false} />
          <input
            className="mono"
            value={v}
            placeholder="value"
            onChange={(e) => setV(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && k.trim()) {
                commit({ ...obj, [k.trim()]: v });
                setK('');
                setV('');
              }
            }}
            spellCheck={false}
          />
          <button
            className="btn small"
            disabled={!k.trim()}
            onClick={() => {
              commit({ ...obj, [k.trim()]: v });
              setK('');
              setV('');
            }}
          >
            Add
          </button>
        </div>
      )}
      {k && suggestions[k] && <div className="set-desc">{suggestions[k].description}</div>}
    </div>
  );
}

function JsonField({ value, onChange, disabled }: { value: unknown; onChange: (v: unknown) => void; disabled?: boolean }) {
  const [text, setText] = useState(value === undefined ? '' : JSON.stringify(value, null, 2));
  const [err, setErr] = useState('');
  useEffect(() => {
    // Re-sync when the value changes from outside (e.g. reload).
    const cur = value === undefined ? '' : JSON.stringify(value, null, 2);
    try {
      if (text.trim() === '' ? value !== undefined : JSON.stringify(JSON.parse(text), null, 2) !== cur) setText(cur);
    } catch {
      /* user is mid-edit with invalid JSON; leave it */
    }
  }, [value]);
  return (
    <div>
      <textarea
        className="mono json-field"
        rows={Math.min(14, Math.max(3, text.split('\n').length))}
        value={text}
        disabled={disabled}
        placeholder="(not set) — JSON value"
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value);
          if (!e.target.value.trim()) {
            setErr('');
            onChange(undefined);
            return;
          }
          try {
            onChange(JSON.parse(e.target.value));
            setErr('');
          } catch (er) {
            setErr((er as Error).message);
          }
        }}
      />
      {err && <div className="field-err">{err}</div>}
    </div>
  );
}

function FieldControl({ schema, value, onChange, disabled, depth }: { schema: Schema; value: unknown; onChange: (v: unknown) => void; disabled?: boolean; depth: number }) {
  const s = resolve(schema);
  const t = typeOf(s);
  const en = enumOf(s);
  if (t === 'boolean') return <TriBool value={value} onChange={onChange} disabled={disabled} />;
  if (t === 'string' && en) {
    const custom = value !== undefined && !en.includes(String(value));
    return (
      <select value={value === undefined ? '' : String(value)} disabled={disabled} onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}>
        <option value="">Default</option>
        {custom && <option value={String(value)}>{String(value)}</option>}
        {en.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  }
  if (t === 'string')
    return (
      <input
        value={value === undefined ? '' : String(value)}
        disabled={disabled}
        placeholder={s.default !== undefined ? `Default: ${s.default}` : 'Not set'}
        onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
        spellCheck={false}
      />
    );
  if (t === 'integer' || t === 'number')
    return (
      <input
        type="number"
        className="num"
        value={value === undefined ? '' : String(value)}
        disabled={disabled}
        min={s.minimum}
        max={s.maximum}
        step={t === 'integer' ? 1 : 'any'}
        placeholder={s.default !== undefined ? String(s.default) : 'Not set'}
        onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
      />
    );
  if (t === 'array' && ['string'].includes(typeOf(s.items || {})))
    return <StringList value={value} onChange={onChange} disabled={disabled} placeholder={s.examples?.[0]?.[0]} />;
  if (t === 'object' && s.properties && depth < 1) {
    const props = s.properties as Record<string, Schema>;
    const many = Object.keys(props).length > 12 && s.additionalProperties !== false;
    if (many) return <KVObject value={value} onChange={onChange} disabled={disabled} suggestions={props} />;
    const obj = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
    return (
      <div className="nested">
        {Object.entries(props).map(([k, ps]) => (
          <div className="nested-row" key={k}>
            <div className="nested-label">
              <span className="mono">{k}</span>
              <Desc text={resolve(ps).description} />
            </div>
            <FieldControl
              schema={ps}
              value={obj[k]}
              depth={depth + 1}
              disabled={disabled}
              onChange={(v) => {
                const next = { ...obj };
                if (v === undefined) delete next[k];
                else next[k] = v;
                onChange(Object.keys(next).length ? next : undefined);
              }}
            />
          </div>
        ))}
      </div>
    );
  }
  if (t === 'object' && s.additionalProperties && typeof s.additionalProperties === 'object' && typeOf(s.additionalProperties) === 'string' && !s.properties)
    return <KVObject value={value} onChange={onChange} disabled={disabled} suggestions={{}} />;
  return <JsonField value={value} onChange={onChange} disabled={disabled} />;
}

// ---------------------------------------------------------------- main view

export function ClaudeSettings() {
  const { sessions, home, connected } = useCore();
  const prefs = usePrefs();
  const projects = useMemo(() => {
    const fromSessions = sessions.filter((s) => !s.external).map((s) => s.cwd);
    return [...new Set([...prefs.agentProjects, ...fromSessions])];
  }, [prefs.agentProjects, sessions]);

  const [scope, setScope] = useState<Scope>('user');
  const [project, setProject] = useState('');
  const [files, setFiles] = useState<SettingsFile[]>([]);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [raw, setRaw] = useState('');
  const [mode, setMode] = useState<'form' | 'json'>('form');
  const [query, setQuery] = useState('');
  const [onlySet, setOnlySet] = useState(false);
  const [showManaged, setShowManaged] = useState(false);
  const [cat, setCat] = useState('all');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!project && projects.length) setProject(projects[0]);
  }, [projects.join('|')]);

  const needsProject = scope === 'project' || scope === 'local';
  const file = files.find((f) => f.scope === scope);
  const readonly = !!file?.readonly;

  const load = useCallback(async () => {
    setError('');
    try {
      const all = await client.rpc<SettingsFile[]>('settings.readAll', { project: project || undefined });
      setFiles(all);
      const f = all.find((x) => x.scope === scope);
      setDraft(structuredClone(f?.data || {}));
      setRaw(f?.raw || '{}\n');
      if (f?.error) setError(`This file isn't valid JSON (${f.error}). Fix it in the JSON view.`);
      if (f?.error) setMode('json');
    } catch (e) {
      setError((e as Error).message);
    }
  }, [scope, project]);

  useEffect(() => {
    if (connected && (!needsProject || project)) load();
  }, [connected, load]);

  const original = file?.data || {};
  const dirty = mode === 'form' ? JSON.stringify(draft) !== JSON.stringify(original) : raw !== (file?.raw || '{}\n');

  const setKey = (k: string, v: unknown) =>
    setDraft((d) => {
      const n = { ...d };
      if (v === undefined) delete n[k];
      else n[k] = v;
      return n;
    });

  const switchMode = (m: 'form' | 'json') => {
    if (m === mode) return;
    if (m === 'json') setRaw(JSON.stringify(draft, null, 2) + '\n');
    else {
      try {
        const parsed = JSON.parse(raw || '{}');
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Top level must be an object');
        setDraft(parsed);
      } catch (e) {
        setError(`Fix the JSON before switching back: ${(e as Error).message}`);
        return;
      }
    }
    setError('');
    setMode(m);
  };

  const save = async () => {
    setError('');
    let data: unknown = draft;
    if (mode === 'json') {
      try {
        data = JSON.parse(raw || '{}');
      } catch (e) {
        setError(`Invalid JSON: ${(e as Error).message}`);
        return;
      }
    }
    setBusy(true);
    try {
      await client.rpc('settings.write', { scope, project: needsProject ? project : undefined, data, expectedMtimeMs: file?.exists ? file.mtimeMs : undefined });
      await load();
      setNotice('Saved. New Claude Code sessions use it right away. Most settings also apply to running sessions; some need a restart.');
      client.refreshHooks();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const otherScopesFor = (key: string) => files.filter((f) => f.scope !== scope && f.data && key in f.data).map((f) => SCOPES.find((s) => s.id === f.scope)!.label);

  const allKeys = useMemo(() => {
    const keys = Object.keys(PROPS).filter((k) => k !== '$schema');
    // Keys present in the file but not in the schema (newer/older Claude versions).
    for (const k of Object.keys(draft)) if (!PROPS[k] && !keys.includes(k)) keys.push(k);
    return keys;
  }, [draft]);

  const q = query.trim().toLowerCase();
  const visible = allKeys.filter((k) => {
    const s = PROPS[k] || {};
    const c = PROPS[k] ? categoryOf(k, s) : 'other';
    if (c === 'managed' && !showManaged && !(k in draft)) return false;
    if (cat !== 'all' && c !== cat) return false;
    if (onlySet && !(k in draft)) return false;
    if (q && !`${k} ${s.description || ''}`.toLowerCase().includes(q)) return false;
    return true;
  });
  const cats = [...CATEGORIES, { id: 'other', label: 'Other', match: /$^/ }, ...(showManaged ? [{ id: 'managed', label: 'Managed / enterprise', match: /$^/ }] : [])];
  const countIn = (id: string) => allKeys.filter((k) => (PROPS[k] ? categoryOf(k, PROPS[k]) : 'other') === id && k in draft).length;

  return (
    <div className="cc-settings">
      <div className="cc-top">
        <div className="seg">
          {SCOPES.map((s) => (
            <button
              key={s.id}
              className={scope === s.id ? 'on' : ''}
              title={s.hint}
              onClick={() => {
                if (dirty && !confirm('Discard unsaved changes?')) return;
                setScope(s.id);
                setNotice('');
              }}
            >
              {s.label}
            </button>
          ))}
        </div>
        {needsProject && (
          <select
            className="cc-project"
            value={project}
            onChange={(e) => {
              if (dirty && !confirm('Discard unsaved changes?')) return;
              setProject(e.target.value);
            }}
          >
            {projects.length === 0 && <option value="">No projects yet</option>}
            {projects.map((p) => (
              <option key={p} value={p}>
                {shortPath(p, home)}
              </option>
            ))}
          </select>
        )}
        <span className="spacer" />
        <div className="seg small">
          <button className={mode === 'form' ? 'on' : ''} onClick={() => switchMode('form')}>
            Form
          </button>
          <button className={mode === 'json' ? 'on' : ''} onClick={() => switchMode('json')}>
            JSON
          </button>
        </div>
      </div>
      <div className="cc-file mono">
        {file ? shortPath(file.path, home) : '…'} {file && !file.exists && <span className="tag">will be created</span>}
        {readonly && <span className="tag">read-only</span>}
        <span className="muted"> · precedence: managed › local › project › user</span>
      </div>

      {mode === 'form' ? (
        <div className="cc-body">
          <nav className="cc-cats">
            <input className="sl-filter" placeholder="Search settings…" value={query} onChange={(e) => setQuery(e.target.value)} />
            <button className={`cc-cat ${cat === 'all' ? 'on' : ''}`} onClick={() => setCat('all')}>
              All settings <span className="count">{Object.keys(draft).length || ''}</span>
            </button>
            {cats.map((c) => (
              <button key={c.id} className={`cc-cat ${cat === c.id ? 'on' : ''}`} onClick={() => setCat(c.id)}>
                {c.label} <span className="count">{countIn(c.id) || ''}</span>
              </button>
            ))}
            <label className="check small">
              <input type="checkbox" checked={onlySet} onChange={(e) => setOnlySet(e.target.checked)} /> Only show what's set
            </label>
            <label className="check small">
              <input type="checkbox" checked={showManaged} onChange={(e) => setShowManaged(e.target.checked)} /> Show enterprise-only
            </label>
          </nav>
          <div className="cc-list">
            {visible.length === 0 && <div className="empty">No settings match.</div>}
            {visible.map((k) => {
              const s = PROPS[k] || {};
              const set = k in draft;
              const others = otherScopesFor(k);
              return (
                <div key={k} className={`set-row ${set ? 'is-set' : ''}`}>
                  <div className="set-head">
                    <span className="set-key mono">{k}</span>
                    {set && <span className="tag set-tag">set</span>}
                    {!PROPS[k] && <span className="tag">not in schema</span>}
                    {others.length > 0 && <span className="tag" title="This key is also set in another settings file">also in {others.join(', ')}</span>}
                    {String(s.description || '').startsWith('DEPRECATED') && <span className="tag err">deprecated</span>}
                    <span className="spacer" />
                    {set && !readonly && (
                      <button className="link small" onClick={() => setKey(k, undefined)}>
                        Reset
                      </button>
                    )}
                  </div>
                  <Desc text={s.description} />
                  <div className="set-control">
                    <FieldControl schema={s} value={draft[k]} onChange={(v) => setKey(k, v)} disabled={readonly} depth={0} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <textarea className="mono cc-raw" value={raw} readOnly={readonly} onChange={(e) => setRaw(e.target.value)} spellCheck={false} />
      )}

      {error && <div className="error">{error}</div>}
      {notice && !dirty && <div className="notice">{notice}</div>}
      {!readonly && (
        <div className="editor-foot">
          <span className="hint">A backup of the previous version is kept next to the file (the last 5 saves).</span>
          {dirty && (
            <button className="btn ghost" onClick={load}>
              Discard changes
            </button>
          )}
          <button className="btn primary" onClick={save} disabled={!dirty || busy || (needsProject && !project)}>
            {busy ? 'Saving…' : 'Save settings'}
          </button>
        </div>
      )}
    </div>
  );
}
