import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron';
import { execFile, spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { readWindowsTerminalProfile } from './wt';

interface CoreInfo {
  port: number;
  token: string;
}

let core: CoreInfo | undefined;
let coreProc: ChildProcess | undefined;
let coreError: string | undefined;
let win: BrowserWindow | undefined;

const ROOT = path.resolve(__dirname, '..', '..', '..');

/**
 * Native Windows mode: this Electron build runs on Windows and the core runs inside
 * WSL (started through wsl.exe). Written by `npm run win:install` as resources/app/wsl.json.
 */
interface WslConfig {
  distro: string;
  appDir: string;
}
const WSL: WslConfig | undefined = (() => {
  if (process.platform !== 'win32') return undefined;
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'wsl.json'), 'utf8'));
  } catch {
    return undefined;
  }
})();

function wslExec(args: string[], timeout = 20000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('wsl.exe', ['-d', WSL!.distro, '--', ...args], { timeout, windowsHide: true, encoding: 'utf8' }, (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    );
  });
}

/** Linux path → something the Windows folder dialog can open, and back. */
function toWindowsPath(p: string): string {
  const m = /^\/mnt\/([a-z])(\/.*)?$/.exec(p);
  if (m) return `${m[1].toUpperCase()}:${(m[2] || '\\').replace(/\//g, '\\')}`;
  return `\\\\wsl.localhost\\${WSL!.distro}${p.replace(/\//g, '\\')}`;
}
function toLinuxPath(p: string): string {
  const out = toLinuxPathRaw(p);
  return out.length > 1 ? out.replace(/\/+$/, '') : out;
}
function toLinuxPathRaw(p: string): string {
  const unc = /^\\\\(?:wsl\.localhost|wsl\$)\\[^\\]+(.*)$/i.exec(p);
  if (unc) return unc[1].replace(/\\/g, '/') || '/';
  const drive = /^([a-zA-Z]):(.*)$/.exec(p);
  if (drive) return `/mnt/${drive[1].toLowerCase()}${drive[2].replace(/\\/g, '/')}`;
  return p;
}

function health(info: CoreInfo): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: info.port, path: `/health?token=${info.token}`, timeout: 1000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

/** Reuse an already-running core (e.g. `npm run core`), otherwise start one. */
async function ensureCore(): Promise<CoreInfo> {
  try {
    const raw = WSL
      ? await wslExec(['sh', '-c', 'cat "${TERMINUS_HOME:-$HOME/.terminus}/core.json"'])
      : fs.readFileSync(path.join(process.env.TERMINUS_HOME || path.join(os.homedir(), '.terminus'), 'core.json'), 'utf8');
    const existing = JSON.parse(raw) as CoreInfo;
    if (await health(existing)) return existing;
  } catch {}

  const nodeBin = process.env.TERMINUS_NODE || 'node';
  const entry = path.join(ROOT, 'dist', 'main', 'core', 'index.js');
  const timeoutMs = WSL ? 45000 : 15000; // first wsl.exe call may need to boot the distro
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, TERMINUS_EXIT_WITH_PARENT: '1' };
    delete env.ELECTRON_RUN_AS_NODE;
    coreProc = WSL
      ? // Login shell so PATH (node, claude) matches an interactive WSL terminal.
        spawn('wsl.exe', ['-d', WSL.distro, '--cd', WSL.appDir, '--', 'env', 'TERMINUS_EXIT_WITH_PARENT=1', 'bash', '-lc', 'exec node dist/main/core/index.js'], {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        })
      : spawn(nodeBin, [entry], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => reject(new Error(`Core did not start within ${timeoutMs / 1000}s`)), timeoutMs);
    coreProc.stdout!.on('data', (d) => {
      out += d.toString();
      const ready = /TERMINUS_READY (\{.*\})/.exec(out);
      if (ready) {
        clearTimeout(timer);
        resolve(JSON.parse(ready[1]));
      }
      const err = /TERMINUS_ERROR (\{.*\})/.exec(out);
      if (err) {
        clearTimeout(timer);
        reject(new Error(JSON.parse(err[1]).message));
      }
    });
    coreProc.stderr!.on('data', (d) => process.stderr.write(`[core] ${d}`));
    coreProc.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`Could not start core with "${WSL ? 'wsl.exe' : nodeBin}": ${e.message}`));
    });
    coreProc.on('exit', (code) => {
      clearTimeout(timer);
      coreProc = undefined;
      if (!core) reject(new Error(`Core exited early (code ${code}). ${out}`));
      else win?.webContents.send('core-exit', code);
    });
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1600,
    height: 980,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#0b0c10',
    title: 'Terminus',
    icon: path.join(ROOT, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    // Frameless: the renderer draws its own title bar with macOS-style window dots.
    frame: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win?.webContents.getURL()) {
      e.preventDefault();
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
    }
  });
  if (process.env.VITE_DEV_URL) win.loadURL(process.env.VITE_DEV_URL);
  else win.loadFile(path.join(ROOT, 'dist', 'renderer', 'index.html'));
  win.on('closed', () => (win = undefined));
  const sendState = () => win?.webContents.send('win-state', { maximized: win.isMaximized(), focused: win.isFocused() });
  for (const ev of ['maximize', 'unmaximize', 'focus', 'blur', 'enter-full-screen', 'leave-full-screen'] as const) win.on(ev as any, sendState);
  if (process.env.TERMINUS_SELFTEST) runSelfTest(win, process.env.TERMINUS_SELFTEST);
}

