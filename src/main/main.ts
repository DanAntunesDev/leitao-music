import {
  app, BrowserWindow, desktopCapturer, Display, globalShortcut, ipcMain, Menu, nativeImage, Notification, screen, shell, Tray,
} from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Config, configPath, loadConfig, saveConfig } from './config';
import type { Anchor, AuthState, Control, LibraryItem, NowPlaying, OpenPayload, Side, VPos } from './shared';
import { REDIRECT_URI, Spotify, SpotifyError } from './spotify';
import { initCursor, queryCursor } from './cursor';

// ---------------------------------------------------------------------------
// Linux: transparência, always-on-top e posição absoluta só são confiáveis no
// X11. No Wayland roda via XWayland.
// ---------------------------------------------------------------------------
const isLinux = process.platform === 'linux';
const isWayland = isLinux && process.env.XDG_SESSION_TYPE === 'wayland';
if (isLinux) {
  app.commandLine.appendSwitch('ozone-platform', 'x11');
  app.commandLine.appendSwitch('enable-transparent-visuals');
}

// pasta de dados fixa e sem acento: ~/.config/leitao-music  |  %APPDATA%\\leitao-music
app.setPath('userData', path.join(app.getPath('appData'), 'leitao-music'));
if (!app.requestSingleInstanceLock()) app.quit();
if (process.platform === 'win32') app.setAppUserModelId('dev.whoami.leitaomusic');
if (isLinux) app.commandLine.appendSwitch('class', 'leitao-music'); // WM_CLASS = StartupWMClass do .desktop

// Log em arquivo (userData/leitao-music.log) — ajuda a depurar login e API
const logFile = () => path.join(app.getPath('userData'), 'leitao-music.log');
for (const level of ['log', 'info', 'warn', 'error'] as const) {
  const orig = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    orig(...args);
    try {
      const line = args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
      fs.appendFileSync(logFile(), `${new Date().toISOString()} [${level}] ${line}\n`);
    } catch { /* ignora */ }
  };
}

let cfg: Config;
let spotify: Spotify;
let win: BrowserWindow | null = null;
let setupWin: BrowserWindow | null = null;
let tray: Tray | null = null;

let isOpen = false;     // aberto pelo usuário (interativo, com foco)
let peeking = false;    // aberto sozinho pela troca de música (sem foco, click-through)
let peekTimer: NodeJS.Timeout | null = null;
let lastTrackId: string | null | undefined; // undefined = ainda não consultou
let lastNp: NowPlaying | null = null;
const history: LibraryItem[] = []; // faixas que tocaram nesta sessão (mais recente primeiro)
let opening = false;
let pollTimer: NodeJS.Timeout | null = null;
let libraryCache: { at: number; items: LibraryItem[] } | null = null;

const dist = (f: string) => path.join(__dirname, f);
// assets ficam fora do .asar (asarUnpack) pra notificação/bandeja conseguirem ler o arquivo
const assets = (f: string) => path.join(app.getAppPath().replace('app.asar', 'app.asar.unpacked'), 'assets', f);

