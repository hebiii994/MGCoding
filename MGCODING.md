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

## Configurazione LLM

- **Ollama**: avvia Ollama e scarica un modello (es. `ollama pull qwen2.5-coder:14b`). Endpoint default `http://localhost:11434`.
- **Claude**: comando *MGCoding: Imposta API key Claude*, poi seleziona il provider Claude.

## Upstream

Questo repository è un fork di [microsoft/vscode](https://github.com/microsoft/vscode) con storia propria. Il remote `upstream` punta al repo originale per futuri allineamenti.
