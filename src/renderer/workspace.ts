import type { DockviewApi } from 'dockview-react';
import type { SubagentInfo } from '../shared/protocol';
import { client } from './client';
import { getPrefs } from './store';

export type OpenPlacement = 'tab' | 'right' | 'below' | 'float';

let api: DockviewApi | undefined;
let showTerminalView: () => void = () => {};

export function setWorkspaceApi(a: DockviewApi | undefined) {
  api = a;
}
export function getWorkspaceApi() {
  return api;
}
export function onShowTerminal(fn: () => void) {
  showTerminalView = fn;
}

export const termPanelId = (sessionId: string) => `term-${sessionId}`;
export const subPanelId = (subId: string) => `sub-${subId}`;
export const logPanelId = (sessionId: string) => `log-${sessionId}`;

function sessionTitle(id: string) {
  return client.getState().sessions.find((s) => s.id === id)?.title || id;
}

/** Prefer a group that already holds terminals, so sessions don't land among subagent panels. */
function terminalGroup() {
  if (!api) return undefined;
  const hasTerm = (g: any) => g?.panels?.some((p: any) => p.id.startsWith('term-'));
  if (hasTerm(api.activeGroup)) return api.activeGroup;
  return api.groups.find((g) => g.api.location.type === 'grid' && hasTerm(g)) || api.activeGroup;
}

function positionFor(placement: OpenPlacement): any {
  if (!api) return {};
  const group = terminalGroup();
  if (placement === 'float') return { floating: { width: 720, height: 460 } };
  if (!group) return {};
  if (placement === 'tab') return { position: { referenceGroup: group, direction: 'within' } };
  return { position: { referenceGroup: group, direction: placement } };
}

/** Placement for new terminals from Settings (Terminus → Terminal → Open new sessions as). */
export function defaultPlacement(): OpenPlacement {
  const p = getPrefs().newSessionPlacement;
  return p === 'right' || p === 'below' ? p : 'tab';
}

export function openSession(sessionId: string, placement: OpenPlacement = defaultPlacement()) {
  if (!api) return;
  showTerminalView();
  const existing = api.getPanel(termPanelId(sessionId));
  if (existing) {
    existing.api.setActive();
    return;
  }
  api.addPanel({
    id: termPanelId(sessionId),
    component: 'terminal',
    tabComponent: 'status',
    title: sessionTitle(sessionId),
    params: { sessionId },
    renderer: 'always',
    ...positionFor(placement),
  });
}

/** Opens a subagent's live transcript next to its parent session's terminal. */
export function openSubagent(sub: SubagentInfo, opts: { focus?: boolean } = {}) {
  if (!api) return;
  if (opts.focus !== false) showTerminalView();
  const id = subPanelId(sub.id);
  const existing = api.getPanel(id);
  if (existing) {
    existing.api.setActive();
    return;
  }
  const title = `${sub.agentType}${sub.description ? ` · ${sub.description}` : ''}`;
  const base = {
    id,
    component: 'transcript',
    tabComponent: 'status',
    title,
    params: { key: `sub:${sub.id}`, subagentId: sub.id, sessionId: sub.parentId },
    renderer: 'always' as const,
    inactive: opts.focus === false,
  };
  // First subagent: a side panel to the right of its parent terminal.
  // Each additional one gets its own side panel, stacked in that right-hand column.
  const docked = api.panels.filter((p) => p.id.startsWith('sub-') && p.group.api.location.type === 'grid');
  const sameParent = docked.filter((p) => (p.params as { sessionId?: string })?.sessionId === sub.parentId);
  const ref = sameParent[sameParent.length - 1] || docked[docked.length - 1];
  if (ref) {
    api.addPanel({ ...base, position: { referencePanel: ref, direction: 'below' } });
    return;
  }
  const parent = api.getPanel(termPanelId(sub.parentId));
  if (parent) api.addPanel({ ...base, position: { referencePanel: parent, direction: 'right' } });
  else api.addPanel({ ...base, ...positionFor('right') });
}

/** Read-only live view of a session's main transcript (used for external sessions). */
export function openSessionLog(sessionId: string) {
  if (!api) return;
  showTerminalView();
  const id = logPanelId(sessionId);
  const existing = api.getPanel(id);
  if (existing) {
    existing.api.setActive();
    return;
  }
  api.addPanel({
    id,
    component: 'transcript',
    tabComponent: 'status',
    title: `log · ${sessionTitle(sessionId)}`,
    params: { key: `session:${sessionId}`, sessionId },
    renderer: 'always',
    ...positionFor('tab'),
  });
}

export function closeSessionPanel(sessionId: string) {
  api?.getPanel(termPanelId(sessionId))?.api.close();
}

const RUNNING = new Set(['starting', 'active', 'idle', 'waiting']);

/** Focus a session's terminal, resuming it first (`claude --resume`) if it was closed. */
export async function openOrResume(sessionId: string, placement: OpenPlacement = defaultPlacement()) {
  const s = client.getState().sessions.find((x) => x.id === sessionId);
  if (s && !RUNNING.has(s.status)) await client.rpc('sessions.resume', { id: sessionId });
  openSession(sessionId, placement);
}

/** Closing a terminal tab shuts its session down gracefully (it stays resumable in the sidebar). */
export function closeTerminal(sessionId: string) {
  const s = client.getState().sessions.find((x) => x.id === sessionId);
  if (s && RUNNING.has(s.status)) client.rpc('sessions.close', { id: sessionId }).catch(() => {});
  api?.getPanel(termPanelId(sessionId))?.api.close();
}

export function isRunning(status: string) {
  return RUNNING.has(status);
}
