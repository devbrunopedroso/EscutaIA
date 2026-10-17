# EscutaIA

Um "tl;dv" que roda **no computador de cada pessoa**. Grava reuniões, transcreve, identifica quem falou, resume com o Claude e permite buscar em tudo. A transcrição e os dados não saem do computador.

```
desktop/    App (Electron) — o EscutaIA completo: servidor local + interface + gravador do computador
extension/  Extensão do Chrome — grava reuniões no navegador e envia para o app
server/     Servidor (TypeScript): API, banco, transcrição, falantes, Claude. Roda dentro do app.
web/        Interface (React) — aberta dentro do app
site/       Página de download (HTML estático, GitHub Pages) — a única parte "na web"
```

## Como funciona

```
 Chrome (Meet/Zoom/Teams)                 App EscutaIA (no computador)
 ┌───────────────────────┐   http://127.0.0.1:47821   ┌───────────────────────────────────────┐
 │ extensão: grava a aba │ ─────────────────────────▶ │ servidor local (Node.js embutido)      │
 │ + microfone (estéreo) │   token da extensão        │  • PGlite (Postgres embutido)          │
 │ + legendas (nomes)    │                            │  • Whisper (sherpa-onnx) + VAD          │
 └───────────────────────┘                            │  • quem fala (sherpa-onnx)              │
                                                      │  • resumo/perguntas (Claude)            │
 Zoom/Teams/WhatsApp (apps) ── gravador do app ─────▶ │ janela: reuniões, busca, perguntas      │
                                                      └───────────────────────────────────────┘
```

1. **A extensão detecta o app.** Ela procura o app em `127.0.0.1:47821–47825`.
   - Se o app estiver fechado, mostra **"Abrir EscutaIA"**, que abre o app pelo link `escutaia://`, e não começa a gravar.
   - Na primeira vez, **"Conectar ao app"** abre uma janela **no app** pedindo permissão. Um site não consegue se conectar sem você ver e aprovar.
2. **A gravação é estéreo:** microfone no canal esquerdo e aba no direito. Ela para e é enviada sozinha quando você sai da chamada, quando a aba fecha ou depois de alguns minutos de silêncio.
3. **Se o app fechar no meio,** a gravação fica guardada no navegador (IndexedDB) e é enviada sozinha quando o app abrir.
4. **O app transcreve:** Whisper int8 com detector de fala, em trechos de até 8 s. Depois identifica quem falou e gera o resumo. A busca é full-text em português, sem acentos e com radical das palavras, e mostra o trecho destacado com o momento em que foi dito.

### Segurança do app local

- A API escuta **só em 127.0.0.1**, então não aparece na rede.
- Toda chamada precisa de um token:
  - a janela do app usa o token do próprio app;
  - cada extensão recebe um token próprio, guardado só como hash, e pode ser desconectada em **Extensão** no app.
- O CORS aceita **só** extensões do Chrome e a própria janela do app. Um site aberto no navegador não consegue usar a API.
- O token do Claude, se você colar um, fica criptografado no banco local.

## Para usuários

Baixe na página do projeto (`site/`, publicada no GitHub Pages):
1. **App** para macOS (Apple Silicon/Intel), Windows (x64; roda também em ARM) ou Linux (.deb/AppImage, x64/ARM).
2. **Extensão** do Chrome (zip; ou pela Chrome Web Store, quando for publicada).
3. Abra o app, clique na extensão → **Conectar ao app** → **Permitir**.

Na **primeira abertura**, o app baixa os modelos de IA (cerca de 415 MB). Uma barra no topo mostra o progresso. Depois disso, transcrever funciona sem internet.

## Claude (resumos e perguntas)

O app usa, nesta ordem:
1. Um token colado em **⚙ Configurações → Claude**: o da assinatura (`claude setup-token`) ou uma chave de API.
2. O **Claude Code já instalado e logado** no computador. O app procura o `claude` em `~/.local/bin`, `/opt/homebrew/bin` e outros caminhos comuns.

O modelo padrão é `claude-opus-5-5`.

## Identificação de quem fala

