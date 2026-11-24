import type {
  AuthState, BridgeApi, LibraryItem, NowPlaying, OpenPayload, QueueContext, Side, Tab, TrackItem, VPos,
} from '../main/shared';

declare global {
  interface Window { leitao: BridgeApi }
}

const api = window.leitao;
const $ = (sel: string) => document.querySelector(sel) as HTMLElement;

const root = $('#root');
const bgSoft = $('.bg-soft');
const bgDots = $('.bg-dots');
const deck = $('#deck');
const labels = $('#labels');
const tabsEl = $('#tabs');
const ctxEl = $('#ctx');
const head = $('#album-head');
const headName = $('#album-head .name');
const tracksBox = $('#tracks');
const tracksInner = $('#tracks-inner');
const scrollBar = $('#scroll');
const scrollThumb = $('#scroll i');
const npBox = $('#np');
const npText = $('.np-text');
const hSelect = $('.h-select');
const hCancel = $('.h-cancel');
const toastEl = $('#toast');
const peekEl = $('#peek');
const peekCap = $('#peek .cap');
const peekT = $('#peek .t');
const peekS = $('#peek .s');

// ------------------------------------------------------------------ estado
type Mode = 'browse' | 'album' | 'peek';

let side: Side = 'left';
let vpos: VPos = 'center';
let scale = 1;
let panelMode = false;
let screenH = 1080;
let auth: AuthState = 'ok';
let mode: Mode = 'browse';
let isOpen = false;
let showQueue = true;
let showTabs = true;

let lib: LibraryItem[] = [];               // biblioteca inteira, com `section`
let queueItems: LibraryItem[] = [];        // anteriores → atual → próximas
let queueCtx: QueueContext | null = null;
let tab: Tab = 'queue';
let libLoading = false;
let queueLoading = false;

let items: LibraryItem[] = [];             // o que a pilha mostra agora
let index = 0;

let tracks: TrackItem[] = [];
let tIndex = 0;
let tracksFor: string | null = null;

let np: NowPlaying | null = null;

const coverEls = new Map<string, HTMLElement>();
const labelEls = new Map<string, HTMLElement>();

const TAB_LABEL: Record<Tab, string> = {
  queue: 'Tocando agora',
  recent: 'Recentes',
  albums: 'Álbuns',
  playlists: 'Playlists',
  all: 'Biblioteca',
};
const CTX_KIND: Record<QueueContext['kind'], string> = {
  album: 'Álbum', playlist: 'Playlist', artist: 'Artista', collection: 'Curtidas', other: '',
};

// ------------------------------------------------------------------ geometria
let U = 1;   // px por unidade
let C = 230; // tamanho da capa
let vw = innerWidth;
let vh = innerHeight;

function measure() {
  vw = innerWidth;
  vh = innerHeight;
  // mesma fórmula do main (overlayBounds): a escala vem da altura do monitor
  U = scale * Math.min(1.6, Math.max(0.7, (screenH || vh) / 1080));
  C = Math.round(230 * U);
  document.documentElement.style.setProperty('--u', `${U}px`);
}

const M = () => Math.round(64 * U); // margem até a borda

function centerY() {
  if (panelMode) return Math.round(vh * 0.5); // o painel já foi posicionado no topo/centro/baixo
  if (vpos === 'top') return Math.round(vh * 0.32);
  if (vpos === 'bottom') return Math.round(vh * 0.62);
  return Math.round(vh * 0.47);
}

/** Converte X do layout "lado esquerdo" para o lado escolhido. */
const X = (x: number, w: number) => (side === 'left' ? x : vw - x - w);

// posições das capas na pilha (em unidades de C), relativas à capa atual
const SLOTS: Record<number, { dx: number; dy: number; s: number; o: number }> = {
  [-3]: { dx: -0.5, dy: -0.95, s: 0.3, o: 0 },
  [-2]: { dx: -0.3, dy: -0.62, s: 0.46, o: 0.85 },
  [-1]: { dx: 0.16, dy: -0.3, s: 0.74, o: 0.92 },
  [0]: { dx: 0, dy: 0, s: 1, o: 1 },
  [1]: { dx: -0.06, dy: 0.36, s: 0.8, o: 0.92 },
  [2]: { dx: -0.22, dy: 0.66, s: 0.55, o: 0.6 },
  [3]: { dx: -0.38, dy: 0.95, s: 0.35, o: 0 },
};