// ---------------------------------------------------------------------------
// Janela do overlay (tela cheia, transparente, escondida quando fechada)
// ---------------------------------------------------------------------------
function createOverlay() {
  win = new BrowserWindow({
    width: 800,
    height: 600,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: dist('preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(dist('index.html'));
  win.on('blur', () => { if (isOpen && !opening) close(); });
  win.on('closed', () => (win = null));
}

async function targetDisplay(): Promise<{ d: Display; cursor: { x: number; y: number } }> {
  const cursor = await queryCursor();
  if (cfg.displayId != null) {
    const d = screen.getAllDisplays().find((x) => x.id === cfg.displayId);
    if (d) return { d, cursor };
  }
  return { d: screen.getDisplayNearestPoint(cursor), cursor };
}

function authState(): AuthState {
  if (!cfg.clientId) return 'no-client-id';
  return spotify.isLoggedIn ? 'ok' : 'logged-out';
}

// ---------------------------------------------------------------------------
// Geometria: tela toda (matrix/transparent) ou só o painel (panel)
// A escala U precisa bater com measure() no renderer.
// ---------------------------------------------------------------------------
type Rect = { x: number; y: number; width: number; height: number };

function overlayBounds(d: Display): { rect: Rect; panel: boolean } {
  if (cfg.background !== 'panel') return { rect: d.bounds, panel: false };
  const wa = d.workArea;
  const U = cfg.scale * Math.min(1.6, Math.max(0.7, d.size.height / 1080));
  const width = Math.min(wa.width - 24, Math.round(900 * U));
  const height = Math.min(wa.height - 24, Math.round(780 * U));
  const [side, vpos] = cfg.anchor.split('-') as [Side, VPos];
  const gap = 12;
  const x = side === 'left' ? wa.x + gap : wa.x + wa.width - width - gap;
  const y = vpos === 'top' ? wa.y + gap
    : vpos === 'bottom' ? wa.y + wa.height - height - gap
    : wa.y + Math.round((wa.height - height) / 2);
  return { rect: { x, y, width, height }, panel: true };
}

/** Print do que está atrás (em 1/4 da resolução — o efeito borra/pixeliza mesmo), recortado em `rect`. */
async function captureBackground(d: Display, rect: Rect): Promise<string | null> {
  try {
    const all = screen.getAllDisplays();
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.round(d.size.width / 4), height: Math.round(d.size.height / 4) },
    });
    let img: Electron.NativeImage | null = null;
    let origin = { x: d.bounds.x, y: d.bounds.y };
    let span = d.bounds.width;

    const own = sources.find((s) => s.display_id === String(d.id));
    if (own) img = own.thumbnail;
    else if (sources.length && all.length === 1) img = sources[0].thumbnail;
    else if (sources.length) {
      // Linux/X11 às vezes devolve um único "tela inteira" cobrindo todos os monitores
      const minX = Math.min(...all.map((x) => x.bounds.x));
      const minY = Math.min(...all.map((x) => x.bounds.y));
      const maxX = Math.max(...all.map((x) => x.bounds.x + x.bounds.width));
      const maxY = Math.max(...all.map((x) => x.bounds.y + x.bounds.height));
      const full = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: Math.round((maxX - minX) / 4), height: Math.round((maxY - minY) / 4) },
      });
      img = full[0]?.thumbnail ?? null;
      origin = { x: minX, y: minY };
      span = maxX - minX;
    }
    if (!img || img.isEmpty()) return null;

    const k = img.getSize().width / span;
    return img.crop({
      x: Math.round((rect.x - origin.x) * k),
      y: Math.round((rect.y - origin.y) * k),
      width: Math.max(1, Math.round(rect.width * k)),
      height: Math.max(1, Math.round(rect.height * k)),
    }).toDataURL();
  } catch (e) {
    console.error('[capture]', e);
  }
  return null;
}

/**
 * Mostra a janela em `rect`. No Linux (mutter/GNOME) e no Windows com escalas
 * diferentes por monitor, mover uma janela ESCONDIDA pode ser ignorado e ela
 * reaparece no monitor anterior: por isso reaplica a posição depois de mostrar
 * e confere de novo.
 */
async function showAt(rect: Rect, interactive: boolean) {
  if (!win) return;
  const same = (b: Rect) => b.x === rect.x && b.y === rect.y && b.width === rect.width && b.height === rect.height;
  win.setBounds(rect);
  if (interactive) {
    win.show();
    win.focus();
  } else {
    win.showInactive();
  }
  win.setBounds(rect);
  win.moveTop();
  for (const delay of [30, 120]) {
    await new Promise((r) => setTimeout(r, delay));
    if (!win || same(win.getBounds())) return;
    console.warn('[place] posição corrigida', JSON.stringify(win.getBounds()), '→', JSON.stringify(rect));
    win.setBounds(rect);
  }
}

function makePayload(d: Display, panel: boolean, bg: string | null, peek?: 'full' | 'minimal'): OpenPayload {
  const [side, vpos] = cfg.anchor.split('-') as [Side, VPos];
  return {
    side, vpos, scale: cfg.scale, bg, auth: authState(), panel, screenH: d.size.height, peek,
    showQueue: cfg.showQueue, showTabs: cfg.showTabs,
  };
}

