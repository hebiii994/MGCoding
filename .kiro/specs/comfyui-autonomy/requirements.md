# Requirements Document

## Introduction

Questo documento raccoglie i requisiti per rendere MGCoding **completamente autonoma** su tre pilastri:

1. **Autonomia LLM** — un ciclo agentico che, da una richiesta in linguaggio naturale, sceglie il provider/modello migliore, pianifica ed esegue end-to-end la generazione, recuperando da solo gli errori.
2. **Autonomia di generazione** — supporto non solo a immagini (txt2img, img2img) ma anche a **video** (text-to-video e image-to-video, es. WAN, AnimateDiff), con gestione robusta degli input/output e dell'anteprima.
3. **Autonomia ComfyUI** — ciclo di vita completo (installazione, avvio, arresto, rilevamento), conversione automatica dei workflow dal formato UI al formato API, mappatura robusta degli input, gestione di GGUF e workflow multi-stadio, download di modelli e installazione di nodi custom.

Lo scenario guida concreto è l'esecuzione di un workflow **WAN 2.2 I2V GGUF** scaricato da una community (Civitai): l'utente fornisce un'immagine e una descrizione, e MGCoding deve portare a termine la generazione del video gestendo da sola conversione del workflow, modelli/nodi mancanti, mappatura degli input e recupero dagli errori, anche su una GPU da 8 GB di VRAM.

I requisiti sono **raggruppati per pilastro** in modo che la fase di design possa prioritizzarli e suddividerli in fasi. Ogni requisito segue la notazione EARS.

## Glossary

- **MGCoding**: l'estensione integrata nel fork di VS Code (Code-OSS) che fornisce chat agentica, multi-provider LLM e generazione multimediale.
- **Orchestratore**: il componente che esegue il ciclo agentico autonomo (interpreta la richiesta, pianifica, esegue, riporta) per i compiti di generazione.
- **Router_LLM**: il componente che seleziona provider e modello LLM (locale o cloud) in base alla richiesta e alla disponibilità.
- **Motore_Generazione**: il componente che produce contenuti multimediali (immagini e video) invocando un backend.
- **Gestore_ComfyUI**: il componente che gestisce il ciclo di vita di ComfyUI (rilevamento, installazione, avvio, arresto, ambiente Python).
- **Motore_Workflow**: il componente che carica, valida, mappa gli input ed esegue i workflow ComfyUI.
- **Convertitore_Workflow**: il componente che converte un workflow dal formato UI al formato API.
- **Gestore_Modelli**: il componente che rileva, risolve e scarica i modelli mancanti.
- **Gestore_Nodi**: il componente che rileva, risolve e installa i nodi custom mancanti.
- **Recupero_Errori**: il componente che interpreta gli errori di un'esecuzione ComfyUI e applica azioni correttive.
- **Monitor_Avanzamento**: il componente che riceve gli aggiornamenti di stato in tempo reale da ComfyUI e li mostra all'utente.
- **Galleria**: la raccolta visuale dei contenuti generati (immagini e video) nel webview Image Studio.
- **Workflow_API**: un workflow ComfyUI nel formato "API" (dizionario di nodi con `class_type` e `inputs`).
- **Workflow_UI**: un workflow ComfyUI nel formato editor (grafo con `nodes[]` e `links[]`).
- **I2V**: image-to-video, generazione di un video a partire da un'immagine iniziale.
- **T2V**: text-to-video, generazione di un video a partire da un testo.
- **GGUF**: formato di pesi quantizzati caricato da nodi dedicati (es. `UnetLoaderGGUF`).
- **VRAM**: memoria video della GPU.
- **Endpoint_ComfyUI**: l'indirizzo HTTP su cui ComfyUI è in ascolto (predefinito `http://127.0.0.1:8188`).

---

## Requirements

I requisiti sono organizzati in quattro gruppi: **Pilastro A — Autonomia LLM** (Req. 1-4), **Pilastro B — Autonomia di generazione** (Req. 5-11), **Pilastro C — Autonomia ComfyUI** (Req. 12-18) e **Requisiti non funzionali** (Req. 19-24).

### Requirement 1: Ciclo agentico di generazione end-to-end (Pilastro A — Autonomia LLM)

**User Story:** Come utente, voglio chiedere in linguaggio naturale "genera un video di X da questa immagine" e ottenere il risultato, così che non debba configurare manualmente workflow, modelli e parametri.

#### Acceptance Criteria

