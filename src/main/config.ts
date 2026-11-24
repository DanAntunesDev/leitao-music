import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { Anchor } from './shared';

export interface Config {
  clientId: string;
  anchor: Anchor;
  displayId: number | null;   // null = monitor onde está o cursor
  shortcut: string;           // atalho global (formato Electron Accelerator)
  hoverEdge: boolean;         // abrir encostando o mouse na borda
  hoverDelayMs: number;
  background: 'panel' | 'matrix' | 'transparent'; // panel = só a área do app (padrão)
  scale: number;              // 0.7 – 1.5
  peek: 'full' | 'minimal' | 'off'; // aparecer sozinho quando a música muda
  peekMs: number;
  showQueue: boolean;         // aba "Tocando agora" com a fila (e usada quando aparece sozinho)
  showTabs: boolean;          // abas clicáveis: Tocando agora · Recentes · Álbuns · Playlists
  v: number;                  // versão do formato (migrações)
}

const defaults: Config = {
  clientId: '',
  anchor: 'left-center',
  displayId: null,
  shortcut: 'CommandOrControl+Alt+M',
  hoverEdge: true,
  hoverDelayMs: 300,
  background: 'panel',
  scale: 1,
  peek: 'full',
  peekMs: 5000,
  showQueue: true,
  showTabs: true,
  v: 2,
};

export const configPath = () => path.join(app.getPath('userData'), 'config.json');

export function loadConfig(): Config {
  let cfg: Config;
  try {
    cfg = { ...defaults, ...JSON.parse(fs.readFileSync(configPath(), 'utf8')) };
  } catch {
    cfg = { ...defaults };
  }
  if (!/^(left|right)-(top|center|bottom)$/.test(cfg.anchor)) cfg.anchor = defaults.anchor;
  if (!['panel', 'matrix', 'transparent'].includes(cfg.background)) cfg.background = defaults.background;
  // v1 → v2: o padrão do fundo passou a ser "só no painel"
  if (!cfg.v || cfg.v < 2) {
    cfg.background = 'panel';
    cfg.v = 2;
    try { saveConfig(cfg); } catch { /* primeira execução sem pasta ainda */ }
  }
  if (process.env.SPOTIFY_CLIENT_ID) cfg.clientId = process.env.SPOTIFY_CLIENT_ID;
  return cfg;
}

export function saveConfig(cfg: Config) {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
}