async function open() {
  if (!win || isOpen || opening) return;
  opening = true;
  const wasPeeking = peeking;
  endPeekTimer();
  peeking = false;
  try {
    const { d, cursor } = await targetDisplay();
    const { rect, panel } = overlayBounds(d);
    console.info(`[open] monitor ${d.id} (${d.bounds.x},${d.bounds.y} ${d.bounds.width}x${d.bounds.height}) cursor=${JSON.stringify(cursor)}`);
    // se estava no modo peek, o print atual já tem o overlay por cima: reaproveita o fundo
    const bg = wasPeeking ? 'keep' : cfg.background !== 'transparent' ? await captureBackground(d, rect) : null;
    const payload = makePayload(d, panel, bg);

    win.setIgnoreMouseEvents(false);
    win.setFocusable(true);
    win.setBounds(rect);
    win.webContents.send('open', payload);
    await new Promise((r) => setTimeout(r, 40)); // deixa o renderer pintar o 1º quadro
    isOpen = true;
    await showAt(rect, true);
    schedulePoll(0);
  } finally {
    opening = false;
  }
}

function close() {
  if (!isOpen && !peeking) return;
  isOpen = false;
  peeking = false;
  endPeekTimer();
  win?.webContents.send('close'); // renderer anima e responde com 'closed'
  schedulePoll(2500);
}

function endPeekTimer() {
  if (peekTimer) clearTimeout(peekTimer);
  peekTimer = null;
}

// ---------------------------------------------------------------------------
// Modo escuta: a música mudou → aparece sozinho, anima e some
// ---------------------------------------------------------------------------
async function peek(np: NowPlaying) {
  if (!win || cfg.peek === 'off' || opening) return;
  if (isOpen) return; // aberto pelo usuário: o renderer já anima a troca

  const style = cfg.peek;
  let payload: OpenPayload | null = null;
  let rect: Rect | null = null;
  if (!peeking) {
    const { d } = await targetDisplay();
    const ob = overlayBounds(d);
    rect = ob.rect;
    const bg = style === 'full' && cfg.background !== 'transparent' ? await captureBackground(d, rect) : null;
    payload = makePayload(d, ob.panel, bg, style);
    win.setBounds(rect);
    win.setIgnoreMouseEvents(true);   // cliques passam pra janela de trás
    win.setFocusable(false);          // não rouba o foco de quem está digitando
  }
  win.webContents.send('peek', { open: payload, np });
  if (!peeking && rect) {
    peeking = true;
    await new Promise((r) => setTimeout(r, 40));
    await showAt(rect, false);
  }
  endPeekTimer();
  peekTimer = setTimeout(() => { if (peeking) close(); }, cfg.peekMs);
}

const toggle = () => (isOpen ? close() : open());

// ---------------------------------------------------------------------------
// Hover na borda: encostar o mouse no canto escolhido abre o overlay
// ---------------------------------------------------------------------------
let edgeSince = 0;
let edgeBusy = false;
setInterval(async () => {
  if (!cfg?.hoverEdge || !win || isOpen || opening || edgeBusy) return; // durante o peek o hover promove pra interativo
  edgeBusy = true;
  const p = await queryCursor().finally(() => (edgeBusy = false));
  const d = cfg.displayId != null
    ? screen.getAllDisplays().find((x) => x.id === cfg.displayId) ?? screen.getPrimaryDisplay()
    : screen.getDisplayNearestPoint(p);
  const b = d.bounds;
  const [side, vpos] = cfg.anchor.split('-') as [Side, VPos];
  const band = Math.round(b.height * 0.3);
  const top = vpos === 'top' ? b.y : vpos === 'bottom' ? b.y + b.height - band : b.y + Math.round((b.height - band) / 2);
  const onEdge = side === 'left' ? p.x <= b.x + 1 : p.x >= b.x + b.width - 2;
  const inBand = p.y >= top && p.y < top + band;

  if (onEdge && inBand) {
    edgeSince ||= Date.now();
    if (Date.now() - edgeSince >= cfg.hoverDelayMs) {
      edgeSince = 0;
      open();
    }
  } else {
    edgeSince = 0;
  }
}, 50);

// ---------------------------------------------------------------------------
// Spotify: escuta contínua do "tocando agora"
//   aberto: 1 s · fechado e tocando: 2,5 s · nada tocando: 6 s
// ---------------------------------------------------------------------------
let idleSince = 0;

function schedulePoll(ms: number) {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(poll, ms);
}