1. WHEN l'utente invia una richiesta di generazione in linguaggio naturale, THE Orchestratore SHALL classificare la richiesta come immagine, T2V o I2V prima di pianificare l'esecuzione.
2. WHEN la richiesta è stata classificata, THE Orchestratore SHALL produrre un piano ordinato di passi che includa selezione del workflow, verifica delle dipendenze, impostazione degli input ed esecuzione.
3. WHEN il piano è pronto, THE Orchestratore SHALL eseguire i passi in sequenza fino al completamento o al primo errore non recuperabile.
4. WHEN l'esecuzione termina con successo, THE Orchestratore SHALL riportare all'utente il contenuto generato e un riepilogo dei passi eseguiti.
5. IF un passo del piano fallisce in modo non recuperabile, THEN THE Orchestratore SHALL interrompere l'esecuzione e riportare all'utente il passo fallito e la causa in linguaggio naturale.
6. WHERE la richiesta dell'utente è ambigua riguardo al tipo di contenuto, THE Orchestratore SHALL chiedere all'utente una conferma del tipo prima di pianificare.

### Requirement 2: Selezione automatica provider e modello LLM

**User Story:** Come utente, voglio che MGCoding scelga da sola il provider e il modello LLM più adatti, così da ottenere qualità senza configurazione manuale.

#### Acceptance Criteria

1. WHEN l'Orchestratore richiede assistenza di ragionamento, THE Router_LLM SHALL selezionare un provider tra quelli configurati e raggiungibili.
2. WHERE è configurato l'instradamento automatico, THE Router_LLM SHALL instradare le richieste complesse al provider designato come pesante e le richieste semplici al provider designato come leggero.
3. WHERE la richiesta include immagini, THE Router_LLM SHALL selezionare un modello con capacità vision tra quelli installati.
4. IF nessun provider LLM è configurato o raggiungibile, THEN THE Router_LLM SHALL notificare all'utente l'assenza di un provider e indicare come configurarne uno.
5. WHERE l'utente ha indicato una preferenza locale-first, THE Router_LLM SHALL privilegiare i modelli locali Ollama prima dei provider cloud.

### Requirement 3: Assistenza LLM alla comprensione del workflow

**User Story:** Come utente, voglio che MGCoding capisca un workflow arbitrario per impostarne gli input correttamente, così da non dover mappare i nodi a mano.

#### Acceptance Criteria

1. WHEN un workflow non riconosciuto deve essere eseguito, THE Orchestratore SHALL costruire una mappatura tra i parametri logici (prompt positivo, prompt negativo, seed, passi, cfg, dimensioni, immagine iniziale, durata video, fps) e i nodi/campi del workflow.
2. WHERE la mappatura euristica dei nodi è ambigua, THE Orchestratore SHALL usare il Router_LLM per disambiguare la mappatura sulla base della struttura del grafo.
3. WHEN la mappatura è completa, THE Orchestratore SHALL registrare la mappatura risolta per il workflow così da riusarla nelle esecuzioni successive.
4. IF un parametro logico richiesto non trova alcun nodo corrispondente nel workflow, THEN THE Orchestratore SHALL segnalare all'utente quale parametro non è mappabile.

### Requirement 4: Scoperta e raccomandazione di workflow

**User Story:** Come utente, voglio che MGCoding mi suggerisca un workflow adatto al compito, così da partire dalla configurazione giusta.

#### Acceptance Criteria

1. WHEN l'utente descrive un compito di generazione senza indicare un workflow, THE Orchestratore SHALL proporre un workflow compatibile tra quelli disponibili localmente.
2. IF nessun workflow locale è adatto al compito, THEN THE Orchestratore SHALL informare l'utente e proporre l'importazione o il download di un workflow.
3. WHEN l'Orchestratore propone un workflow, THE Orchestratore SHALL indicare i modelli e i nodi richiesti dal workflow.

### Requirement 5: Generazione video text-to-video e image-to-video (Pilastro B — Autonomia di generazione)

**User Story:** Come utente, voglio generare video da testo o da un'immagine iniziale, così da produrre contenuti animati e non solo immagini statiche.

#### Acceptance Criteria

