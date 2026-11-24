import { useSyncExternalStore } from 'react';
import { client, type CoreState } from './client';
import { DEFAULT_CONFIG, type TerminusConfig } from '../shared/config';

export function useCore(): CoreState {
  return useSyncExternalStore(client.subscribe, client.getState);
}

// ---- preferences: live in ~/.terminus/config.json, owned by the core ----

export type Prefs = TerminusConfig;

let prefs: Prefs = { ...DEFAULT_CONFIG };
let pendingConfig: Record<string, unknown> = {};
let pendingState: Record<string, unknown> = {};
let uiState: Record<string, unknown> = {};
let configLoaded = false;
const prefSubs = new Set<() => void>();
const notify = () => prefSubs.forEach((s) => s());

// Follow config broadcasts from the core (including hand edits to config.json).
let lastConfigObj: unknown;
let wasConnected = false;
client.subscribe(() => {
  const st = client.getState();
  if (st.config && st.config !== lastConfigObj) {
    lastConfigObj = st.config;
    // Local edits that haven't reached the core yet win over the broadcast.
    prefs = { ...DEFAULT_CONFIG, ...(st.config as Partial<Prefs>), ...(pendingConfig as Partial<Prefs>) };
    if (!configLoaded) {
      uiState = { ...(st.uiState || {}), ...pendingState };
      configLoaded = true;
      migrateLocalStorage();
    }
    notify();
  }
  if (st.connected && !wasConnected) flush();
  wasConnected = st.connected;
});

function flush() {
  if (!client.getState().connected) return;
  if (Object.keys(pendingConfig).length) {
    const patch = pendingConfig;
    pendingConfig = {};
    client.rpc('config.patch', patch).catch(() => (pendingConfig = { ...patch, ...pendingConfig }));
  }
  if (Object.keys(pendingState).length) {
    const patch = pendingState;
    pendingState = {};
    client.rpc('state.patch', patch).catch(() => (pendingState = { ...patch, ...pendingState }));
  }
}

export function getPrefs() {
  return prefs;
}

export function setPrefs(patch: Partial<Prefs>) {
  prefs = { ...prefs, ...patch };
  pendingConfig = { ...pendingConfig, ...patch };
  notify();
  flush();
}

export function rememberCwd(cwd: string) {
  const recentCwds = [cwd, ...prefs.recentCwds.filter((c) => c !== cwd)].slice(0, 12);
  setPrefs({ recentCwds });
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(
    (fn) => {
      prefSubs.add(fn);
      return () => prefSubs.delete(fn);
    },
    () => prefs,
  );
}

/** True once the core has sent config.json/state.json (layout restore waits for it). */
export function useConfigLoaded() {
  return useSyncExternalStore(
    (fn) => {
      prefSubs.add(fn);
      return () => prefSubs.delete(fn);
    },
    () => configLoaded,
  );
}

// ---- per-machine UI state (~/.terminus/state.json) ----

export function getUiState<T = unknown>(key: string): T | undefined {
  return uiState[key] as T | undefined;
}

export function setUiState(key: string, value: unknown) {
  if (value === undefined) delete uiState[key];
  else uiState[key] = value;
  pendingState = { ...pendingState, [key]: value ?? null };
  flush();
}

// ---- per-terminal zoom (Ctrl + mouse wheel), kept in state.json ----

export const DEFAULT_FONT_SIZE = 13;

export function getTermFontSize(sessionId: string): number {
  return (getUiState<Record<string, number>>('termZoom') || {})[sessionId] || DEFAULT_FONT_SIZE;
}

export function setTermFontSize(sessionId: string, size: number) {
  const zoom = { ...(getUiState<Record<string, number>>('termZoom') || {}) };
  if (size === DEFAULT_FONT_SIZE) delete zoom[sessionId];
  else zoom[sessionId] = size;
  setUiState('termZoom', zoom);
}

// ---- one-time migration from the old browser-storage prefs ----

function migrateLocalStorage() {
  if (uiState.migratedLocalStorage) return;
  try {
    const old = JSON.parse(localStorage.getItem('terminus.prefs') || 'null');
    if (old && typeof old === 'object') {
      const patch: Record<string, unknown> = {};
      for (const k of Object.keys(DEFAULT_CONFIG)) if (k in old) patch[k] = old[k];
      setPrefs(patch as Partial<Prefs>);
    }
    const zoom = JSON.parse(localStorage.getItem('terminus.termZoom') || 'null');
    if (zoom && typeof zoom === 'object' && !uiState.termZoom) setUiState('termZoom', zoom);
    const layout = JSON.parse(localStorage.getItem('terminus.layout') || 'null');
    if (layout && !uiState.layout) setUiState('layout', layout);
    for (const k of ['terminus.prefs', 'terminus.termZoom', 'terminus.layout']) localStorage.removeItem(k);
  } catch {}
  setUiState('migratedLocalStorage', true);
}