function layout() {
  const m = M();
  const cy = centerY();
  const baseX = m;
  const baseY = cy - C / 2;

  // ---- capas
  items.forEach((it, i) => {
    const el = coverEl(it);
    el.style.width = el.style.height = `${C}px`;
    const d = i - index;
    let x: number, y: number, s: number, o: number;

    if (mode === 'album') {
      if (d === 0) {
        x = baseX + 2.15 * C; y = baseY; s = 1; o = 1;
      } else {
        const slot = SLOTS[Math.max(-3, Math.min(3, d))];
        x = baseX + slot.dx * C - 0.2 * C; y = baseY + slot.dy * C; s = slot.s * 0.8; o = 0;
      }
    } else {
      const slot = SLOTS[Math.max(-3, Math.min(3, d))];
      x = baseX + slot.dx * C; y = baseY + slot.dy * C; s = slot.s; o = Math.abs(d) > 3 ? 0 : slot.o;
    }

    if (!isOpen) { x -= 0.35 * C; o = 0; } // entra deslizando da borda
    const transform = `translate3d(${X(x, C)}px, ${y}px, 0) scale(${s})`;
    if (el.dataset.fresh) {
      // capa nova: nasce já na posição (sem atravessar a tela) e só aparece com fade
      el.style.transition = 'none';
      el.style.transform = transform;
      el.style.opacity = '0';
      void el.offsetWidth;
      el.style.transition = '';
      delete el.dataset.fresh;
    }
    el.style.transform = transform;
    el.style.opacity = String(o);
    el.style.zIndex = String(50 - Math.abs(d));
    el.style.pointerEvents = o > 0.1 && mode !== 'peek' ? 'auto' : 'none';
    el.classList.toggle('dim', d !== 0);
  });

  // ---- títulos (modo navegação)
  const lx = baseX + C + Math.round(40 * U);
  items.forEach((it, i) => {
    const el = labelEl(it);
    const d = i - index;
    const dy = d === 0 ? 0 : d * 0.42 * C;
    const o = mode !== 'browse' || !isOpen ? 0 : d === 0 ? 1 : Math.abs(d) === 1 ? 0.2 : 0;
    const h = el.offsetHeight || 60;
    const w = el.offsetWidth || 300;
    const slide = mode === 'album' ? -20 * U : 0;
    const transform = `translate3d(${X(lx + slide, w)}px, ${cy - h / 2 + dy}px, 0)`;
    if (el.dataset.fresh) {
      el.style.transition = 'none';
      el.style.transform = transform;
      el.style.opacity = '0';
      void el.offsetWidth;
      el.style.transition = '';
      delete el.dataset.fresh;
    }
    el.style.transform = transform;
    el.style.opacity = String(o);
    el.classList.toggle('current', d === 0);
  });
  layoutStatusLabel(lx, cy);
  {
    const w = peekEl.offsetWidth || 300;
    const h = peekEl.offsetHeight || 80;
    peekEl.style.transform = `translate3d(${X(lx, w)}px, ${cy - h / 2}px, 0)`;
    peekEl.style.opacity = mode === 'peek' && isOpen ? '1' : '0';
  }

  // ---- abas + "tocando de"
  {
    const showT = isOpen && mode === 'browse' && auth === 'ok' && tabsAvailable().length > 1;
    const top = panelMode ? Math.round(30 * U) : Math.max(Math.round(30 * U), Math.round(cy - 1.62 * C));
    const w = tabsEl.offsetWidth || 400;
    tabsEl.style.transform = `translate3d(${X(baseX, w)}px, ${top}px, 0)`;
    tabsEl.style.opacity = showT ? '1' : '0';
    tabsEl.style.pointerEvents = showT ? 'auto' : 'none';

    const showC = isOpen && mode === 'browse' && tab === 'queue' && !!queueCtx;
    const cw = ctxEl.offsetWidth || 300;
    const ctop = top + (showT ? (tabsEl.offsetHeight || 30) + Math.round(10 * U) : 0);
    ctxEl.style.transform = `translate3d(${X(baseX, cw)}px, ${ctop}px, 0)`;
    ctxEl.style.opacity = showC ? '1' : '0';
  }

  // ---- álbum aberto: título + lista
  const coverX = baseX + 2.15 * C;
  const listX = baseX + 0.1 * C;
  const listW = coverX - listX - 0.12 * C;
  head.style.width = `${listW}px`;
  head.style.transform = `translate3d(${X(listX, listW)}px, ${baseY + 0.02 * C}px, 0)`;

  const listTop = baseY + 0.3 * C;
  const listH = Math.max(3 * 54 * U, Math.min(vh - listTop - 110 * U, 9.5 * 54 * U));
  tracksBox.style.width = `${listW}px`;
  tracksBox.style.height = `${listH}px`;
  tracksBox.style.transform = `translate3d(${X(listX, listW)}px, ${listTop}px, 0)`;
  scrollTracks(listH);

  // ---- barra de rolagem (lado oposto, como no vídeo)
  const trackH = 2.4 * C;
  const total = mode === 'album' ? tracks.length : items.length;
  const pos = mode === 'album' ? tIndex : index;
  const thumbH = total > 1 ? Math.max(0.35 * C, trackH / Math.min(total, 6)) : 0;
  const ty = total > 1 ? (pos / (total - 1)) * (trackH - thumbH) : 0;
  scrollBar.style.height = `${trackH}px`;
  scrollBar.style.transform = `translate3d(${X(vw - 2 * m * 0.45, 2)}px, ${cy - trackH / 2}px, 0)`;
  scrollBar.style.opacity = isOpen && total > 1 && mode !== 'peek' ? '0.9' : '0';
  scrollThumb.style.height = `${thumbH}px`;
  scrollThumb.style.transform = `translateY(${ty}px)`;

  // ---- dicas
  const cur = items[index];
  hSelect.textContent = mode === 'album' ? 'Tocar'
    : auth !== 'ok' ? 'Conectar'
    : cur?.kind === 'track' ? (cur.offset === 0 ? (np?.isPlaying ? 'Pausar' : 'Tocar') : 'Tocar')
    : 'Abrir';
  hCancel.textContent = mode === 'album' ? 'Voltar' : 'Fechar';

  // ---- tinta do fundo acompanha o lado
  root.style.setProperty('--tint-x', side === 'left' ? '18%' : '82%');
}

