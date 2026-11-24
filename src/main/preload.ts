import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('terminus', {
  coreInfo: () => ipcRenderer.invoke('core-info'),
  pickDirectory: (defaultPath?: string) => ipcRenderer.invoke('pick-directory', defaultPath),
  attention: () => ipcRenderer.send('attention'),
  openExternal: (url: string) => ipcRenderer.send('open-external', url),
  window: {
    minimize: () => ipcRenderer.send('win:minimize'),
    toggleMaximize: () => ipcRenderer.send('win:toggle-maximize'),
    close: () => ipcRenderer.send('win:close'),
    state: () => ipcRenderer.invoke('win:state'),
    onState: (cb: (s: { maximized: boolean; focused: boolean }) => void) => ipcRenderer.on('win-state', (_e, st) => cb(st)),
  },
  windowsTerminalProfile: () => ipcRenderer.invoke('wt-profile'),
  onCoreExit: (cb: (code: number) => void) => ipcRenderer.on('core-exit', (_e, code) => cb(code)),
});
