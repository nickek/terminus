import { useEffect, useRef, useState } from 'react';
import {
  DockviewReact,
  themeDark,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewHeaderActionsProps,
  type IDockviewPanelHeaderProps,
  type IWatermarkPanelProps,
} from 'dockview-react';
import 'dockview-react/dist/styles/dockview.css';
import { client } from '../client';
const useCoreSnapshot = () => client.getState();
import { getUiState, setPrefs, setUiState, useConfigLoaded, useCore, usePrefs } from '../store';
import { TerminalPanel } from './TerminalPanel';
import { TranscriptPanel } from './TranscriptPanel';
import { closeSessionPanel, closeTerminal, isRunning, openOrResume, openSessionLog, openSubagent, setWorkspaceApi, termPanelId } from '../workspace';
import { STATUS_LABEL, ago, shortPath } from '../util';
import type { SessionInfo } from '../../shared/protocol';
import { Icon } from './Icon';
import { ContextMenu, type MenuState } from './ContextMenu';
import { sessionMenuItems } from '../sessionMenu';


const theme = { ...themeDark, name: 'terminus', className: 'dockview-theme-dark terminus-dv', gap: 8 };

function StatusTab(props: IDockviewPanelHeaderProps<{ sessionId?: string; subagentId?: string }>) {
  const { sessions, subagents } = useCore();
  const [title, setTitle] = useState(props.api.title);
  useEffect(() => {
    const d = props.api.onDidTitleChange((e) => setTitle(e.title));
    return () => d.dispose();
  }, [props.api]);
  let dot = 'idle';
  if (props.params.subagentId) {
    const s = subagents.find((x) => x.id === props.params.subagentId);
    dot = s ? (s.status === 'running' ? 'active' : s.status === 'failed' ? 'failed' : 'exited') : 'exited';
  } else if (props.params.sessionId) {
    dot = sessions.find((x) => x.id === props.params.sessionId)?.status || 'exited';
  }
  return (
    <div
      className="tab"
      onMouseDown={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          closePanel(props);
        }
      }}
    >
      {props.params.subagentId && (
        <span className="tab-kind">
          <Icon name="fork" size={12} />
        </span>
      )}
      <span className={`dot ${dot}`} />
      <span className="tab-title">{title}</span>
      <button
        className="tab-close"
        title={props.params.subagentId || props.api.id.startsWith('log-') ? 'Close panel' : 'Close and shut down session (resume it from the sidebar)'}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          closePanel(props);
        }}
      >
        <Icon name="close" size={11} />
      </button>
    </div>
  );
}

function closePanel(props: IDockviewPanelHeaderProps<{ sessionId?: string; subagentId?: string }>) {
  const sid = props.params.sessionId;
  if (sid && !props.params.subagentId && props.api.id === termPanelId(sid)) {
    const s = useCoreSnapshot().sessions.find((x) => x.id === sid);
    if (s && (s.status === 'active' || s.status === 'waiting') && !confirm(`"${s.title}" is still working. Close and shut it down?`)) return;
    closeTerminal(sid);
    return;
  }
  props.api.close();
}

function HeaderActions(props: IDockviewHeaderActionsProps) {
  const floating = props.location?.type === 'floating';
  const [max, setMax] = useState(props.api.isMaximized());
  useEffect(() => {
    const d = props.containerApi.onDidMaximizedGroupChange?.(() => setMax(props.api.isMaximized()));
    return () => d?.dispose();
  }, [props.api, props.containerApi]);
  return (
    <div className="group-actions">
      {!floating && (
        <button
          title={max ? 'Restore' : 'Maximize'}
          onClick={() => {
            if (props.api.isMaximized()) props.api.exitMaximized();
            else props.api.maximize();
            setMax(props.api.isMaximized());
          }}
        >
          <Icon name={max ? 'minimize' : 'maximize'} />
        </button>
      )}
      <button
        title={floating ? 'Dock back into the grid' : 'Float this group'}
        onClick={() => {
          if (floating) props.api.moveTo({ position: 'right' });
          else props.containerApi.addFloatingGroup(props.group, { width: 760, height: 480, x: 80, y: 60 });
        }}
      >
        <Icon name={floating ? 'dock' : 'float'} />
      </button>
    </div>
  );
}