function scrollTracks(listH: number) {
  const rowH = 54 * U;
  const visible = Math.floor(listH / rowH);
  const maxOff = Math.max(0, tracks.length - visible);
  const off = Math.min(maxOff, Math.max(0, tIndex - Math.floor(visible / 2)));
  tracksInner.style.transform = `translateY(${-off * rowH}px)`;
}

// ------------------------------------------------------------------ abas
function tabsAvailable(): Tab[] {
  if (!showTabs) return ['all'];
  return [...(showQueue ? (['queue'] as Tab[]) : []), 'recent', 'albums', 'playlists'];
}

function defaultTab(): Tab {
  const t = tabsAvailable();
  return t.includes('queue') ? 'queue' : t[0];
}

function renderTabs() {
  const list = tabsAvailable();
  tabsEl.innerHTML = '';
  if (list.length < 2) return;
  for (const t of list) {
    const b = document.createElement('button');
    b.className = 'tab' + (t === tab ? ' active' : '');
    b.textContent = TAB_LABEL[t];
    b.addEventListener('click', (e) => { e.stopPropagation(); switchTab(t); });
    tabsEl.appendChild(b);
  }
}

function renderCtx() {
  if (!queueCtx) { ctxEl.innerHTML = ''; return; }
  const kind = CTX_KIND[queueCtx.kind];
  ctxEl.innerHTML = '<span class="eq"><i></i><i></i><i></i></span><span class="by">Tocando de</span><span class="nm"></span><span class="kd"></span>';
  (ctxEl.querySelector('.nm') as HTMLElement).textContent = queueCtx.name;
  (ctxEl.querySelector('.kd') as HTMLElement).textContent = kind;
  (ctxEl.querySelector('.kd') as HTMLElement).hidden = !kind;
}

function listFor(t: Tab): LibraryItem[] {
  const sec = (...s: string[]) => lib.filter((i) => s.includes(i.section ?? ''));
  const uniq = (l: LibraryItem[]) => {
    const seen = new Set<string>();
    return l.filter((i) => (seen.has(i.uri) ? false : (seen.add(i.uri), true)));
  };
  switch (t) {
    case 'queue': return queueItems;
    case 'recent': return uniq(sec('playing', 'recent'));
    case 'albums': return sec('albums');
    case 'playlists': return sec('playlists');
    default: return uniq([...sec('playing'), ...sec('recent'), ...sec('albums'), ...sec('playlists')]);
  }
}

function defaultIndex(list: LibraryItem[]) {
  const q = list.findIndex((i) => i.kind === 'track' && i.offset === 0);
  if (q >= 0) return q;
  const p = playingIndexIn(list, np);
  return Math.max(0, p);
}

function switchTab(t: Tab, animate = true) {
  if (t === tab && items === listFor(t)) return;
  tab = t;
  renderTabs();
  if (mode === 'album') back();
  setItems(listFor(t), !animate);
  index = defaultIndex(items);
  updateAccent();
  requestAnimationFrame(() => requestAnimationFrame(layout));
  if (t === 'queue') loadQueue();
}

