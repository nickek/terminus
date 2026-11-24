import { useEffect, useState } from 'react';
import type { SessionInfo, SessionStatus } from '../../shared/protocol';
import { client } from '../client';
import { useCore } from '../store';
import { STATUS_LABEL, ago, duration, shortPath } from '../util';
import { ContextMenu, type MenuState } from './ContextMenu';
import { Icon } from './Icon';
import { editSession, sessionMenuItems } from '../sessionMenu';
import { closeSessionPanel, closeTerminal, isRunning, openOrResume, openSessionLog, openSubagent } from '../workspace';

const TILES: { key: SessionStatus | 'subagents'; label: string; hint: string }[] = [
  { key: 'active', label: 'Active', hint: 'Working on a turn' },
  { key: 'waiting', label: 'Needs input', hint: 'Waiting on a permission or question' },
  { key: 'idle', label: 'Idle', hint: 'Alive, waiting for a prompt' },
  { key: 'failed', label: 'Failed', hint: 'Exited with a non-zero code' },
  { key: 'closed', label: 'Closed', hint: 'Shut down from Terminus — click a row to resume' },
  { key: 'exited', label: 'Exited', hint: 'Ended normally' },
  { key: 'subagents', label: 'Subagents running', hint: 'Across all sessions' },
];

export function Dashboard() {
  const { sessions, subagents, events, hooks, home, connected } = useCore();
  const [, tick] = useState(0);
  const [showExternal, setShowExternal] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [menu, setMenu] = useState<MenuState>();

  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 5000);
    return () => clearInterval(t);
  }, []);

  const pool = sessions.filter((s) => showExternal || !s.external);
  const count = (k: string) =>
    k === 'subagents' ? subagents.filter((s) => s.status === 'running').length : pool.filter((s) => s.status === k).length;
  const rows = pool
    .filter((s) => !statusFilter || s.status === statusFilter)
    .sort((a, b) => order(a) - order(b) || b.lastActivity - a.lastActivity);

  return (
    <div className="page">
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(undefined)} />}
      <div className="page-head">
        <h1>Dashboard</h1>
        <div className="page-actions">
          <label className="check">
            <input type="checkbox" checked={showExternal} onChange={(e) => setShowExternal(e.target.checked)} /> Include other Claude
            sessions
          </label>
          <button className="btn" onClick={() => client.rpc('sessions.removeFinished')}>
            Clear ended sessions
          </button>
          <button className="btn primary" onClick={() => window.dispatchEvent(new CustomEvent('terminus:new-session'))}>
            New session
          </button>
        </div>
      </div>

      {!connected && <div className="banner warn">Not connected to the core service — reconnecting…</div>}
      {hooks && !hooks.installed && (
        <div className="banner">
          <div>
            <b>Hooks are not installed.</b> Without them, status comes only from terminal output, and subagent popups won't fire.
          </div>
          <button className="btn primary" onClick={() => client.setHooks(true)}>
            Install hooks
          </button>
        </div>
      )}

      <div className="tiles">
        {TILES.map((t) => (
          <button
            key={t.key}
            className={`tile tile-${t.key} ${statusFilter === t.key ? 'on' : ''}`}
            title={t.hint}
            onClick={() => t.key !== 'subagents' && setStatusFilter(statusFilter === t.key ? '' : t.key)}
          >
            <div className="tile-num">{count(t.key)}</div>
            <div className="tile-label">
              {t.key !== 'subagents' && <span className={`dot ${t.key}`} />}
              {t.label}
            </div>
          </button>
        ))}
      </div>

      <section className="card">
        <div className="card-head">
          <h2>Sessions {statusFilter && <span className="muted">· {STATUS_LABEL[statusFilter as SessionStatus]}</span>}</h2>
          <span className="muted">{rows.length} shown</span>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Status</th>
              <th>Session</th>
              <th>Directory</th>
              <th>Uptime</th>
              <th>Last activity</th>
              <th>Subagents</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="empty">
                  No sessions{statusFilter ? ' with this status' : ''}.
                </td>
              </tr>
            )}
            {rows.map((s) => (
              <tr
                key={s.id}
                className="clickable"
                onClick={() => (s.external ? openSessionLog(s.id) : openOrResume(s.id).catch((e) => alert(e.message)))}
                onContextMenu={(e) => {
                  if (s.external) return;
                  e.preventDefault();
                  setMenu({ x: e.clientX, y: e.clientY, items: sessionMenuItems(s) });
                }}
              >
                <td>
                  <span className={`pill ${s.status}`}>
                    <span className={`dot ${s.status}`} />
                    {STATUS_LABEL[s.status]}
                  </span>
                </td>
                <td>
                  <div className="cell-title">
                    {s.title}
                    {s.external && <span className="tag">external</span>}
                    {s.kind === 'shell' && <span className="tag">shell</span>}
                  </div>
                  <div className="cell-sub" title={s.lastEvent}>
                    {s.lastEvent || (s.hooked || s.kind === 'shell' ? '' : 'no hook events yet')}
                  </div>
                </td>
                <td className="mono">{shortPath(s.cwd, home)}</td>
                <td>{isRunning(s.status) ? duration(s.startedAt || s.createdAt) : '—'}</td>
                <td>{ago(s.lastActivity)}</td>
                <td>{s.subagentsTotal ? `${s.subagentsRunning} running / ${s.subagentsTotal}` : '—'}</td>
                <td className="row-actions" onClick={(e) => e.stopPropagation()}>
                  <RowActions s={s} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <div className="two-col">
        <section className="card">
          <div className="card-head">
            <h2>Subagents</h2>
            <button className="btn small ghost" onClick={() => client.rpc('subagents.clearFinished')}>
              Clear finished
            </button>
          </div>
          <div className="list">
            {subagents.length === 0 && <div className="empty">No subagents seen yet.</div>}
            {subagents.slice(0, 50).map((a) => {
              const parent = sessions.find((s) => s.id === a.parentId);
              return (
                <div key={a.id} className="list-row clickable" onClick={() => openSubagent(a)} title={a.prompt}>
                  <span className={`badge sub-${a.status}`}>{a.status}</span>
                  <div className="list-main">
                    <div className="cell-title">
                      {a.description || '(no description)'} <span className="tag">{a.agentType}</span>
                    </div>
                    <div className="cell-sub">
                      {parent?.title || a.parentId} · {ago(a.startedAt)} · {duration(a.startedAt, a.endedAt)}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
        <section className="card">
          <div className="card-head">
            <h2>Activity</h2>
            <span className="muted">{hooks?.lastHookAt ? `last hook ${ago(hooks.lastHookAt)}` : 'no hook events yet'}</span>
          </div>
          <div className="list feed">
            {events.length === 0 && <div className="empty">Hook events will appear here.</div>}
            {[...events]
              .reverse()
              .slice(0, 120)
              .map((e) => (
                <div key={e.id} className="feed-row">
                  <span className="feed-time">{new Date(e.ts).toLocaleTimeString()}</span>
                  <span className={`feed-ev ev-${e.event.split(' ')[0]}`}>{e.event}</span>
                  <span className="feed-session">{e.sessionTitle}</span>
                  <span className="feed-detail">{e.detail}</span>
                </div>
              ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function order(s: SessionInfo) {
  return { waiting: 0, active: 1, starting: 2, idle: 3, failed: 4, closed: 5, exited: 6 }[s.status];
}

function RowActions({ s }: { s: SessionInfo }) {
  const ended = !isRunning(s.status);
  if (s.external) {
    return (
      <button className="btn small ghost" onClick={() => openSessionLog(s.id)}>
        View log
      </button>
    );
  }
  const edit = (
    <button className="icon-btn" title="Edit session" onClick={() => editSession(s.id)}>
      <Icon name="edit" size={14} />
    </button>
  );
  return ended ? (
    <span className="btn-row">
      {edit}
      {s.kind === 'claude' && (
        <button className="btn small" onClick={() => openOrResume(s.id).catch((e) => alert(e.message))}>
          Resume
        </button>
      )}
      <button
        className="btn small ghost"
        onClick={() => {
          closeSessionPanel(s.id);
          client.rpc('sessions.remove', { id: s.id });
        }}
      >
        Remove
      </button>
    </span>
  ) : (
    <span className="btn-row">
      {edit}
      <button className="btn small danger" onClick={() => closeTerminal(s.id)}>
        Shut down
      </button>
    </span>
  );
}
