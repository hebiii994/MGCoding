# MGCoding

Fork di **Code – OSS** (la base open source di Visual Studio Code): un IDE agentico **spec-driven** che usa **LLM locali (Ollama)** oppure **modelli cloud** (Claude, ChatGPT, Gemini, …), a scelta e intercambiabili.

## Funzionalità

L'estensione built-in `extensions/mgcoding/` aggiunge:

- **Provider LLM switchabile** — Claude (API key in SecretStorage) oppure Ollama locale, selezionabili dalla status bar o dal menu a tendina nella chat. Nessuna dipendenza esterna: entrambi i provider usano `fetch`.
- **Chat agentica** (barra laterale destra) — l'agente può **leggere/scrivere file** ed **eseguire comandi** tramite un protocollo tool JSON compatibile sia con Claude (tool-use) sia con i modelli locali.
- **Specs** (`.mg/specs/<feature>/`) — workflow a fasi con approvazione: `requirements.md` (notazione EARS) → `design.md` → `tasks.md`.
- **Steering** (`.mg/steering/*.md`) — regole persistenti iniettate nel system prompt, con front-matter `inclusion: always | fileMatch | manual`.
- **Agent Hooks** (`.mg/hooks/*.json`) — automazioni su eventi (save/create/delete) con azione "ask" (prompt all'agente) o "command" (shell).
- **MCP Servers** (`.mg/mcp.json`) — visualizzazione/configurazione (client in arrivo).

## Build (Windows)

Requisiti: Node 24.15.0 (consigliato via [fnm](https://github.com/Schniz/fnm)), Python 3.x reale (non quella dello Store), Visual Studio con C++ tools + **librerie Spectre**.

```bash
npm install
npm run compile
node build/lib/preLaunch.ts      # scarica Electron + estensioni built-in
".build/electron/Code - OSS.exe" . <cartella-da-aprire>
```

## Release / Pubblicazione (Windows)

Procedura per pubblicare una nuova versione (es. `0.9.18`) come release GitHub con
l'installer `MGCodingSetup.exe`. Tutti i comandi vanno eseguiti dalla root del repo.

Requisiti aggiuntivi (oltre a quelli di Build):
- Inno Setup, fornito dal pacchetto npm `innosetup` (`ISCC.exe`) già presente in `node_modules` dopo `npm install`.
- [GitHub CLI](https://cli.github.com/) (`gh`) autenticato. Avendo due remote (`origin` = MGCoding, `upstream` = vscode), imposta una volta il repo di default:
  ```bash
  gh repo set-default hebiii994/MGCoding
  ```

### 1. Bump della versione
Aggiorna `"version"` in `extensions/mgcoding/package.json` (es. `0.9.17` → `0.9.18`).
L'installer prende il numero di versione da `package.json` (root), quindi tieni allineato
anche quello se cambi la versione del prodotto.

### 2. Commit
```bash
git add -A
git commit -m "0.9.18 - <descrizione breve>"
```

### 3. Build dell'installer
Quattro task gulp in sequenza (il wrapper `npm run gulp` usa già `--experimental-strip-types`):

```bash
npm run gulp compile-extension:mgcoding      # ⚠️ OBBLIGATORIO: ricompila out/ dell'estensione mgcoding
npm run gulp vscode-win32-x64-min            # ~4 min: impacchetta il prodotto in ../VSCode-win32-x64
npm run gulp vscode-win32-x64-inno-updater   # pochi secondi: prepara l'updater
npm run gulp vscode-win32-x64-user-setup     # ~6 min: Inno Setup → installer
```

> ⚠️ **IMPORTANTE — non saltare il primo passo.** A differenza delle altre estensioni built-in,
> `mgcoding` **non** viene ricompilata da `vscode-win32-x64-min`: il packaging copia la cartella
> `extensions/mgcoding/out/` così com'è sul disco. Se non lanci prima
> `compile-extension:mgcoding` (oppure tieni attivo `npm run watch`), l'installer conterrà il
> **codice compilato vecchio** e le tue modifiche non finiranno nella release. In alternativa
> al primo comando puoi usare `npm --prefix extensions/mgcoding run compile`.

Output: `.build/win32-x64/user-setup/MGCodingSetup.exe`. I numerosi `Warning` di Inno Setup
sulle lingue (korean/chinese/hungarian) e su `x64`/variabili inutilizzate sono normali e non
bloccano la build (deve terminare con *"Successful compile"*).

### 4. Push + release GitHub
```bash
git push origin main
gh release create v0.9.18 ".build/win32-x64/user-setup/MGCodingSetup.exe" \
  --title "MGCoding 0.9.18 - <titolo>" \
  --notes-file <file-note.md> \
  --target main
```
`gh release create` crea anche il tag `v0.9.18` sul commit di `main`. Verifica con
`gh release view v0.9.18` che l'asset `MGCodingSetup.exe` risulti `state: uploaded`.

## Configurazione LLM

- **Ollama**: avvia Ollama e scarica un modello (es. `ollama pull qwen2.5-coder:14b`). Endpoint default `http://localhost:11434`.
- **Claude**: comando *MGCoding: Imposta API key Claude*, poi seleziona il provider Claude.

## Upstream

Questo repository è un fork di [microsoft/vscode](https://github.com/microsoft/vscode) con storia propria. Il remote `upstream` punta al repo originale per futuri allineamenti.
