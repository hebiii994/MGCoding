# Guida utente — MGCoding

MGCoding è un IDE (fork di VS Code) con un agente di sviluppo integrato, *spec-driven*, che
funziona sia con **modelli locali** (Ollama) sia con **modelli cloud** (Claude, Gemini,
ChatGPT, Azure OpenAI, OpenRouter, LM Studio). Tutto ciò che è locale resta sul tuo PC.

Indice:
1. [Primo avvio e provider](#1-primo-avvio-e-provider)
2. [La chat: modalità Vibe e Spec](#2-la-chat-modalità-vibe-e-spec)
3. [L'agente e i suoi strumenti](#3-lagente-e-i-suoi-strumenti)
4. [Spec, Steering, Hooks, MCP](#4-spec-steering-hooks-mcp)
5. [Indice semantico del codice (RAG)](#5-indice-semantico-del-codice-rag)
6. [Profili e auto-apprendimento](#6-profili-e-auto-apprendimento)
7. [Voce: dettatura, hands-free, lettura](#7-voce-dettatura-hands-free-lettura)
8. [Controllo da smartphone (Telegram)](#8-controllo-da-smartphone-telegram)
9. [Gestione modelli Ollama](#9-gestione-modelli-ollama)
10. [Altre funzioni dell'editor](#10-altre-funzioni-delleditor)
11. [Aggiornamenti](#11-aggiornamenti)
12. [Riferimento comandi](#12-riferimento-comandi)
13. [Riferimento impostazioni](#13-riferimento-impostazioni)
14. [Build su macOS](#14-build-su-macos)

---

## 1. Primo avvio e provider

Apri il comando **`MGCoding: Configurazione guidata (provider e API key)`** (premi
`Ctrl+Shift+P` per la palette comandi) e scegli il servizio:

- **Google Gemini** — API key gratuita da [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
  (l'abbonamento Gemini Advanced **non** basta: serve la API key di AI Studio).
- **ChatGPT (OpenAI)** — API key da OpenAI Platform.
- **Claude (Anthropic)** — API key `sk-ant-…`.
- **Azure OpenAI** — endpoint del deployment + `api-version`.
- **OpenRouter** — tutti i modelli con una sola key.
- **Ollama (locale)** — nessuna chiave, gira sul tuo PC.
- **LM Studio (locale)** — server locale OpenAI-compatibile.

Le API key sono salvate nella Secret Storage del sistema. Puoi cambiare provider/modello in
qualsiasi momento dal **menu del modello** in basso nella chat (la voce con il nome del
modello e la freccia ▾).

> Suggerimento: i modelli con il badge 🔧 supportano i *tool nativi*. Per gli altri modelli
> Ollama lascia il toggle "Tool nativi" su OFF (protocollo testuale, più affidabile).

---

## 2. La chat: modalità Vibe e Spec

La chat è nella barra laterale. In basso trovi i controlli:

- **#** aggiungi contesto: `#codebase`, `#problems`, `#git`, oppure un file con `@nome`.
- **📎** allega un'immagine (i modelli *vision*, es. Gemini o gemma vision, la leggono).
- **🎤** dettatura vocale · **🎧** conversazione hands-free · **👤** profilo utente.
- **Selettore modello** e **Autopilot** (esegue le azioni senza chiederti conferma).

Tre modalità (pulsanti *Vibe* / *Spec* / *🎨 Img* in alto):

- **Vibe**: chat libera/agentica. Chiedi una modifica e l'agente la realizza con i suoi tool.
- **Spec**: flusso guidato *requirements → design → tasks* (vedi sezione 4).
- **🎨 Img** (Text-to-Image): descrivi un'immagine e MGCoding la genera. **Si configura da
  solo**: cerca prima un generatore locale in ascolto (Stable Diffusion A1111/SD.Next/Forge su
  `:7860`, ComfyUI su `:8188`), altrimenti usa una tua API key già impostata (Google Gemini →
  Imagen, OpenAI → gpt-image-1). Basta scrivere poche parole: il prompt viene espanso
  automaticamente e l'immagine salvata in `.mg/generated/`. Clicca l'immagine per aprirla.
  **Image-to-image**: allega un'immagine (📎) in modalità Img e descrivi la modifica: MGCoding
  la usa come base (img2img su ComfyUI/A1111, edit su OpenAI; non disponibile con Imagen). Quanto
  trasformarla si regola con `image.denoise` (0.4 ritocco, 0.7-0.8 cambiamento forte).

  Impostazioni: `image.backend` (auto/locale/cloud), `image.localEndpoint`,
  `image.comfyEndpoint`, `image.enhancePrompt`, `image.enhanceModel`, `image.denoise`.
  (La generazione video arriverà in seguito.)

  **Helper ComfyUI** (comandi nella palette):
  - **`MGCoding: Seleziona cartella ComfyUI`** — scegli con un dialog la cartella di ComfyUI
    (anche quella portable: trova da solo `models/`). Serve per scaricare i modelli al posto giusto.
  - **`MGCoding: Scarica modello immagini (ComfyUI)`** — catalogo curato (SDXL, FLUX schnell,
    SD 1.5, VAE) con download e barra di avanzamento nella cartella corretta; oppure incolla un
    URL diretto (HuggingFace/Civitai). Niente più download manuali.
  - **`MGCoding: Scegli checkpoint immagini`** — scegli QUALE modello usare (la lista è letta da
    ComfyUI). La didascalia sotto l'immagine mostra il modello usato (es. `ComfyUI · flux1-schnell-fp8`).
    I modelli **FLUX** sono riconosciuti dal nome e usano in automatico i parametri giusti
    (cfg basso, pochi step), quindi rendono bene anche col workflow predefinito.
  - **`MGCoding: Scegli workflow ComfyUI`** — usa un tuo workflow avanzato: esporta da ComfyUI in
    *formato API* (Save → API Format), mettilo in `.mg/workflows/`, selezionalo. In modalità Img
    MGCoding inietta il prompt ed esegue quel workflow (FLUX, upscaler, LoRA…). Prima dell'avvio
    controlla se mancano modelli o **nodi custom** e te lo segnala.
  - **`MGCoding: Installa nodi mancanti (ComfyUI)`** — per il workflow selezionato, individua i
    nodi custom mancanti, li risolve tramite l'elenco di ComfyUI-Manager, e (con conferma) li
    clona in `custom_nodes/` installandone le dipendenze. Poi riavvia ComfyUI.

Mentre l'agente lavora vedi l'indicatore **"MGCoding sta lavorando · *strumento*"** e, per le
risposte, il pannello **Ragionamento** (think) espandibile. I blocchi di codice hanno i
pulsanti *Copia* / *Inserisci*.

---

## 3. L'agente e i suoi strumenti

L'agente segue il metodo **esplora → pianifica → agisci → verifica**. Strumenti disponibili:

| Strumento | A cosa serve |
|---|---|
| `read_file` | legge un file (con numeri di riga, offset/limit) |
| `write_file` | crea/sovrascrive un file (con anteprima diff e conferma) |
| `apply_patch` | modifica mirata di un file esistente |
| `create_directory` | crea cartelle |
| `find_files` / `search_text` | cerca file e testo (per parola esatta) |
| `search_code` | **ricerca semantica** nel workspace (vedi sezione 5) |
| `get_diagnostics` | errori/warning dei language server |
| `run_command` | esegue comandi (chiede conferma se non in Autopilot); i dev server (es. `npm run dev`) partono in background con **output catturato** |
| `get_command_output` | rilegge l'output reale di un dev server/processo avviato (es. gli errori di Vite) |
| `fetch_url` | fa GET sull'app locale per **verificare da solo** che risponda e diagnosticare le pagine bianche |
| `update_plan` | mostra/aggiorna un piano a step in chat |
| `ask_user` | ti fa una **domanda con opzioni cliccabili** quando una scelta è ambigua |
| `remember` | salva una tua preferenza duratura (vedi sezione 6) |
| `delegate` | affida un sottocompito a un **subagent** focalizzato |

Caratteristiche automatiche:

- **Auto-verifica**: dopo che modifica dei file, controlla gli errori dei language server e
  si **auto-corregge** (fino a 2 giri) prima di concludere. Disattiva con `mgcoding.autoVerify`.
- **Dev server sotto controllo**: l'agente vede l'output reale dei server che avvia, non li
  riavvia inutilmente (sa che l'hot reload applica le modifiche da solo) e verifica con
  `fetch_url` che l'app risponda davvero.
- **Tool calling rigoroso (locali)**: con `mgcoding.ollama.structuredTools` l'output del
  modello è vincolato a uno schema (nomi tool inclusi): niente comandi scritti come testo.
- **Progetti Unity**: rilevati in automatico — l'agente conosce le regole (mai toccare i
  `.meta`, scena via tool MCP, leggere la console Unity dopo le modifiche agli script).
- **Nudge**: se annuncia un'azione ma non la esegue, viene sollecitato a farla davvero.
- **Planner + subagent**: per task complessi fa da orchestratore e delega i pezzi indipendenti.
- **Diff e approvazione**: le scritture mostrano un diff; approvi tu (a meno di Autopilot).
- **Checkpoint**: puoi rivedere/annullare le modifiche dell'agente (sezione 10).

---

## 4. Spec, Steering, Hooks, MCP

Nella barra delle attività trovi i pannelli **SPECS / HOOKS / STEERING / MCP**. MGCoding legge
sia `.mg/` sia `.kiro/` (compatibilità).

- **Spec** (`.mg/specs/<nome>/`): funzionalità descritte come `requirements.md` → `design.md`
  → `tasks.md`. Avvia una Spec dalla chat (modalità Spec) o crea con il pulsante **+** del
  pannello. I task hanno stato `[ ]` da fare, `[~]` in corso, `[x]` fatto.
  - **Esegui i task**: dalla chat o dalle CodeLens in cima a `tasks.md`:
    *Run all tasks*, *Run waves (subagent)* (parallelo), *Run all + optional*.
  - Se `mgcoding.tasks.parallel > 1` (default 2), l'esecuzione dalla chat usa i **subagent in
    parallelo** (wave).
  - A fine lavoro viene generato un **report** (cosa è stato fatto + come avviarlo).
  - Clic destro su una Spec: *Reveal in Explorer*, *Rinomina*, *Elimina*.
- **Steering** (`.mg/steering/`): regole/linee guida persistenti iniettate nel contesto. A
  inizio turno vedi i "chip" degli steering inclusi. Modalità di inclusione (front-matter
  `inclusion:`): `always` (default), `fileMatch` (+`fileMatchPattern`), `manual`, e **`auto`**
  (+`description`: incluso quando la richiesta in chat combacia con la descrizione).
- **Hooks** (`.mg/hooks/`): automazioni su eventi — `onSave`/`onCreate`/`onDelete`,
  **`onPromptSubmit`** (quando invii un messaggio), **`onAgentDone`** (a fine turno agente,
  es. "lancia i test"), o manuali. Compatibili con i `.kiro.hook`.
- **Bug**: per i bug l'agente propone una spec leggera con il solo `bugfix.md`
  (comportamento attuale / atteso / cosa non toccare) invece del trio completo.
- **MCP**: server MCP con i loro tool/resource/prompt; aggiungi dal pannello (wizard guidato).
  In `mcp.json` ogni server supporta: `command`+`args` (stdio) **oppure `url`** (HTTP),
  **`env`** (variabili d'ambiente), **`timeout`** (secondi per chiamata, default 60 — utile
  con Unity), `disabled`. Robustezza: **riconnessione automatica** se il server cade, stderr
  nel canale Output *MGCoding MCP*, e **immagini** dei tool (es. screenshot della scena
  Unity) passate ai modelli vision. Se i tool sono tanti, all'agente vengono esposti i più
  pertinenti alla richiesta (`mgcoding.mcp.maxTools`, default 12).

  Esempio per Unity:
  ```json
  {
    "mcpServers": {
      "unity": {
        "command": "node",
        "args": ["percorso/mcp-unity/build/index.js"],
        "env": { "UNITY_PORT": "8090" },
        "timeout": 180
      }
    }
  }
  ```

---

## 5. Indice semantico del codice (RAG)

MGCoding può costruire un **indice vettoriale locale** del workspace e usarlo per trovare i
pezzi di codice (e documenti) più pertinenti a una richiesta in linguaggio naturale.

- **Prerequisito**: un modello di embedding in Ollama → `ollama pull nomic-embed-text`
  (se manca, l'indicizzazione te lo propone in download).
- **Crea/aggiorna l'indice**: comando **`MGCoding: Crea/aggiorna indice del codice (RAG)`** o
  il pulsante **🗄️** nella barra del pannello *SPECS*. Si crea anche da solo al primo uso del
  tool `search_code`.
- **Aggiornamento automatico**: una volta creato, l'indice si aggiorna da solo (incrementale)
  all'avvio e dopo i salvataggi (`mgcoding.index.autoUpdate`).
- **Cosa indicizza**: codice e testo (`.ts/.py/.js/.md/.json/.yaml/…`) e documenti
  **DOCX/PPTX/XLSX**. (I PDF richiedono `pdftotext`/poppler nel PATH.)
- **Come lo usa l'agente**: con il tool `search_code` ("dove viene gestito il login?") trova i
  passaggi giusti senza tentativi a vuoto — utilissimo con i modelli locali.

Impostazioni: `index.embedModel`, `index.maxFileKB`, `index.autoUpdate`.

---

## 6. Profili e auto-apprendimento

MGCoding impara le tue **preferenze personali** e le riusa nelle sessioni successive.

- **Profili multi-persona**: pulsante **👤** in chat → scegli/crea la persona attiva. Su
  Telegram ogni chat ha il proprio profilo.
- **Cosa impara**: solo preferenze **trasversali** (lingua, stile, framework preferiti, come
  vuoi le risposte, sistema operativo). **Non** salva nomi di progetto o dettagli del lavoro
  corrente.
- **Come impara**: il tool `remember` (vedi nota "📝 Memorizzato…") e un **consolidamento
  automatico** ogni ~6 turni che riassume le preferenze.
- **Ripulire/modificare**: 👤 → *Modifica/ripulisci preferenze…* (o comando
  **`MGCoding: Modifica/ripulisci preferenze profilo`**) per rimuovere voci sbagliate.

---

## 7. Voce: dettatura, hands-free, lettura

Il motore vocale (Whisper) è **incluso** e si avvia da solo; la registrazione avviene fuori
dal webview tramite SoX (incluso).

- **🎤 Dettatura**: clicca, parla, e il testo trascritto compare nella casella di input
  (premi invio per inviare; con `stt.autoSend` parte da solo).
- **🎧 Hands-free**: registra → trascrive → invia → l'agente risponde → 🔊 legge → riascolta,
  in loop. Riclicca 🎧 per uscire.
- **Selezione microfono**: comando **`MGCoding: Seleziona microfono`** → scegli il dispositivo
  e parte un test di 4s che ti dice cosa ha sentito. Utile se "parli ma non succede nulla".
- **Test microfono**: comando **`MGCoding: Test microfono`**.
- **Lingua**: la trascrizione è forzata in italiano (`stt.language`, default `it`).
- **Modello più accurato**: comando **`MGCoding: Scarica modello vocale migliore (Whisper)`**
  → `small` / `medium` / `large-v3-turbo` (più grande = più preciso).
- **🔊 Lettura (TTS)**: il pulsante altoparlante sotto i messaggi li legge ad alta voce
  (richiede una voce italiana installata in Windows).

Impostazioni: `stt.inputDevice`, `stt.language`, `stt.thresholdPct`, `stt.maxSeconds`,
`stt.autoSend`, `voice.lang`.

---

## 8. Controllo da smartphone (Telegram)

Comanda l'agente dal telefono e segui ciò che accade sul PC.

- **Collega**: comando **`MGCoding: Connetti Telegram`** → incolla il token del tuo bot
  (creato con @BotFather). Sul telefono invia `/pair <codice>` al bot per abbinarlo.
- **Usa**: manda un prompt al bot; l'agente lo esegue sul PC e ti risponde. `/new` per una
  nuova conversazione.
- **Mirror**: ciò che fai nella chat del **PC** viene rispecchiato su Telegram (🧑 i tuoi
  messaggi, 🔧 le azioni, 🤖 le risposte). Disattiva con `mgcoding.telegram.mirror`.
- **Sicurezza**: da remoto le azioni che modificano file/eseguono comandi sono **bloccate**
  salvo tua conferma; per consentirle attiva `mgcoding.telegram.autoApprove` (a tuo rischio).
- **Disconnetti**: comando **`MGCoding: Disconnetti Telegram`**.

---

## 9. Gestione modelli Ollama

- **Gestione**: comando **`MGCoding: Gestione modelli Ollama`** (o dal menu del modello →
  *⚙️ Gestione modelli…*): vedi gli installati con dimensione → *Usa* o *Cancella*; scarica
  nuovi modelli con barra di avanzamento (anche da HuggingFace, `hf.co/<repo>:<tag>`).
- **Consulente**: comando **`MGCoding: Consigliami un modello`**: rispondi a 3 domande
  (VRAM/RAM, uso, priorità) e ti propone i modelli adatti, pronti da scaricare.

---

## 10. Altre funzioni dell'editor

- **Inline edit**: seleziona del codice e premi `Ctrl+I` per modificarlo con un'istruzione.
- **Autocomplete (ghost text)**: completamenti inline mentre scrivi.
- **Checkpoint / revert**: rivedi le modifiche dell'agente (`MGCoding: Visualizza modifiche`)
  e annullale (`MGCoding: Annulla modifiche`).
- **Sessioni multiple**: cronologia conversazioni; lo storico lungo viene riassunto in
  automatico per restare leggero (vedi `context.*`).

---

## 11. Aggiornamenti

MGCoding controlla gli aggiornamenti su GitHub Releases. Quando ce n'è uno vedi un badge in
basso a sinistra: clicca **Aggiorna ora** per scaricare e installare in-app (Windows) o aprire
il `.dmg` (macOS). Controllo manuale: comando **`MGCoding: Controlla aggiornamenti`**.

---

## 12. Riferimento comandi

(Apri la palette con `Ctrl+Shift+P` e digita "MGCoding".)

- `MGCoding: Configurazione guidata (provider e API key)`
- `MGCoding: Imposta API key` / `Imposta API key OpenAI-compat`
- `MGCoding: Apri chat`
- `MGCoding: Autopilot on/off` · `Tool nativi Ollama on/off`
- `MGCoding: Profilo utente (cambia/crea)` · `Modifica/ripulisci preferenze profilo`
- `MGCoding: Seleziona microfono` · `Test microfono` · `Scarica modello vocale migliore (Whisper)`
- `MGCoding: Gestione modelli Ollama` · `Consigliami un modello`
- `MGCoding: Crea/aggiorna indice del codice (RAG)`
- `MGCoding: Connetti Telegram` · `Disconnetti Telegram`
- `MGCoding: Inline edit` (`Ctrl+I`)
- `MGCoding: Visualizza modifiche` · `Annulla modifiche`
- `MGCoding: Controlla aggiornamenti`
- (Spec) `Nuova Spec`, `Esegui i task`, `Importa da Kiro`, `Aggiorna`

---

## 13. Riferimento impostazioni

Tutte sotto `mgcoding.*` (apri *Impostazioni* e cerca "mgcoding"):

- **Provider**: `provider`, `claude.model`, `claude.effort`, `ollama.endpoint`, `ollama.model`,
  `ollama.nativeTools`, `ollama.structuredTools`, `ollama.temperature`, `ollama.autoModel`,
  `openai.endpoint`, `openai.model`, `claude.thinkingAuto`.
- **Agente**: `autoApprove` (Autopilot), `diffApproval`, `autoVerify`, `tasks.parallel`,
  `mcp.maxTools`.
- **Contesto**: `context.autoCompact`, `context.compactAtTokens`, `context.keepMessages`.
- **Indice (RAG)**: `index.embedModel`, `index.maxFileKB`, `index.autoUpdate`.
- **Voce**: `stt.inputDevice`, `stt.language`, `stt.thresholdPct`, `stt.maxSeconds`,
  `stt.autoSend`, `stt.endpoint`, `voice.lang`.
- **Telegram**: `telegram.mirror`, `telegram.autoApprove`.
- **Altro**: impostazioni analytics opt-in anonime.

---

## 14. Build su macOS

Vedi `build/mgcoding/MAC-BUILD.md`. In sintesi: su un Mac Apple Silicon installa i
prerequisiti (`xcode-select --install`, `brew install python cmake sox`) e lancia
`bash build/mgcoding/build-mac-arm64.sh` (con `MGCODING_MAKE_DMG=1` per il `.dmg`). Voce e
aggiornamenti in-app sono supportati anche su Mac.

---

*Tutto ciò che usa Ollama e il motore vocale resta locale sul tuo computer. Le API cloud
vengono usate solo se scegli un provider cloud e inserisci la relativa chiave.*
