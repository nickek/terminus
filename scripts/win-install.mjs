#!/usr/bin/env node
/**
 * Installs Terminus as a native Windows app (run this from inside WSL).
 *
 *   npm run win:install            build, then install/update %LOCALAPPDATA%\Terminus
 *   npm run win:install -- --launch   …and start it
 *
 * The Windows app is the official Electron win32-x64 build plus our compiled main/renderer.
 * Its core service still runs inside this WSL distro (started via wsl.exe), so Claude
 * sessions, hooks and files all stay in Linux; only the window is native.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const launch = process.argv.includes('--launch');
const log = (...a) => console.log('›', ...a);

function win(cmd) {
  return execFileSync('cmd.exe', ['/d', '/c', cmd], { cwd: '/mnt/c', encoding: 'utf8' }).replace(/\r/g, '').trim();
}
const toWin = (p) => execFileSync('wslpath', ['-w', p], { encoding: 'utf8' }).trim();
const toLinux = (p) => execFileSync('wslpath', ['-u', p], { encoding: 'utf8' }).trim();

if (!process.env.WSL_DISTRO_NAME) {
  console.error('Run this from inside WSL.');
  process.exit(1);
}
for (const f of ['dist/main/main/index.js', 'dist/main/main/preload.js', 'dist/renderer/index.html']) {
  if (!fs.existsSync(path.join(ROOT, f))) {
    console.error(`Missing ${f}; run "npm run build" first.`);
    process.exit(1);
  }
}

const localAppData = toLinux(win('echo %LOCALAPPDATA%'));
const target = path.join(localAppData, 'Terminus');
const cache = path.join(os.homedir(), '.cache', 'terminus');
fs.mkdirSync(cache, { recursive: true });

// ---------------------------------------------------------------- Electron runtime
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules/electron/package.json'), 'utf8')).version;
const zipName = `electron-v${version}-win32-x64.zip`;
const zipPath = path.join(cache, zipName);
const base = `https://github.com/electron/electron/releases/download/v${version}`;

function download(url, dest) {
  execFileSync('curl', ['-fL', '--retry', '3', '-o', dest, url], { stdio: ['ignore', 'ignore', 'inherit'] });
}
const sha256 = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');

const sums = path.join(cache, `SHASUMS256-v${version}.txt`);
if (!fs.existsSync(sums)) download(`${base}/SHASUMS256.txt`, sums);
const expected = fs
  .readFileSync(sums, 'utf8')
  .split('\n')
  .map((l) => l.trim().split(/\s+\*?/))
  .find(([, name]) => name === zipName)?.[0];
if (!expected) throw new Error(`No checksum for ${zipName}`);
if (!fs.existsSync(zipPath) || sha256(zipPath) !== expected) {
  log(`Downloading Electron ${version} for Windows…`);
  download(`${base}/${zipName}`, zipPath);
  if (sha256(zipPath) !== expected) {
    fs.rmSync(zipPath);
    throw new Error('Electron download failed checksum verification');
  }
}
log(`Electron ${version} verified (sha256 ${expected.slice(0, 12)}…)`);

const versionFile = path.join(target, 'electron-version.txt');
const installed = fs.existsSync(versionFile) ? fs.readFileSync(versionFile, 'utf8').trim() : '';
// Not "Terminus.exe": Discord matches running exe names against its game list, and a game
// called Terminus would show up as your activity.
const EXE_NAME = 'TerminusApp.exe';
const LEGACY_EXE_NAMES = ['Terminus.exe'];
const exe = path.join(target, EXE_NAME);
const hasLegacyExe = LEGACY_EXE_NAMES.some((n) => fs.existsSync(path.join(target, n)));

/** Count running Terminus processes (current and legacy exe names). Calls tasklist.exe directly (no cmd.exe), so the
 *  filter's quotes survive the WSL → Windows hand-off. */
