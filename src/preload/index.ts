import { contextBridge, ipcRenderer } from 'electron';
import type { AppCommand, AppSnapshot, UnicornApi, ViewBounds } from '../shared/types';
const api: UnicornApi = {
  security: { sandboxed: process.sandboxed === true, contextIsolated: process.contextIsolated === true },
  invoke: (command: AppCommand) => ipcRenderer.invoke('unicorn:command', command),
  subscribe: (listener: (snapshot: AppSnapshot) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: AppSnapshot) => listener(snapshot);
    ipcRenderer.on('unicorn:snapshot', handler);
    return () => ipcRenderer.removeListener('unicorn:snapshot', handler);
  },
  layout: (bounds: ViewBounds[]) => ipcRenderer.send('unicorn:layout', bounds),
};
contextBridge.exposeInMainWorld('unicorn', Object.freeze(api));
