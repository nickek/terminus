import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SkillDefinition, SkillInfo } from '../../shared/protocol';
import { client } from '../client';
import { setPrefs, useCore, usePrefs } from '../store';
import { shortPath } from '../util';
import { Icon } from './Icon';

const EMPTY: SkillDefinition = { name: '', description: '', body: '' };
const TEMPLATE = `# Skill title

## When to use
Describe the situations this skill is for.

## Instructions
1. Step one
2. Step two
`;

function toDef(s: SkillInfo): SkillDefinition {
  return {
    name: s.name || s.folder,
    description: s.description,
    allowedTools: s.allowedTools,
    model: s.model,
    argumentHint: s.argumentHint,
    disableModelInvocation: s.disableModelInvocation,
    extraYaml: s.extraYaml,
    body: s.body,
  };
}

function fmtSize(n: number) {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

interface Sel {
  parentDir: string;
  dir?: string;
  readonly: boolean;
}

export function SkillsView() {
  const { home, sessions, connected } = useCore();
  const prefs = usePrefs();
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [userDir, setUserDir] = useState('');
  const [sel, setSel] = useState<Sel>();
  const [draft, setDraft] = useState<SkillDefinition>(EMPTY);
  const [saved, setSaved] = useState<SkillDefinition>(EMPTY);
  const [tab, setTab] = useState<'skill' | 'files' | 'raw'>('skill');
  const [advanced, setAdvanced] = useState(false);
  const [preview, setPreview] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [filter, setFilter] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({ synced: true, plugin: true });
  // supporting-file editor
  const [file, setFile] = useState<{ rel: string; content: string; original: string; binary: boolean }>();
  const [newFile, setNewFile] = useState('');

  const projects = useMemo(() => {
    const fromSessions = sessions.filter((s) => !s.external).map((s) => s.cwd);
    return [...new Set([...prefs.agentProjects, ...fromSessions])];
  }, [prefs.agentProjects, sessions]);

  const reload = useCallback(async () => {
    try {
      const r = await client.rpc<{ userDir: string; skills: SkillInfo[] }>('skills.list', { projects });
      setSkills(r.skills);
      setUserDir(r.userDir);
      return r.skills;
    } catch (e) {
      setError((e as Error).message);
      return [];
    }
  }, [projects.join('|')]);

  useEffect(() => {
    if (connected) reload();
  }, [connected, reload]);

  const current = sel?.dir ? skills.find((s) => s.dir === sel.dir) : undefined;
  const dirty = !sel?.readonly && JSON.stringify(draft) !== JSON.stringify(saved);
  const fileDirty = !!file && file.content !== file.original;

  useEffect(() => {
    if (!sel || tab !== 'raw') return;
    const t = setTimeout(() => {
      client
        .rpc<string>('skills.preview', { def: draft })
        .then(setPreview)
        .catch((e) => setPreview(`# ${e.message}`));
    }, 150);
    return () => clearTimeout(t);
  }, [draft, sel, tab]);

  const guard = () => (!dirty && !fileDirty) || confirm('Discard unsaved changes?');

  const select = (s: SkillInfo) => {
    if (!guard()) return;
    const def = toDef(s);
    setSel({ parentDir: s.parentDir, dir: s.dir, readonly: s.readonly });
    setDraft(def);
    setSaved(def);
    setFile(undefined);
    setAdvanced(!!(s.model || s.argumentHint || s.disableModelInvocation || s.extraYaml));
    setError(s.parseError ? `Could not parse SKILL.md: ${s.parseError}` : '');
    setNotice('');
    if (tab === 'files' && !s.files.length) setTab('skill');
  };

  const create = (parentDir: string) => {
    if (!guard()) return;
    setSel({ parentDir, readonly: false });
    setDraft({ ...EMPTY, body: TEMPLATE });
    setSaved(EMPTY);
    setFile(undefined);
    setTab('skill');
    setError('');
    setNotice('');
  };

  const save = async () => {
    if (!sel || sel.readonly) return;
    setError('');
    try {
      const dir = await client.rpc<string>('skills.save', { parentDir: sel.parentDir, originalDir: sel.dir, def: draft });
      setSel({ ...sel, dir });
      setSaved(draft);
      setNotice(`Saved ${shortPath(dir, home)}/SKILL.md. Use it in Claude Code as /${draft.name}, or let Claude pick it from the description.`);
      reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const remove = async () => {
    if (!sel?.dir || sel.readonly || !confirm(`Delete the skill folder ${sel.dir} and all its files?`)) return;
    try {
      await client.rpc('skills.delete', { dir: sel.dir });
      setSel(undefined);
      setDraft(EMPTY);
      setSaved(EMPTY);
      reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const copyTo = async (parentDir: string) => {
    if (!current) return;
    const name = prompt('Name for your copy', current.folder.startsWith('my-') ? current.folder : `my-${current.folder}`);
    if (!name) return;
    try {
      const dir = await client.rpc<string>('skills.copy', { fromDir: current.dir, parentDir, name });
      const list = await reload();
      const copy = list.find((s) => s.dir === dir);
      if (copy) {
        setSel({ parentDir: copy.parentDir, dir: copy.dir, readonly: false });
        setDraft(toDef(copy));
        setSaved(toDef(copy));
      }
      setNotice(`Copied to ${shortPath(dir, home)}. You can edit this copy.`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const openFile = async (rel: string) => {
    if (!sel?.dir || (fileDirty && !confirm('Discard changes to the open file?'))) return;
    try {
      const r = await client.rpc<{ content: string; binary: boolean }>('skills.readFile', { dir: sel.dir, rel });
      setFile({ rel, content: r.content, original: r.content, binary: r.binary });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const saveFile = async () => {
    if (!sel?.dir || !file) return;
    try {
      await client.rpc('skills.writeFile', { dir: sel.dir, rel: file.rel, content: file.content });
      setFile({ ...file, original: file.content });
      reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const addFile = async () => {
    const rel = newFile.trim();
    if (!sel?.dir || !rel) return;
    try {
      await client.rpc('skills.writeFile', { dir: sel.dir, rel, content: '' });
      setNewFile('');
      await reload();
      setFile({ rel, content: '', original: '', binary: false });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const deleteFile = async (rel: string) => {
    if (!sel?.dir || !confirm(`Delete ${rel}?`)) return;
    try {
      await client.rpc('skills.deleteFile', { dir: sel.dir, rel });
      if (file?.rel === rel) setFile(undefined);
      reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const addProject = async () => {
    const p = await window.terminus?.pickDirectory();
    if (p) setPrefs({ agentProjects: [...new Set([...prefs.agentProjects, p])] });
  };

  const set = (patch: Partial<SkillDefinition>) => setDraft((d) => ({ ...d, ...patch }));
  const ro = !!sel?.readonly;
  const match = (s: SkillInfo) => !filter || `${s.name} ${s.description}`.toLowerCase().includes(filter.toLowerCase());

  const groups: { key: string; label: string; parentDir?: string; items: SkillInfo[]; removable?: string; hint?: string }[] = [
    { key: 'user', label: 'User (all projects)', parentDir: userDir, items: skills.filter((s) => s.scope === 'user') },
    ...projects.map((p) => ({
      key: `p:${p}`,
      label: shortPath(p, home),
      parentDir: `${p}/.claude/skills`,
      items: skills.filter((s) => s.scope === 'project' && s.parentDir === `${p}/.claude/skills`),
      removable: prefs.agentProjects.includes(p) ? p : undefined,
    })),
    { key: 'synced', label: 'From your Claude account', items: skills.filter((s) => s.scope === 'synced'), hint: 'read-only' },
    ...[...new Set(skills.filter((s) => s.scope === 'plugin').map((s) => s.source))].map((src) => ({
      key: `plugin:${src}`,
      label: `Plugin · ${src}`,
      items: skills.filter((s) => s.scope === 'plugin' && s.source === src),
      hint: 'read-only',
    })),
  ];

  return (
    <div className="agents">
      <aside className="agents-list">
        <div className="sl-head">
          <span>Skills</span>
          <div>
            <button className="icon-btn" title="Reload" onClick={reload}>
              <Icon name="refresh" />
            </button>
            <button className="icon-btn" title="Add a project folder" onClick={addProject}>
              <Icon name="folder" />
            </button>
          </div>
        </div>
        <input className="sl-filter" placeholder="Filter skills…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <div className="sl-scroll">
          {groups.map((g) => {
            const items = g.items.filter(match);
            if (!g.parentDir && items.length === 0) return null;
            const isCollapsed = collapsed[g.key] ?? (g.key.startsWith('plugin:') && !filter);
            return (
              <div key={g.key} className="agent-group">
                <div className="agent-group-head">
                  <button className="group-toggle" onClick={() => setCollapsed({ ...collapsed, [g.key]: !isCollapsed })} title={g.parentDir || g.label}>
                    <span className="caret">{isCollapsed && !filter ? '▸' : '▾'}</span>
                    {g.label}
                    <span className="count">{items.length}</span>
                    {g.hint && <span className="ro">{g.hint}</span>}
                  </button>
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
                    {g.parentDir && (
                      <button className="icon-btn" title="New skill here" onClick={() => create(g.parentDir!)}>
                        <Icon name="plus" size={14} />
                      </button>
                    )}
                  </span>
                </div>
                {!(isCollapsed && !filter) && (
                  <>
                    {items.length === 0 && <div className="sl-empty">No skills</div>}
                    {items.map((s) => (
                      <div key={s.dir} className={`sl-item ${sel?.dir === s.dir ? 'selected' : ''}`} onClick={() => select(s)} title={s.description}>
                        <span className={`skill-glyph ${s.readonly ? 'ro' : ''}`}>
                          <Icon name="skill" size={13} />
                        </span>
                        <div className="sl-main">
                          <div className="sl-title">
                            {s.name || s.folder}
                            {s.parseError && <span className="tag err">error</span>}
                          </div>
                          <div className="sl-sub">{s.description || 'no description'}</div>
                        </div>
                      </div>
                    ))}
                  </>
                )}
              </div>
            );
          })}
        </div>
      </aside>

      <div className="agent-editor">
        {!sel ? (
          <div className="placeholder">
            <h2>Skills</h2>
            <p>
              A skill is a folder with a <code>SKILL.md</code> file: a name, a description, and markdown instructions, plus any scripts or
              reference files it needs. Claude loads a skill on its own when the description matches the task, or you can run it
              directly with <code>/skill-name</code>.
            </p>
            <p className="muted">
              Skills in <code>~/.claude/skills</code> work in every project. Skills in <code>&lt;project&gt;/.claude/skills</code> work only
              in that project. Skills synced from your Claude account or installed by plugins are read-only, but you can copy one and edit
              the copy.
            </p>
            <button className="btn primary" onClick={() => create(userDir)} disabled={!userDir}>
              New user skill
            </button>
          </div>
        ) : (
          <>
            <div className="editor-head">
              <div>
                <h2>
                  {draft.name || 'New skill'} {ro && <span className="tag">read-only</span>}
                </h2>
                <div className="muted mono">{shortPath(sel.dir || `${sel.parentDir}/${draft.name || '<name>'}`, home)}</div>
              </div>
              <div className="seg small">
                <button className={tab === 'skill' ? 'on' : ''} onClick={() => setTab('skill')}>
                  SKILL.md
                </button>
                <button className={tab === 'files' ? 'on' : ''} onClick={() => setTab('files')} disabled={!sel.dir}>
                  Files {current ? `(${current.files.length})` : ''}
                </button>
                <button className={tab === 'raw' ? 'on' : ''} onClick={() => setTab('raw')}>
                  Preview
                </button>
              </div>
            </div>

            {ro && (
              <div className="banner">
                <div>
                  {current?.scope === 'synced'
                    ? 'This skill is synced from your Claude account, so changes here would be overwritten.'
                    : `This skill comes from the ${current?.source} plugin and is managed by it.`}{' '}
                  Copy it to edit your own version.
                </div>
                <span className="btn-row">
                  <button className="btn small primary" onClick={() => copyTo(userDir)}>
                    Copy to user skills
                  </button>
                </span>
              </div>
            )}

            {tab === 'skill' && (
              <div className="editor-body">
                <div className="grid2">
                  <label className="field">
                    <span>Name (also the /command)</span>
                    <input
                      value={draft.name}
                      disabled={ro}
                      onChange={(e) => set({ name: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') })}
                      placeholder="release-notes"
                      spellCheck={false}
                    />
                  </label>
                  <label className="field">
                    <span>Allowed tools (optional, comma separated)</span>
                    <input
                      value={(draft.allowedTools || []).join(', ')}
                      disabled={ro}
                      onChange={(e) =>
                        set({
                          allowedTools: e.target.value
                            .split(/,(?![^()]*\))/)
                            .map((s) => s.trim())
                            .filter(Boolean),
                        })
                      }
                      placeholder="Read, Grep, Bash(git log:*)"
                      spellCheck={false}
                    />
                  </label>
                </div>
                <label className="field">
                  <span>Description — when should Claude use this skill?</span>
                  <textarea
                    rows={3}
                    disabled={ro}
                    value={draft.description}
                    onChange={(e) => set({ description: e.target.value })}
                    placeholder="Writes release notes from merged PRs. Use when the user asks for a changelog or release notes."
                  />
                </label>
                <label className="field grow">
                  <span>Instructions (markdown)</span>
                  <textarea className="mono prompt" readOnly={ro} value={draft.body} onChange={(e) => set({ body: e.target.value })} spellCheck={false} />
                </label>
                <button className="disclosure" onClick={() => setAdvanced(!advanced)}>
                  {advanced ? '▾' : '▸'} Advanced
                </button>
                {advanced && (
                  <div className="advanced">
                    <div className="grid2">
                      <label className="field">
                        <span>Model override</span>
                        <input value={draft.model || ''} disabled={ro} onChange={(e) => set({ model: e.target.value || undefined })} placeholder="inherit" spellCheck={false} />
                      </label>
                      <label className="field">
                        <span>Argument hint (shown after /{draft.name || 'name'})</span>
                        <input value={draft.argumentHint || ''} disabled={ro} onChange={(e) => set({ argumentHint: e.target.value || undefined })} placeholder="[version]" />
                      </label>
                    </div>
                    <label className="check">
                      <input
                        type="checkbox"
                        disabled={ro}
                        checked={!!draft.disableModelInvocation}
                        onChange={(e) => set({ disableModelInvocation: e.target.checked || undefined })}
                      />
                      Only run when I type <code>/{draft.name || 'name'}</code> (Claude won't load it on its own)
                    </label>
                    <label className="field">
                      <span>Extra frontmatter (YAML)</span>
                      <textarea
                        className="mono"
                        rows={4}
                        disabled={ro}
                        value={draft.extraYaml || ''}
                        onChange={(e) => set({ extraYaml: e.target.value })}
                        placeholder={'license: MIT'}
                        spellCheck={false}
                      />
                    </label>
                  </div>
                )}
              </div>
            )}

            {tab === 'files' && current && (
              <div className="files-pane">
                <div className="file-list">
                  {current.files.length === 0 && <div className="sl-empty">No supporting files.</div>}
                  {current.files.map((f) => (
                    <div key={f.rel} className={`sl-item ${file?.rel === f.rel ? 'selected' : ''}`} onClick={() => openFile(f.rel)}>
                      <div className="sl-main">
                        <div className="sl-title mono">{f.rel}</div>
                        <div className="sl-sub">{fmtSize(f.size)}</div>
                      </div>
                      {!ro && (
                        <div className="sl-actions" onClick={(e) => e.stopPropagation()}>
                          <button className="icon-btn danger" title="Delete file" onClick={() => deleteFile(f.rel)}>
                            <Icon name="trash" />
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                  {!ro && (
                    <div className="row new-file">
                      <input
                        placeholder="scripts/helper.py"
                        value={newFile}
                        onChange={(e) => setNewFile(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && addFile()}
                        spellCheck={false}
                      />
                      <button className="btn small" onClick={addFile}>
                        Add
                      </button>
                    </div>
                  )}
                </div>
                <div className="file-editor">
                  {file ? (
                    <>
                      <div className="file-head mono">
                        {file.rel}
                        {fileDirty && <span className="tag">modified</span>}
                        <span className="spacer" />
                        {!ro && !file.binary && (
                          <button className="btn small primary" disabled={!fileDirty} onClick={saveFile}>
                            Save file
                          </button>
                        )}
                      </div>
                      <textarea
                        className="mono file-text"
                        value={file.content}
                        readOnly={ro || file.binary}
                        onChange={(e) => setFile({ ...file, content: e.target.value })}
                        spellCheck={false}
                      />
                    </>
                  ) : (
                    <div className="tx-empty">Select a file to view or edit it.</div>
                  )}
                </div>
              </div>
            )}

            {tab === 'raw' && <pre className="raw-preview">{preview}</pre>}

            {error && <div className="error">{error}</div>}
            {notice && !dirty && <div className="notice">{notice}</div>}
            {!ro && (
              <div className="editor-foot">
                {sel.dir && (
                  <button className="btn danger" onClick={remove}>
                    Delete skill
                  </button>
                )}
                <span className="spacer" />
                {dirty && (
                  <button className="btn ghost" onClick={() => setDraft(saved)}>
                    Revert
                  </button>
                )}
                <button className="btn primary" onClick={save} disabled={!dirty && !!sel.dir}>
                  {sel.dir ? 'Save' : 'Create skill'}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
