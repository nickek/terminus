import type { SessionInfo } from '../shared/protocol';
import { client } from './client';
import type { MenuItem } from './components/ContextMenu';
import { closeSessionPanel, closeTerminal, isRunning, openOrResume, openSession } from './workspace';

export const editSession = (id: string) => window.dispatchEvent(new CustomEvent('terminus:edit-session', { detail: id }));

const report = (e: unknown) => alert((e as Error).message);

/** Right-click actions for a session (sidebar, dashboard). */
export function sessionMenuItems(s: SessionInfo): MenuItem[] {
  const running = isRunning(s.status);
  const claude = s.kind === 'claude';
  const items: MenuItem[] = [];
  if (running) items.push({ label: 'Show terminal', icon: 'terminal', onSelect: () => openSession(s.id) });
  else
    items.push({
      label: claude ? (s.resumeMode === 'new' ? 'Open (new conversation)' : 'Open (resume conversation)') : 'Open (new shell)',
      icon: 'terminal',
      onSelect: () => openOrResume(s.id).catch(report),
    });
  items.push({ label: 'Edit session…', icon: 'edit', onSelect: () => editSession(s.id) });
  items.push({
    label: 'Duplicate',
    icon: 'copy',
    hint: 'new session, same settings',
    onSelect: () =>
      client
        .spawn({
          kind: s.kind,
          cwd: s.cwd,
          title: `${s.title} (copy)`,
          model: s.model,
          args: s.extraArgs,
          resumeMode: s.resumeMode,
        })
        .then((n) => openSession(n.id))
        .catch(report),
  });
  if (claude) {
    items.push({
      label: s.resumeMode === 'new' ? 'Switch to: resume conversation on open' : 'Switch to: new conversation on open',
      icon: 'refresh',
      onSelect: () => client.rpc('sessions.configure', { id: s.id, patch: { resumeMode: s.resumeMode === 'new' ? 'resume' : 'new' } }).catch(report),
    });
  }
  if (running) items.push({ label: 'Restart', icon: 'refresh', hint: 'applies edited settings', onSelect: () => client.rpc('sessions.restart', { id: s.id }).catch(report) });
  if (claude && s.claudeSessionId)
    items.push({ label: 'Copy conversation ID', icon: 'copy', onSelect: () => navigator.clipboard.writeText(s.claudeSessionId!) });
  items.push({ separator: true });
  if (running) items.push({ label: 'Shut down', icon: 'stop', danger: true, onSelect: () => closeTerminal(s.id) });
  else
    items.push({
      label: 'Remove from list',
      icon: 'trash',
      danger: true,
      onSelect: () => {
        closeSessionPanel(s.id);
        client.rpc('sessions.remove', { id: s.id }).catch(report);
      },
    });
  return items;
}
