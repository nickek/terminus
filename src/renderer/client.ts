import type {
  ClientMessage,
  HookEventSummary,
  HooksStatus,
  ServerMessage,
  SessionInfo,
  SpawnOptions,
  SubagentInfo,
  TranscriptItem,
} from '../shared/protocol';

declare global {
  interface Window {
    terminus?: {
      coreInfo(): Promise<{ core?: { port: number; token: string }; error?: string }>;
      pickDirectory(defaultPath?: string): Promise<string | undefined>;
      attention(): void;
      openExternal(url: string): void;
      clipboard?: { readText(): Promise<string>; writeText(text: string): Promise<void> };
      onCoreExit(cb: (code: number) => void): void;
      window: {
        minimize(): void;
        toggleMaximize(): void;
        close(): void;
        state(): Promise<{ maximized: boolean; focused: boolean }>;
        onState(cb: (s: { maximized: boolean; focused: boolean }) => void): void;
      };
    };
  }
}

export interface CoreState {
  connected: boolean;
  error?: string;
  home: string;
  port?: number;
  sessions: SessionInfo[];
  subagents: SubagentInfo[];
  events: HookEventSummary[];
  hooks?: HooksStatus;
  /** True once the first session snapshot has arrived after connecting. */
  ready: boolean;
  /** Contents of ~/.terminus/config.json (prefs) and state.json (layout, zoom), from the core. */
  config?: Record<string, unknown>;
  uiState?: Record<string, unknown>;
  configPath?: string;
  configError?: string;
}

type TranscriptListener = (items: TranscriptItem[], reset: boolean, path?: string) => void;

class CoreClient {
  private ws?: WebSocket;
  private state: CoreState = { connected: false, home: '', sessions: [], subagents: [], events: [], ready: false };
  private subs = new Set<() => void>();
  private reqId = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private dataListeners = new Map<string, Set<(d: string) => void>>();
  private scrollbackListeners = new Map<string, Set<(d: string) => void>>();
  private transcriptListeners = new Map<string, Set<TranscriptListener>>();
  private transcriptCache = new Map<string, { items: TranscriptItem[]; path?: string }>();
  private subagentListeners = new Set<(s: SubagentInfo) => void>();
  private url?: string;
  private retry = 0;

  async connect() {
    const info = await window.terminus?.coreInfo();
    if (!info?.core) {
      this.set({ error: info?.error || 'Terminus core is not available (are you running inside the Electron app?)' });
      return;
    }
    this.url = `ws://127.0.0.1:${info.core.port}/ws?token=${info.core.token}`;
    window.terminus?.onCoreExit((code) => this.set({ connected: false, error: `Core service exited (code ${code}). Restart Terminus.` }));
    this.open();
  }