1. WHERE il backend selezionato è ComfyUI, THE Motore_Generazione SHALL supportare la generazione T2V tramite un workflow video.
2. WHERE il backend selezionato è ComfyUI ed è fornita un'immagine iniziale, THE Motore_Generazione SHALL eseguire una generazione I2V instradando l'immagine iniziale al nodo di caricamento immagine di partenza del workflow.
3. WHEN un workflow video viene eseguito, THE Motore_Generazione SHALL accettare i parametri di durata (numero di fotogrammi) e di frequenza fotogrammi (fps) e applicarli al workflow.
4. WHEN un'esecuzione video termina, THE Motore_Generazione SHALL recuperare i file video prodotti dai nodi di output video.
5. IF il workflow non espone alcun nodo di output video, THEN THE Motore_Generazione SHALL segnalare all'utente che il workflow non produce video.

### Requirement 6: Riconoscimento degli output video

**User Story:** Come utente, voglio che i video generati siano riconosciuti e salvati, così da poterli rivedere.

#### Acceptance Criteria

1. WHEN un'esecuzione produce un output da un nodo di combinazione video, THE Motore_Generazione SHALL riconoscere l'output come video.
2. WHEN un'esecuzione produce un output animato WEBP o GIF, THE Motore_Generazione SHALL riconoscere l'output come video animato.
3. WHEN un file video viene recuperato, THE Motore_Generazione SHALL salvarlo nella cartella della Galleria mantenendo il formato originale.
4. WHERE un'esecuzione produce sia immagini sia video, THE Motore_Generazione SHALL salvare entrambi i tipi di output.

### Requirement 7: Galleria e anteprima dei video

**User Story:** Come utente, voglio vedere e riprodurre i video nella galleria, così da gestirli come le immagini.

#### Acceptance Criteria

1. WHEN la Galleria viene aggiornata, THE Galleria SHALL elencare sia le immagini sia i video presenti nella cartella di output.
2. WHEN l'utente seleziona un video nella Galleria, THE Galleria SHALL riprodurre il video in un'anteprima.
3. WHEN l'utente richiede di eliminare un elemento video, THE Galleria SHALL rimuovere il file e aggiornare l'elenco.
4. WHEN l'utente richiede di aprire un elemento, THE Galleria SHALL aprire il file nel sistema operativo.

### Requirement 8: Avanzamento in tempo reale e annullamento

**User Story:** Come utente, voglio vedere l'avanzamento di una generazione e poterla annullare, così da non attendere al buio operazioni lunghe come i video.

#### Acceptance Criteria

1. WHILE un'esecuzione ComfyUI è in corso, THE Monitor_Avanzamento SHALL mostrare la percentuale di completamento e il nodo correntemente in esecuzione.
2. WHEN l'utente richiede l'annullamento di un'esecuzione in corso, THE Motore_Generazione SHALL interrompere l'esecuzione su ComfyUI entro 5 secondi.
3. WHEN un'esecuzione viene annullata, THE Motore_Generazione SHALL riportare all'utente lo stato di annullamento.
4. IF la connessione di stato in tempo reale con ComfyUI cade durante un'esecuzione, THEN THE Monitor_Avanzamento SHALL ripiegare sul polling periodico dello stato dell'esecuzione.

### Requirement 9: Workflow multi-stadio e GGUF

**User Story:** Come utente, voglio eseguire workflow multi-stadio con pesi GGUF (es. WAN 2.2 con esperti high-noise/low-noise e doppio LoRA), così da usare i workflow video moderni della community.

#### Acceptance Criteria

1. WHERE un workflow carica i pesi tramite un nodo GGUF, THE Motore_Workflow SHALL trattare i campi nome-modello GGUF come riferimenti a modelli da verificare e scaricare.
2. WHERE un workflow contiene più stadi di campionamento (es. high-noise e low-noise), THE Motore_Workflow SHALL applicare il seed e i parametri a ciascuno stadio in modo coerente.
3. WHERE un workflow applica più LoRA, THE Motore_Workflow SHALL preservare i collegamenti di ciascun LoRA durante l'impostazione degli input.
4. WHEN l'Orchestratore imposta gli input su un workflow multi-stadio, THE Motore_Workflow SHALL iniettare il prompt nel nodo di testo positivo corretto senza alterare gli altri stadi.

### Requirement 10: Mappatura robusta degli input

**User Story:** Come utente, voglio che il prompt, l'immagine iniziale e i parametri vengano inseriti nei punti giusti di qualsiasi workflow, così da evitare errori di iniezione.

#### Acceptance Criteria