function runningCount() {
  try {
    let n = 0;
    for (const name of [EXE_NAME, ...LEGACY_EXE_NAMES]) {
      const out = execFileSync('tasklist.exe', ['/FI', `IMAGENAME eq ${name}`, '/NH', '/FO', 'CSV'], {
        cwd: '/mnt/c',
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      n += out.split('\n').filter((l) => l.trim().toLowerCase().startsWith(`"${name.toLowerCase()}"`)).length;
    }
    return n;
  } catch (e) {
    log(`warning: couldn't check whether Terminus is running (${String(e.stderr || e.message).trim().split('\n')[0]})`);
    return 0;
  }
}
if (runningCount() > 0) {
  console.error('\nTerminus is open on Windows. Quit it first (title bar ● close, or right-click its taskbar icon → Close window), then run this again.');
  console.error('Quitting also stops its sessions; they stay in the sidebar and resume when you reopen Terminus.');
  process.exit(1);
}

if (installed !== version || hasLegacyExe || !fs.existsSync(exe)) {
  log(
    !installed ? `Installing to ${toWin(target)}`
    : installed !== version ? `Updating runtime ${installed} → ${version}`
    : `Reinstalling runtime as ${EXE_NAME}`,
  );
  // Only remove what a previous install created (the runtime), never anything else.
  if (fs.existsSync(versionFile)) fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  execFileSync('unzip', ['-q', '-o', zipPath, '-d', target], { stdio: 'inherit' });
  fs.renameSync(path.join(target, 'electron.exe'), exe);
  fs.rmSync(path.join(target, 'resources', 'default_app.asar'), { force: true });

  // Give the exe our icon and name (rcedit runs natively through WSL interop).
  const rcedit = path.join(cache, 'rcedit-x64.exe');
  if (!fs.existsSync(rcedit)) {
    log('Downloading rcedit (sets the exe icon)…');
    download('https://github.com/electron/rcedit/releases/download/v2.0.0/rcedit-x64.exe', rcedit);
    fs.chmodSync(rcedit, 0o755);
  }
  const tmpRcedit = path.join(target, 'rcedit-x64.exe');
  fs.copyFileSync(rcedit, tmpRcedit);
  fs.chmodSync(tmpRcedit, 0o755);
  try {
    execFileSync(tmpRcedit, [
      toWin(exe),
      '--set-icon', toWin(path.join(ROOT, 'assets', 'icon.ico')),
      '--set-version-string', 'ProductName', 'Terminus',
      '--set-version-string', 'FileDescription', 'Terminus',
      '--set-version-string', 'CompanyName', 'Terminus',
      '--set-version-string', 'OriginalFilename', EXE_NAME,
    ]);
  } catch (e) {
    log(`warning: could not set exe icon (${e.message.split('\n')[0]})`);
  } finally {
    fs.rmSync(tmpRcedit, { force: true });
  }
  fs.writeFileSync(versionFile, version + '\n');
}

// ---------------------------------------------------------------- app files
const app = path.join(target, 'resources', 'app');
fs.rmSync(app, { recursive: true, force: true });
fs.mkdirSync(path.join(app, 'dist', 'main'), { recursive: true });
fs.cpSync(path.join(ROOT, 'dist', 'main', 'main'), path.join(app, 'dist', 'main', 'main'), { recursive: true });
fs.cpSync(path.join(ROOT, 'dist', 'renderer'), path.join(app, 'dist', 'renderer'), { recursive: true });
fs.mkdirSync(path.join(app, 'assets'), { recursive: true });
for (const f of ['icon.ico', 'icon.png']) fs.copyFileSync(path.join(ROOT, 'assets', f), path.join(app, 'assets', f));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
fs.writeFileSync(
  path.join(app, 'package.json'),
  JSON.stringify({ name: 'terminus', productName: 'Terminus', version: pkg.version, main: 'dist/main/main/index.js' }, null, 2),
);
// Tells the Windows app which distro and folder hold the core service.
fs.writeFileSync(path.join(app, 'wsl.json'), JSON.stringify({ distro: process.env.WSL_DISTRO_NAME, appDir: ROOT }, null, 2));
log(`App files updated (core runs in WSL distro "${process.env.WSL_DISTRO_NAME}" from ${ROOT})`);

// ---------------------------------------------------------------- Start Menu shortcut
const ps = `$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Programs')+'\\Terminus.lnk');$s.TargetPath='${toWin(exe)}';$s.WorkingDirectory='${toWin(target)}';$s.IconLocation='${toWin(exe)},0';$s.Description='Terminus: orchestrate Claude Code sessions';$s.Save()`;
try {
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { cwd: '/mnt/c', stdio: ['ignore', 'ignore', 'inherit'] });
  log('Start Menu shortcut: Terminus');
} catch {
  log('warning: could not create the Start Menu shortcut');
}

console.log(`\nDone. Start "Terminus" from the Start Menu, or run:\n  "${toWin(exe)}"\n`);
if (launch) {
  // Start-Process copes with spaces in the path (e.g. a Windows username with a space).
  const q = (p) => `'${p.replace(/'/g, "''")}'`;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Start-Process -FilePath ${q(toWin(exe))} -WorkingDirectory ${q(toWin(target))}`], {
    cwd: '/mnt/c',
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  log('Launched.');
}
