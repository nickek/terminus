import { useState } from 'react';
import { ClaudeSettings } from './ClaudeSettings';
import { shortPath } from '../util';
import { BUILTIN_SCHEMES, TERMINUS_SCHEME, resolveTerminalLook, useWtProfile } from '../schemes';

function ConfigFileNote() {
  const { configPath, configError, home } = useCore();
  if (!configPath) return null;
  return (
    <div className="config-note">
      {configError ? (
        <div className="error">Can't read your preferences file, so the last good version is in use: {configError}</div>
      ) : (
        <div className="muted small">
          Preferences are saved to <code>{shortPath(configPath, home)}</code>. Copy that file to another machine to bring your setup along,
          or edit it by hand; changes apply right away.
        </div>
      )}
    </div>
  );
}

function TerminalLook() {
  const prefs = usePrefs();
  const wt = useWtProfile();
  const { scheme } = resolveTerminalLook(prefs.termScheme, prefs.termFont);
  const swatch = [scheme.black, scheme.red, scheme.green, scheme.yellow, scheme.blue, scheme.magenta, scheme.cyan, scheme.white];
  const bright = [scheme.brightBlack, scheme.brightRed, scheme.brightGreen, scheme.brightYellow, scheme.brightBlue, scheme.brightMagenta, scheme.brightCyan, scheme.brightWhite];
  return (
    <div className="term-look">
      <div className="grid2">
        <label className="field">
          <span>Color scheme</span>
          <select value={prefs.termScheme} onChange={(e) => setPrefs({ termScheme: e.target.value })}>
            <option value="auto">{wt ? `Match Windows Terminal (${wt.schemeName})` : 'Automatic (Terminus)'}</option>
            <option value="terminus">{TERMINUS_SCHEME.name} (glass)</option>
            {Object.keys(BUILTIN_SCHEMES).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Font</span>
          <select value={prefs.termFont} onChange={(e) => setPrefs({ termFont: e.target.value })}>
            <option value="auto">{wt ? `Match Windows Terminal (${wt.fontFace})` : 'Automatic (JetBrains Mono)'}</option>
            <option value="JetBrains Mono">JetBrains Mono (bundled)</option>
            <option value="Cascadia Mono">Cascadia Mono</option>
            <option value="Cascadia Code">Cascadia Code</option>
            <option value="Consolas">Consolas</option>
          </select>
        </label>
      </div>
      <div className="scheme-preview" style={{ background: scheme.background === 'transparent' ? 'rgba(12,13,17,0.9)' : scheme.background, color: scheme.foreground }}>
        <div className="mono">
          <span style={{ color: scheme.brightGreen, fontWeight: 700 }}>user</span>
          <span style={{ color: scheme.green, fontWeight: 700 }}>@host </span>
          <span style={{ color: scheme.brightGreen }}>~/project </span>
          <span style={{ color: scheme.green, fontWeight: 700 }}>➜&gt;</span> ls
        </div>
        <div className="swatches">
          {[swatch, bright].map((row, i) => (
            <div key={i} className="swatch-row">
              {row.map((c, j) => (
                <span key={j} style={{ background: c }} />
              ))}
            </div>
          ))}
        </div>
      </div>
      {wt && <div className="muted small">Read from {wt.settingsPath} (profile "{wt.profileName}").</div>}
    </div>
  );
}
import { client } from '../client';
import { setPrefs, setUiState, useCore, usePrefs } from '../store';
import { ago } from '../util';

export function SettingsView() {
  const { hooks, port, connected } = useCore();
  const prefs = usePrefs();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const toggleHooks = async (install: boolean) => {
    setBusy(true);
    setError('');
    try {
      await client.setHooks(install);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const [section, setSection] = useState<'claude' | 'terminus'>('claude');
  return (
    <div className="settings-shell">
      <div className="settings-tabs">
        <h1>Settings</h1>
        <div className="seg">
          <button className={section === 'claude' ? 'on' : ''} onClick={() => setSection('claude')}>
            Claude Code
          </button>
          <button className={section === 'terminus' ? 'on' : ''} onClick={() => setSection('terminus')}>
            Terminus
          </button>
        </div>
      </div>
      {section === 'claude' ? (
        <ClaudeSettings />
      ) : (
    <div className="settings-scroll">
    <div className="page narrow">
      <ConfigFileNote />

      <section className="card">
        <div className="card-head">
          <h2>Claude Code hooks</h2>
          <span className={`pill ${hooks?.installed ? 'active' : hooks?.partial ? 'waiting' : 'exited'}`}>
            {hooks?.installed ? 'Installed' : hooks?.partial ? 'Partially installed' : 'Not installed'}
          </span>
        </div>
        <p>
          Hooks let every Claude Code session report what it's doing to Terminus: status changes, permission prompts and subagent launches.
          They are added to <code>{hooks?.settingsPath || '~/.claude/settings.json'}</code> (a backup is saved next to it first). Each
          hook is a quick <code>curl</code> to <code>127.0.0.1:{hooks?.port ?? port}</code> that does nothing when Terminus isn't
          running.
        </p>
        <div className="toggle-row">
          <label className="switch">
            <input type="checkbox" checked={!!hooks?.installed} disabled={busy || !connected} onChange={(e) => toggleHooks(e.target.checked)} />
            <span />
          </label>
          <span>{hooks?.installed ? 'Hooks enabled' : 'Hooks disabled'}</span>
          {hooks?.partial && (
            <button className="btn small" onClick={() => toggleHooks(true)}>
              Repair
            </button>
          )}
        </div>
        <div className="muted small">
          Events: {hooks?.events.length ? hooks.events.join(', ') : 'none'} · last event received {ago(hooks?.lastHookAt)}
        </div>
        <div className="muted small">Sessions that are already running pick up hook changes after a restart.</div>
        {error && <div className="error">{error}</div>}
      </section>

      <section className="card">
        <h2>Subagents</h2>
        <label className="check">
          <input type="checkbox" checked={prefs.popups} onChange={(e) => setPrefs({ popups: e.target.checked })} />
          Show a popup when a subagent starts
        </label>
        <label className="check">
          <input type="checkbox" checked={prefs.autoOpenSubagents} onChange={(e) => setPrefs({ autoOpenSubagents: e.target.checked })} />
          Open subagents in a side panel automatically (without asking)
        </label>
      </section>

      <section className="card">
        <h2>Terminal</h2>
        <TerminalLook />
        <p className="muted small">Zoom a terminal with Ctrl + mouse wheel (per pane, remembered per session). Ctrl+0 resets it.</p>
        <p className="muted small">
          Shells start like your normal terminal: your <code>~/.bashrc</code> (prompt, aliases, functions) and login files load
          themselves on every machine, so nothing needs copying.
        </p>
        <label className="field">
          <span>Default working directory</span>
          <input value={prefs.defaultCwd} onChange={(e) => setPrefs({ defaultCwd: e.target.value })} placeholder="last used" />
        </label>
        <div className="field">
          <span>Open new sessions as</span>
          <div className="seg small">
            {(
              [
                ['tab', 'Tab in the current pane'],
                ['right', 'Pane to the right'],
                ['below', 'Pane below'],
              ] as const
            ).map(([v, label]) => (
              <button key={v} className={prefs.newSessionPlacement === v ? 'on' : ''} onClick={() => setPrefs({ newSessionPlacement: v })}>
                {label}
              </button>
            ))}
          </div>
          <div className="set-desc">
            Applies to new sessions, reopened sessions, duplicates and forks when a terminal is already open. The New session dialog starts
            on this choice, and you can still change it there.
          </div>
        </div>
        <label className="field">
          <span>New Claude sessions, when reopened</span>
          <select value={prefs.defaultResumeMode} onChange={(e) => setPrefs({ defaultResumeMode: e.target.value as 'resume' | 'new' })}>
            <option value="resume">Resume their conversation (default)</option>
            <option value="new">Start a new conversation each time</option>
          </select>
        </label>
        <label className="field">
          <span>Default extra claude arguments</span>
          <input value={prefs.defaultArgs} onChange={(e) => setPrefs({ defaultArgs: e.target.value })} placeholder="e.g. --permission-mode acceptEdits" />
        </label>
      </section>

      <section className="card">
        <h2>Layout</h2>
        <p className="muted">Drag tabs to split or regroup panels, drag the dividers to resize, and use the float button to detach a group.</p>
        <button
          className="btn"
          onClick={() => {
            setUiState('layout', undefined);
            setTimeout(() => location.reload(), 400);
          }}
        >
          Reset panel layout
        </button>
      </section>
    </div>
    </div>
      )}
    </div>
  );
}
