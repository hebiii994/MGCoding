# Implementation Plan: local-model-kiro-parity

## Overview

Il piano implementa i sette ambiti del design come componenti puri e testabili
(con guscio di I/O attorno all'infrastruttura esistente in `extensions/mgcoding/src/`),
in TypeScript, partendo dalle fondamenta (config + tipi di dominio), proseguendo con
i nuclei puri (Context_Manager, Capability_Detector, Prompt_Composer, Autonomy_Controller,
Spec_Validator, Provider_Router) e i provider (GLM), per poi cablare tutto nell'Agent_Loop
e nel guscio I/O di Ollama. Ogni proprietà di correttezza del design è coperta da un
singolo property-based test con `fast-check` (≥ 100 iterazioni), annotato con il numero
di proprietà e i criteri EARS validati. I default preservano il comportamento esistente.

## Tasks

- [x] 1. Fondamenta di configurazione e tipi di dominio
  - [x] 1.1 Definire i nuovi Config_Key e i tipi di dominio condivisi
    - Aggiungere a `extensions/mgcoding/package.json` i Config_Key del namespace `mgcoding`: `ollama.numCtx` (default 0), `context.summarize` (true), `context.responseReserve` (1024), `model.capabilityTier` ({}), `autonomyMode` (`supervised`), `glm.useAnthropicEndpoint` (false), `glm.model` (`glm-4.6`), `localFirst` (true) e l'estensione di `route.heavy` con il valore `glm`
    - Aggiungere in `extensions/mgcoding/src/llm/types.ts` i tipi `CapabilityTier`, `AutonomyMode`, `EarsPattern`, `SpecPhase`, `ContextBudget`, `ActionDecision`, `CoverageEntry`, `RouteResult`
    - I default scelti devono riprodurre il comportamento precedente per gli utenti esistenti
    - _Requirements: 11.4, 1.3, 4.2, 4.6, 3.5, 5.6, 8.1, 8.3, 10.1_

  - [x] 1.2 Implementare la risoluzione/migrazione della configurazione di feature
    - Creare `extensions/mgcoding/src/util/mgConfig.ts` con `readFeatureConfig`, `writeFeatureConfig`, `ensureInitialConfig`
    - Precedenza di lettura `.mg/` → legacy `.kiro/` → default; scrittura sempre sotto `.mg/`; creazione dei default sotto `.mg/` quando nessuna cartella contiene il dato
    - Riusare `util/featurePaths.ts` (`mgDir`, `resolveFeatureDir`)
    - _Requirements: 11.2, 11.3, 11.1_

  - [x] 1.3 Property test per la precedenza della configurazione di feature
    - File `extensions/mgcoding/src/test/featureConfig.pbt.test.ts`
    - **Property 28: Precedenza della configurazione di feature .mg → .kiro → default**
    - **Validates: Requirements 11.2, 11.3**

  - [x] 1.4 Unit test di retrocompatibilità della configurazione
    - Verificare che configurazioni Ollama/Claude/OpenAI esistenti restino operative e che i default preservino il comportamento
    - _Requirements: 11.1, 11.4_

- [x] 2. Context_Manager (nucleo puro per budget e riduzione cronologia)
  - [x] 2.1 Implementare la stima dei token e il calcolo del Context_Budget
    - Creare `extensions/mgcoding/src/llm/contextManager.ts` con `estimateTokens`, `estimateMessagesTokens`, `computeBudget`, le costanti `DEFAULT_NUM_CTX = 8192` e `MIN_RESPONSE_RESERVE = 1024`
    - Precedenza `configNumCtx` (intero positivo) > `modelMaxCtx` > `DEFAULT_NUM_CTX`; riserva risposta alzata almeno a 1024
    - _Requirements: 1.2, 1.4, 4.1, 4.2_

  - [x] 2.2 Property test per budget e stima token
    - File `extensions/mgcoding/src/test/contextBudget.pbt.test.ts`
    - **Property 1: Derivazione valida di num_ctx con precedenza** (Validates: 1.1, 1.2, 1.3, 1.4)
    - **Property 3: Riserva minima per la risposta** (Validates: 4.2)
    - **Property 4: Stima dei token non negativa e monotòna** (Validates: 4.1)

  - [x] 2.3 Implementare la riduzione della cronologia consapevole dei token
    - Aggiungere a `contextManager.ts` `reduceHistory` (riassunto/troncamento dei risultati tool più vecchi mantenendo integri `keepRecent=4`, conservazione di identità ed esito OK/ERRORE, rimozione dei turni più vecchi, `stillOverBudget` quando irriducibile, ultimo messaggio utente mai rimosso)
    - _Requirements: 1.5, 4.3, 4.4, 4.5, 4.6_

  - [x] 2.4 Property test per la riduzione della cronologia
    - File `extensions/mgcoding/src/test/reduceHistory.pbt.test.ts`
    - **Property 2: La riduzione rientra nel budget o segnala l'irriducibilità** (Validates: 1.5, 4.5)
    - **Property 5: I risultati tool recenti restano integri durante la riduzione** (Validates: 4.3)
    - **Property 6: Il riassunto conserva identità ed esito del tool** (Validates: 4.4)
    - **Property 7: Senza riassunto si applica solo il troncamento** (Validates: 4.6)

- [x] 3. Capability_Detector (nucleo puro + cache di sessione)
  - [x] 3.1 Implementare classificazione, declassamento e cache del tier
    - Creare `extensions/mgcoding/src/llm/capability.ts` con `classifyTier`, `downgradeTier`, classe `CapabilityCache` (get/set/downgrade/clear)
    - `native` solo se `functionalProbePassed === true`; `configOverride` salta la probe; modello che dichiara `tools` ma fallisce la probe → al massimo `structured`
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 9.6_

  - [x] 3.2 Property test per la classificazione e la cache del tier
    - File `extensions/mgcoding/src/test/capabilityTier.pbt.test.ts`
    - **Property 10: Semantica della classificazione del tier** (Validates: 3.1, 3.2, 3.3, 3.5)
    - **Property 11: Round-trip della cache delle capacità** (Validates: 3.4)
    - **Property 12: Il declassamento abbassa di un rango, con limite inferiore** (Validates: 9.6)

- [x] 4. Prompt_Composer (nucleo puro)
  - [x] 4.1 Implementare la composizione di variante prompt e sottoinsieme di tool
    - Creare `extensions/mgcoding/src/agent/promptComposer.ts` con `compose`, costante `COMPACT_BUDGET_THRESHOLD = 8192` e `SMALL_WINDOW_TOOLS`
    - `contextBudget <= 8192` → `compact` + `SMALL_WINDOW_TOOLS ∩ allToolNames`; altrimenti `full` + tutti i tool; scelta basata sul budget, non sul nome del modello
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

  - [x] 4.2 Property test per la composizione del prompt
    - File `extensions/mgcoding/src/test/promptCompose.pbt.test.ts`
    - **Property 21: Composizione del prompt in funzione del solo budget**
    - **Validates: Requirements 7.1, 7.2, 7.3, 7.4, 7.5**

- [~] 5. Checkpoint - Verifica dei nuclei puri di base
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Autonomy_Controller (gating, checkpoint, revert)
  - [x] 6.1 Implementare la logica pura di decisione delle azioni
    - Creare `extensions/mgcoding/src/agent/autonomy.ts` con `isDestructiveCommand` (Windows-first: del/rd/rmdir/format/rm -rf/git reset --hard/git clean -fd/...) e `decideAction`
    - `supervised` → approvazione per ogni `file_edit`/`shell_command`; `autopilot` → nessuna approvazione salvo comandi distruttivi; `autopilot` + `file_edit` → checkpoint richiesto
    - _Requirements: 5.2, 5.3, 5.4, 5.7_

  - [x] 6.2 Property test per le decisioni di autonomia
    - File `extensions/mgcoding/src/test/autonomyDecision.pbt.test.ts`
    - **Property 13: In supervised ogni azione richiede approvazione** (Validates: 5.2)
    - **Property 14: In autopilot le azioni non distruttive non richiedono approvazione** (Validates: 5.3)
    - **Property 15: In autopilot una modifica a file richiede un checkpoint** (Validates: 5.4)
    - **Property 16: I comandi distruttivi richiedono approvazione anche in autopilot** (Validates: 5.7)

  - [x] 6.3 Implementare il guscio AutonomyController con checkpoint e revert
    - Aggiungere ad `autonomy.ts` la classe `AutonomyController` che legge `mgcoding.autonomyMode`, invoca `beginCheckpoint`/`recordOriginal` (da `edit/checkpoint.ts`) prima delle modifiche in autopilot e usa `revertCheckpoint` per il ripristino
    - Mappare `supervised` ⇔ conferma (come `diffApproval`/conferma `run_command`), `autopilot` ⇔ `autoApprove`
    - _Requirements: 5.1, 5.5, 5.6_

  - [x] 6.4 Property test per il ripristino del checkpoint
    - File `extensions/mgcoding/src/test/checkpointRevert.pbt.test.ts`
    - **Property 17: Il ripristino del checkpoint riporta i file all'originale**
    - **Validates: Requirements 5.5**

  - [x] 6.5 Unit test per modalità accettate e lettura della config
    - Verificare il supporto delle due Autonomy_Mode e la lettura di `mgcoding.autonomyMode`
    - _Requirements: 5.1, 5.6_

- [x] 7. Spec_Validator (EARS, coverage, struttura, gating)
  - [x] 7.1 Implementare il parsing dei criteri e il riconoscimento dei pattern EARS
    - Creare `extensions/mgcoding/src/specs/specValidator.ts` con `matchEarsPattern` e `parseAcceptanceCriteria`
    - Riconoscere i sei pattern (ubiquitous/event/state/optional/unwanted/complex); estrarre i criteri numerati `Req N.M`
    - _Requirements: 6.1_

  - [x] 7.2 Property test per il riconoscimento dei pattern EARS
    - File `extensions/mgcoding/src/test/earsPattern.pbt.test.ts`
    - **Property 18: Riconoscimento round-trip dei pattern EARS**
    - **Validates: Requirements 6.1**

  - [x] 7.3 Implementare Coverage_Map, validazione strutturale e report
    - Aggiungere a `specValidator.ts` `buildCoverageMap`, `validateStructure` e il tipo `ValidationReport` con `canAdvance`
    - Ogni criterio compare una volta ed è `covered` se almeno un task lo cita; sezioni mancanti e criteri scoperti azzerano `canAdvance` (fase corrente comunque completabile)
    - _Requirements: 6.2, 6.3, 6.4, 6.5_

  - [x] 7.4 Property test per coverage e validazione strutturale
    - File `extensions/mgcoding/src/test/coverageStructural.pbt.test.ts`
    - **Property 19: Completezza della Coverage_Map e blocco sui criteri scoperti** (Validates: 6.2, 6.3)
    - **Property 20: La validazione strutturale segnala le sezioni mancanti e blocca l'avanzamento** (Validates: 6.4, 6.5)

  - [x] 7.5 Cablare lo Spec_Validator nel workflow Spec
    - In `extensions/mgcoding/src/specs/specs.ts` invocare il validator al passaggio di fase e bloccare l'avanzamento se `canAdvance` è false, mostrando criteri scoperti / sezioni mancanti; impedire l'avvio della fase successiva finché l'approvazione non è registrata
    - _Requirements: 6.3, 6.5, 6.6_

  - [x] 7.6 Unit test per il gating dell'approvazione tra fasi
    - Verificare che la fase successiva non parta finché l'approvazione della fase corrente non è registrata
    - _Requirements: 6.6_

- [~] 8. Checkpoint - Verifica di autonomia e validazione Spec
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. Provider_Router con consapevolezza di tier, GLM e costo
  - [x] 9.1 Estendere `chooseProvider` con RouteResult, tier e catena di ripiego
    - In `extensions/mgcoding/src/llm/registry.ts` aggiungere `ProviderDescriptor` (maxTier/paid/free), `RouteContext` (requiredTier), `RouteResult` e la nuova logica: solo disponibili → local-first → vision → heavy (free → GLM/heavy con `fallbackReason` → locale degradato) → light (preferisci free) → fallback
    - Restituire `RouteResult{provider:undefined, fallbackReason}` quando nessun provider è disponibile
    - _Requirements: 8.5, 8.6, 8.7, 9.5, 10.1, 10.2, 10.3, 10.4, 10.5_

  - [x] 9.2 Property test per il routing esteso
    - File `extensions/mgcoding/src/test/routerTier.pbt.test.ts`
    - **Property 22: Local-first restringe ai provider locali** (Validates: 10.1)
    - **Property 23: Catena di ripiego per le richieste heavy senza locale adeguato** (Validates: 8.6, 8.7, 10.2)
    - **Property 24: Instradamento heavy verso GLM designato** (Validates: 8.5)
    - **Property 25: Preferenza per il cloud gratuito rispetto a quello a pagamento** (Validates: 10.4, 10.5)
    - **Property 26: Il ripiego al cloud a pagamento sotto local-first è motivato** (Validates: 10.3)
    - **Property 27: Nessun provider disponibile produce assenza di provider** (Validates: 9.5)

  - [x] 9.3 Aggiornare i chiamanti del router al nuovo RouteResult
    - Aggiornare `selectProvider` e gli altri chiamanti in `registry.ts` per leggere `.provider`; adeguare il test esistente `router.pbt.test.ts` alla nuova firma
    - _Requirements: 8.5, 10.3_

- [x] 10. GLM_Provider (Zhipu/Z.ai)
  - [x] 10.1 Implementare il GLM_Provider
    - Creare `extensions/mgcoding/src/llm/glmProvider.ts` con la classe `GLMProvider` (id `glm`): `useAnthropicEndpoint=false` delega a `OpenAIProvider` sull'endpoint OpenAI-compat; `useAnthropicEndpoint=true` usa il percorso Anthropic-native mantenendo disponibile l'OpenAI-compat
    - _Requirements: 8.2, 8.3_

  - [x] 10.2 Registrare GLM tra i preset e gestire la chiave segreta
    - Registrare `GLMProvider` nei preset selezionabili in `registry.ts`, leggere `mgcoding.glm.*` e salvare/recuperare la chiave API in SecretStorage con chiave `mgcoding.glm.apiKey`; integrare `glm` in `route.heavy`
    - _Requirements: 8.1, 8.4, 8.5_

  - [x] 10.3 Unit test per flag Anthropic e SecretStorage
    - Verificare l'abilitazione dell'endpoint Anthropic-compat con tool-use nativo e il salvataggio della chiave nel Secret_Store
    - _Requirements: 8.3, 8.4_

  - [x] 10.4 Integration test per preset ed endpoint OpenAI-compat
    - Mock di `fetch`/SecretStorage: GLM presente tra i preset e funzionante via endpoint OpenAI-compatibile
    - _Requirements: 8.1, 8.2_

- [x] 11. Tool-calling strutturato come default con retry/fallback per iterazione
  - [x] 11.1 Implementare la logica pura del percorso di iterazione
    - In `extensions/mgcoding/src/agent/agentLoop.ts` aggiungere `chooseIterationPath`, `onSchemaViolation` e i tipi `IterationToolOutcome`/`IterationRetryState`
    - `chooseIterationPath` → `structured` sse tier ∈ {structured,native} e flag true, altrimenti `textual`, indipendente dalle iterazioni precedenti; `onSchemaViolation` incrementa i retry di uno poi `fallback`
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 3.6_

  - [x] 11.2 Property test per percorso e retry di iterazione
    - File `extensions/mgcoding/src/test/iterationPath.pbt.test.ts`
    - **Property 8: Il percorso di tool-calling dipende solo da tier e flag** (Validates: 2.1, 2.4, 2.5, 3.6)
    - **Property 9: Retry per singola iterazione poi fallback** (Validates: 2.2, 2.3)

  - [x] 11.3 Integrare il default structured con retry e fallback per iterazione
    - Modificare l'Agent_Loop affinché usi `Structured_Tool_Engine` come default per tier capaci, ricreando `IterationRetryState` a ogni iterazione (un retry, poi fallback `mg-tool` solo per quella iterazione), con `structuredTools=false` che forza il percorso testuale
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

  - [x] 11.4 Cablare il declassamento del tier sull'assenza di tool-call valide
    - Nell'Agent_Loop, se un modello dichiara tool-use ma non emette chiamate valide entro le iterazioni configurate, invocare `downgradeTier` + `CapabilityCache.downgrade` per la sessione corrente
    - _Requirements: 9.6_

- [x] 12. Cablaggio del guscio I/O Ollama, gestione errori e integrazione finale
  - [x] 12.1 Cablare num_ctx e la probe nel guscio Ollama
    - In `extensions/mgcoding/src/llm/ollamaProvider.ts` inserire `options.num_ctx` (da Context_Manager / `mgcoding.ollama.numCtx`) in ogni POST a `/api/chat` per `stream`/`chatStructured`/`streamAgent`; ricavare e mettere in cache la finestra max da `/api/show`; aggiungere `probeToolUse(model)` per il test funzionale
    - _Requirements: 1.1, 1.3, 3.2_

  - [x] 12.2 Integration test per num_ctx nel body della richiesta
    - Mock di `fetch`: verificare l'invio reale di `options.num_ctx` con valore intero positivo nel body di `/api/chat`
    - _Requirements: 1.1_

  - [x] 12.3 Integrare Context_Manager, Prompt_Composer e Capability_Detector nell'Agent_Loop
    - Nell'Agent_Loop: risolvere il tier (con probe e cache), comporre prompt/sottoinsieme tool via `compose`, ridurre la cronologia via `reduceHistory` e passare il `num_ctx` calcolato; sostituire `isSmallLocalModel()` con la scelta basata sul budget; eseguire i comandi shell via `cmd` su Windows
    - _Requirements: 1.5, 3.6, 7.1, 11.5_

  - [x] 12.4 Implementare la gestione degli errori di provider e modelli
    - In `ollamaProvider.ts`/`openaiProvider.ts`/`claudeProvider.ts` e nel router: `LLMError` con endpoint per Ollama irraggiungibile; richiesta della chiave e interruzione su chiave mancante; messaggio dedicato su chiave non valida (401/403); segnalazione del rate limit (429) con proposta di ripiego; messaggio di assenza provider quando tutti irraggiungibili
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5_

  - [x] 12.5 Unit test per gli errori dei provider cloud
    - Verificare chiave mancante (interruzione e richiesta), chiave non valida e rate limit con proposta di ripiego
    - _Requirements: 9.2, 9.3, 9.4_

  - [x] 12.6 Integration test per Ollama irraggiungibile ed esecuzione shell su Windows
    - Ollama irraggiungibile → `LLMError` con endpoint citato; comandi eseguiti tramite `cmd`
    - _Requirements: 9.1, 11.5_

- [~] 13. Checkpoint finale - Verifica end-to-end
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- I task contrassegnati con `*` sono opzionali (test) e possono essere saltati per un MVP più rapido.
- Ogni task referenzia criteri di requisito specifici per la tracciabilità.
- I checkpoint garantiscono la validazione incrementale.
- I property test validano le proprietà universali di correttezza del design (1 test per proprietà, ≥ 100 iterazioni con `fast-check`).
- Gli unit/integration test coprono esempi, casi limite e wiring di I/O con mock di `fetch`/SecretStorage e `test/vscodeStub.ts`.
- I test girano in modalità singola (`vitest --run`), mai in watch.
- Identificatori di codice in inglese, prosa/commenti in italiano; configurazione scritta sotto `.mg/` con lettura legacy `.kiro/`.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1", "3.1", "4.1", "6.1", "7.1", "10.1"] },
    { "id": 1, "tasks": ["1.2", "2.3", "6.3", "7.3", "9.1", "11.1"] },
    { "id": 2, "tasks": ["1.3", "1.4", "2.2", "2.4", "3.2", "4.2", "6.2", "6.4", "6.5", "7.2", "7.4", "7.5", "7.6", "9.2", "9.3", "11.2", "12.1"] },
    { "id": 3, "tasks": ["10.2", "11.3", "12.2"] },
    { "id": 4, "tasks": ["10.3", "10.4", "11.4", "12.4"] },
    { "id": 5, "tasks": ["12.3", "12.5", "12.6"] }
  ]
}
```
