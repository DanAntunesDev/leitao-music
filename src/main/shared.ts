// Tipos compartilhados entre main, preload e renderer.

export type Anchor =
  | 'left-top' | 'left-center' | 'left-bottom'
  | 'right-top' | 'right-center' | 'right-bottom';

export type Side = 'left' | 'right';
export type VPos = 'top' | 'center' | 'bottom';

export interface NowPlaying {
  id: string;
  uri: string;
  title: string;
  artist: string;
  album: string;
  albumUri: string | null;
  cover: string | null;
  contextUri: string | null;
  durationMs: number;
  progressMs: number;
  isPlaying: boolean;
  fetchedAt: number;
}

export type Section = 'playing' | 'recent' | 'albums' | 'playlists' | 'queue';

export interface LibraryItem {
  id: string;          // chave única na lista (também usada pra animar a mesma capa entre atualizações)
  uri: string;
  kind: 'album' | 'playlist' | 'track';
  name: string;
  subtitle: string;    // "Álbum • 2018" / "Playlist • 34 faixas" / artistas da faixa
  cover: string | null;
  section?: Section;
  offset?: number;     // fila: <0 já tocou, 0 tocando, >0 próxima
  contextUri?: string | null;
}

export interface QueueContext {
  uri: string;
  kind: 'album' | 'playlist' | 'artist' | 'collection' | 'other';
  name: string;
}

export interface QueueData {
  context: QueueContext | null;
  items: LibraryItem[]; // anteriores (offset<0) → atual (0) → próximas (>0)
}

export type Tab = 'queue' | 'recent' | 'albums' | 'playlists' | 'all';

export interface TrackItem {
  uri: string;
  name: string;
  artists: string;
  explicit: boolean;
  durationMs: number;
}

export type AuthState = 'no-client-id' | 'logged-out' | 'ok';

export interface OpenPayload {
  side: Side;
  vpos: VPos;
  scale: number;
  bg: string | null;   // dataURL do print (modos panel/matrix), 'keep' (reaproveita) ou null (transparente)
  panel: boolean;      // janela do tamanho do painel (não ocupa a tela toda)
  screenH: number;     // altura do monitor: base da escala da UI nos dois modos
  auth: AuthState;
  peek?: 'full' | 'minimal'; // aberto sozinho pela troca de música (sem foco, click-through)
  showQueue: boolean;  // aba/peek "Tocando agora" com a fila
  showTabs: boolean;   // abas clicáveis (senão, lista única)
}

export type Control = 'prev' | 'next' | 'toggle' | 'login' | 'setup' | 'close';

export interface BridgeApi {
  onOpen(cb: (p: OpenPayload) => void): void;
  onPeek(cb: (p: { open: OpenPayload | null; np: NowPlaying }) => void): void;
  onClose(cb: () => void): void;
  onNowPlaying(cb: (np: NowPlaying | null) => void): void;
  onToast(cb: (msg: string) => void): void;
  library(): Promise<LibraryItem[]>;
  queue(): Promise<QueueData>;
  playItem(item: LibraryItem): Promise<void>;
  tracks(item: LibraryItem): Promise<TrackItem[]>;
  play(contextUri: string, trackUri: string): Promise<void>;
  control(action: Control): void;
  closed(): void;
  saveClientId(id: string): Promise<boolean>;
  getClientId(): Promise<string>;
}
