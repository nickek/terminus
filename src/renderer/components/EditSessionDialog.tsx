import { useEffect, useState } from 'react';
import type { ResumeMode, SessionInfo } from '../../shared/protocol';
import { client } from '../client';
import { useCore, usePrefs } from '../store';
import { shortPath, splitArgs } from '../util';
import { isRunning } from '../workspace';
import { Icon } from './Icon';

const MODELS = ['', 'opus', 'sonnet', 'haiku', 'fable'];

/** Quote args back into one editable string (inverse of splitArgs for common cases). */
function joinArgs(args: string[]): string {
  return args.map((a) => (a === '' || /[\s"'\\]/.test(a) ? `"${a.replace(/(["\\])/g, '\\$1')}"` : a)).join(' ');
}

export function ResumeModeToggle({ value, onChange }: { value: ResumeMode; onChange: (v: ResumeMode) => void }) {
  return (
    <div className="field">
      <span>When this session is opened again</span>
      <div className="seg small">
        <button type="button" className={value === 'resume' ? 'on' : ''} onClick={() => onChange('resume')}>
          Resume its conversation
        </button>
        <button type="button" className={value === 'new' ? 'on' : ''} onClick={() => onChange('new')}>
          Start a new conversation
        </button>
      </div>
      <div className="set-desc">
        {value === 'resume'
          ? 'Reopening runs claude --resume, so Claude continues where it left off.'
          : 'Each time it is opened, Claude starts a clean conversation with the same folder, model and arguments.'}
      </div>
    </div>
  );
}

export function EditSessionDialog({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const { sessions, home } = useCore();
  const prefs = usePrefs();
  const session = sessions.find((s) => s.id === sessionId);
  const [initial, setInitial] = useState<SessionInfo | undefined>(session);
  const [title, setTitle] = useState(initial?.title || '');
  const [cwd, setCwd] = useState(initial?.cwd || '');
  const [model, setModel] = useState(initial?.model || '');
  const [args, setArgs] = useState(joinArgs(initial?.extraArgs || []));
  const [resumeMode, setResumeMode] = useState<ResumeMode>(initial?.resumeMode || 'resume');

  // Opened before the session reached this window's list (e.g. right after creating it): fill in once it arrives.
  useEffect(() => {
    if (initial || !session) return;
    setInitial(session);
    setTitle(session.title);
    setCwd(session.cwd);
    setModel(session.model || '');
    setArgs(joinArgs(session.extraArgs || []));
    setResumeMode(session.resumeMode || 'resume');
  }, [session, initial]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);

  if (!session || !initial) {
    return null;
  }
  const claude = session.kind === 'claude';
  const running = isRunning(session.status);
  const launchChanged =
    cwd.trim() !== initial.cwd || (claude && (model !== (initial.model || '') || args.trim() !== joinArgs(initial.extraArgs || []).trim()));
  const changed = launchChanged || title.trim() !== initial.title || (claude && resumeMode !== (initial.resumeMode || 'resume'));
  const cwdChangedClaude = claude && cwd.trim() !== initial.cwd;

  const save = async (restart: boolean) => {
    setError('');
    setBusy(true);
    try {
      await client.rpc('sessions.configure', {
        id: sessionId,
        patch: {
          title: title.trim(),
          cwd: cwd.trim().replace(/^~/, home),
          ...(claude ? { model: model || null, extraArgs: splitArgs(args), resumeMode } : {}),
        },
      });
      if (restart) await client.rpc('sessions.restart', { id: sessionId });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const preview = claude ? ['claude', ...(model ? ['--model', model] : []), ...splitArgs(args), resumeMode === 'resume' ? '--resume <conversation>' : '--session-id <new>'].join(' ') : '';

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="modal"
        onSubmit={(e) => {
          e.preventDefault();
          save(false);
        }}
      >
        <div className="modal-head">
          <div>
            <h2>Edit session</h2>
            <div className="muted small">
              {claude ? 'Claude Code' : 'Shell'} · {running ? 'running' : session.status}
              {claude && session.claudeSessionId && <span className="mono"> · conversation {session.claudeSessionId.slice(0, 8)}</span>}
            </div>
          </div>
          <button type="button" className="icon-btn" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>

        <label className="field">
          <span>Title</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        </label>

        <label className="field">
          <span>Working directory</span>
          <div className="row">
            <input value={cwd} onChange={(e) => setCwd(e.target.value)} spellCheck={false} className="mono" />
            <button
              type="button"
              className="btn"
              onClick={async () => {
                const p = await window.terminus?.pickDirectory(cwd);
                if (p) setCwd(p);
              }}
            >
              <Icon name="folder" /> Browse
            </button>
          </div>
          {prefs.recentCwds.length > 0 && (
            <div className="chips">
              {prefs.recentCwds.slice(0, 6).map((c) => (
                <button type="button" key={c} className={`chip ${c === cwd ? 'on' : ''}`} onClick={() => setCwd(c)}>
                  {shortPath(c, home)}
                </button>
              ))}
            </div>
          )}
          {cwdChangedClaude && resumeMode === 'resume' && (
            <div className="set-desc warn-text">Claude keeps conversations per folder, so after moving folders the next open starts a new conversation.</div>
          )}
        </label>

        {claude && (
          <>
            <div className="grid2">
              <label className="field">
                <span>Model</span>
                <select value={MODELS.includes(model) ? model : '__custom'} onChange={(e) => setModel(e.target.value === '__custom' ? model || 'claude-' : e.target.value)}>
                  {MODELS.map((m) => (
                    <option key={m} value={m}>
                      {m || 'default (from settings)'}
                    </option>
                  ))}
                  <option value="__custom">Custom model ID…</option>
                </select>
              </label>
              {!MODELS.includes(model) ? (
                <label className="field">
                  <span>Custom model ID</span>
                  <input value={model} onChange={(e) => setModel(e.target.value)} spellCheck={false} className="mono" />
                </label>
              ) : (
                <div />
              )}
            </div>
            <label className="field">
              <span>Extra CLI arguments</span>
              <input
                value={args}
                onChange={(e) => setArgs(e.target.value)}
                placeholder="e.g. --permission-mode plan --agent code-reviewer"
                spellCheck={false}
                className="mono"
              />
            </label>
            <ResumeModeToggle value={resumeMode} onChange={setResumeMode} />
            <div className="cmd-preview mono" title="What runs the next time this session starts">
              {preview}
            </div>
          </>
        )}

        {error && <div className="error">{error}</div>}
        <div className="modal-foot">
          <span className="hint">
            {running && launchChanged ? 'Folder, model and argument changes apply when the session restarts.' : running ? '' : 'Changes apply the next time you open it.'}
          </span>
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          {running && launchChanged ? (
            <>
              <button type="button" className="btn" disabled={busy} onClick={() => save(false)}>
                Save
              </button>
              <button type="button" className="btn primary" disabled={busy} onClick={() => save(true)}>
                Save &amp; restart
              </button>
            </>
          ) : (
            <button type="submit" className="btn primary" disabled={busy || !changed}>
              Save
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
