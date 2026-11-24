import { useEffect, useState } from 'react';
import { useCore } from './store';
import { onShowTerminal } from './workspace';
import { TerminalWorkspace } from './components/TerminalWorkspace';
import { Dashboard } from './components/Dashboard';
import { AgentsView } from './components/AgentsView';
import { SettingsView } from './components/SettingsView';
import { SkillsView } from './components/SkillsView';
import { McpView } from './components/McpView';
import { getPrefs, setPrefs, usePrefs } from './store';
import { NewSessionDialog } from './components/NewSessionDialog';
import { EditSessionDialog } from './components/EditSessionDialog';
import { Toasts } from './components/Toasts';
import { Icon } from './components/Icon';
import { TitleBar } from './components/TitleBar';

type View = 'terminal' | 'dashboard' | 'agents' | 'skills' | 'mcp' | 'settings';

const NAV: { id: View; label: string; icon: string }[] = [
  { id: 'terminal', label: 'Terminal', icon: 'terminal' },
  { id: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
  { id: 'agents', label: 'Agents', icon: 'agents' },
  { id: 'skills', label: 'Skills', icon: 'skill' },
  { id: 'mcp', label: 'MCP', icon: 'plug' },
];
const VIEW_ORDER: View[] = ['terminal', 'dashboard', 'agents', 'skills', 'mcp', 'settings'];

export function App() {
  const [view, setView] = useState<View>('terminal');
  const [newOpen, setNewOpen] = useState(false);
  const [editing, setEditing] = useState<string>();
  const { sessions, connected, error, hooks } = useCore();
  const { railCollapsed } = usePrefs();

  useEffect(() => onShowTerminal(() => setView('terminal')), []);
  useEffect(() => {
    const open = () => setNewOpen(true);
    const edit = (e: Event) => setEditing((e as CustomEvent<string>).detail);
    window.addEventListener('terminus:edit-session', edit);
    const keys = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.code === 'KeyT') {
        e.preventDefault();
        setNewOpen(true);
      }
      if (e.ctrlKey && e.shiftKey && /^Digit[1-6]$/.test(e.code)) {
        e.preventDefault();
        setView(VIEW_ORDER[Number(e.code.slice(5)) - 1]);
      }
      if (e.ctrlKey && e.shiftKey && e.code === 'KeyB') {
        e.preventDefault();
        setPrefs({ railCollapsed: !getPrefs().railCollapsed });
      }
    };
    window.addEventListener('terminus:new-session', open);
    window.addEventListener('keydown', keys, true);
    return () => {
      window.removeEventListener('terminus:new-session', open);
      window.removeEventListener('terminus:edit-session', edit);
      window.removeEventListener('keydown', keys, true);
    };
  }, []);

  const attention = sessions.filter((s) => s.status === 'waiting').length;
  const failed = sessions.filter((s) => s.status === 'failed').length;

  return (
    <div className="app">
      <TitleBar view={view === 'settings' ? 'Settings' : NAV.find((n) => n.id === view)!.label} />
      <div className="body">
      <nav className={`rail ${railCollapsed ? 'collapsed' : ''}`}>
        {NAV.map((n) => (
          <button key={n.id} className={`rail-btn ${view === n.id ? 'on' : ''}`} onClick={() => setView(n.id)} title={railCollapsed ? n.label : undefined}>
            <Icon name={n.icon} size={20} />
            <span>{n.label}</span>
            {n.id === 'dashboard' && attention + failed > 0 && <i className={`rail-badge ${attention ? 'waiting' : 'failed'}`}>{attention || failed}</i>}
          </button>
        ))}
        <div className="rail-spacer" />
        <button className={`rail-btn ${view === 'settings' ? 'on' : ''}`} onClick={() => setView('settings')} title={railCollapsed ? 'Settings' : undefined}>
          <Icon name="settings" size={20} />
          <span>Settings</span>
          {hooks && !hooks.installed && <i className="rail-badge warn">!</i>}
        </button>
        <div className="rail-foot">
          <div className={`conn ${connected ? 'ok' : 'bad'}`} title={connected ? 'Connected to core' : error || 'Disconnected'} />
          {!railCollapsed && <span className="conn-label">{connected ? 'Connected' : 'Reconnecting…'}</span>}
          <button
            className="icon-btn rail-toggle"
            title={railCollapsed ? 'Expand sidebar (Ctrl+Shift+B)' : 'Collapse sidebar (Ctrl+Shift+B)'}
            onClick={() => setPrefs({ railCollapsed: !railCollapsed })}
          >
            <Icon name={railCollapsed ? 'chevronRight' : 'chevronLeft'} />
          </button>
        </div>
      </nav>
      <main className="main">
        {error && !connected && <div className="fatal">{error}</div>}
        {/* The terminal workspace stays mounted so terminals keep their state across views. */}
        <div className="view" style={{ display: view === 'terminal' ? 'flex' : 'none' }}>
          <TerminalWorkspace />
        </div>
        {view === 'dashboard' && (
          <div className="view scroll">
            <Dashboard />
          </div>
        )}
        {view === 'agents' && (
          <div className="view">
            <AgentsView />
          </div>
        )}
        {view === 'skills' && (
          <div className="view">
            <SkillsView />
          </div>
        )}
        {view === 'mcp' && (
          <div className="view">
            <McpView />
          </div>
        )}
        {view === 'settings' && (
          <div className="view">
            <SettingsView />
          </div>
        )}
      </main>
      </div>
      {newOpen && <NewSessionDialog onClose={() => setNewOpen(false)} />}
      {editing && <EditSessionDialog key={editing} sessionId={editing} onClose={() => setEditing(undefined)} />}
      <Toasts />
    </div>
  );
}