| | Como | Quando |
|---|---|---|
| **Nomes reais** | A extensão liga as legendas do Meet/Teams e anota quem falou e quando ([TranscripTonic](https://github.com/vivek-nexus/transcriptonic), MIT, como referência dos seletores) | Meet e Teams no navegador |
| **Você vs. os outros** | Canal do microfone vs. canal da aba | Sempre (extensão e gravador do app) |
| **Quantas pessoas** | "Quantas pessoas falaram além de você?" → Refazer | Quando o automático erra |
| **Automático** | sherpa-onnx (pyannote 3.0 + `nemo_en_titanet_small`). Grupos com menos de 3 s de fala entram no grupo mais parecido. | O resto |

Correção manual:
- Renomear um participante com o nome de outro junta os dois.
- Clicar no nome de uma fala troca quem disse.
- **Refazer resumo** usa os nomes atualizados.

## Desenvolvimento

```bash
cd web && npm install && cd ..
cd desktop && npm install
npm start            # empacota server/ + web/, baixa o Node.js do sistema atual e abre o app
```

Variáveis úteis para testes:
- `ESCUTAIA_USER_DATA=/tmp/x`: usa uma pasta de dados separada.
- `ESCUTAIA_E2E_AUTO_PAIR=1`: aprova o pareamento sem a janela.
- `EscutaIA --selftest=/tmp/out.json`: grava 5 s do som do computador e salva os níveis.

Detalhes que importam:
- **O servidor roda num Node.js oficial dentro do app** (`build/fetch-node.mjs`), e não no Node do Electron. O sherpa-onnx usa "external buffers", que o V8 do Electron proíbe ("External buffers are not allowed").
- **Cada instalador precisa ser gerado no seu próprio sistema e processador.** O sherpa-onnx, o ffmpeg-static e o Node são binários nativos. `npm run dist` gera o instalador do sistema atual.
- `asar` está desligado: a thread de cálculo, o ffmpeg e os módulos nativos precisam ser arquivos reais.

### Publicar uma versão

```bash
git tag v0.2.0 && git push --tags
```

O workflow `.github/workflows/release.yml`:
- gera o app em 6 máquinas (macOS arm64/x64, Windows x64, Linux x64/arm64);
- empacota a extensão;
- cria a **Release** com nomes de arquivo fixos (`EscutaIA-mac-arm64.dmg`, `escutaia-extension.zip`…), para que os links `releases/latest/download/…` da página sempre apontem para a versão mais nova;
- publica `site/` no GitHub Pages (a cada push na `main`), já apontando para o repositório.

No GitHub, ative **Settings → Pages → Source: GitHub Actions**.

**Assinatura (opcional).** Sem ela, o Windows mostra o SmartScreen e o macOS diz que *"não pôde verificar se o EscutaIA está livre de malware"*. No macOS 15+, o "botão direito → Abrir" não funciona mais. O usuário precisa ir em **Ajustes do Sistema → Privacidade e Segurança → Abrir Mesmo Assim**, ou rodar `xattr -dr com.apple.quarantine /Applications/EscutaIA.app`. Para assinar:
- **macOS:** secrets `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` e `APPLE_TEAM_ID` (conta Apple Developer, US$ 99/ano).
- **Windows:** secrets `WIN_CSC_LINK` e `WIN_CSC_KEY_PASSWORD`.

**Chrome Web Store (instalação com um clique).** Envie o `escutaia-extension.zip` da Release em https://chrome.google.com/webstore/devconsole (taxa única de US$ 5). Justificativas das permissões:
- `tabCapture`: gravar a aba da reunião;
- `offscreen`: rodar o gravador;
- `storage`: guardar a conexão com o app;
- `activeTab`: identificar a aba;
- `notifications`: avisar sobre o envio;
- `alarms`: reenviar gravações pendentes;
- `127.0.0.1`: falar com o app local;
- Meet/Zoom/Teams: detectar o fim da chamada e ler as legendas para os nomes.

Depois coloque o link em `CHROME_STORE_URL` no `site/index.html`.

### Testes feitos

| O quê | Resultado |
|---|---|
| App empacotado (macOS arm64): pareamento, envio, transcrição, falantes, resumo | ✓ |
| 1ª abertura sem modelos: download de 415 MB com progresso na tela | ✓ cerca de 1 min |
| Extensão: detecta o app, "Conectar ao app", grava e envia | ✓ |
| App fechado: a extensão recusa gravar; se o app fecha no meio, guarda e reenvia | ✓ reenviou 1 s depois de reabrir |
| Segurança: sem token → 401; site qualquer → sem CORS; pareamento vindo de site → recusado | ✓ |
| Porta 47821 ocupada → app sobe na 47822 e a extensão encontra | ✓ |
| Captura do som do sistema: Linux (.deb no Debian 12) | ✓ |
| Captura do som do sistema: macOS | ⏳ precisa do seu clique em "Permitir" |
| Windows | ⚠️ não testado (gerado pelo CI) |

## Modo servidor (opcional, legado)

O mesmo servidor também roda em Docker como serviço multiusuário (`docker compose up -d --build`). Ele usa Postgres e whisper.cpp, e cada pessoa tem login. A extensão atual fala só com o app local; nesse modo, as gravações são enviadas pelo site (upload).
# EscutaIA
# EscutaIA
