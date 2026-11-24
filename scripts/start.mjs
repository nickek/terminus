#!/usr/bin/env node
/**
 * Launches the Linux/macOS Electron window. Chromium's sandbox needs either a
 * non-root user with a setuid chrome-sandbox helper or user namespaces; when
 * neither is available (e.g. running as root in WSL, or npm reset the helper's
 * permissions) we pass --no-sandbox. The window only loads local app files.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const electron = require('electron'); // path to the Electron binary

const args = ['.', ...process.argv.slice(2)];
if (process.platform === 'linux' && !args.includes('--no-sandbox')) {
  let helperOk = false;
  try {
    const st = fs.statSync(path.join(path.dirname(electron), 'chrome-sandbox'));
    helperOk = st.uid === 0 && (st.mode & 0o4000) !== 0;
  } catch {}
  const isRoot = process.getuid?.() === 0;
  let userns = false;
  try {
    userns = fs.readFileSync('/proc/sys/kernel/unprivileged_userns_clone', 'utf8').trim() === '1';
  } catch {
    userns = !fs.existsSync('/proc/sys/kernel/apparmor_restrict_unprivileged_userns'); // assume allowed if no knob
  }
  try {
    if (fs.readFileSync('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', 'utf8').trim() === '1') userns = false;
  } catch {}
  if (isRoot || !(helperOk || userns)) args.push('--no-sandbox');
}

const child = spawn(electron, args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } });
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