  private open() {
    if (!this.url) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.set({ connected: true, error: undefined });
      this.refreshHooks();
      this.rpc('events.list').then((events) => this.set({ events }));
      // Re-establish transcript watches after reconnect.
      for (const key of this.transcriptListeners.keys()) this.send({ t: 'watch', key });
    };
    ws.onclose = () => {
      this.set({ connected: false });
      for (const p of this.pending.values()) p.reject(new Error('Disconnected from core'));
      this.pending.clear();
      const delay = Math.min(5000, 300 * 2 ** this.retry++);
      setTimeout(() => this.open(), delay);
    };
    ws.onmessage = (ev) => this.onMessage(JSON.parse(ev.data));
  }

  private onMessage(m: ServerMessage) {
    switch (m.t) {
      case 'hello':
        this.set({ home: m.home, port: m.port });
        break;
      case 'config':
        this.set({ config: m.config, uiState: m.state, configPath: m.path, configError: m.error });
        break;
      case 'sessions':
        this.set({ sessions: m.sessions, ready: true });
        break;
      case 'subagents':
        this.set({ subagents: m.subagents });
        break;
      case 'subagentStarted':
        for (const l of this.subagentListeners) l(m.subagent);
        break;
      case 'event': {
        const events = [...this.state.events, m.event].slice(-300);
        this.set({ events });
        if (this.state.hooks && !this.state.hooks.lastHookAt) this.set({ hooks: { ...this.state.hooks, lastHookAt: m.event.ts } });
        break;
      }
      case 'data':
        this.dataListeners.get(m.id)?.forEach((l) => l(m.data));
        break;
      case 'scrollback':
        this.scrollbackListeners.get(m.id)?.forEach((l) => l(m.data));
        break;
      case 'transcript': {
        const cache = this.transcriptCache.get(m.key) || { items: [] };
        cache.items = m.reset ? [...m.items] : [...cache.items, ...m.items];
        if (m.path) cache.path = m.path;
        this.transcriptCache.set(m.key, cache);
        this.transcriptListeners.get(m.key)?.forEach((l) => l(m.items, m.reset, m.path));
        break;
      }
      case 'rpcResult': {
        const p = this.pending.get(m.reqId);
        if (!p) break;
        this.pending.delete(m.reqId);
        if (m.error) p.reject(new Error(m.error));
        else p.resolve(m.result);
        break;
      }
    }
  }

  private set(patch: Partial<CoreState>) {
    this.state = { ...this.state, ...patch };
    this.subs.forEach((s) => s());
  }

  subscribe = (fn: () => void) => {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  };
  getState = () => this.state;

  send(msg: ClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  rpc<T = any>(method: string, params?: any): Promise<T> {
    return new Promise((resolve, reject) => {
      if (this.ws?.readyState !== WebSocket.OPEN) return reject(new Error('Not connected to core'));
      const reqId = ++this.reqId;
      this.pending.set(reqId, { resolve, reject });
      this.send({ t: 'rpc', reqId, method, params });
    });
  }

  spawn(opts: SpawnOptions): Promise<SessionInfo> {
    return new Promise((resolve, reject) => {
      if (this.ws?.readyState !== WebSocket.OPEN) return reject(new Error('Not connected to core'));
      const reqId = ++this.reqId;
      this.pending.set(reqId, { resolve, reject });
      this.send({ t: 'spawn', reqId, opts });
    });
  }

  async refreshHooks() {
    try {
      this.set({ hooks: await this.rpc<HooksStatus>('hooks.status') });
    } catch {}
  }
  async setHooks(install: boolean) {
    const hooks = await this.rpc<HooksStatus>(install ? 'hooks.install' : 'hooks.uninstall');
    this.set({ hooks });
  }

  onData(id: string, cb: (d: string) => void) {
    return addTo(this.dataListeners, id, cb);
  }
  onScrollback(id: string, cb: (d: string) => void) {
    return addTo(this.scrollbackListeners, id, cb);
  }
  onSubagentStarted(cb: (s: SubagentInfo) => void) {
    this.subagentListeners.add(cb);
    return () => {
      this.subagentListeners.delete(cb);
    };
  }

  watchTranscript(key: string, cb: TranscriptListener) {
    const first = !this.transcriptListeners.has(key);
    const off = addTo(this.transcriptListeners, key, cb);
    const cached = this.transcriptCache.get(key);
    if (cached) cb(cached.items, true, cached.path);
    if (first) this.send({ t: 'watch', key });
    return () => {
      off();
      if (!this.transcriptListeners.has(key)) {
        this.send({ t: 'unwatch', key });
        this.transcriptCache.delete(key);
      }
    };
  }
}

function addTo<T>(map: Map<string, Set<T>>, key: string, v: T) {
  let s = map.get(key);
  if (!s) map.set(key, (s = new Set()));
  s.add(v);
  return () => {
    const cur = map.get(key);
    cur?.delete(v);
    if (cur && cur.size === 0) map.delete(key);
  };
}

export const client = new CoreClient();
