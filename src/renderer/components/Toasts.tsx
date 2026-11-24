import { useEffect, useState } from 'react';
import type { SubagentInfo } from '../../shared/protocol';
import { client } from '../client';
import { getPrefs } from '../store';
import { openSession, openSubagent } from '../workspace';
import { Icon } from './Icon';

interface Toast {
  id: string;
  sub: SubagentInfo;
}

const TTL = 20000;

export function Toasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    return client.onSubagentStarted((sub) => {
      const prefs = getPrefs();
      if (prefs.autoOpenSubagents) {
        openSubagent(sub, { focus: false });
        return;
      }
      if (!prefs.popups) return;
      window.terminus?.attention();
      setToasts((t) => [...t.filter((x) => x.id !== sub.id), { id: sub.id, sub }].slice(-4));
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== sub.id)), TTL);
    });
  }, []);

  const dismiss = (id: string) => setToasts((t) => t.filter((x) => x.id !== id));

  return (
    <div className="toasts">
      {toasts.map(({ id, sub }) => {
        const parent = client.getState().sessions.find((s) => s.id === sub.parentId);
        return (
          <div key={id} className="toast">
            <div className="toast-head">
              <span className="toast-icon">
                <Icon name="fork" />
              </span>
              <div className="toast-title">
                Subagent started <span className="tag">{sub.agentType}</span>
              </div>
              <button className="icon-btn" onClick={() => dismiss(id)}>
                <Icon name="close" size={14} />
              </button>
            </div>
            <div className="toast-desc">{sub.description || sub.prompt.slice(0, 160) || 'No description'}</div>
            <div className="toast-from">from {parent?.title || sub.parentId}</div>
            <div className="toast-actions">
              <button
                className="btn small primary"
                onClick={() => {
                  openSubagent(sub);
                  dismiss(id);
                }}
              >
                Open side panel
              </button>
              <button
                className="btn small"
                title="Start a separate interactive claude session with the same task"
                onClick={async () => {
                  dismiss(id);
                  const s = await client.spawn({
                    kind: 'claude',
                    cwd: sub.cwd,
                    title: `fork · ${sub.description || sub.agentType}`,
                    initialPrompt: sub.prompt || undefined,
                  });
                  openSession(s.id);
                }}
              >
                Fork interactive
              </button>
              <button className="btn small ghost" onClick={() => dismiss(id)}>
                Dismiss
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
