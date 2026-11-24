# Leitão Music

Overlay de música estilo console (PS5/PSP) para **Linux e Windows**, integrado ao Spotify.

- **Escuta o Spotify:** trocou de música (no app do Spotify, no celular, onde for), o Leitão aparece sozinho, a pilha de capas desliza até o álbum que está tocando e mostra a faixa nova. Depois de alguns segundos ele some. Nesse modo ele não rouba o foco e os cliques passam direto.
- **Abrir pra escolher música:** a tela vira uma matriz de pontos de LED com o que está atrás. Na borda aparece a pilha de capas da sua biblioteca. Selecione um álbum ou playlist e escolha a faixa.

## Instalar

| Sistema | Arquivo |
|---|---|
| Ubuntu/Debian | `LeitaoMusic-1.0.0-amd64.deb` → `sudo apt install ./LeitaoMusic-1.0.0-amd64.deb` |
| Qualquer Linux | `LeitaoMusic-1.0.0-x86_64.AppImage` → `chmod +x` e executar |
| Windows | `LeitaoMusic-Portable-1.0.0.exe` (roda sem instalar) ou `LeitaoMusic-Setup-1.0.0.exe` (instalador, gerado pelo GitHub Actions) |

## Primeiro uso

1. https://developer.spotify.com/dashboard → **Create app**
2. Redirect URI: `http://127.0.0.1:8888/callback`
3. Marque **Web API**, salve e cole o **Client ID** na janela do Leitão
4. Autorize no navegador. A página só diz "Conectado" depois que o token foi obtido de verdade. Se der erro, ela mostra o motivo.

> ⚠️ Desde fev/2026 o Spotify exige **Premium** para apps em modo de desenvolvimento, com até 5 usuários por Client ID.

Se algo falhar: bandeja → **Ver log** (`~/.config/leitao-music/leitao-music.log` ou `%APPDATA%\leitao-music\leitao-music.log`).

## Controles

| Ação | Teclado | Mouse | Gamepad |
|---|---|---|---|
| Abrir / fechar | `Ctrl+Alt+M` ou encostar o mouse na borda | ícone da bandeja | — |
| Navegar | ↑ ↓ | roda | D-pad / analógico |
| Abrir álbum / tocar faixa | Enter | clique | ✕ / A |
| Voltar / fechar | Esc | clique no vazio | ○ / B |
| Play/pause | Espaço | — | Options |
| Anterior / próxima | ← → | — | D-pad ← → |

Se a animação automática estiver na tela, o atalho ou o hover transformam ela no modo interativo.

## Configurações (bandeja)

- Posição: esquerda ou direita × topo, centro ou baixo
- Monitor
- Fundo: matriz de pontos ou transparente
- Tamanho
- **Ao trocar de música:** completo, discreto (só as capas) ou desligado, e quanto tempo fica na tela
- Hover na borda
- Iniciar com o sistema

O atalho fica em `config.json` (`"shortcut"`).

## Linux / Wayland

O app roda via XWayland. No Ubuntu com Wayland o atalho global e o hover na borda podem não funcionar quando o foco está num app Wayland nativo. A animação automática funciona normalmente. Para abrir por atalho, crie um atalho personalizado no GNOME com o comando:

```bash
leitao-music --toggle                       # instalado pelo .deb
/caminho/LeitaoMusic-1.0.0-x86_64.AppImage --toggle
```

## Desenvolvimento

```bash
npm install
npm start               # build + abre
npm run dist:linux      # AppImage + .deb
npm run dist:win        # .exe (instalador + portátil); no Linux o instalador precisa de Wine, o portátil não
```

O ícone do `.exe` e os metadados são gravados por `scripts/after-pack.cjs` (resedit, JS puro). Isso funciona sem Wine.

**Instalador do Windows pelo GitHub:** suba o repositório e crie uma tag. O workflow `.github/workflows/build.yml` gera `.exe`, `.AppImage` e `.deb` e cria uma Release:

```bash
git tag v1.0.0 && git push --tags
```

```
src/main/main.ts        overlay, escuta do Spotify, modo automático, atalho, bandeja, log
src/main/spotify.ts     OAuth PKCE + Web API (biblioteca, faixas, player)
src/renderer/           UI: pilha de capas, lista de faixas, fundo em matriz, gamepad
scripts/after-pack.cjs  ícone/metadados no .exe
assets/                 ícones (gerados), bandeja
```