/**
 * Troca o conteúdo da pilha. Com `continuity`, capas que continuam na lista
 * (mesmo id) só deslizam até a nova posição — é assim que a fila "anda".
 */
function setItems(list: LibraryItem[], continuity: boolean) {
  const keep = new Set(list.map((i) => i.id));
  for (const [id, el] of [...coverEls]) {
    if (continuity && keep.has(id)) continue;
    fadeRemove(el);
    coverEls.delete(id);
  }
  for (const [id, el] of [...labelEls]) {
    if (continuity && keep.has(id)) continue;
    fadeRemove(el);
    labelEls.delete(id);
  }
  items = list;
  items.forEach((it) => { coverEl(it); labelEl(it); });
}

function fadeRemove(el: HTMLElement) {
  el.style.opacity = '0';
  el.style.pointerEvents = 'none';
  setTimeout(() => el.remove(), 450);
}

// ------------------------------------------------------------------ elementos
function coverEl(it: LibraryItem) {
  let el = coverEls.get(it.id);
  if (el) return el;
  el = document.createElement('div');
  el.className = 'cover';
  el.dataset.fresh = '1';
  if (it.cover) {
    const img = document.createElement('img');
    img.src = it.cover;
    img.draggable = false;
    el.appendChild(img);
  } else {
    el.innerHTML = '<div class="fallback">♪</div>';
  }
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    const i = items.findIndex((x) => x.id === it.id);
    if (mode !== 'browse' || i < 0) return;
    if (i === index) select();
    else go(i - index);
  });
  deck.appendChild(el);
  coverEls.set(it.id, el);
  return el;
}

function isPlayingItem(it: LibraryItem, n: NowPlaying | null) {
  if (!n) return false;
  if (it.kind === 'track') return it.offset === 0 || (it.offset === undefined && it.uri === n.uri);
  return n.contextUri === it.uri || n.albumUri === it.uri;
}

function labelEl(it: LibraryItem) {
  let el = labelEls.get(it.id);
  if (el) {
    (el.querySelector('.eq') as HTMLElement).style.display = isPlayingItem(it, np) ? '' : 'none';
    return el;
  }
  el = document.createElement('div');
  el.className = 'label';
  el.dataset.fresh = '1';
  el.innerHTML = `<div class="t"></div><div class="s"><span class="eq"><i></i><i></i><i></i></span><span></span></div>`;
  (el.querySelector('.t') as HTMLElement).textContent = it.name;
  (el.querySelector('.s span:last-child') as HTMLElement).textContent = it.subtitle;
  (el.querySelector('.eq') as HTMLElement).style.display = isPlayingItem(it, np) ? '' : 'none';
  el.addEventListener('click', (e) => { e.stopPropagation(); if (items[index]?.id === it.id) select(); });
  labels.appendChild(el);
  labelEls.set(it.id, el);
  return el;
}

// rótulo de estado (sem login / carregando / vazio)
const statusLabel = document.createElement('div');
statusLabel.className = 'label';
statusLabel.innerHTML = '<div class="t"></div><div class="s"></div><div class="btn" hidden></div>';
statusLabel.addEventListener('click', (e) => { e.stopPropagation(); select(); });
labels.appendChild(statusLabel);

function statusContent(): [string, string, string] | null {
  if (auth === 'no-client-id') return ['Configure o Spotify', 'Precisa de um Client ID do Spotify Developer', 'Configurar'];
  if (auth === 'logged-out') return ['Conecte o Spotify', 'Faça login pra ver sua biblioteca', 'Conectar'];
  if (items.length) return null;
  const loading = tab === 'queue' ? queueLoading : libLoading;
  if (loading) return ['Carregando…', tab === 'queue' ? 'Buscando a fila' : 'Buscando sua biblioteca', ''];
  switch (tab) {
    case 'queue': return ['Nada tocando', 'Dê play no Spotify em algum dispositivo', ''];
    case 'recent': return ['Nada recente', 'Ouça alguma coisa no Spotify', ''];
    case 'albums': return ['Nenhum álbum salvo', 'Salve álbuns no Spotify pra aparecerem aqui', ''];
    case 'playlists': return ['Nenhuma playlist sua', 'Só aparecem playlists que você criou ou colabora', ''];
    default: return ['Biblioteca vazia', 'Salve álbuns ou crie playlists no Spotify', ''];
  }
}

