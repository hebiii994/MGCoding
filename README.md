# MGCoding

[![Latest release](https://img.shields.io/github/v/release/hebiii994/MGCoding)](https://github.com/hebiii994/MGCoding/releases/latest)
[![Download](https://img.shields.io/github/downloads/hebiii994/MGCoding/total)](https://github.com/hebiii994/MGCoding/releases)

**MGCoding** è un IDE agentico *spec-driven*, fork di [Visual Studio Code / Code-OSS](https://github.com/microsoft/vscode). Porta un agente di codifica completo dentro l'editor — con workflow spec (requirements → design → tasks), steering, hook e MCP — usando **LLM locali (Ollama)** oppure **modelli cloud (Claude, ChatGPT, Gemini, …)**, a tua scelta.

> Basato su Code-OSS sotto licenza [MIT](LICENSE.txt). MGCoding non è affiliato a Microsoft.

## Caratteristiche principali

- **Workflow spec-driven** — gestione di **SPEC** (`.mg/specs`: requirements → design → tasks), **Steering** (`.mg/steering`) e **Agent Hooks** (`.mg/hooks`), con import dei progetti `.kiro` esistenti.
- **Provider LLM intercambiabili** — passa al volo tra:
  - **Ollama** (locale, anche su un altro PC della rete)
  - **Claude** (Anthropic)
  - **ChatGPT** (OpenAI), **Google Gemini**, **OpenRouter**, **Azure OpenAI**, **LM Studio** o qualsiasi endpoint OpenAI-compatibile

  Ogni endpoint conserva la propria API key: nessun provider è obbligato come default.
- **Agente con strumenti** — lettura/scrittura file, esecuzione comandi, patch mirate, ricerca; con **diff e approvazione**, **checkpoint/revert** delle modifiche e **Autopilot**.
- **Chat avanzata** — modalità **Vibe** e **Spec**, storico multi-sessione, Markdown e blocchi di codice (copia/inserisci), menzioni `@file`, selettore `#context`, **immagini (vision)** e pannello **Ragionamento** (Ollama thinking / Claude extended thinking).
- **Inline edit (Ctrl+I)** e **autocomplete ghost-text** (FIM via Ollama).
- **MCP (Model Context Protocol)** — client stdio reale con stato live dei server e tool/risorse/prompt esposti.
- **Auto-updater in-app** — controlla le nuove release su GitHub e propone l'aggiornamento.

## Installazione

### Windows
Scarica l'ultimo **`MGCodingSetup.exe`** dalla pagina [Releases](https://github.com/hebiii994/MGCoding/releases/latest) ed eseguilo. Gli aggiornamenti successivi verranno proposti automaticamente dall'app.

### macOS (Apple Silicon)
Il pacchetto va costruito su un Mac. Vedi [`build/mgcoding/MAC-BUILD.md`](build/mgcoding/MAC-BUILD.md).

## Configurazione rapida

1. Apri una cartella di progetto.
2. Comando **`MGCoding: Cambia modello/provider`** (o clic sulla status bar) → scegli il provider/servizio.
3. Per i servizi cloud inserisci l'API key quando richiesta (salvata in modo sicuro nel SecretStorage, mai nel repo).

### Usare un LLM locale da un altro dispositivo
Sul PC con Ollama: avvialo con `OLLAMA_HOST=0.0.0.0:11434` e apri la porta nel firewall. Sul client imposta `mgcoding.ollama.endpoint = http://IP-DEL-PC:11434` (stessa rete o VPN).

## Build da sorgente

Requisiti: Node.js 24.x, Python 3, toolchain di build nativa (vedi i prerequisiti di Code-OSS).

```bash
npm ci
npx gulp compile-extension:mgcoding     # compila l'estensione MGCoding
npx gulp vscode-win32-x64               # build app Windows
npx gulp vscode-win32-x64-user-setup    # installer (user-setup)
```

L'estensione che implementa MGCoding vive in [`extensions/mgcoding`](extensions/mgcoding).

## Crediti

MGCoding è un fork di [Visual Studio Code – Code-OSS](https://github.com/microsoft/vscode) (Microsoft, licenza MIT).

## Licenza

Distribuito sotto licenza [MIT](LICENSE.txt). Il codice di Code-OSS è Copyright (c) Microsoft Corporation.