async function poll() {
  if (authState() !== 'ok') return schedulePoll(5000);
  try {
    const np = await spotify.nowPlaying();
    win?.webContents.send('now-playing', np);

    const id = np?.id ?? null;
    if (lastNp && id && lastNp.id !== id) {
      // a faixa anterior vai pro topo do histórico local (a fila mostra "pra cima")
      history.unshift({
        id: lastNp.uri, uri: lastNp.uri, kind: 'track', name: lastNp.title, subtitle: lastNp.artist,
        cover: lastNp.cover, section: 'queue', offset: -1, contextUri: lastNp.contextUri,
      });
      history.splice(20);
    }
    if (np) lastNp = np;
    if (lastTrackId !== undefined && id && id !== lastTrackId) {
      console.info(`[listen] nova faixa: ${np!.title} — ${np!.artist}`);
      libraryCache = null; // "tocando agora"/recentes mudaram
      peek(np!);
    }
    lastTrackId = id;

    if (np?.isPlaying) idleSince = 0;
    else idleSince ||= Date.now();
    schedulePoll(isOpen || peeking ? 1000 : idleSince && Date.now() - idleSince > 60_000 ? 6000 : 2500);
  } catch (e) {
    if (e instanceof SpotifyError && e.status === 429) return schedulePoll(Math.max(e.retryAfterMs, 5000));
    console.error('[poll]', (e as Error).message);
    if (!spotify.isLoggedIn) buildTray();
    schedulePoll(8000);
  }
}

function toast(msg: string) {
  win?.webContents.send('toast', msg);
}

function handleError(e: unknown, ctx: string) {
  console.error(`[${ctx}]`, e);
  if (e instanceof SpotifyError) {
    if (e.status === 403) return toast('O Spotify recusou (precisa de Premium ou o app não tem acesso)');
    if (e.status === 404) return toast('Abra o Spotify em algum dispositivo');
    if (e.status === 429) return toast('Muitas requisições, aguarde um pouco');
  }
  toast('Falha ao falar com o Spotify');
}

async function runControl(action: Control) {
  try {
    switch (action) {
      case 'close': return close();
      case 'login': return doLogin();
      case 'setup': close(); return openSetup();
      case 'next': await spotify.next(); break;
      case 'prev': await spotify.prev(); break;
      case 'toggle': {
        const np = await spotify.nowPlaying();
        await (np?.isPlaying ? spotify.pause() : spotify.play());
        break;
      }
    }
  } catch (e) {
    handleError(e, action);
  }
  schedulePoll(350);
}

function notify(title: string, body: string) {
  if (Notification.isSupported()) new Notification({ title, body, icon: assets('icon.png'), silent: true }).show();
}

async function doLogin() {
  if (!cfg.clientId) return openSetup();
  close();
  try {
    await spotify.login();
    libraryCache = null;
    lastTrackId = undefined;
    console.info('[login] ok');
    notify('Leitão Music', 'Spotify conectado ✔');
    buildTray();
    schedulePoll(0);
    open();
  } catch (e) {
    console.error('[login] falhou:', e);
    notify('Leitão Music — falha no login', (e as Error).message.slice(0, 180));
    buildTray();
  }
}

// ---------------------------------------------------------------------------
// Configuração do Client ID
// ---------------------------------------------------------------------------
function openSetup() {
  if (setupWin) return setupWin.focus();
  setupWin = new BrowserWindow({
    width: 520,
    height: 500,
    resizable: false,
    title: 'Leitão Music — configurar Spotify',
    autoHideMenuBar: true,
    backgroundColor: '#121214',
    icon: assets('icon.png'),
    webPreferences: { preload: dist('preload.js'), contextIsolation: true, sandbox: true },
  });
  setupWin.loadFile(dist('setup.html'), { query: { redirect: REDIRECT_URI } });
  setupWin.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  setupWin.on('closed', () => (setupWin = null));
}

// ---------------------------------------------------------------------------
// Bandeja
// ---------------------------------------------------------------------------
const POSITIONS: [Anchor, string][] = [
  ['left-top', 'Esquerda — topo'],
  ['left-center', 'Esquerda — centro'],
  ['left-bottom', 'Esquerda — baixo'],
  ['right-top', 'Direita — topo'],
  ['right-center', 'Direita — centro'],
  ['right-bottom', 'Direita — baixo'],
];

function update(patch: Partial<Config>) {
  Object.assign(cfg, patch);
  saveConfig(cfg);
  buildTray();
}