function layoutStatusLabel(lx: number, cy: number) {
  const c = statusContent();
  const show = !!c && isOpen && mode !== 'peek';
  statusLabel.style.opacity = show ? '1' : '0';
  statusLabel.style.pointerEvents = show && c?.[2] ? 'auto' : 'none';
  ghost.style.opacity = show ? '1' : '0';
  if (!c) return;
  (statusLabel.querySelector('.t') as HTMLElement).textContent = c[0];
  (statusLabel.querySelector('.s') as HTMLElement).textContent = c[1];
  const btn = statusLabel.querySelector('.btn') as HTMLElement;
  btn.hidden = !c[2];
  btn.textContent = c[2];
  const w = statusLabel.offsetWidth || 300;
  const h = statusLabel.offsetHeight || 80;
  // sem itens, mostra uma capa "fantasma" no lugar
  ghost.style.width = ghost.style.height = `${C}px`;
  ghost.style.transform = `translate3d(${X(M() - (isOpen ? 0 : 0.35 * C), C)}px, ${cy - C / 2}px, 0)`;
  statusLabel.style.transform = `translate3d(${X(lx, w)}px, ${cy - h / 2}px, 0)`;
}
const ghost = document.createElement('div');
ghost.className = 'cover placeholder';
ghost.style.pointerEvents = 'none';
deck.appendChild(ghost);

const PLAY_SVG = '<svg viewBox="0 0 24 24"><path d="M7 4v16l13-8z"/></svg>';
const EQ = '<span class="eq"><i></i><i></i><i></i></span>';

function renderTracks() {
  tracksInner.innerHTML = '';
  if (!tracks.length) {
    tracksInner.innerHTML = `<div class="empty-tracks">${tracksFor ? 'Sem faixas disponíveis' : 'Carregando faixas…'}</div>`;
    return;
  }
  tracks.forEach((t, i) => {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `
      <div class="meta"><div class="n"></div><div class="a">${t.explicit ? '<span class="e">E</span>' : ''}<span></span></div></div>
      <div class="go">${PLAY_SVG}${EQ}</div>`;
    (row.querySelector('.n') as HTMLElement).textContent = t.name;
    (row.querySelector('.a span:last-child') as HTMLElement).textContent = t.artists;
    row.addEventListener('mouseenter', () => { if (tIndex !== i) { tIndex = i; refreshRows(); layout(); } });
    row.addEventListener('click', (e) => { e.stopPropagation(); tIndex = i; playCurrent(); });
    tracksInner.appendChild(row);
    // entrada em cascata (desfocado → nítido), como no vídeo
    setTimeout(() => row.classList.add('in'), 260 + Math.min(i, 12) * 55);
  });
  refreshRows();
}

function refreshRows() {
  tracksInner.querySelectorAll<HTMLElement>('.row').forEach((r, i) => {
    r.classList.toggle('focus', i === tIndex);
    r.classList.toggle('playing', !!np && tracks[i]?.uri === np.uri);
  });
}

// ------------------------------------------------------------------ ações
function go(delta: number) {
  if (mode === 'browse') {
    if (!items.length) return;
    const ni = Math.max(0, Math.min(items.length - 1, index + delta));
    if (ni === index) return;
    index = ni;
    updateAccent();
  } else if (mode === 'album') {
    if (!tracks.length) return;
    tIndex = Math.max(0, Math.min(tracks.length - 1, tIndex + delta));
    refreshRows();
  }
  layout();
}

function cycleTab(delta: number) {
  const list = tabsAvailable();
  if (list.length < 2 || mode !== 'browse') return;
  const i = list.indexOf(tab);
  switchTab(list[(i + delta + list.length) % list.length]);
}

async function select() {
  if (mode === 'album') return playCurrent();
  if (auth === 'no-client-id') return api.control('setup');
  if (auth === 'logged-out') return api.control('login');
  const it = items[index];
  if (!it) return;

  // faixa da fila: toca direto (atual = play/pause)
  if (it.kind === 'track') {
    if (it.offset === 0) return api.control('toggle');
    await api.playItem(it);
    setTimeout(loadQueue, 700);
    return;
  }

  mode = 'album';
  root.classList.replace('mode-browse', 'mode-album');
  headName.textContent = it.name;
  tracks = [];
  tIndex = 0;
  tracksFor = null;
  renderTracks();
  layout();
  requestAnimationFrame(() => head.classList.add('show'));

  const list = await api.tracks(it);
  if (mode !== 'album' || items[index] !== it) return; // usuário saiu nesse meio tempo
  tracks = list;
  tracksFor = it.uri;
  const playingIdx = np ? list.findIndex((t) => t.uri === np!.uri) : -1;
  tIndex = playingIdx >= 0 ? playingIdx : 0;
  renderTracks();
  layout();
}

function back() {
  if (mode === 'album') {
    mode = 'browse';
    root.classList.replace('mode-album', 'mode-browse');
    head.classList.remove('show');
    tracksInner.querySelectorAll('.row').forEach((r) => r.classList.remove('in'));
    layout();
  } else {
    api.control('close');
  }
}

