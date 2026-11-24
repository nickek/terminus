import * as fs from 'fs';
import * as path from 'path';

/** The Windows Terminal profile for a WSL distro (color scheme + font), so Terminus can match it. */
export function readWindowsTerminalProfile(la: string, distroName?: string) {
  const candidates = [
    path.join(la, 'Packages', 'Microsoft.WindowsTerminal_8wekyb3d8bbwe', 'LocalState', 'settings.json'),
    path.join(la, 'Packages', 'Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe', 'LocalState', 'settings.json'),
    path.join(la, 'Microsoft', 'Windows Terminal', 'settings.json'),
  ];
  const file = candidates.find((f) => fs.existsSync(f));
  if (!file) return null;
  try {
    // settings.json allows comments and trailing commas.
    const text = fs
      .readFileSync(file, 'utf8')
      .replace(/^\uFEFF/, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/,(\s*[}\]])/g, '$1');
    const d = JSON.parse(text);
    const profiles = d.profiles || {};
    const list: any[] = Array.isArray(profiles) ? profiles : profiles.list || [];
    const defaults = Array.isArray(profiles) ? {} : profiles.defaults || {};
    const distro = (distroName || '').toLowerCase();
    const p =
      list.find((x) => distro && String(x.name || '').toLowerCase() === distro) ||
      list.find((x) => String(x.source || '').includes('Wsl') && distro && String(x.name || '').toLowerCase().includes(distro)) ||
      list.find((x) => x.guid === d.defaultProfile) ||
      {};
    const pick = (k: string) => p[k] ?? defaults[k];
    let schemeName = pick('colorScheme') ?? 'Campbell';
    if (schemeName && typeof schemeName === 'object') schemeName = schemeName.dark || schemeName.light || 'Campbell';
    const font = { ...(defaults.font || {}), ...(p.font || {}) };
    return {
      profileName: p.name || 'Default',
      schemeName,
      customScheme: (d.schemes || []).find((x: any) => x.name === schemeName),
      fontFace: font.face || pick('fontFace') || 'Cascadia Mono',
      fontSize: font.size || pick('fontSize') || 12,
      settingsPath: file,
    };
  } catch {
    return null;
  }
}
