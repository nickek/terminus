import { useEffect, useState } from 'react';
import { useCore } from '../store';
import { Logo } from './Logo';

/** Custom title bar for the frameless window, with macOS-style window dots. */
export function TitleBar({ view }: { view: string }) {
  const { sessions, subagents } = useCore();
  const [state, setState] = useState({ maximized: false, focused: true });
  useEffect(() => {
    window.terminus?.window.state().then(setState);
    window.terminus?.window.onState(setState);
  }, []);
  const w = window.terminus?.window;

  const active = sessions.filter((s) => s.status === 'active').length;
  const waiting = sessions.filter((s) => s.status === 'waiting').length;
  const subs = subagents.filter((s) => s.status === 'running').length;

  return (
    <header className={`titlebar ${state.focused ? '' : 'blurred'}`} onDoubleClick={() => w?.toggleMaximize()}>
      <div className="tb-brand">
        <Logo size={20} />
        <span className="tb-name">Terminus</span>
        <span className="tb-sep">/</span>
        <span className="tb-view">{view}</span>
      </div>
      <div className="tb-center">
        {active > 0 && (
          <span className="tb-chip">
            <span className="dot active" /> {active} working
          </span>
        )}
        {waiting > 0 && (
          <span className="tb-chip warn">
            <span className="dot waiting" /> {waiting} need{waiting === 1 ? 's' : ''} input
          </span>
        )}
        {subs > 0 && (
          <span className="tb-chip">
            <span className="dot sub" /> {subs} subagent{subs === 1 ? '' : 's'}
          </span>
        )}
      </div>
      <div className="traffic" onDoubleClick={(e) => e.stopPropagation()}>
        <button className="light min" title="Minimize" onClick={() => w?.minimize()}>
          <svg viewBox="0 0 10 10">
            <path d="M2 5h6" />
          </svg>
        </button>
        <button className="light max" title={state.maximized ? 'Restore' : 'Maximize'} onClick={() => w?.toggleMaximize()}>
          <svg viewBox="0 0 10 10">
            {state.maximized ? <path d="M3 7V3h4 M7 3v4H3" /> : <path d="M2.5 6.5v-4h4 M7.5 3.5v4h-4" />}
          </svg>
        </button>
        <button className="light close" title="Close" onClick={() => w?.close()}>
          <svg viewBox="0 0 10 10">
            <path d="M2.8 2.8l4.4 4.4 M7.2 2.8l-4.4 4.4" />
          </svg>
        </button>
      </div>
    </header>
  );
}