async function playCurrent() {
  const it = items[index];
  const t = tracks[tIndex];
  if (!it || !t) return;
  await api.play(it.uri, t.uri);
}

// ------------------------------------------------------------------ cor da capa → tinta do fundo
const accentCache = new Map<string, string>();
function updateAccent() {
  const url = items[index]?.cover ?? np?.cover;
  if (!url) return;
  const cached = accentCache.get(url);
  if (cached) return root.style.setProperty('--accent', cached);
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    try {
      const c = document.createElement('canvas');
      c.width = c.height = 16;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(img, 0, 0, 16, 16);
      const d = ctx.getImageData(0, 0, 16, 16).data;
      // média ponderada pela saturação (ignora cinzas)
      let r = 0, g = 0, b = 0, wsum = 0;
      for (let i = 0; i < d.length; i += 4) {
        const mx = Math.max(d[i], d[i + 1], d[i + 2]);
        const mn = Math.min(d[i], d[i + 1], d[i + 2]);
        const w = (mx - mn) / 255 + 0.05;
        r += d[i] * w; g += d[i + 1] * w; b += d[i + 2] * w; wsum += w;
      }
      const v = `${Math.round(r / wsum)}, ${Math.round(g / wsum)}, ${Math.round(b / wsum)}`;
      accentCache.set(url, v);
      if (items[index]?.cover === url) root.style.setProperty('--accent', v);
    } catch { /* CDN sem CORS: mantém a cor atual */ }
  };
  img.src = url;
}

/** O item da lista que corresponde ao que está tocando (contexto ou álbum da faixa). */
function playingIndexIn(list: LibraryItem[], n: NowPlaying | null) {
  if (!n) return -1;
  let i = n.contextUri ? list.findIndex((it) => it.uri === n.contextUri) : -1;
  if (i < 0 && n.albumUri) i = list.findIndex((it) => it.uri === n.albumUri);
  return i;
}

// ------------------------------------------------------------------ carregamento
async function loadLibrary() {
  if (auth !== 'ok') return;
  libLoading = true;
  if (tab !== 'queue') layout();
  lib = await api.library();
  libLoading = false;
  if (tab === 'queue' || mode === 'peek') return;
  const curId = items[index]?.id;
  setItems(listFor(tab), true);
  const keepAt = items.findIndex((i) => i.id === curId);
  index = keepAt >= 0 ? keepAt : defaultIndex(items);
  updateAccent();
  requestAnimationFrame(() => requestAnimationFrame(layout));
}

let queueSeq = 0;
async function loadQueue() {
  if (auth !== 'ok' || !showQueue) return;
  const seq = ++queueSeq;
  queueLoading = true;
  if (!queueItems.length) layout();
  const data = await api.queue();
  if (seq !== queueSeq) return; // chegou uma mais nova
  queueLoading = false;
  queueItems = data.items;
  queueCtx = data.context;
  renderCtx();
  if (tab !== 'queue') return;
  setItems(queueItems, true);
  index = defaultIndex(items);
  updateAccent();
  setPeekCaption();
  requestAnimationFrame(() => requestAnimationFrame(layout));
}

function clearAll() {
  setItems([], false);
  lib = [];
  queueItems = [];
  queueCtx = null;
  index = 0;
}

// ------------------------------------------------------------------ abrir / fechar
function applyPayload(p: OpenPayload) {
  side = p.side;
  vpos = p.vpos;
  scale = p.scale;
  auth = p.auth;
  panelMode = p.panel;
  screenH = p.screenH;
  showQueue = p.showQueue;
  showTabs = p.showTabs;
  root.classList.toggle('panel-mode', p.panel);
  root.classList.toggle('side-left', side === 'left');
  root.classList.toggle('side-right', side === 'right');
  applyBg(p.bg);
  measure();
}

api.onOpen((p: OpenPayload) => {
  const fromPeek = mode === 'peek' && isOpen;
  applyPayload(p);
  root.classList.remove('mode-peek', 'peek-minimal');

  tracks = [];
  tracksFor = null;
  tracksInner.innerHTML = '';
  if (auth !== 'ok') clearAll();
  mode = 'browse';
  root.classList.remove('mode-album');
  root.classList.add('mode-browse');
  head.classList.remove('show');

  // aba inicial: "Tocando agora" (se ligada); vindo do peek, continua na fila
  const startTab = fromPeek && tab === 'queue' && tabsAvailable().includes('queue') ? 'queue' : defaultTab();
  if (startTab !== tab || !items.length) {
    tab = startTab;
    setItems(listFor(tab), false);
    index = defaultIndex(items);
  }
  renderTabs();
  renderCtx();

  loadLibrary();
  if (tab === 'queue') loadQueue();

  if (fromPeek) { layout(); return; } // já está na tela: só vira interativo
  isOpen = false;
  layout(); // posição "fora da tela"
  requestAnimationFrame(() => {
    isOpen = true;
    root.classList.add('open');
    requestAnimationFrame(layout);
  });
});

