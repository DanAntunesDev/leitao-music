import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { app, net, safeStorage, shell } from 'electron';
import type { LibraryItem, NowPlaying, QueueContext, QueueData, TrackItem } from "./shared";

const REDIRECT_PORT = 8888;
export const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/callback`;
const SCOPES = [
  'user-read-currently-playing',
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-recently-played',
  'user-library-read',
  'playlist-read-private',
  'playlist-read-collaborative',
].join(' ');

interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  scope?: string;
}

export class SpotifyError extends Error {
  constructor(public status: number, message: string, public retryAfterMs = 0) {
    super(message);
  }
}

const b64url = (buf: Buffer) => buf.toString('base64url');
/**
 * Requisições pela pilha de rede do Chromium (net.fetch): mesma DNS/proxy/IPv6
 * do navegador. O fetch do Node falhava em algumas redes com "fetch failed".
 * Em erro, anexa a causa real (ex.: ENOTFOUND, ETIMEDOUT, ERR_NAME_NOT_RESOLVED).
 */
async function http_(url: string, init: RequestInit): Promise<Response> {
  try {
    return await net.fetch(url, init as any);
  } catch (e: any) {
    const cause = e?.cause ? ` (${e.cause.code ?? ''} ${e.cause.message ?? e.cause}`.trimEnd() + ')' : '';
    const err = new Error(`${e?.message ?? e}${cause} — ${new URL(url).host}`);
    console.error('[net]', err.message);
    throw err;
  }
}

const escapeHtml = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const CALLBACK_PAGE = (ok: boolean, msg: string) => `<!doctype html><meta charset="utf-8">
<title>Leitão Music</title>
<body style="font-family:system-ui;background:#111;color:#eee;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><h2>${ok ? '✅ Conectado!' : '❌ Falhou'}</h2><p>${msg}</p></div></body>`;

export class Spotify {
  private tokens: Tokens | null;
  private refreshing: Promise<void> | null = null;
  private loginInFlight: Promise<void> | null = null;
  private file = path.join(app.getPath('userData'), 'tokens.bin');

  constructor(private clientId: () => string) {
    this.tokens = this.load();
  }

  get isLoggedIn() {
    return !!this.tokens && this.hasAllScopes;
  }

  /** Token salvo foi concedido com todos os escopos que o app usa hoje? */
  get hasAllScopes() {
    const granted = new Set((this.tokens?.scope ?? '').split(' '));
    return SCOPES.split(' ').every((sc) => granted.has(sc));
  }

  logout() {
    this.tokens = null;
    fs.rmSync(this.file, { force: true });
  }

  // ---------- OAuth (Authorization Code + PKCE) ----------

  login(): Promise<void> {
    this.loginInFlight ??= this.doLogin().finally(() => (this.loginInFlight = null));
    return this.loginInFlight;
  }

  private async doLogin() {
    const clientId = this.clientId();
    if (!clientId) throw new Error('Client ID não configurado');

    const verifier = b64url(crypto.randomBytes(64));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state = b64url(crypto.randomBytes(16));

    const authUrl = new URL('https://accounts.spotify.com/authorize');
    authUrl.search = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: REDIRECT_URI,
      code_challenge_method: 'S256',
      code_challenge: challenge,
      scope: SCOPES,
      state,
    }).toString();

    // O servidor só responde ao navegador DEPOIS de trocar o código pelo token,
    // então a página mostra o resultado real. Callbacks de abas antigas (state
    // diferente) são ignorados sem derrubar o login em andamento.
    await new Promise<void>((resolve, reject) => {
      let done = false;
      const finish = (err?: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        setTimeout(() => server.close(), 500);
        err ? reject(err) : resolve();
      };

      const server = http.createServer(async (req, res) => {
        const url = new URL(req.url ?? '/', REDIRECT_URI);
        if (url.pathname !== '/callback') {
          res.writeHead(404).end();
          return;
        }
        const page = (ok: boolean, msg: string) =>
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(CALLBACK_PAGE(ok, msg));

        if (url.searchParams.get('state') !== state) {
          page(false, 'Este link de login é de uma tentativa antiga. Use a aba mais recente ou tente de novo pelo app.');
          return; // continua esperando o callback certo
        }
        const err = url.searchParams.get('error');
        if (err) {
          page(false, err === 'access_denied' ? 'Você recusou o acesso.' : `Spotify retornou: ${err}`);
          return finish(new Error(`authorize: ${err}`));
        }
        try {
          await this.tokenRequest({
            grant_type: 'authorization_code',
            code: url.searchParams.get('code') ?? '',
            redirect_uri: REDIRECT_URI,
            client_id: clientId,
            code_verifier: verifier,
          });
          const me = await this.api('GET', '/me').catch(() => null);
          page(true, `${me?.display_name ? `Olá, ${escapeHtml(me.display_name)}! ` : ''}Pode fechar esta aba.`);
          finish();
        } catch (e) {
          const msg = (e as Error).message;
          page(false, `Não consegui trocar o código pelo token.<br><small>${escapeHtml(msg)}</small>`);
          finish(e as Error);
        }
      });

      const timer = setTimeout(() => finish(new Error('Tempo esgotado esperando o login')), 5 * 60_000);
      server.on('error', (e: NodeJS.ErrnoException) =>
        finish(e.code === 'EADDRINUSE' ? new Error('Porta 8888 ocupada por outro programa') : e));
      server.listen(REDIRECT_PORT, '127.0.0.1', () => shell.openExternal(authUrl.toString()));
    });
  }

  private async tokenRequest(params: Record<string, string>) {
    const res = await http_('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });
    if (!res.ok) {
      const txt = await res.text();
      if (params.grant_type === 'refresh_token' && res.status === 400) this.logout(); // refresh revogado
      throw new SpotifyError(res.status, `token: ${txt}`);
    }
    const j = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number; scope?: string };
    this.tokens = {
      access_token: j.access_token,
      refresh_token: j.refresh_token ?? this.tokens?.refresh_token ?? '',
      expires_at: Date.now() + (j.expires_in - 60) * 1000,
      scope: j.scope ?? this.tokens?.scope,
    };
    this.save();
  }

  private refresh(): Promise<void> {
    if (!this.tokens) return Promise.reject(new SpotifyError(401, 'deslogado'));
    this.refreshing ??= this.tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: this.tokens.refresh_token,
      client_id: this.clientId(),
    }).finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  // ---------- persistência (criptografada quando o SO permite) ----------

  private save() {
    const raw = JSON.stringify(this.tokens);
    const data = safeStorage.isEncryptionAvailable()
      ? Buffer.concat([Buffer.from('ENC1'), safeStorage.encryptString(raw)])
      : Buffer.from(raw);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, data, { mode: 0o600 });
  }

  private load(): Tokens | null {
    try {
      const data = fs.readFileSync(this.file);
      const raw = data.subarray(0, 4).toString() === 'ENC1'
        ? safeStorage.decryptString(data.subarray(4))
        : data.toString();
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  // ---------- Web API ----------

  private async api(method: string, endpoint: string, body?: unknown, retry = true): Promise<any> {
    if (!this.tokens) throw new SpotifyError(401, 'deslogado');
    if (Date.now() >= this.tokens.expires_at) await this.refresh();

    const url = endpoint.startsWith('https://') ? endpoint : `https://api.spotify.com/v1${endpoint}`;
    const res = await http_(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.tokens!.access_token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (res.status === 401 && retry) {
      await this.refresh();
      return this.api(method, endpoint, body, false);
    }
    if (res.status === 429) {
      const s = Number(res.headers.get('Retry-After') ?? 5);
      throw new SpotifyError(429, 'rate limit', s * 1000);
    }
    if (res.status === 204 || res.status === 202) return null;
    if (!res.ok) throw new SpotifyError(res.status, await res.text());
    const txt = await res.text();
    return txt ? JSON.parse(txt) : null;
  }

  /** Percorre a paginação (`next`) até `max` itens. */
  private async paged(first: string, max: number): Promise<any[]> {
    const out: any[] = [];
    let url: string | null = first;
    while (url && out.length < max) {
      const page: any = await this.api('GET', url);
      out.push(...(page?.items ?? []));
      url = page?.next ?? null;
    }
    return out.slice(0, max);
  }

  async nowPlaying(): Promise<NowPlaying | null> {
    const j = await this.api('GET', '/me/player?additional_types=episode');
    const item = j?.item;
    if (!item) return null;
    const isEpisode = item.type === 'episode';
    const images = isEpisode ? item.images ?? item.show?.images : item.album?.images;
    return {
      id: item.id ?? item.uri,
      uri: item.uri,
      title: item.name,
      artist: isEpisode ? item.show?.name ?? '' : (item.artists ?? []).map((a: any) => a.name).join(', '),
      album: isEpisode ? item.show?.name ?? '' : item.album?.name ?? '',
      albumUri: isEpisode ? item.show?.uri ?? null : item.album?.uri ?? null,
      cover: pickImage(images),
      contextUri: j.context?.uri ?? null,
      durationMs: item.duration_ms ?? 0,
      progressMs: j.progress_ms ?? 0,
      isPlaying: !!j.is_playing,
      fetchedAt: Date.now(),
    };
  }

  /** Álbuns salvos + playlists do usuário (só as que ele criou/colabora, por causa das regras de Dev Mode). */
  /**
   * Ordem da pilha:
   *   1. álbum que está tocando agora (mesmo que não esteja salvo)
   *   2. álbuns das últimas 50 músicas ouvidas (sem repetir)
   *   3. álbuns salvos
   *   4. playlists que o usuário criou/colabora (Dev Mode só lista faixas dessas)
   */
  async library(): Promise<LibraryItem[]> {
    const warn = (tag: string) => (e: Error) => (console.error(`[${tag}]`, e.message), null);
    const [me, player, recent, albums, playlists] = await Promise.all([
      this.api('GET', '/me').catch(warn('me')),
      this.api('GET', '/me/player').catch(warn('player')),
      this.api('GET', '/me/player/recently-played?limit=50').catch(warn('recent')),
      this.paged('/me/albums?limit=50', 100).catch(warn('albums')),
      this.paged('/me/playlists?limit=50', 100).catch(warn('playlists')),
    ]);

    const out: LibraryItem[] = [];
    const seen = new Set<string>();
    // o mesmo álbum pode estar em "recentes" e em "salvos": dedup só dentro de cada seção
    const push = (it: LibraryItem | null, section: LibraryItem['section']) => {
      if (!it || seen.has(`${section}|${it.uri}`)) return;
      seen.add(`${section}|${it.uri}`);
      out.push({ ...it, section });
    };
    const albumItem = (a: any, tag?: string): LibraryItem | null =>
      a?.uri?.startsWith('spotify:album:')
        ? {
            id: a.id,
            uri: a.uri,
            kind: 'album',
            name: a.name,
            subtitle: [tag, a.album_type === 'single' ? 'Single' : 'Álbum', String(a.release_date ?? '').slice(0, 4)].filter(Boolean).join(' • '),
            cover: pickImage(a.images),
          }
        : null;

    // 1. tocando agora
    if (player?.item?.type === 'track') push(albumItem(player.item.album, 'Tocando agora'), 'playing');

    // 2. ouvidos recentemente
    for (const h of recent?.items ?? []) push(albumItem(h.track?.album, 'Recente'), 'recent');

    // 3. álbuns salvos
    for (const s of albums ?? []) {
      const a = s?.album;
      if (!a) continue;
      this.albumCache.set(a.uri, a.tracks?.items ?? []);
      push(albumItem(a), 'albums');
    }

    // 4. playlists próprias
    for (const p of playlists ?? []) {
      if (!p || !(p.owner?.id === me?.id || p.collaborative)) continue;
      const total = p.items?.total ?? p.tracks?.total;
      push({
        id: p.id,
        uri: p.uri,
        kind: 'playlist',
        name: p.name,
        subtitle: total != null ? `Playlist • ${total} faixas` : 'Playlist',
        cover: pickImage(p.images),
      }, 'playlists');
    }
    return out;
  }

  private albumCache = new Map<string, any[]>();
  private contextNames = new Map<string, string>();

  /**
   * Fila: anteriores (histórico local da sessão + recently-played) → atual → próximas (/me/player/queue).
   * `localPrev`: faixas que o app viu tocando nesta sessão, da mais recente pra mais antiga —
   * o recently-played do Spotify demora a registrar a faixa que acabou de passar.
   */
  async queue(localPrev: LibraryItem[]): Promise<QueueData> {
    const warn = (tag: string) => (e: Error) => (console.error(`[${tag}]`, e.message), null);
    const [player, q, recent] = await Promise.all([
      this.api('GET', '/me/player?additional_types=episode').catch(warn('player')),
      this.api('GET', '/me/player/queue').catch(warn('queue')),
      this.api('GET', '/me/player/recently-played?limit=15').catch(warn('recent')),
    ]);
    const cur = player?.item ?? q?.currently_playing ?? null;
    const ctxUri: string | null = player?.context?.uri ?? null;

    const used = new Map<string, number>();
    const key = (uri: string) => {
      const n = used.get(uri) ?? 0;
      used.set(uri, n + 1);
      return n ? `${uri}#${n}` : uri;
    };
    const track = (t: any, offset: number, contextUri: string | null): LibraryItem => ({
      id: '',
      uri: t.uri,
      kind: 'track',
      name: t.name,
      subtitle: (t.artists ?? []).map((a: any) => a.name).join(', ') || t.show?.name || '',
      cover: pickImage(t.album?.images ?? t.images ?? t.show?.images),
      section: 'queue',
      offset,
      contextUri,
    });

    const items: LibraryItem[] = [];
    // atual primeiro (pra ficar com a chave "limpa" e animar quando virar anterior)
    if (cur?.uri) items.push({ ...track(cur, 0, ctxUri), id: key(cur.uri) });

    // anteriores: histórico local + recently-played, sem repetir e sem a atual
    const prevRaw: LibraryItem[] = [...localPrev];
    for (const h of recent?.items ?? []) if (h.track?.uri) prevRaw.push(track(h.track, -1, h.context?.uri ?? null));
    const seenPrev = new Set<string>([cur?.uri]);
    const prev: LibraryItem[] = [];
    for (const p of prevRaw) {
      if (seenPrev.has(p.uri)) continue;
      seenPrev.add(p.uri);
      prev.push(p);
      if (prev.length >= 8) break;
    }
    prev.forEach((p, i) => items.unshift({ ...p, section: 'queue', offset: -(i + 1), id: key(p.uri) }));

    // próximas
    (q?.queue ?? []).slice(0, 15).forEach((t: any, i: number) => {
      if (t?.uri) items.push({ ...track(t, i + 1, ctxUri), id: key(t.uri) });
    });

    items.sort((a, b) => (a.offset ?? 0) - (b.offset ?? 0));
    return { context: ctxUri ? await this.contextOf(ctxUri, cur) : null, items };
  }

  private async contextOf(uri: string, cur: any): Promise<QueueContext> {
    const [, type, id] = uri.split(':');
    const kind: QueueContext['kind'] = uri.endsWith(':collection') ? 'collection'
      : type === 'album' ? 'album' : type === 'playlist' ? 'playlist' : type === 'artist' ? 'artist' : 'other';
    if (kind === 'collection') return { uri, kind, name: 'Músicas Curtidas' };
    if (kind === 'album' && cur?.album?.uri === uri) return { uri, kind, name: cur.album.name };

    let name = this.contextNames.get(uri);
    if (!name) {
      const ep = kind === 'album' ? `/albums/${id}` : kind === 'playlist' ? `/playlists/${id}?fields=name` : kind === 'artist' ? `/artists/${id}` : null;
      name = ep ? (await this.api('GET', ep).catch(() => null))?.name : undefined;
      name ||= kind === 'playlist' ? 'Playlist' : kind === 'artist' ? 'Artista' : 'Spotify';
      this.contextNames.set(uri, name);
    }
    return { uri, kind, name };
  }

  /** Tocar um item da fila: próximas = pular N vezes (mantém a fila); anteriores = tocar de novo no contexto. */
  async playQueueItem(it: LibraryItem) {
    const off = it.offset ?? 0;
    if (off > 0) {
      for (let i = 0; i < off; i++) await this.next();
      return;
    }
    if (off === 0) return;
    if (it.contextUri && !it.contextUri.endsWith(':collection')) {
      try { return await this.playInContext(it.contextUri, it.uri); } catch { /* contexto inacessível: toca avulsa */ }
    }
    await this.api('PUT', '/me/player/play', { uris: [it.uri] });
  }

  async tracks(item: LibraryItem): Promise<TrackItem[]> {
    let raw: any[];
    if (item.kind === 'album') {
      const cached = this.albumCache.get(item.uri) ?? [];
      // o álbum salvo já vem com até 50 faixas; busca o resto só se precisar
      raw = cached.length >= 50
        ? await this.paged(`/albums/${item.id}/tracks?limit=50`, 200).catch(() => cached)
        : cached.length ? cached : await this.paged(`/albums/${item.id}/tracks?limit=50`, 200);
    } else {
      // Fev/2026: /playlists/{id}/tracks virou /items e a faixa veio de `track` para `item`
      const entries = await this.paged(`/playlists/${item.id}/items?limit=50`, 200);
      raw = entries.map((e: any) => e.item ?? e.track).filter((t: any) => t && t.uri && !t.is_local);
    }
    return raw.map((t: any) => ({
      uri: t.uri,
      name: t.name,
      artists: (t.artists ?? []).map((a: any) => a.name).join(', ') || t.show?.name || '',
      explicit: !!t.explicit,
      durationMs: t.duration_ms ?? 0,
    }));
  }

  /** Toca uma faixa dentro do contexto (álbum/playlist). Se não houver dispositivo ativo, acorda o primeiro disponível. */
  async playInContext(contextUri: string, trackUri: string) {
    const body = { context_uri: contextUri, offset: { uri: trackUri } };
    try {
      await this.api('PUT', '/me/player/play', body);
    } catch (e) {
      if (!(e instanceof SpotifyError) || e.status !== 404) throw e;
      const { devices = [] } = (await this.api('GET', '/me/player/devices')) ?? {};
      const dev = devices.find((d: any) => !d.is_restricted);
      if (!dev) throw e;
      await this.api('PUT', `/me/player/play?device_id=${dev.id}`, body);
    }
  }

  next() { return this.api('POST', '/me/player/next'); }
  prev() { return this.api('POST', '/me/player/previous'); }
  play() { return this.api('PUT', '/me/player/play'); }
  pause() { return this.api('PUT', '/me/player/pause'); }
}

function pickImage(images?: { url: string; width: number | null }[] | null): string | null {
  if (!images?.length) return null;
  // menor imagem >= 300px: nítida sem pesar
  const sorted = [...images].sort((a, b) => (a.width ?? 640) - (b.width ?? 640));
  return (sorted.find((i) => (i.width ?? 640) >= 300) ?? sorted[sorted.length - 1]).url;
}
