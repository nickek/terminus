import { useEffect, useRef, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { client } from '../client';
import { DEFAULT_FONT_SIZE, getPrefs, getTermFontSize, setTermFontSize, useCore, usePrefs } from '../store';
import { resolveTerminalLook, useWtProfile, type TermScheme } from '../schemes';

const xtermTheme = (s: TermScheme) => ({ ...s, background: s.background === 'transparent' ? '#00000000' : s.background });


export function TerminalPanel(props: IDockviewPanelProps<{ sessionId: string }>) {
  const sessionId = props.params.sessionId;
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal>(undefined);
  const fitRef = useRef<() => void>(() => {});
  const { sessions, connected } = useCore();
  const [zoomLabel, setZoomLabel] = useState<string>();
  const prefs = usePrefs();
  const wtProfile = useWtProfile();
  const look = resolveTerminalLook(prefs.termScheme, prefs.termFont);
  const session = sessions.find((s) => s.id === sessionId);

  useEffect(() => {
    const host = hostRef.current!;
    const term = new Terminal({
      fontFamily: resolveTerminalLook(getPrefs().termScheme, getPrefs().termFont).fontFamily,
      fontSize: getTermFontSize(sessionId),
      lineHeight: 1.15,
      cursorBlink: true,
      allowProposedApi: true,
      allowTransparency: true,
      scrollback: 10000,
      theme: xtermTheme(resolveTerminalLook(getPrefs().termScheme, getPrefs().termFont).scheme),
      macOptionIsMeta: true,
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon((_e, uri) => window.terminus?.openExternal(uri)));
    let disposed = false;
    const fontReady = document.fonts.load(`${getTermFontSize(sessionId)}px "JetBrains Mono"`).catch(() => undefined);
    fontReady.then(() => {
      if (disposed) return;
      term.open(host);
      requestAnimationFrame(doFit);
    });

    // Attach: ignore live data until the scrollback snapshot arrives, since
    // the snapshot already contains everything emitted before it.
    let synced = false;
    const offData = client.onData(sessionId, (d) => {
      if (synced) term.write(d);
    });
    const offScroll = client.onScrollback(sessionId, (d) => {
      term.reset();
      term.write(d);
      synced = true;
      lastSize = '';
      requestAnimationFrame(() => fitRef.current());
    });
    const attach = () => {
      synced = false;
      client.send({ t: 'attach', id: sessionId });
    };
    attach();
    const offState = client.subscribe(() => {
      // Re-attach after a reconnect.
      const st = client.getState();
      if (st.connected && !wasConnected) attach();
      wasConnected = st.connected;
    });
    let wasConnected = client.getState().connected;

    const input = term.onData((data) => client.send({ t: 'input', id: sessionId, data }));
    const binput = term.onBinary((data) => client.send({ t: 'input', id: sessionId, data }));

    // Ctrl+Shift+C / Ctrl+Shift+V copy/paste; plain Ctrl+C still goes to the process.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.code === 'Digit0' || e.code === 'Numpad0')) {
        setZoom(DEFAULT_FONT_SIZE);
        return false;
      }
      if (e.ctrlKey && e.shiftKey && e.code === 'KeyC') {
        const sel = term.getSelection();
        if (sel) navigator.clipboard.writeText(sel);
        return false;
      }
      if (e.ctrlKey && e.shiftKey && e.code === 'KeyV') {
        navigator.clipboard.readText().then((t) => t && term.paste(t));
        return false;
      }
      return true;
    });

    let lastSize = '';
    const doFit = () => {
      if (!term.element || !host.isConnected || host.clientWidth < 20 || host.clientHeight < 20) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      const size = `${term.cols}x${term.rows}`;
      if (size !== lastSize) {
        lastSize = size;
        client.send({ t: 'resize', id: sessionId, cols: term.cols, rows: term.rows });
      }
    };
    fitRef.current = doFit;

    // Ctrl + mouse wheel zooms this terminal only (remembered per session; Ctrl+0 resets).
    let labelTimer = 0;
    function setZoom(size: number) {
      const next = Math.max(8, Math.min(32, Math.round(size)));
      if (next !== term.options.fontSize) {
        term.options.fontSize = next;
        setTermFontSize(sessionId, next);
        requestAnimationFrame(doFit);
      }
      setZoomLabel(`${Math.round((next / DEFAULT_FONT_SIZE) * 100)}%`);
      clearTimeout(labelTimer);
      labelTimer = window.setTimeout(() => setZoomLabel(undefined), 1100);
    }
    let wheelAcc = 0;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      e.stopPropagation();
      // One size step per wheel notch; trackpads send many small deltas, so accumulate them.
      wheelAcc += e.deltaMode === 1 ? e.deltaY * 50 : e.deltaY;
      if (Math.abs(wheelAcc) < 50) return;
      const dir = Math.sign(wheelAcc);
      wheelAcc = 0;
      setZoom((term.options.fontSize ?? DEFAULT_FONT_SIZE) - dir);
    };
    host.addEventListener('wheel', onWheel, { capture: true, passive: false });
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(doFit);
    });
    ro.observe(host);
    const vis = props.api.onDidVisibilityChange((e) => e.isVisible && requestAnimationFrame(doFit));
    const act = props.api.onDidActiveChange((e) => e.isActive && term.focus());
    return () => {
      disposed = true;
      host.removeEventListener('wheel', onWheel, { capture: true });
      clearTimeout(labelTimer);
      offData();
      offScroll();
      offState();
      input.dispose();
      binput.dispose();
      ro.disconnect();
      vis.dispose();
      act.dispose();
      cancelAnimationFrame(raf);
      term.dispose();
    };
  }, [sessionId]);

  useEffect(() => {
    const t = termRef.current;
    if (!t) return;
    t.options.theme = xtermTheme(look.scheme);
    if (t.options.fontFamily !== look.fontFamily) {
      t.options.fontFamily = look.fontFamily;
      document.fonts.load(`13px ${look.fontFamily.split(',')[0]}`).finally(() => requestAnimationFrame(() => fitRef.current()));
    }
  }, [look.scheme, look.fontFamily, wtProfile]);

  const ended = session && (session.status === 'exited' || session.status === 'failed' || session.status === 'closed');

  return (
    <div
      className="term-wrap"
      style={look.scheme.background !== 'transparent' ? { background: look.scheme.background } : undefined}
      onMouseDown={() => termRef.current?.focus()}
    >
      <div className="term-host" ref={hostRef} />
      {zoomLabel && <div className="zoom-badge">{zoomLabel}</div>}
      {!session && connected && (
        <div className="term-overlay">
          <div>This session no longer exists.</div>
          <button className="btn" onClick={() => props.api.close()}>
            Close panel
          </button>
        </div>
      )}
      {ended && (
        <div className="term-banner">
          <span className={`dot ${session.status}`} />
          <span>
            {session.status === 'failed'
              ? `Exited with code ${session.exitCode}`
              : session.status === 'closed'
                ? 'Session closed'
                : 'Session ended'}
          </span>
          <span className="spacer" />
          <button className="btn small primary" onClick={() => client.rpc('sessions.resume', { id: sessionId }).catch((e) => alert(e.message))}>
            {session.kind === 'claude' ? 'Resume conversation' : 'Restart shell'}
          </button>
          <button className="btn small ghost" onClick={() => props.api.close()}>
            Close
          </button>
        </div>
      )}
    </div>
  );
}