function applyBg(bg: string | null) {
  if (bg === 'keep') return;
  root.classList.toggle('no-shot', !bg);
  bgSoft.style.backgroundImage = bg ? `url("${bg}")` : '';
  bgDots.style.backgroundImage = bg ? `url("${bg}")` : '';
}

// ------------------------------------------------------------------ modo escuta (peek)
// A música mudou: o overlay aparece sozinho (sem foco). Com a fila ligada, a
// pilha mostra anteriores (pra cima) → atual (centro) → próximas (pra baixo) e
// desliza uma posição. Sem a fila, desliza até o álbum/playlist que está tocando.
const TEMP = 'np:';

api.onPeek(async ({ open, np: n }) => {
  setNowPlaying(n);
  const first = !!open;

  if (open) {
    applyPayload(open);
    root.classList.add('mode-peek');
    root.classList.remove('mode-browse', 'mode-album');
    root.classList.toggle('peek-minimal', open.peek === 'minimal');
    mode = 'peek';
    tracksInner.innerHTML = '';
    head.classList.remove('show');
  }
  setPeekText(n, !first);

  if (showQueue) return peekQueue(first);
  return peekAlbum(n, first);
});

async function peekQueue(first: boolean) {
  const wasQueue = tab === 'queue';
  tab = 'queue';
  if (first || !wasQueue) {
    // mostra o que já tinha (se tinha) enquanto busca a fila nova
    setItems(queueItems, wasQueue);
    index = defaultIndex(items);
  }
  if (first) {
    isOpen = false;
    layout();
    requestAnimationFrame(() => {
      isOpen = true;
      root.classList.add('open');
      layout();
    });
  }
  await loadQueue();
}

async function peekAlbum(n: NowPlaying, first: boolean) {
  if (tab !== 'all' || first) {
    tab = 'all';
    if (!lib.length && auth === 'ok') lib = await api.library();
    setItems(listFor('all'), false);
  }

  // remove capa temporária de um peek anterior
  const tempIdx = items.findIndex((i) => i.id.startsWith(TEMP));
  if (tempIdx >= 0) {
    const [t] = items.splice(tempIdx, 1);
    if (index > tempIdx) index--;
    removeEls(t.id);
  }

  let target = playingIndexIn(items, n);
  if (target < 0) {
    // não está na biblioteca: entra uma capa temporária logo depois da atual
    const temp: LibraryItem = {
      id: TEMP + n.id, uri: TEMP + n.uri, kind: 'album', name: n.album || n.title, subtitle: n.artist, cover: n.cover,
    };
    target = Math.min(items.length, index + 1);
    items = [...items.slice(0, target), temp, ...items.slice(target)];
    coverEl(temp); labelEl(temp);
  }

  if (first) {
    index = Math.max(0, target - 1);
    isOpen = false;
    layout();
    requestAnimationFrame(() => {
      isOpen = true;
      root.classList.add('open');
      layout();
      setTimeout(() => { index = target; updateAccent(); layout(); }, 220);
    });
  } else {
    if (index === target) replay(coverEls.get(items[index].id)!, 'bump');
    index = target;
    updateAccent();
    layout();
  }
}

function setPeekText(n: NowPlaying, animate: boolean) {
  peekT.textContent = n.title;
  peekS.textContent = [n.artist, n.album].filter(Boolean).join(' • ');
  setPeekCaption();
  if (animate) replay(peekEl, 'swap');
  requestAnimationFrame(layout);
}

function setPeekCaption() {
  peekCap.textContent = showQueue && queueCtx ? `Tocando agora · ${queueCtx.name}` : 'Tocando agora';
}

function replay(el: HTMLElement, cls: string) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

function removeEls(id: string) {
  coverEls.get(id)?.remove(); coverEls.delete(id);
  labelEls.get(id)?.remove(); labelEls.delete(id);
}

api.onClose(() => {
  isOpen = false;
  root.classList.remove('open');
  head.classList.remove('show');
  layout();
  setTimeout(() => {
    if (!isOpen) {
      bgSoft.style.backgroundImage = bgDots.style.backgroundImage = ''; // libera o print da memória
      if (mode === 'peek') { mode = 'browse'; root.classList.remove('mode-peek', 'peek-minimal'); root.classList.add('mode-browse'); }
      api.closed();
    }
  }, 320);
});

