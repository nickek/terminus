import { useSyncExternalStore } from 'react';

/** Terminal color schemes (xterm.js theme shape). Built-ins match Windows Terminal's values. */
export interface TermScheme {
  name: string;
  background: string;
  foreground: string;
  cursor?: string;
  selectionBackground?: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

const wt = (name: string, bg: string, fg: string, c: string[], cursor = '#FFFFFF', sel = '#FFFFFF'): TermScheme => ({
  name,
  background: bg,
  foreground: fg,
  cursor,
  selectionBackground: sel + '55',
  black: c[0],
  red: c[1],
  green: c[2],
  yellow: c[3],
  blue: c[4],
  magenta: c[5],
  cyan: c[6],
  white: c[7],
  brightBlack: c[8],
  brightRed: c[9],
  brightGreen: c[10],
  brightYellow: c[11],
  brightBlue: c[12],
  brightMagenta: c[13],
  brightCyan: c[14],
  brightWhite: c[15],
});

const CAMPBELL = ['#0C0C0C', '#C50F1F', '#13A10E', '#C19C00', '#0037DA', '#881798', '#3A96DD', '#CCCCCC', '#767676', '#E74856', '#16C60C', '#F9F1A5', '#3B78FF', '#B4009E', '#61D6D6', '#F2F2F2'];

export const TERMINUS_SCHEME: TermScheme = {
  name: 'Terminus',
  background: 'transparent',
  foreground: '#e5e5ea',
  cursor: '#64d2ff',
  selectionBackground: 'rgba(10, 132, 255, 0.38)',
  black: '#1c1c1e',
  red: '#ff6961',
  green: '#30d158',
  yellow: '#ffd60a',
  blue: '#0a84ff',
  magenta: '#bf5af2',
  cyan: '#64d2ff',
  white: '#d1d1d6',
  brightBlack: '#636366',
  brightRed: '#ff8a80',
  brightGreen: '#5de07d',
  brightYellow: '#ffe24d',
  brightBlue: '#409cff',
  brightMagenta: '#da8fff',
  brightCyan: '#8ce0ff',
  brightWhite: '#ffffff',
};

/** Windows Terminal built-in schemes, by their WT names. */
export const BUILTIN_SCHEMES: Record<string, TermScheme> = {
  Campbell: wt('Campbell', '#0C0C0C', '#CCCCCC', CAMPBELL),
  'Campbell Powershell': wt('Campbell Powershell', '#012456', '#CCCCCC', CAMPBELL),
  Vintage: wt('Vintage', '#000000', '#C0C0C0', ['#000000', '#800000', '#008000', '#808000', '#000080', '#800080', '#008080', '#C0C0C0', '#808080', '#FF0000', '#00FF00', '#FFFF00', '#0000FF', '#FF00FF', '#00FFFF', '#FFFFFF']),
  'One Half Dark': wt('One Half Dark', '#282C34', '#DCDFE4', ['#282C34', '#E06C75', '#98C379', '#E5C07B', '#61AFEF', '#C678DD', '#56B6C2', '#DCDFE4', '#5A6374', '#E06C75', '#98C379', '#E5C07B', '#61AFEF', '#C678DD', '#56B6C2', '#DCDFE4']),
  'One Half Light': wt('One Half Light', '#FAFAFA', '#383A42', ['#383A42', '#E45649', '#50A14F', '#C18301', '#0184BC', '#A626A4', '#0997B3', '#FAFAFA', '#4F525D', '#DF6C75', '#98C379', '#E4C07A', '#61AFEF', '#C577DD', '#56B5C1', '#FFFFFF'], '#4F525D', '#4F525D'),
  'Solarized Dark': wt('Solarized Dark', '#002B36', '#839496', ['#002B36', '#DC322F', '#859900', '#B58900', '#268BD2', '#D33682', '#2AA198', '#EEE8D5', '#073642', '#CB4B16', '#586E75', '#657B83', '#839496', '#6C71C4', '#93A1A1', '#FDF6E3']),
  'Solarized Light': wt('Solarized Light', '#FDF6E3', '#657B83', ['#002B36', '#DC322F', '#859900', '#B58900', '#268BD2', '#D33682', '#2AA198', '#EEE8D5', '#073642', '#CB4B16', '#586E75', '#657B83', '#839496', '#6C71C4', '#93A1A1', '#FDF6E3'], '#002B36', '#002B36'),
  'Tango Dark': wt('Tango Dark', '#000000', '#D3D7CF', ['#000000', '#CC0000', '#4E9A06', '#C4A000', '#3465A4', '#75507B', '#06989A', '#D3D7CF', '#555753', '#EF2929', '#8AE234', '#FCE94F', '#729FCF', '#AD7FA8', '#34E2E2', '#EEEEEC']),
  'Tango Light': wt('Tango Light', '#FFFFFF', '#555753', ['#000000', '#CC0000', '#4E9A06', '#C4A000', '#3465A4', '#75507B', '#06989A', '#D3D7CF', '#555753', '#EF2929', '#8AE234', '#FCE94F', '#729FCF', '#AD7FA8', '#34E2E2', '#EEEEEC'], '#000000', '#000000'),
};

// ---- Windows Terminal profile (read by the Windows build's main process) ----

export interface WtProfile {
  profileName: string;
  schemeName: string;
  scheme?: TermScheme;
  fontFace: string;
  fontSize: number;
  settingsPath: string;
}

let wtProfile: WtProfile | null | undefined; // undefined = not loaded yet
const subs = new Set<() => void>();

export async function loadWindowsTerminalProfile() {
  try {
    const raw = (await (window.terminus as any)?.windowsTerminalProfile?.()) as (Omit<WtProfile, 'scheme'> & { customScheme?: any }) | null;
    if (!raw) {
      wtProfile = null;
    } else {
      const c = raw.customScheme;
      const scheme = c
        ? wt(raw.schemeName, c.background, c.foreground, [c.black, c.red, c.green, c.yellow, c.blue, c.purple, c.cyan, c.white, c.brightBlack, c.brightRed, c.brightGreen, c.brightYellow, c.brightBlue, c.brightPurple, c.brightCyan, c.brightWhite], c.cursorColor || '#FFFFFF', c.selectionBackground || '#FFFFFF')
        : BUILTIN_SCHEMES[raw.schemeName];
      wtProfile = { ...raw, scheme };
    }
  } catch {
    wtProfile = null;
  }
  subs.forEach((s) => s());
}

export function useWtProfile() {
  return useSyncExternalStore(
    (fn) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    () => wtProfile,
  );
}
export const getWtProfile = () => wtProfile;

export type SchemeChoice = 'auto' | 'terminus' | string;

/** Resolve the user's choice into a concrete scheme + font. */
export function resolveTerminalLook(choice: SchemeChoice, fontChoice: string): { scheme: TermScheme; fontFamily: string } {
  const wtp = wtProfile || undefined;
  let scheme = TERMINUS_SCHEME;
  if (choice === 'auto') scheme = wtp?.scheme || TERMINUS_SCHEME;
  else if (BUILTIN_SCHEMES[choice]) scheme = BUILTIN_SCHEMES[choice];
  const face = fontChoice === 'auto' ? wtp?.fontFace || 'JetBrains Mono' : fontChoice;
  return { scheme, fontFamily: `"${face}", "JetBrains Mono", monospace` };
}
