# Requirements Document

## Introduction

Questa funzionalità migliora MGCoding (fork di VS Code con estensione integrata in `extensions/mgcoding/`, che realizza un IDE agentico spec-driven in stile Kiro) affinché le esperienze **Vibe** (chat agentica) e **Spec** (workflow requirements → design → tasks) raggiungano un'affidabilità paragonabile a Kiro **mentre girano su modelli locali** (Ollama), usando modelli cloud economici come ripiego conveniente.

Gli obiettivi principali sono otto, tutti derivati da un'analisi del codice esistente:

1. Impostare esplicitamente la finestra di contesto Ollama (`num_ctx`), oggi mai impostata, per evitare il troncamento silenzioso del contesto durante le esecuzioni agentiche lunghe.
2. Rendere il tool-calling strutturato/grammaticale il default per i modelli locali capaci, con fallback e retry **per iterazione** (non disabilitazione per l'intera esecuzione al primo errore).
3. Introdurre una classificazione esplicita delle capacità dei modelli (tier) e instradare di conseguenza, senza fidarsi della sola capability `tools` dichiarata da `/api/show`.
4. Gestione del contesto consapevole dei token (budget per-modello, riserva per system+tools, riassunto dei turni vecchi invece del troncamento a caratteri fissi).
5. Modalità di autonomia reali: **Autopilot** vs **Supervised**, basate sull'infrastruttura di checkpoint esistente.
6. Enforcement del gating dello workflow Spec contro il modello: copertura di ogni criterio EARS (Req N.M) ad almeno un task, validazione strutturale dei documenti, approvazione obbligatoria.
7. Prompt di sistema calibrati sul modello: varianti compatte e sottoinsieme di tool ridotto per finestre di contesto piccole.
8. Aggiungere GLM (Zhipu/Z.ai) come provider (API OpenAI-compatibile e Anthropic-compatibile), integrato con l'instradamento heavy/light esistente, come tier "heavy" cloud economico.

I vincoli del prodotto sono: Windows-first (`win32`, shell `cmd`); identificatori di codice in inglese, prosa/commenti in italiano; configurazione scritta sotto `.mg/` con lettura legacy di `.kiro/`; chiavi provider in VS Code SecretStorage; piena retrocompatibilità con gli utenti Ollama/Claude/OpenAI esistenti.

## Glossary

- **MGCoding**: l'estensione VS Code che fornisce le esperienze Vibe e Spec; sistema contenitore di tutti gli altri componenti.
- **Agent_Loop**: il ciclo agentico (`agent/agentLoop.ts`) che alterna chiamate al modello ed esecuzione di tool, con `MAX_ITERATIONS = 30`.
- **Ollama_Provider**: il provider locale (`llm/ollamaProvider.ts`) che dialoga con il server Ollama via `/api/chat`.
- **Claude_Provider**: il provider Anthropic native tool-use (`llm/claudeProvider.ts`).
- **OpenAI_Provider**: il provider OpenAI-compatibile (`llm/openaiProvider.ts`), incluso Azure e Gemini.
- **GLM_Provider**: il nuovo provider per i modelli GLM di Zhipu/Z.ai, raggiungibile via endpoint OpenAI-compatibile o Anthropic-compatibile.
- **Provider_Router**: la logica di selezione del provider (`llm/registry.ts`, funzione pura `chooseProvider` più `autoRoute`).
- **Capability_Tier**: la classe di capacità assegnata a un modello: `native` (tool-use nativo affidabile), `structured` (richiede grammatica/JSON vincolato), `textual` (richiede il protocollo testuale `mg-tool` con scaffolding).
- **Capability_Detector**: il componente che determina la Capability_Tier di un modello.
- **Context_Budget**: il budget di token per una richiesta, comprensivo di system prompt, definizioni dei tool, cronologia e spazio riservato per la risposta.
- **Context_Manager**: il componente che calcola il Context_Budget, imposta `num_ctx` e riassume i turni vecchi.
- **Structured_Tool_Engine**: il percorso di tool-calling con output vincolato a uno schema (Ollama `chatStructured`).
- **Autonomy_Mode**: la modalità di autonomia attiva: `autopilot` (esecuzione senza interruzioni con checkpoint) o `supervised` (approvazione richiesta per le azioni a rischio).
- **Autonomy_Controller**: il componente che applica la Autonomy_Mode alle azioni dell'Agent_Loop.
- **Spec_Validator**: il componente che valida struttura e copertura dei documenti Spec.
- **Acceptance_Criterion**: un singolo criterio di accettazione EARS, identificato come `Req N.M`.
- **Coverage_Map**: la mappatura da ogni Acceptance_Criterion ad almeno un task del file `tasks.md`.
- **Prompt_Composer**: il componente che compone il system prompt e il sottoinsieme di tool in base alla Capability_Tier e al Context_Budget.
- **Secret_Store**: VS Code SecretStorage, dove sono custodite le chiavi API dei provider.
- **Config_Key**: una chiave di configurazione sotto il namespace `mgcoding`.

## Requirements

### Requirement 1: Finestra di contesto Ollama esplicita

**User Story:** Come utente che esegue agenti su modelli locali, voglio che la finestra di contesto Ollama sia impostata esplicitamente, così che le esecuzioni lunghe non subiscano un troncamento silenzioso del contesto.

#### Acceptance Criteria

1. WHEN Ollama_Provider invia una richiesta a `/api/chat`, THE Ollama_Provider SHALL includere il parametro `options.num_ctx` con un valore intero positivo.
2. WHEN Context_Manager calcola il Context_Budget per un modello, THE Context_Manager SHALL derivare `num_ctx` dalla finestra di contesto massima dichiarata dal modello e dal Config_Key di budget.
3. WHERE l'utente ha impostato il Config_Key `mgcoding.ollama.numCtx` con un valore intero positivo, THE Ollama_Provider SHALL usare quel valore come `num_ctx`.
4. IF la finestra di contesto del modello non è determinabile, THEN THE Context_Manager SHALL usare un valore di `num_ctx` di default pari a 8192.
5. WHEN il Context_Budget stimato di una richiesta supera il valore di `num_ctx` corrente, THE Context_Manager SHALL ridurre la cronologia inviata fino a rientrare nel valore di `num_ctx`.

### Requirement 2: Tool-calling strutturato come default con fallback per iterazione

**User Story:** Come utente su modelli locali capaci, voglio che il tool-calling strutturato sia il comportamento predefinito con recupero per singola iterazione, così che un singolo errore di formato non degradi l'intera esecuzione.

#### Acceptance Criteria

1. WHERE il modello locale attivo ha Capability_Tier pari a `structured` o `native`, THE Agent_Loop SHALL usare lo Structured_Tool_Engine come percorso predefinito di tool-calling.
2. IF lo Structured_Tool_Engine produce un output non conforme allo schema in una iterazione, THEN THE Agent_Loop SHALL ritentare la stessa iterazione sullo Structured_Tool_Engine incrementando il contatore dei retry esattamente di uno prima di cambiare percorso.
3. IF lo Structured_Tool_Engine fallisce dopo il numero massimo di retry per una iterazione, THEN THE Agent_Loop SHALL ricadere sul percorso testuale `mg-tool` solo per quella iterazione.
4. WHEN una iterazione successiva inizia dopo un fallback testuale, THE Agent_Loop SHALL ritentare lo Structured_Tool_Engine se la Capability_Tier del modello è `structured` o `native`.
5. WHERE l'utente imposta il Config_Key `mgcoding.ollama.structuredTools` su `false`, THE Agent_Loop SHALL usare il percorso testuale `mg-tool` senza tentare lo Structured_Tool_Engine.

### Requirement 3: Classificazione delle capacità del modello (tiering)

**User Story:** Come utente, voglio che MGCoding riconosca cosa ogni modello locale sa davvero fare, così che l'instradamento non si basi su capacità dichiarate ma inaffidabili.

#### Acceptance Criteria

1. WHEN un modello locale viene selezionato per la prima volta in una sessione, THE Capability_Detector SHALL assegnare al modello una Capability_Tier tra `native`, `structured` e `textual`.
2. THE Capability_Detector SHALL assegnare la Capability_Tier `native` solo dopo che il modello supera un test di verifica funzionale del tool-use, indipendentemente dalla capability `tools` dichiarata da `/api/show`.
3. IF un modello dichiara la capability `tools` ma fallisce il test di verifica funzionale, THEN THE Capability_Detector SHALL assegnare una Capability_Tier non superiore a `structured`.
4. WHEN la Capability_Tier di un modello è stata determinata, THE Capability_Detector SHALL memorizzarla in cache per la durata della sessione associandola al nome del modello.
5. WHERE l'utente imposta il Config_Key `mgcoding.model.capabilityTier` per un modello, THE Capability_Detector SHALL usare il valore configurato senza eseguire il test di verifica funzionale.
6. THE Provider_Router SHALL selezionare il percorso di tool-calling dell'Agent_Loop in base alla Capability_Tier del modello attivo.

### Requirement 4: Gestione del contesto consapevole dei token

**User Story:** Come utente con esecuzioni agentiche lunghe, voglio una gestione del contesto basata sui token con riassunto dei turni vecchi, così che le informazioni rilevanti non vengano perse da un troncamento cieco a caratteri.

#### Acceptance Criteria

1. WHEN Context_Manager prepara una richiesta, THE Context_Manager SHALL stimare i token di system prompt, definizioni dei tool e cronologia dei messaggi.
2. THE Context_Manager SHALL riservare una quota del Context_Budget per la risposta del modello non inferiore a 1024 token.
3. WHEN la cronologia stimata eccede lo spazio disponibile del Context_Budget, THE Context_Manager SHALL riassumere i risultati dei tool più vecchi mantenendo integri i 4 risultati più recenti.
4. WHEN Context_Manager riassume un risultato di tool, THE Context_Manager SHALL conservare l'identità del tool e l'esito (successo o errore) nel riassunto.
5. IF dopo il riassunto la richiesta eccede ancora il Context_Budget, THEN THE Context_Manager SHALL rimuovere i turni più vecchi finché la richiesta rientra nel Context_Budget, e SHALL procedere con la richiesta anche se, rimossi tutti i turni rimovibili, la richiesta resta oltre il Context_Budget.
6. WHERE il Config_Key `mgcoding.context.summarize` è `false`, THE Context_Manager SHALL applicare il troncamento dei risultati vecchi senza generare riassunti.

### Requirement 5: Modalità di autonomia Autopilot e Supervised

**User Story:** Come utente, voglio scegliere tra autonomia totale e supervisione, così che io possa lasciar lavorare l'agente da solo oppure approvare le azioni a rischio.

#### Acceptance Criteria

1. THE Autonomy_Controller SHALL supportare due Autonomy_Mode: `autopilot` e `supervised`.
2. WHERE la Autonomy_Mode è `supervised`, THE Autonomy_Controller SHALL richiedere l'approvazione dell'utente prima di applicare una modifica a file o di eseguire un comando di shell.
3. WHERE la Autonomy_Mode è `autopilot`, THE Autonomy_Controller SHALL eseguire le azioni dell'Agent_Loop senza richiedere approvazione.
4. WHEN la Autonomy_Mode è `autopilot` e una modifica a file viene applicata, THE Autonomy_Controller SHALL creare un checkpoint reversibile prima della modifica.
5. WHEN l'utente richiede il ripristino di un checkpoint, THE Autonomy_Controller SHALL riportare i file allo stato del checkpoint selezionato.
6. THE Autonomy_Controller SHALL leggere la Autonomy_Mode predefinita dal Config_Key `mgcoding.autonomyMode`.
7. IF un comando di shell è classificato come distruttivo, THEN THE Autonomy_Controller SHALL richiedere l'approvazione dell'utente anche in Autonomy_Mode `autopilot`.

### Requirement 6: Enforcement del gating dello workflow Spec

**User Story:** Come utente dello workflow Spec, voglio che la copertura, la struttura e l'approvazione siano verificate contro il modello, così che i documenti generati siano completi e coerenti prima di procedere.

#### Acceptance Criteria

1. WHEN viene generato un documento `requirements.md`, THE Spec_Validator SHALL verificare che ogni Acceptance_Criterion segua esattamente uno dei sei pattern EARS.
2. WHEN viene generato un documento `tasks.md`, THE Spec_Validator SHALL costruire la Coverage_Map dagli Acceptance_Criterion ai task.
3. IF un Acceptance_Criterion non è mappato ad almeno un task nella Coverage_Map, THEN THE Spec_Validator SHALL segnalare il criterio non coperto e bloccare il completamento della fase tasks.
4. WHEN un documento Spec viene generato, THE Spec_Validator SHALL validare la presenza delle sezioni strutturali attese per la fase corrente.
5. IF una sezione strutturale attesa è assente, THEN THE Spec_Validator SHALL segnalare la sezione mancante e bloccare l'avanzamento alla fase successiva, consentendo comunque il completamento della fase corrente.
6. WHILE l'approvazione dell'utente per la fase corrente non è registrata, THE MGCoding SHALL impedire l'avvio della fase successiva dello workflow.

### Requirement 7: Prompt di sistema e tool calibrati sul modello

**User Story:** Come utente su modelli con finestre di contesto piccole, voglio prompt di sistema più brevi e un set di tool ridotto, così che il contesto utile non sia consumato dal preambolo.

#### Acceptance Criteria

1. WHEN Prompt_Composer compone il system prompt, THE Prompt_Composer SHALL selezionare la variante del prompt in base alla Capability_Tier e al Context_Budget del modello attivo.
2. WHERE il Context_Budget del modello attivo è inferiore o uguale a 8192 token, THE Prompt_Composer SHALL usare la variante compatta del system prompt.
3. WHERE il Context_Budget del modello attivo è inferiore o uguale a 8192 token, THE Prompt_Composer SHALL selezionare un sottoinsieme ridotto di tool definito per le finestre piccole e SHALL esporre al modello esclusivamente tale sottoinsieme come tool utilizzabili.
4. THE Prompt_Composer SHALL basare la scelta della variante compatta sul Context_Budget effettivo e non sul solo nome del modello.
5. WHERE il Context_Budget del modello attivo è superiore a 8192 token, THE Prompt_Composer SHALL usare la variante completa del system prompt e l'insieme completo dei tool.

### Requirement 8: Provider GLM (Zhipu/Z.ai)

**User Story:** Come utente, voglio usare i modelli GLM come tier cloud economico, così che io abbia un ripiego affidabile e conveniente quando i modelli locali sono troppo deboli.

#### Acceptance Criteria

1. THE Provider_Router SHALL rendere disponibile GLM_Provider come provider selezionabile tra i preset.
2. THE GLM_Provider SHALL supportare la configurazione dell'endpoint OpenAI-compatibile per i modelli GLM.
3. WHERE l'utente abilita il Config_Key `mgcoding.glm.useAnthropicEndpoint`, THE GLM_Provider SHALL abilitare l'endpoint Anthropic-compatibile con il percorso di tool-use nativo mantenendo disponibile anche la compatibilità OpenAI.
4. WHEN l'utente fornisce una chiave API GLM, THE MGCoding SHALL memorizzare la chiave nel Secret_Store.
5. WHERE l'instradamento automatico `autoRoute` è attivo e GLM_Provider è il provider heavy configurato, THE Provider_Router SHALL selezionare GLM_Provider per le richieste classificate come `heavy`.
6. IF nessun modello locale raggiunge la Capability_Tier richiesta per una richiesta `heavy` e GLM_Provider è raggiungibile, THEN THE Provider_Router SHALL selezionare GLM_Provider come ripiego.
7. IF nessun modello locale raggiunge la Capability_Tier richiesta per una richiesta `heavy` e GLM_Provider non è raggiungibile, THEN THE Provider_Router SHALL selezionare il miglior modello locale disponibile anche se non raggiunge la Capability_Tier richiesta.

### Requirement 9: Gestione degli errori dei provider e dei modelli

**User Story:** Come utente, voglio messaggi chiari e ripieghi sicuri quando un provider o un modello non risponde come atteso, così che l'esperienza resti utilizzabile senza fallimenti silenziosi.

#### Acceptance Criteria

1. IF il server Ollama locale non è raggiungibile all'endpoint configurato, THEN THE MGCoding SHALL mostrare un messaggio di errore che indica l'endpoint non raggiungibile.
2. IF una richiesta a un provider cloud fallisce per chiave API mancante, THEN THE MGCoding SHALL chiedere all'utente di fornire la chiave API e SHALL interrompere la richiesta corrente.
3. IF una richiesta a un provider cloud fallisce per chiave API non valida, THEN THE MGCoding SHALL mostrare un messaggio che indica la chiave non valida.
4. IF un provider raggiunge un limite di rate, THEN THE MGCoding SHALL segnalare la condizione di limite e SHALL proporre un provider di ripiego se disponibile.
5. WHEN tutti i provider configurati sono non raggiungibili, THE Provider_Router SHALL restituire l'assenza di un provider e THE MGCoding SHALL informare l'utente che nessun provider è disponibile.
6. IF un modello dichiara una capacità di tool-use ma non emette alcuna chiamata a tool valida entro le iterazioni configurate, THEN THE Agent_Loop SHALL declassare la Capability_Tier del modello per la sessione corrente.

### Requirement 10: Decisione di costo e ripiego cloud

**User Story:** Come utente attento ai costi, voglio che MGCoding privilegi i modelli locali e ricorra al cloud solo quando serve, così che il consumo a pagamento resti minimo.

#### Acceptance Criteria

1. WHERE il Config_Key `localFirst` è attivo ed esiste almeno un provider locale raggiungibile, THE Provider_Router SHALL limitare la scelta ai soli provider locali.
2. WHEN una richiesta è classificata come `heavy` e nessun modello locale raggiungibile ha Capability_Tier adeguata, THE Provider_Router SHALL selezionare il provider cloud heavy configurato.
3. WHEN il Provider_Router seleziona un provider cloud a pagamento mentre `localFirst` è attivo, THE MGCoding SHALL registrare il motivo del ripiego al cloud.
4. WHERE è disponibile un modello cloud gratuito configurato come light, THE Provider_Router SHALL preferire il modello gratuito per le richieste classificate come `light`.
5. WHEN una richiesta è classificata come `heavy` ed è disponibile un modello cloud gratuito con Capability_Tier adeguata, THE Provider_Router SHALL selezionare il modello cloud gratuito per quella richiesta.

### Requirement 11: Retrocompatibilità e migrazione della configurazione

**User Story:** Come utente esistente di MGCoding, voglio che le mie configurazioni e i miei provider continuino a funzionare, così che l'aggiornamento non interrompa il mio flusso di lavoro.

#### Acceptance Criteria

1. WHERE un utente ha una configurazione Ollama, Claude o OpenAI esistente, THE MGCoding SHALL continuare a operare con quella configurazione senza richiedere una riconfigurazione.
2. WHEN MGCoding legge la configurazione di funzionalità, THE MGCoding SHALL scrivere sotto la cartella `.mg/` e SHALL leggere la configurazione legacy sotto la cartella `.kiro/` se la cartella `.mg/` non contiene il dato.
3. IF né la cartella `.mg/` né la cartella `.kiro/` contengono configurazione, THEN THE MGCoding SHALL creare una configurazione di default iniziale sotto la cartella `.mg/`.
4. WHERE un nuovo Config_Key non è impostato, THE MGCoding SHALL applicare un valore di default che preserva il comportamento precedente per gli utenti esistenti.
5. WHEN la funzionalità è attiva su Windows, THE Agent_Loop SHALL eseguire i comandi di shell tramite `cmd`.
