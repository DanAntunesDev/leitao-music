import { contextBridge, ipcRenderer } from 'electron';
import type { BridgeApi } from './shared';

const on = (channel: string) => (cb: (v: any) => void) => {
  ipcRenderer.on(channel, (_e, v) => cb(v));
};

const api: BridgeApi = {
  onOpen: on('open'),
  onPeek: on('peek'),
  onClose: on('close'),
  onNowPlaying: on('now-playing'),
  onToast: on('toast'),
  library: () => ipcRenderer.invoke('library'),
  queue: () => ipcRenderer.invoke('queue'),
  playItem: (item) => ipcRenderer.invoke('play-item', item),
  tracks: (item) => ipcRenderer.invoke('tracks', item),
  play: (ctx, track) => ipcRenderer.invoke('play', ctx, track),
  control: (action) => ipcRenderer.send('control', action),
  closed: () => ipcRenderer.send('closed'),
  saveClientId: (id) => ipcRenderer.invoke('save-client-id', id),
  getClientId: () => ipcRenderer.invoke('get-client-id'),
};

contextBridge.exposeInMainWorld('leitao', api);
