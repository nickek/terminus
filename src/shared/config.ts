/**
 * Terminus preferences, stored by the core in ~/.terminus/config.json.
 * This file is meant to be portable: copy it to another machine (or let the
 * bootstrap script do it) and Terminus picks it up. Unknown keys are preserved.
 */
export interface TerminusConfig {
  /** Show a popup when a subagent starts. */
  popups: boolean;
  /** Open subagents in a side panel automatically instead of asking. */
  autoOpenSubagents: boolean;
  /** Collapse the left navigation sidebar to icons. */
  railCollapsed: boolean;
  /** Width of the session list in the Terminal view (px). */
  sessionListWidth: number;
  /** 'auto' = match Windows Terminal when available, 'terminus', or a built-in scheme name (e.g. "Campbell"). */
  termScheme: string;
  /** 'auto' = Windows Terminal's font when available, else a font family name. */
  termFont: string;
  /** Default working directory for new sessions ('' = last used). */
  defaultCwd: string;
  /** Extra CLI arguments added to new claude sessions. */
  defaultArgs: string;
  /** Where a newly opened terminal goes when one is already open: a tab in the same pane, or a new pane. */
  newSessionPlacement: 'tab' | 'right' | 'below';
  /** Default for new Claude sessions: 'resume' its conversation when reopened, or start a 'new' one each time. */
  defaultResumeMode: 'resume' | 'new';
  /** Recently used working directories (most recent first). */
  recentCwds: string[];
  /** Project folders shown in Agents / Skills / MCP / Settings. */
  agentProjects: string[];
}

export const DEFAULT_CONFIG: TerminusConfig = {
  popups: true,
  autoOpenSubagents: false,
  railCollapsed: false,
  sessionListWidth: 240,
  termScheme: 'auto',
  termFont: 'auto',
  defaultCwd: '',
  defaultArgs: '',
  newSessionPlacement: 'tab',
  defaultResumeMode: 'resume',
  recentCwds: [],
  agentProjects: [],
};

/** Per-machine UI state, stored in ~/.terminus/state.json (not meant to be copied). */
export interface TerminusState {
  /** Serialized panel layout. */
  layout?: unknown;
  /** Terminal font size per session id (Ctrl + wheel zoom). */
  termZoom?: Record<string, number>;
  /** Set once old browser-storage prefs have been migrated into config.json. */
  migratedLocalStorage?: boolean;
}

/** Merge a loaded config with defaults, dropping values of the wrong type. */
export function normalizeConfig(raw: unknown): TerminusConfig & Record<string, unknown> {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: Record<string, unknown> = { ...src };
  for (const [k, def] of Object.entries(DEFAULT_CONFIG)) {
    const v = src[k];
    const ok = Array.isArray(def) ? Array.isArray(v) : typeof v === typeof def;
    out[k] = ok ? v : def;
  }
  return out as TerminusConfig & Record<string, unknown>;
}
