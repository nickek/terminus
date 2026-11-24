import { useEffect, useState } from 'react';
import type { SessionKind } from '../../shared/protocol';
import { client } from '../client';
import { rememberCwd, useCore, usePrefs } from '../store';
import { shortPath, splitArgs } from '../util';
import { defaultPlacement, openSession, type OpenPlacement } from '../workspace';
import { Icon } from './Icon';
import { ResumeModeToggle } from './EditSessionDialog';
import type { ResumeMode } from '../../shared/protocol';

const MODELS = ['', 'opus', 'sonnet', 'haiku', 'fable'];

export function NewSessionDialog({ onClose }: { onClose: () => void }) {
  const { home } = useCore();
  const prefs = usePrefs();
  const [kind, setKind] = useState<SessionKind>('claude');
  const [cwd, setCwd] = useState(prefs.defaultCwd || prefs.recentCwds[0] || home);
  const [title, setTitle] = useState('');
  const [model, setModel] = useState('');
  const [args, setArgs] = useState(prefs.defaultArgs);
  const [prompt, setPrompt] = useState('');
  const [mode, setMode] = useState<'new' | 'continue'>('new');
  const [resumeMode, setResumeMode] = useState<ResumeMode>(prefs.defaultResumeMode || 'resume');
  // Starts on the preference from Settings; can be overridden for this one session.
  const [placement, setPlacement] = useState<OpenPlacement>(defaultPlacement());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);

  const browse = async () => {
    const p = await window.terminus?.pickDirectory(cwd);
    if (p) setCwd(p);
  };

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setError('');
    setBusy(true);
    try {
      const dir = cwd.trim() || home;
      const s = await client.spawn({
        kind,
        cwd: dir,
        title: title.trim() || undefined,
        model: kind === 'claude' && model ? model : undefined,
        args: kind === 'claude' ? splitArgs(args) : undefined,
        initialPrompt: kind === 'claude' && prompt.trim() ? prompt.trim() : undefined,
        continueLast: kind === 'claude' && mode === 'continue',
        resumeMode: kind === 'claude' ? resumeMode : undefined,
      });
      rememberCwd(dir.replace(/^~/, home));
      openSession(s.id, placement);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal" onSubmit={submit}>
        <div className="modal-head">
          <h2>New session</h2>
          <button type="button" className="icon-btn" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>

        <div className="seg">
          <button type="button" className={kind === 'claude' ? 'on' : ''} onClick={() => setKind('claude')}>
            Claude Code
          </button>
          <button type="button" className={kind === 'shell' ? 'on' : ''} onClick={() => setKind('shell')}>
            Shell
          </button>
        </div>

        <label className="field">
          <span>Working directory</span>
          <div className="row">
            <input value={cwd} onChange={(e) => setCwd(e.target.value)} autoFocus spellCheck={false} />
            <button type="button" className="btn" onClick={browse}>
              <Icon name="folder" /> Browse
            </button>
          </div>
          {prefs.recentCwds.length > 0 && (
            <div className="chips">
              {prefs.recentCwds.slice(0, 8).map((c) => (
                <button type="button" key={c} className={`chip ${c === cwd ? 'on' : ''}`} onClick={() => setCwd(c)}>
                  {shortPath(c, home)}
                </button>
              ))}
            </div>
          )}
        </label>

        <label className="field">
          <span>Title (optional)</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. api refactor" />
        </label>

        {kind === 'claude' && (
          <>
            <div className="grid2">
              <label className="field">
                <span>Model</span>
                <select value={model} onChange={(e) => setModel(e.target.value)}>
                  {MODELS.map((m) => (
                    <option key={m} value={m}>
                      {m || 'default (from settings)'}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Conversation</span>
                <select value={mode} onChange={(e) => setMode(e.target.value as 'new' | 'continue')}>
                  <option value="new">Start fresh</option>
                  <option value="continue">Continue most recent in this folder</option>
                </select>
              </label>
            </div>
            <label className="field">
              <span>Extra CLI arguments</span>
              <input
                value={args}
                onChange={(e) => setArgs(e.target.value)}
                placeholder='e.g. --permission-mode plan --agent code-reviewer'
                spellCheck={false}
              />
            </label>
            <ResumeModeToggle value={resumeMode} onChange={setResumeMode} />
            <label className="field">
              <span>Initial prompt (optional)</span>
              <textarea rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Sent as the first message" />
            </label>
          </>
        )}

        <label className="field">
          <span>Open as</span>
          <div className="seg small">
            {(['tab', 'right', 'below', 'float'] as OpenPlacement[]).map((p) => (
              <button type="button" key={p} className={placement === p ? 'on' : ''} onClick={() => setPlacement(p)}>
                {p === 'tab' ? 'Tab' : p === 'right' ? 'Split right' : p === 'below' ? 'Split down' : 'Floating'}
              </button>
            ))}
          </div>
        </label>

        {error && <div className="error">{error}</div>}
        <div className="modal-foot">
          <span className="hint">Closing a tab shuts the session down; resume it any time from the sidebar.</span>
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? 'Starting…' : 'Start session'}
          </button>
        </div>
      </form>
    </div>
  );
}