function Watermark(_: IWatermarkPanelProps) {
  return (
    <div className="watermark">
      <div className="wm-title">No panels open</div>
      <div className="wm-sub">Start a session, or pick one from the list on the left.</div>
      <button className="btn primary" onClick={() => window.dispatchEvent(new CustomEvent('terminus:new-session'))}>
        New session
      </button>
    </div>
  );
}

function SessionRow({ s, open, onMenu }: { s: SessionInfo; open: boolean; onMenu: (e: React.MouseEvent, s: SessionInfo) => void }) {
  const running = isRunning(s.status);
  const [busy, setBusy] = useState(false);
  const activate = async () => {
    setBusy(true);
    try {
      await openOrResume(s.id);
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className={`sl-item ${running ? '' : 'stopped'} ${busy ? 'busy' : ''}`}
      onClick={activate}
      onContextMenu={(e) => onMenu(e, s)}
      title={`${s.cwd}\n${running ? s.lastEvent || '' : s.kind === 'claude' ? 'Click to resume (claude --resume)' : 'Click to start a new shell here'}`}
    >
      <span className={`dot ${s.status}`} />
      <div className="sl-main">
        <div className="sl-title">{s.title}</div>
        <div className="sl-sub">
          {busy ? 'Resuming…' : running ? STATUS_LABEL[s.status] : `${STATUS_LABEL[s.status]} · ${ago(s.lastActivity)}`}
          {s.subagentsRunning > 0 && <span className="sl-subs"> · {s.subagentsRunning} subagent{s.subagentsRunning > 1 ? 's' : ''}</span>}
          {running && !open && <span> · hidden</span>}
        </div>
      </div>
      <div className="sl-actions" onClick={(e) => e.stopPropagation()}>
        {running ? (
          <button className="icon-btn danger" title="Shut down session" onClick={() => closeTerminal(s.id)}>
            <Icon name="stop" />
          </button>
        ) : (
          <button
            className="icon-btn"
            title="Remove from list"
            onClick={() => {
              closeSessionPanel(s.id);
              client.rpc('sessions.remove', { id: s.id });
            }}
          >
            <Icon name="trash" />
          </button>
        )}
      </div>
    </div>
  );
}

const components = { terminal: TerminalPanel, transcript: TranscriptPanel };
const tabComponents = { status: StatusTab };

export function TerminalWorkspace() {
  const { sessions, subagents, ready, home } = useCore();
  const prefs = usePrefs();
  const apiRef = useRef<DockviewApi>(undefined);
  const restoredRef = useRef(false);
  const configLoaded = useConfigLoaded();
  const [, force] = useState(0);
  const [filter, setFilter] = useState('');
  const [menu, setMenu] = useState<MenuState>();
  const openMenu = (e: React.MouseEvent, s: SessionInfo) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, items: sessionMenuItems(s) });
  };

  const onReady = (e: DockviewReadyEvent) => {
    apiRef.current = e.api;
    setWorkspaceApi(e.api);
    let t: number | undefined;
    e.api.onDidLayoutChange(() => {
      if (!restoredRef.current) return;
      clearTimeout(t);
      t = window.setTimeout(() => {
        setUiState('layout', e.api.toJSON());
      }, 400);
    });
    e.api.onDidAddPanel(() => force((n) => n + 1));
    e.api.onDidRemovePanel(() => force((n) => n + 1));
    force((n) => n + 1);
  };

  // Restore the saved layout once we know which sessions still exist.
  useEffect(() => {
    const api = apiRef.current;
    if (!api || !ready || !configLoaded || restoredRef.current) return;
    restoredRef.current = true;
    try {
      const saved = getUiState<any>('layout');
      if (saved) {
        api.fromJSON(saved);
        const live = new Set(client.getState().sessions.filter((s) => isRunning(s.status)).map((s) => s.id));
        const subs = new Set(client.getState().subagents.map((s) => s.id));
        for (const p of [...api.panels]) {
          const params = (p.params || {}) as { sessionId?: string; subagentId?: string };
          const gone = params.subagentId ? !subs.has(params.subagentId) : params.sessionId ? !live.has(params.sessionId) : true;
          if (gone) p.api.close();
        }
      }
    } catch {
      api.clear();
    }
  }, [ready, configLoaded, apiRef.current]);

  // Keep panel titles in sync with session titles.
  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    for (const s of sessions) {
      const p = api.getPanel(termPanelId(s.id));
      if (p && p.title !== s.title) p.api.setTitle(s.title);
    }
  }, [sessions]);

  const api = apiRef.current;
  const shown = sessions.filter(
    (s) => !filter || s.title.toLowerCase().includes(filter.toLowerCase()) || s.cwd.toLowerCase().includes(filter.toLowerCase()),
  );
  const own = shown.filter((s) => !s.external);
  const liveOwn = own.filter((s) => isRunning(s.status));
  const closedOwn = own.filter((s) => !isRunning(s.status)).sort((a, b) => b.lastActivity - a.lastActivity);
  const ext = shown.filter((s) => s.external && s.status !== 'exited');
  const running = subagents.filter((s) => s.status === 'running');

  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = prefs.sessionListWidth;
    const move = (ev: MouseEvent) => setPrefs({ sessionListWidth: Math.max(160, Math.min(520, startW + ev.clientX - startX)) });
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.classList.remove('resizing');
    };
    document.body.classList.add('resizing');
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  return (
    <div className="workspace">
      <aside className="session-list" style={{ width: prefs.sessionListWidth }}>
        <div className="sl-head">
          <span>Sessions</span>
          <button className="icon-btn" title="New session (Ctrl+Shift+T)" onClick={() => window.dispatchEvent(new CustomEvent('terminus:new-session'))}>
            <Icon name="plus" />
          </button>
        </div>
        <input className="sl-filter" placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <div className="sl-scroll">
          {own.length === 0 && <div className="sl-empty">No sessions yet.</div>}
          {liveOwn.map((s) => (
            <SessionRow key={s.id} s={s} open={!!api?.getPanel(termPanelId(s.id))} onMenu={openMenu} />
          ))}
          {closedOwn.length > 0 && <div className="sl-section">Closed · click to resume</div>}
          {closedOwn.map((s) => (
            <SessionRow key={s.id} s={s} open={false} onMenu={openMenu} />
          ))}
          {running.length > 0 && <div className="sl-section">Running subagents</div>}
          {running.map((a) => (
            <div key={a.id} className="sl-item sub" onClick={() => openSubagent(a)} title={a.prompt}>
              <span className="dot active" />
              <div className="sl-main">
                <div className="sl-title">{a.description || a.agentType}</div>
                <div className="sl-sub">
                  {a.agentType} · {ago(a.startedAt)}
                </div>
              </div>
            </div>
          ))}
          {ext.length > 0 && <div className="sl-section">Other Claude sessions</div>}
          {ext.map((s) => (
            <div key={s.id} className="sl-item" onClick={() => openSessionLog(s.id)} title={`${s.cwd}\nOpens a read-only live transcript`}>
              <span className={`dot ${s.status}`} />
              <div className="sl-main">
                <div className="sl-title">{shortPath(s.cwd, home) || s.title}</div>
                <div className="sl-sub">
                  {STATUS_LABEL[s.status]} · {ago(s.lastActivity)}
                </div>
              </div>
            </div>
          ))}
        </div>
      </aside>
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(undefined)} />}
      <div className="splitter" onMouseDown={startDrag} />
      <div className="dock-host">
        <DockviewReact
          theme={theme}
          components={components}
          tabComponents={tabComponents}
          rightHeaderActionsComponent={HeaderActions}
          watermarkComponent={Watermark}
          onReady={onReady}
          floatingGroupBounds="boundedWithinViewport"
        />
      </div>
    </div>
  );
}
