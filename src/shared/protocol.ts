// Shared types between the core service and the GUI client.

export type SessionKind = 'claude' | 'shell';
/** `closed` = shut down from the GUI; a claude session can be resumed with `claude --resume`. */
export type SessionStatus = 'starting' | 'active' | 'idle' | 'waiting' | 'exited' | 'failed' | 'closed';

export interface SessionInfo {
  id: string;
  kind: SessionKind;
  title: string;
  cwd: string;
  pid?: number;
  status: SessionStatus;
  /** True when the session was not started by Terminus (seen only through hooks). */
  external: boolean;
  exitCode?: number;
  createdAt: number;
  /** When the current process was started (differs from createdAt after a resume). */
  startedAt?: number;
  lastActivity: number;
  /** Short human description of the last hook event / notification. */
  lastEvent?: string;
  claudeSessionId?: string;
  transcriptPath?: string;
  args: string[];
  /** Whether a hook event has ever been received for this session. */
  hooked: boolean;
  subagentsRunning: number;
  subagentsTotal: number;
  /** Claude sessions: launch configuration (editable). */
  model?: string;
  extraArgs?: string[];
  /** What opening a stopped Claude session does: continue its conversation, or start a new one. */
  resumeMode?: ResumeMode;
}

export type ResumeMode = 'resume' | 'new';

/** Editable parts of a session (sessions.configure). */
export interface SessionConfigPatch {
  title?: string;
  cwd?: string;
  model?: string | null;
  extraArgs?: string[];
  resumeMode?: ResumeMode;
}

export type SubagentStatus = 'running' | 'done' | 'failed';

export interface SubagentInfo {
  id: string;
  /** Terminus session id of the parent (may be an external session id). */
  parentId: string;
  claudeSessionId: string;
  agentId?: string;
  toolUseId?: string;
  agentType: string;
  description: string;
  prompt: string;
  cwd: string;
  status: SubagentStatus;
  background: boolean;
  startedAt: number;
  endedAt?: number;
  transcriptPath?: string;
}

export interface SpawnOptions {
  kind: SessionKind;
  cwd: string;
  title?: string;
  /** Extra CLI args for claude (already split). */
  args?: string[];
  model?: string;
  initialPrompt?: string;
  continueLast?: boolean;
  resumeId?: string;
  /** Claude sessions: what reopening the session does later (default 'resume'). */
  resumeMode?: ResumeMode;
  cols?: number;
  rows?: number;
}

export type TranscriptItemKind = 'prompt' | 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'system';

export interface TranscriptItem {
  id: string;
  ts?: string;
  kind: TranscriptItemKind;
  text?: string;
  toolName?: string;
  toolUseId?: string;
  input?: unknown;
  isError?: boolean;
}

export interface HookEventSummary {
  id: number;
  ts: number;
  event: string;
  sessionId: string;
  sessionTitle: string;
  detail: string;
}

export interface HooksStatus {
  installed: boolean;
  partial: boolean;
  settingsPath: string;
  port: number;
  events: string[];
  lastHookAt?: number;
}

export type AgentScope = 'user' | 'project';

export interface AgentDefinition {
  name: string;
  description: string;
  model?: string;
  tools?: string[];
  disallowedTools?: string[];
  color?: string;
  permissionMode?: string;
  /** Unknown frontmatter keys, preserved as a YAML string. */
  extraYaml?: string;
  systemPrompt: string;
}

export interface AgentFile extends AgentDefinition {
  scope: AgentScope;
  dir: string;
  path: string;
  parseError?: string;
}

export interface SkillDefinition {
  name: string;
  description: string;
  allowedTools?: string[];
  model?: string;
  argumentHint?: string;
  disableModelInvocation?: boolean;
  /** Unknown frontmatter keys, preserved as a YAML string. */
  extraYaml?: string;
  /** Markdown instructions (SKILL.md body). */
  body: string;
}

export interface SkillInfo extends SkillDefinition {
  scope: 'user' | 'project' | 'synced' | 'plugin';
  /** Human label for where it comes from (project path, plugin name…). */
  source: string;
  readonly: boolean;
  /** The skill folder. */
  dir: string;
  parentDir: string;
  folder: string;
  /** Supporting files, relative to dir (SKILL.md excluded). */
  files: { rel: string; size: number }[];
  parseError?: string;
}

export interface McpServerConfig {
  type: 'stdio' | 'http' | 'sse' | string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  [k: string]: unknown;
}

export interface McpServer {
  name: string;
  scope: 'user' | 'local' | 'project';
  project?: string;
  source: string;
  config: McpServerConfig;
  /** Only for project (.mcp.json) servers. */
  approval?: 'approved' | 'rejected' | 'pending';
}

export interface McpHealth {
  name: string;
  target: string;
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled';
  statusText: string;
}

// ---- wire messages ----

export type ClientMessage =
  | { t: 'spawn'; reqId?: number; opts: SpawnOptions }
  | { t: 'input'; id: string; data: string }
  | { t: 'resize'; id: string; cols: number; rows: number }
  | { t: 'attach'; id: string }
  | { t: 'watch'; key: string }
  | { t: 'unwatch'; key: string }
  | { t: 'rpc'; reqId: number; method: string; params?: any };

export type ServerMessage =
  | { t: 'hello'; version: string; home: string; port: number }
  | { t: 'config'; config: Record<string, unknown>; state: Record<string, unknown>; path: string; error?: string }
  | { t: 'sessions'; sessions: SessionInfo[] }
  | { t: 'subagents'; subagents: SubagentInfo[] }
  | { t: 'subagentStarted'; subagent: SubagentInfo }
  | { t: 'event'; event: HookEventSummary }
  | { t: 'data'; id: string; data: string }
  | { t: 'scrollback'; id: string; data: string }
  | { t: 'transcript'; key: string; reset: boolean; items: TranscriptItem[]; path?: string }
  | { t: 'rpcResult'; reqId: number; result?: any; error?: string };

export const DEFAULT_PORT = 47821;
export const HOOK_MARKER = '# terminus-hook';