// ------------------------------------------------------------------ tocando agora
api.onNowPlaying((n) => setNowPlaying(n));

function setNowPlaying(n: NowPlaying | null) {
  const trackChanged = n?.uri !== np?.uri;
  const changed = trackChanged || n?.contextUri !== np?.contextUri;
  np = n;
  root.classList.toggle('is-playing', !!n?.isPlaying);
  npBox.classList.toggle('show', !!n);
  if (n) npText.textContent = `${n.title} — ${n.artist}`;
  if (changed) {
    items.forEach((it) => labelEl(it)); // atualiza os equalizadores
    refreshRows();
  }
  // aberto pelo usuário na aba "Tocando agora": a fila anda junto com a música
  if (trackChanged && isOpen && mode === 'browse' && tab === 'queue') loadQueue();
  if (n && mode === 'peek' && isOpen && changed) setPeekText(n, true);
}

// ------------------------------------------------------------------ teclado / mouse / gamepad
addEventListener('keydown', (e) => {
  if (!isOpen || mode === 'peek') return;
  switch (e.key) {
    case 'ArrowUp': case 'k': case 'w': go(-1); break;
    case 'ArrowDown': case 'j': case 's': go(1); break;
    case 'PageUp': go(-5); break;
    case 'PageDown': go(5); break;
    case 'Home': go(-1e6); break;
    case 'End': go(1e6); break;
    case 'Tab': cycleTab(e.shiftKey ? -1 : 1); break;
    case '1': case '2': case '3': case '4': {
      const t = tabsAvailable()[Number(e.key) - 1];
      if (t && mode === 'browse') switchTab(t);
      break;
    }
    case 'Enter': select(); break;
    case 'Escape': case 'Backspace': back(); break;
    case ' ': api.control('toggle'); break;
    case 'ArrowLeft': api.control(side === 'left' ? 'prev' : 'next'); break;
    case 'ArrowRight': api.control(side === 'left' ? 'next' : 'prev'); break;
    case 'MediaPlayPause': api.control('toggle'); break;
    case 'MediaTrackNext': api.control('next'); break;
    case 'MediaTrackPrevious': api.control('prev'); break;
    default: return;
  }
  e.preventDefault();
});

let wheelAcc = 0;
let wheelAt = 0;
addEventListener('wheel', (e) => {
  if (!isOpen || mode === 'peek') return;
  const now = performance.now();
  if (now - wheelAt > 250) wheelAcc = 0;
  wheelAt = now;
  wheelAcc += e.deltaY;
  if (Math.abs(wheelAcc) >= 60) {
    go(Math.sign(wheelAcc));
    wheelAcc = 0;
  }
}, { passive: true });

// clique no "vazio": volta / fecha
root.addEventListener('click', () => isOpen && mode !== 'peek' && back());

// Gamepad (layout PlayStation/Xbox padrão): cruz/A = selecionar, bola/B = voltar, L1/R1 = abas
const padState: Record<number, number> = {};
function pollPad() {
  requestAnimationFrame(pollPad);
  if (!isOpen || mode === 'peek') return;
  const gp = navigator.getGamepads?.().find(Boolean);
  if (!gp) return;
  const now = performance.now();
  const btn = (i: number, fn: () => void, repeat = false) => {
    const pressed = gp.buttons[i]?.pressed;
    if (!pressed) { delete padState[i]; return; }
    const since = padState[i];
    if (since === undefined) { padState[i] = now; fn(); }
    else if (repeat && now - since > 350) { padState[i] = now - 350 + 110; fn(); }
  };
  btn(12, () => go(-1), true);
  btn(13, () => go(1), true);
  btn(0, select);
  btn(1, back);
  btn(4, () => cycleTab(-1));
  btn(5, () => cycleTab(1));
  btn(14, () => api.control('prev'));
  btn(15, () => api.control('next'));
  btn(9, () => api.control('toggle'));
  // analógico esquerdo
  const ay = gp.axes[1] ?? 0;
  if (Math.abs(ay) > 0.6) {
    const t = padState[-1];
    if (t === undefined || now - t > 160) { padState[-1] = now; go(ay > 0 ? 1 : -1); }
  } else delete padState[-1];
}
requestAnimationFrame(pollPad);

// ------------------------------------------------------------------ toast
let toastTimer: number | undefined;
api.onToast((msg) => {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove('show'), 2800);
});

addEventListener('resize', () => { measure(); layout(); });
measure();