1. WHEN l'Orchestratore imposta il prompt positivo, THE Motore_Workflow SHALL individuare il nodo di testo collegato all'input positivo del campionatore e sostituirne il testo.
2. WHEN l'Orchestratore imposta il prompt negativo, THE Motore_Workflow SHALL individuare il nodo di testo collegato all'input negativo del campionatore e sostituirne il testo.
3. WHEN viene fornita un'immagine iniziale, THE Motore_Workflow SHALL caricare l'immagine su ComfyUI e collegarne il riferimento al nodo di caricamento immagine usato come ingresso del workflow.
4. WHEN viene richiesta la riproducibilità, THE Motore_Workflow SHALL impostare un seed fisso su tutti i nodi che espongono un campo seed.
5. WHERE l'utente non richiede un seed fisso, THE Motore_Workflow SHALL impostare un seed casuale su tutti i nodi che espongono un campo seed.

### Requirement 11: Backend di generazione multipli

**User Story:** Come utente, voglio che MGCoding scelga il backend di generazione disponibile, così da generare anche quando un backend non è presente.

#### Acceptance Criteria

1. WHERE l'utente non ha forzato un backend, THE Motore_Generazione SHALL selezionare automaticamente il primo backend disponibile tra quelli locali e cloud configurati.
2. WHEN viene richiesta una generazione video, THE Motore_Generazione SHALL selezionare un backend che supporti i workflow video.
3. IF il backend richiesto non è disponibile, THEN THE Motore_Generazione SHALL notificare all'utente quale backend manca e quali alternative sono disponibili.

### Requirement 12: Rilevamento dello stato di ComfyUI (Pilastro C — Autonomia ComfyUI)

**User Story:** Come utente, voglio che MGCoding sappia se ComfyUI è in esecuzione, così da agire di conseguenza senza che debba controllarlo io.

#### Acceptance Criteria

1. WHEN MGCoding deve eseguire un'operazione su ComfyUI, THE Gestore_ComfyUI SHALL verificare la raggiungibilità di ComfyUI sull'Endpoint_ComfyUI entro 3 secondi.
2. IF ComfyUI non è raggiungibile, THEN THE Gestore_ComfyUI SHALL segnalare lo stato non disponibile e proporre l'avvio.
3. WHEN ComfyUI è raggiungibile, THE Gestore_ComfyUI SHALL rendere disponibili gli elenchi di checkpoint, LoRA e nodi installati.

### Requirement 13: Avvio e arresto di ComfyUI

**User Story:** Come utente, voglio che MGCoding avvii e arresti ComfyUI da sola, così da non dover lanciare script manuali.

#### Acceptance Criteria

1. WHEN l'utente richiede l'avvio di ComfyUI e una cartella ComfyUI è configurata, THE Gestore_ComfyUI SHALL avviare il processo di ComfyUI usando l'ambiente Python individuato.
2. WHEN il processo di ComfyUI è stato avviato, THE Gestore_ComfyUI SHALL attendere che l'Endpoint_ComfyUI risponda prima di dichiarare ComfyUI pronto.
3. WHEN l'utente richiede l'arresto di ComfyUI avviato da MGCoding, THE Gestore_ComfyUI SHALL terminare il processo avviato.
4. IF la cartella di ComfyUI non è configurata al momento dell'avvio, THEN THE Gestore_ComfyUI SHALL chiedere all'utente di selezionare la cartella di ComfyUI.
5. IF l'Endpoint_ComfyUI non risponde entro 120 secondi dall'avvio, THEN THE Gestore_ComfyUI SHALL segnalare all'utente il mancato avvio.

### Requirement 14: Installazione di ComfyUI e dell'ambiente

**User Story:** Come utente, voglio che MGCoding installi ComfyUI e ComfyUI-Manager se non sono presenti, così da partire da zero senza setup manuale.

#### Acceptance Criteria

1. WHEN l'utente richiede l'installazione di ComfyUI e nessuna installazione è presente, THE Gestore_ComfyUI SHALL chiedere conferma prima di scaricare e installare ComfyUI.
2. WHERE l'utente conferma l'installazione di ComfyUI, THE Gestore_ComfyUI SHALL installare ComfyUI e configurarne la cartella in MGCoding.
3. WHERE ComfyUI è installato ma ComfyUI-Manager è assente, THE Gestore_ComfyUI SHALL proporre l'installazione di ComfyUI-Manager.
4. IF l'installazione di ComfyUI fallisce, THEN THE Gestore_ComfyUI SHALL riportare all'utente la causa del fallimento e lasciare il sistema in uno stato utilizzabile.