/**
 * Dev aid: TERMINUS_SELFTEST=<json file> with [{wait, js?, shot?}] steps runs JS in
 * the renderer and saves screenshots, then quits. Used for headless verification.
 */
async function runSelfTest(w: BrowserWindow, file: string) {
  const steps: { wait?: number; js?: string; shot?: string }[] = JSON.parse(fs.readFileSync(file, 'utf8'));
  await new Promise<void>((r) => w.webContents.once('did-finish-load', () => r()));
  for (const s of steps) {
    await new Promise((r) => setTimeout(r, s.wait ?? 500));
    if (s.js) {
      try {
        const out = await w.webContents.executeJavaScript(s.js, true);
        if (out !== undefined) console.log('[selftest]', JSON.stringify(out));
      } catch (e) {
        console.log('[selftest] js error', (e as Error).message);
      }
    }
    if (s.shot) fs.writeFileSync(s.shot, (await w.webContents.capturePage()).toPNG());
  }
  app.quit();
}

ipcMain.handle('core-info', () => ({ core, error: coreError }));
ipcMain.handle('pick-directory', async (_e, defaultPath?: string) => {
  // Paths are always Linux paths in the renderer/core; translate for the Windows dialog.
  const start = WSL ? toWindowsPath(defaultPath || '/home') : defaultPath || os.homedir();
  const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'], defaultPath: start });
  if (r.canceled) return undefined;
  return WSL ? toLinuxPath(r.filePaths[0]) : r.filePaths[0];
});
ipcMain.handle('wt-profile', () =>
  process.platform === 'win32' && process.env.LOCALAPPDATA ? readWindowsTerminalProfile(process.env.LOCALAPPDATA, WSL?.distro) : null,
);
ipcMain.on('win:minimize', () => win?.minimize());
ipcMain.on('win:toggle-maximize', () => {
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.on('win:close', () => win?.close());
ipcMain.handle('win:state', () => ({ maximized: !!win?.isMaximized(), focused: !!win?.isFocused() }));
ipcMain.on('attention', () => {
  if (win && !win.isFocused()) win.flashFrame(true);
});
ipcMain.handle('clipboard:read', () => clipboard.readText());
ipcMain.handle('clipboard:write', (_e, text: unknown) => {
  if (typeof text === 'string') clipboard.writeText(text);
});
ipcMain.on('open-external', (_e, url: string) => {
  if (/^https?:\/\//.test(url)) shell.openExternal(url);
});

// Graphics: under WSLg most distros (e.g. Rocky/RHEL) ship Mesa without the d3d12 driver, so there
// is no real GPU path and Chromium's GPU process just fails noisily (and when running as root from
// a private home dir it also can't load its GL library after dropping privileges). Default to
// Chromium's software renderer; TERMINUS_GPU=1 opts into GPU mode for distros that have Mesa d3d12.
if (process.platform !== 'linux') {
  // Native Windows/macOS: normal hardware acceleration.
} else if (process.env.TERMINUS_GPU === '1') {
  app.commandLine.appendSwitch('in-process-gpu');
  app.commandLine.appendSwitch('ignore-gpu-blocklist');
} else {
  app.disableHardwareAcceleration();
}

// Separate Chromium profile (layout, prefs) when requested, e.g. for tests.
if (process.env.TERMINUS_USER_DATA) app.setPath('userData', process.env.TERMINUS_USER_DATA);

if (process.platform === 'win32') app.setAppUserModelId('dev.terminus.app');

app.whenReady().then(async () => {
  try {
    core = await ensureCore();
  } catch (e) {
    coreError = (e as Error).message;
    console.error(coreError);
  }
  createWindow();
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  if (coreProc && !process.env.TERMINUS_KEEP_CORE) coreProc.kill('SIGTERM');
});
