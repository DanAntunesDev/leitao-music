import { screen } from 'electron';

/**
 * Posição do mouse em DIP (mesmas coordenadas de screen.getAllDisplays()).
 *
 * No Linux/X11 o screen.getCursorScreenPoint() do Electron fica preso na última
 * posição em que o ponteiro passou sobre uma janela do próprio app — então o
 * "monitor onde está o mouse" e o hover na borda deixavam de funcionar.
 * Aqui perguntamos direto ao servidor X (QueryPointer, ~1 ms) usando um cliente
 * X11 em JS puro. No Windows (ou se a conexão X falhar) usa a API do Electron.
 */

type Point = { x: number; y: number };

let X: any = null;
let root = 0;
let last: Point | null = null;
let ready: Promise<void> | null = null;

export function initCursor(): Promise<void> {
  if (process.platform !== 'linux' || !process.env.DISPLAY) return Promise.resolve();
  ready ??= new Promise<void>((resolve) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const x11 = require('x11');
      const client = x11.createClient({ display: process.env.DISPLAY }, (err: Error | null, display: any) => {
        if (err) {
          console.warn('[cursor] sem conexão X11, usando Electron:', err.message);
          return resolve();
        }
        X = display.client;
        root = display.screen[0].root;
        X.on('error', (e: Error) => console.warn('[cursor] erro X11:', e.message));
        X.on('end', () => { X = null; });
        console.info('[cursor] usando QueryPointer do X11');
        resolve();
      });
      client?.on?.('error', (e: Error) => {
        console.warn('[cursor] falha X11:', e.message);
        resolve();
      });
    } catch (e) {
      console.warn('[cursor] módulo x11 indisponível:', (e as Error).message);
      resolve();
    }
  });
  return ready;
}

function toDip(p: Point): Point {
  // No X11 o Chromium usa um fator de escala global para todos os monitores
  const k = screen.getPrimaryDisplay().scaleFactor || 1;
  return { x: Math.round(p.x / k), y: Math.round(p.y / k) };
}

/** Consulta atual (assíncrona). */
export function queryCursor(): Promise<Point> {
  if (!X) return Promise.resolve(screen.getCursorScreenPoint());
  return new Promise((resolve) => {
    let done = false;
    const fallback = setTimeout(() => {
      if (!done) { done = true; resolve(last ?? screen.getCursorScreenPoint()); }
    }, 50);
    X.QueryPointer(root, (err: Error | null, p: any) => {
      if (done) return;
      done = true;
      clearTimeout(fallback);
      if (err || !p) return resolve(last ?? screen.getCursorScreenPoint());
      last = toDip({ x: p.rootX, y: p.rootY });
      resolve(last);
    });
  });
}