### Requirement 15: Conversione automatica da formato UI a formato API

**User Story:** Come utente, voglio importare un workflow scaricato dal web (formato UI) senza riesportarlo a mano, così da usare i workflow della community direttamente.

#### Acceptance Criteria

1. WHEN l'utente importa un workflow in formato API, THE Motore_Workflow SHALL salvarlo e impostarlo come workflow attivo.
2. WHEN l'utente importa un Workflow_UI, THE Convertitore_Workflow SHALL convertirlo in Workflow_API prima di salvarlo.
3. WHERE la conversione locale del Workflow_UI non è possibile e ComfyUI è raggiungibile, THE Convertitore_Workflow SHALL usare ComfyUI per produrre il formato API.
4. IF un Workflow_UI non può essere convertito in Workflow_API, THEN THE Convertitore_Workflow SHALL segnalare all'utente che il workflow non è convertibile e indicarne il motivo.
5. WHERE l'utente seleziona un archivio compresso contenente un workflow, THE Motore_Workflow SHALL estrarre il workflow dall'archivio prima di importarlo.

### Requirement 16: Download automatico dei modelli mancanti

**User Story:** Come utente, voglio che i modelli richiesti da un workflow vengano scaricati automaticamente nelle cartelle giuste, così da non cercarli a mano.

#### Acceptance Criteria

1. WHEN un workflow viene preparato per l'esecuzione, THE Gestore_Modelli SHALL rilevare i modelli referenziati dal workflow che non sono installati in ComfyUI.
2. WHERE esistono modelli mancanti risolvibili da un catalogo, THE Gestore_Modelli SHALL chiedere conferma prima di scaricarli nelle cartelle corrispondenti al tipo di modello.
3. WHERE un modello mancante non è risolvibile automaticamente, THE Gestore_Modelli SHALL chiedere all'utente un URL di download per quel modello.
4. WHEN un download di modello è in corso, THE Gestore_Modelli SHALL mostrare l'avanzamento e consentire l'annullamento.
5. IF il download di un modello fallisce, THEN THE Gestore_Modelli SHALL riportare all'utente il modello non scaricato e la causa.

### Requirement 17: Installazione automatica dei nodi custom mancanti

**User Story:** Come utente, voglio che i nodi custom richiesti da un workflow vengano installati automaticamente, così da eseguire workflow che usano estensioni di terzi.

#### Acceptance Criteria

1. WHEN un workflow in formato API viene preparato, THE Gestore_Nodi SHALL rilevare le `class_type` usate dal workflow che non sono registrate in ComfyUI.
2. WHERE esistono nodi mancanti risolvibili in repository, THE Gestore_Nodi SHALL chiedere conferma esplicita prima di clonare codice di terzi e installarne le dipendenze.
3. WHEN l'utente conferma l'installazione dei nodi, THE Gestore_Nodi SHALL clonare i repository nella cartella dei nodi custom e installare le dipendenze indicate.
4. WHEN l'installazione dei nodi è completata, THE Gestore_Nodi SHALL informare l'utente che è necessario riavviare ComfyUI per caricare i nuovi nodi.
5. IF un nodo mancante non è risolvibile automaticamente, THEN THE Gestore_Nodi SHALL elencare all'utente i nodi da installare manualmente.

### Requirement 18: Recupero automatico dagli errori di esecuzione

**User Story:** Come utente, voglio che MGCoding interpreti gli errori di ComfyUI e li risolva da sola quando possibile, così da non vedere errori grezzi.

#### Acceptance Criteria

1. WHEN un'esecuzione ComfyUI fallisce, THE Recupero_Errori SHALL interpretare il messaggio di errore e classificarne la causa.
2. IF l'errore indica un nodo custom mancante, THEN THE Recupero_Errori SHALL proporre l'installazione del nodo mancante e, dopo conferma, ritentare l'esecuzione.
3. IF l'errore indica un modello mancante, THEN THE Recupero_Errori SHALL proporre il download del modello mancante e, dopo conferma, ritentare l'esecuzione.
4. IF l'errore indica memoria VRAM insufficiente, THEN THE Recupero_Errori SHALL ridurre la risoluzione o i passi entro i limiti consentiti e ritentare l'esecuzione.
5. IF l'errore non è classificabile o il numero massimo di tentativi è stato raggiunto, THEN THE Recupero_Errori SHALL riportare all'utente l'errore in linguaggio naturale e l'azione suggerita.
6. WHEN il Recupero_Errori ritenta un'esecuzione, THE Recupero_Errori SHALL limitare i nuovi tentativi a un massimo di 3.