function buildTray() {
  if (!tray) {
    // Windows: ícone colorido (o branco some na barra clara); Linux: silhueta branca
    const img = process.platform === 'win32'
      ? nativeImage.createFromPath(assets('icon.png')).resize({ width: 32, height: 32 })
      : nativeImage.createFromPath(assets('tray.png'));
    tray = new Tray(img);
    tray.setToolTip('Leitão Music');
    tray.on('click', toggle); // Windows: clique simples abre
  }
  const displays = screen.getAllDisplays();
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Abrir  (${cfg.shortcut.replace('CommandOrControl', 'Ctrl')})`, click: () => open() },
    { type: 'separator' },
    spotify.isLoggedIn
      ? { label: 'Desconectar Spotify', click: () => { spotify.logout(); libraryCache = null; buildTray(); } }
      : { label: 'Conectar Spotify…', click: () => doLogin() },
    { label: 'Configurar Client ID…', click: openSetup },
    { type: 'separator' },
    {
      label: 'Posição',
      submenu: POSITIONS.map(([a, label]) => ({
        label, type: 'radio' as const, checked: cfg.anchor === a, click: () => update({ anchor: a }),
      })),
    },
    {
      label: 'Monitor',
      submenu: [
        { label: 'Onde está o mouse', type: 'radio' as const, checked: cfg.displayId == null, click: () => update({ displayId: null }) },
        ...displays.map((d, i) => ({
          label: `Monitor ${i + 1} (${d.size.width}×${d.size.height})`,
          type: 'radio' as const,
          checked: cfg.displayId === d.id,
          click: () => update({ displayId: d.id }),
        })),
      ],
    },
    {
      label: 'Área do overlay',
      submenu: [
        { label: 'Só no painel (padrão)', type: 'radio', checked: cfg.background === 'panel', click: () => update({ background: 'panel' }) },
        { label: 'Tela toda — matriz de pontos', type: 'radio', checked: cfg.background === 'matrix', click: () => update({ background: 'matrix' }) },
        { label: 'Tela toda — transparente', type: 'radio', checked: cfg.background === 'transparent', click: () => update({ background: 'transparent' }) },
      ],
    },
    {
      label: 'Tamanho',
      submenu: [0.8, 0.9, 1, 1.15, 1.3].map((s) => ({
        label: `${Math.round(s * 100)}%`, type: 'radio' as const, checked: Math.abs(cfg.scale - s) < 0.01, click: () => update({ scale: s }),
      })),
    },
    {
      label: 'Ao trocar de música',
      submenu: [
        { label: 'Aparecer com fundo (completo)', type: 'radio', checked: cfg.peek === 'full', click: () => update({ peek: 'full' }) },
        { label: 'Aparecer só as capas (discreto)', type: 'radio', checked: cfg.peek === 'minimal', click: () => update({ peek: 'minimal' }) },
        { label: 'Não aparecer', type: 'radio', checked: cfg.peek === 'off', click: () => update({ peek: 'off' }) },
        { type: 'separator' },
        ...[3000, 5000, 8000].map((ms) => ({
          label: `Ficar ${ms / 1000} s na tela`, type: 'radio' as const, checked: cfg.peekMs === ms, click: () => update({ peekMs: ms }),
        })),
      ],
    },
    { label: 'Mostrar fila (Tocando agora)', type: 'checkbox', checked: cfg.showQueue, click: (i) => update({ showQueue: i.checked }) },
    { label: 'Mostrar abas (Recentes · Álbuns · Playlists)', type: 'checkbox', checked: cfg.showTabs, click: (i) => update({ showTabs: i.checked }) },
    { label: 'Abrir ao encostar o mouse na borda', type: 'checkbox', checked: cfg.hoverEdge, click: (i) => update({ hoverEdge: i.checked }) },
    { label: 'Iniciar com o sistema', type: 'checkbox', checked: getAutostart(), click: (i) => setAutostart(i.checked) },
    { label: 'Abrir pasta de configuração', click: () => shell.showItemInFolder(configPath()) },
    { label: 'Ver log', click: () => shell.openPath(logFile()) },
    { type: 'separator' },
    { label: 'Sair', click: () => app.quit() },
  ]));
}

// ---------------------------------------------------------------------------
// Autostart (Windows via API do Electron, Linux via ~/.config/autostart)
// ---------------------------------------------------------------------------
const linuxAutostartFile = path.join(os.homedir(), '.config', 'autostart', 'leitao-music.desktop');

function getAutostart(): boolean {
  if (isLinux) return fs.existsSync(linuxAutostartFile);
  return app.getLoginItemSettings().openAtLogin;
}

function setAutostart(on: boolean) {
  if (!isLinux) return app.setLoginItemSettings({ openAtLogin: on });
  if (!on) return fs.rmSync(linuxAutostartFile, { force: true });
  fs.mkdirSync(path.dirname(linuxAutostartFile), { recursive: true });
  fs.writeFileSync(linuxAutostartFile, [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Leitão Music',
    `Exec=${launchCommand()}`,
    'X-GNOME-Autostart-enabled=true',
    'X-GNOME-Autostart-Delay=3',
    '',
  ].join('\n'));
}

function launchCommand(extra = '') {
  const exec = process.env.APPIMAGE ?? process.execPath;
  return `"${exec}"${app.isPackaged ? '' : ` "${app.getAppPath()}"`}${extra ? ` ${extra}` : ''}`;
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
ipcMain.on('control', (_e, action: Control) => runControl(action));
ipcMain.on('closed', () => {
  if (!isOpen && !peeking) {
    win?.hide();
    win?.setIgnoreMouseEvents(false);
  }
});

ipcMain.handle('library', async () => {
  if (authState() !== 'ok') return [];
  if (libraryCache && Date.now() - libraryCache.at < 20_000) return libraryCache.items;
  try {
    const items = await spotify.library();
    libraryCache = { at: Date.now(), items };
    return items;
  } catch (e) {
    handleError(e, 'library');
    return libraryCache?.items ?? [];
  }
});

ipcMain.handle('queue', async () => {
  if (authState() !== 'ok') return { context: null, items: [] };
  try {
    return await spotify.queue(history);
  } catch (e) {
    handleError(e, 'queue');
    return { context: null, items: [] };
  }
});

ipcMain.handle('play-item', async (_e, item: LibraryItem) => {
  try {
    if (item.kind === 'track') await spotify.playQueueItem(item);
  } catch (e) {
    handleError(e, 'play-item');
  }
  schedulePoll(400);
});

ipcMain.handle('tracks', async (_e, item: LibraryItem) => {
  try {
    return await spotify.tracks(item);
  } catch (e) {
    handleError(e, 'tracks');
    return [];
  }
});

ipcMain.handle('play', async (_e, contextUri: string, trackUri: string) => {
  try {
    await spotify.playInContext(contextUri, trackUri);
  } catch (e) {
    handleError(e, 'play');
  }
  schedulePoll(400);
});

ipcMain.handle('get-client-id', () => cfg.clientId);
ipcMain.handle('save-client-id', async (_e, id: string) => {
  const clean = String(id).trim();
  if (!/^[a-f0-9]{32}$/i.test(clean)) return false;
  if (clean !== cfg.clientId) spotify.logout();
  cfg.clientId = clean;
  saveConfig(cfg);
  setupWin?.close();
  doLogin();
  return true;
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
// `leitao-music --toggle` numa segunda instância abre/fecha o overlay (útil pra atalho do GNOME no Wayland)
app.on('second-instance', (_e, argv) => {
  if (argv.includes('--toggle')) toggle();
  else open();
});
app.on('window-all-closed', () => { /* vive na bandeja */ });
app.on('will-quit', () => globalShortcut.unregisterAll());

app.whenReady().then(() => {
  cfg = loadConfig();
  spotify = new Spotify(() => cfg.clientId);

  // No Linux o compositor às vezes ignora a transparência se a janela nasce junto com o "ready".
  setTimeout(() => {
    createOverlay();
    buildTray();

    if (!globalShortcut.register(cfg.shortcut, toggle)) {
      console.warn(`[shortcut] não foi possível registrar ${cfg.shortcut}`);
    }
    if (isWayland) {
      console.info(`[wayland] atalhos globais podem não funcionar. Crie um atalho no GNOME com: ${launchCommand('--toggle')}`);
    }
    if (!cfg.clientId) openSetup();
    initCursor();
    console.info(`[boot] Leitão Music ${app.getVersion()} · ${process.platform} · ${isWayland ? 'wayland→xwayland' : 'x11/win'}`);
    poll(); // começa a escutar o Spotify
  }, isLinux ? 400 : 0);
});
