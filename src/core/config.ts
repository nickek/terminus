import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_CONFIG, normalizeConfig, type TerminusConfig, type TerminusState } from '../shared/config';

/**
 * Owns ~/.terminus/config.json (portable preferences) and ~/.terminus/state.json
 * (per-machine UI state). Writes are atomic and debounced; config.json is watched
 * so hand edits (or a bootstrap copying one in) apply live to every open window.
 */
export class ConfigStore extends EventEmitter {
  readonly configPath: string;
  readonly statePath: string;
  private config: TerminusConfig & Record<string, unknown>;
  private state: TerminusState & Record<string, unknown>;
  private lastWritten = '';
  private saveTimer?: NodeJS.Timeout;
  private stateTimer?: NodeJS.Timeout;
  configError?: string;

  constructor(dir: string) {
    super();
    fs.mkdirSync(dir, { recursive: true });
    this.configPath = path.join(dir, 'config.json');
    this.statePath = path.join(dir, 'state.json');
    this.config = this.readConfig();
    this.state = readJson(this.statePath) || {};
    if (!fs.existsSync(this.configPath)) this.writeConfigNow(); // make it discoverable
    fs.watchFile(this.configPath, { interval: 1000 }, () => this.onExternalChange());
  }

  getConfig() {
    return this.config;
  }
  getState() {
    return this.state;
  }

  /** Shallow-merge into config; `null` removes a key (falls back to the default). */
  patchConfig(patch: Record<string, unknown>) {
    const next: Record<string, unknown> = { ...this.config };
    for (const [k, v] of Object.entries(patch || {})) {
      if (v === null || v === undefined) delete next[k];
      else next[k] = v;
    }
    this.config = normalizeConfig(next);
    this.emit('changed');
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.writeConfigNow(), 200);
  }

  patchState(patch: Record<string, unknown>) {
    for (const [k, v] of Object.entries(patch || {})) {
      if (v === null || v === undefined) delete this.state[k];
      else this.state[k] = v;
    }
    clearTimeout(this.stateTimer);
    this.stateTimer = setTimeout(() => writeAtomic(this.statePath, JSON.stringify(this.state) + '\n'), 300);
  }

  flush() {
    if (this.saveTimer) this.writeConfigNow();
    if (this.stateTimer) writeAtomic(this.statePath, JSON.stringify(this.state) + '\n');
  }

  private readConfig() {
    const raw = readJson(this.configPath, (e) => (this.configError = `${this.configPath}: ${e}`));
    return normalizeConfig(raw ?? DEFAULT_CONFIG);
  }

  private writeConfigNow() {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    // Defaults first so the file reads in a stable, documented order.
    const ordered: Record<string, unknown> = {};
    for (const k of Object.keys(DEFAULT_CONFIG)) ordered[k] = this.config[k];
    for (const [k, v] of Object.entries(this.config)) if (!(k in ordered)) ordered[k] = v;
    this.lastWritten = JSON.stringify(ordered, null, 2) + '\n';
    writeAtomic(this.configPath, this.lastWritten);
  }

  private onExternalChange() {
    let text: string;
    try {
      text = fs.readFileSync(this.configPath, 'utf8');
    } catch {
      return;
    }
    if (text === this.lastWritten) return;
    try {
      this.config = normalizeConfig(JSON.parse(text));
      this.configError = undefined;
      this.lastWritten = text;
      this.emit('changed');
    } catch (e) {
      // Keep the last good config while the file is mid-edit or invalid.
      this.configError = `${this.configPath}: ${(e as Error).message}`;
      this.emit('changed');
    }
  }
}

function readJson(p: string, onError?: (msg: string) => void): any {
  if (!fs.existsSync(p)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    onError?.((e as Error).message);
    return undefined;
  }
}

function writeAtomic(p: string, content: string) {
  try {
    const tmp = `${p}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, p);
  } catch {}
}