### Requirement 19: Funzionamento con bassa VRAM (Requisiti non funzionali)

**User Story:** Come utente con una GPU da 8 GB, voglio poter generare immagini e video, così da non essere escluso dalle funzionalità.

#### Acceptance Criteria

1. WHERE è stato indicato un limite di VRAM pari o inferiore a 8 GB, THE Motore_Generazione SHALL selezionare parametri predefiniti compatibili con quel limite.
2. WHEN un'esecuzione fallisce per VRAM insufficiente, THE Recupero_Errori SHALL applicare una configurazione a minore consumo di memoria prima di ritentare.
3. WHERE è disponibile una variante quantizzata GGUF di un modello richiesto, THE Gestore_Modelli SHALL proporre la variante quantizzata per ridurre l'uso di VRAM.

### Requirement 20: Local-first e funzionamento offline

**User Story:** Come utente, voglio operare in locale senza dipendere dal cloud, così da lavorare offline e privatamente.

#### Acceptance Criteria

1. WHERE sono disponibili sia opzioni locali sia cloud, THE Orchestratore SHALL privilegiare i backend e i modelli locali.
2. WHILE non è disponibile alcuna connessione di rete, THE MGCoding SHALL consentire la generazione con i modelli e i workflow già presenti localmente.
3. IF un'operazione richiede la rete e la rete non è disponibile, THEN THE MGCoding SHALL segnalare all'utente che l'operazione richiede una connessione.

### Requirement 21: Privacy dei prompt

**User Story:** Come utente, voglio che i miei prompt restino privati, così da non esporre i contenuti che genero.

#### Acceptance Criteria

1. THE MGCoding SHALL elaborare i prompt destinati ai backend locali senza trasmetterli a servizi di terze parti.
2. WHERE l'utente seleziona un backend o un provider cloud, THE MGCoding SHALL trasmettere il prompt esclusivamente al servizio selezionato per quella richiesta.
3. THE MGCoding SHALL escludere i prompt da qualsiasi telemetria.

### Requirement 22: Conferma per azioni rischiose

**User Story:** Come utente, voglio approvare le azioni che eseguono codice di terzi o avviano processi, così da mantenere il controllo.

#### Acceptance Criteria

1. WHEN MGCoding sta per clonare ed eseguire codice di nodi custom di terzi, THE MGCoding SHALL richiedere conferma esplicita all'utente.
2. WHEN MGCoding sta per scaricare un modello, THE MGCoding SHALL richiedere conferma esplicita all'utente.
3. WHEN MGCoding sta per avviare o installare un processo esterno, THE MGCoding SHALL richiedere conferma esplicita all'utente.
4. WHEN MGCoding sta per eliminare un file, THE MGCoding SHALL richiedere conferma esplicita all'utente.

### Requirement 23: Degrado controllato in assenza di dipendenze

**User Story:** Come utente, voglio che MGCoding resti utilizzabile anche se ComfyUI o un modello mancano, così da non trovarmi con funzioni bloccate.

#### Acceptance Criteria

1. IF ComfyUI non è disponibile, THEN THE MGCoding SHALL mantenere disponibili le funzioni che non dipendono da ComfyUI e indicare le funzioni non disponibili.
2. IF un modello richiesto è assente, THEN THE Motore_Generazione SHALL proporre un modello alternativo disponibile o il download del modello mancante.
3. WHEN una dipendenza opzionale è assente, THE MGCoding SHALL spiegare all'utente cosa installare per abilitare la funzione corrispondente.

### Requirement 24: Priorità a Windows

**User Story:** Come utente Windows, voglio che le funzioni di ciclo di vita e installazione funzionino su Windows, così da usare MGCoding sulla piattaforma di riferimento.

#### Acceptance Criteria

1. WHERE il sistema operativo è Windows, THE Gestore_ComfyUI SHALL individuare l'interprete Python embedded della distribuzione portable di ComfyUI.
2. WHERE il sistema operativo è Windows, THE Gestore_ComfyUI SHALL avviare ComfyUI con il comando appropriato per la piattaforma.
3. WHEN MGCoding costruisce percorsi di file, THE MGCoding SHALL usare separatori di percorso validi per il sistema operativo corrente.
