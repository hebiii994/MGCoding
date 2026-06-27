# Implementation Plan: ComfyUI Autonomy

## Overview

Questo piano implementa l'autonomia di MGCoding sui tre pilastri (LLM, generazione, ComfyUI) estendendo l'estensione TypeScript `extensions/mgcoding`. La strategia è **prima la logica pura** (moduli senza dipendenze da `vscode`/`fetch`, testabili con property-based testing tramite `fast-check`), poi gli **adapter di I/O** (HTTP ComfyUI, processi, WebSocket, download, UI), infine il **cablaggio nell'Orchestratore**.

Ogni passo costruisce sul precedente e termina con l'integrazione, senza codice orfano. I test di proprietà usano `fast-check` con almeno 100 iterazioni e annotano la proprietà di design referenziata.

## Tasks

- [x] 1. Predisporre infrastruttura e tipi condivisi
  - Aggiungere `fast-check` come `devDependency` di `extensions/mgcoding` e verificare il runner di test esistente (`out/test/*.test.js`)
  - Creare `media/workflowGraph.ts` con i tipi base del grafo: `ApiNode`, `WorkflowValue`, `ApiWorkflow`, `LogicalParams`, `ParamMapping` e le guardie `isApiFormat`, `isLink`
  - Definire i tipi condivisi `GenKind`, `GenRequest`, `PlanStepGen`, `GenOutcome`, `GeneratedItem`, `MediaKind` in un modulo dei tipi riusabile dall'Orchestratore
  - _Requirements: 3.1, 9, 10_

- [x] 2. Logica pura del grafo workflow e mappatura input
  - [x] 2.1 Implementare la risoluzione del grafo in `workflowGraph.ts`
    - `resolveSource` (segue il link di un input al nodo sorgente), `findSamplers`, `resolveConditioningTextNode` (risale da `positive`/`negative` del sampler al nodo di testo)
    - _Requirements: 3.1, 10.1, 10.2_

  - [x] 2.2 Write property test per la mappatura risolta (riferimenti validi)
    - **Property 7: La mappatura risolta referenzia solo nodi e campi esistenti**
    - **Validates: Requirements 3.1**

  - [x] 2.3 Implementare `buildMapping`, `unmappedParams` e la persistenza in `workflowMapping.ts`
    - `buildMapping(wf)` → `ParamMapping`; `unmappedParams(required, mapping)`; serializza/deserializza `SavedWorkflowMapping` (hash struttura + mapping) in `.mg/workflows/.mappings/{name}.json`
    - _Requirements: 3.1, 3.3, 3.4_

  - [x] 2.4 Write property test per round-trip della mappatura
    - **Property 8: Round-trip di persistenza della mappatura**
    - **Validates: Requirements 3.3**

  - [x] 2.5 Write property test per i parametri non mappabili
    - **Property 9: I parametri non mappabili sono esattamente la differenza insiemistica**
    - **Validates: Requirements 3.4**

  - [x] 2.6 Implementare `applyParams` immutabile in `workflowMapping.ts`
    - Inietta prompt solo nel nodo di testo risolto via link del sampler; applica seed (fisso/casuale) a tutti i campi `seed`/`noise_seed`; instrada immagine iniziale al nodo di caricamento; applica `frames`/`fps`; preserva i link dei LoRA
    - _Requirements: 5.2, 5.3, 9.2, 9.3, 9.4, 10.1, 10.2, 10.3, 10.4, 10.5_

  - [x] 2.7 Write property test per prompt iniettato solo nel nodo risolto
    - **Property 22: Il prompt è iniettato solo nel nodo di testo risolto via link del sampler**
    - **Validates: Requirements 9.4, 10.1, 10.2**

  - [x] 2.8 Write property test per immagine iniziale instradata al nodo di caricamento
    - **Property 12: L'immagine iniziale è instradata al nodo di caricamento immagine**
    - **Validates: Requirements 5.2, 10.3**

  - [x] 2.9 Write property test per durata e fps applicati ai campi video
    - **Property 13: Durata e fps sono applicati ai campi corrispondenti**
    - **Validates: Requirements 5.3**

  - [x] 2.10 Write property test per seed fisso coerente tra stadi
    - **Property 20: Seed fisso applicato in modo coerente a tutti gli stadi**
    - **Validates: Requirements 9.2, 10.4**

  - [x] 2.11 Write property test per preservazione dei collegamenti LoRA
    - **Property 21: I collegamenti dei LoRA sono preservati**
    - **Validates: Requirements 9.3**

  - [x] 2.12 Write property test per seed casuale entro il range
    - **Property 23: Seed casuale impostato su tutti i campi seed entro il range**
    - **Validates: Requirements 10.5**

- [x] 3. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Logica pura di rilevamento dipendenze (modelli e nodi)
  - [x] 4.1 Implementare `media/modelRefs.ts`
    - `referencedModels(wf)` (incl. campi `.gguf` con `viaGguf: true`), `keyToModelDir(field)`, `missingModels(refs, available)`
    - _Requirements: 9.1, 16.1, 16.2, 19.3_

  - [x] 4.2 Write property test per i file GGUF come riferimenti di modello
    - **Property 19: I file GGUF sono riferimenti di modello da risolvere**
    - **Validates: Requirements 9.1**

  - [x] 4.3 Write property test per i modelli mancanti come differenza insiemistica
    - **Property 27: I modelli mancanti sono la differenza tra referenziati e disponibili**
    - **Validates: Requirements 16.1**

  - [x] 4.4 Write property test per la cartella di destinazione dedotta dal campo
    - **Property 28: La cartella di destinazione è dedotta correttamente dal tipo di campo**
    - **Validates: Requirements 16.2**

  - [x] 4.5 Implementare `media/nodeRefs.ts`
    - `usedClassTypes(wf)`, `missingNodes(used, known)`
    - _Requirements: 17.1_

  - [x] 4.6 Write property test per i nodi mancanti come differenza insiemistica
    - **Property 29: I nodi mancanti sono la differenza tra usati e noti**
    - **Validates: Requirements 17.1**

- [x] 5. Logica pura di classificazione richiesta, piano e proposta workflow
  - [x] 5.1 Implementare `media/requestClassifier.ts`
    - Classifica `image`/`t2v`/`i2v`/`ambiguous` in base a immagine iniziale e marcatori di tipo
    - _Requirements: 1.1, 1.6_

  - [x] 5.2 Write property test per classificazione I2V/T2V
    - **Property 1: Classificazione I2V con immagine iniziale**
    - **Validates: Requirements 1.1**

  - [x] 5.3 Write property test per richiesta ambigua
    - **Property 2: Richiesta senza marcatori di tipo è ambigua**
    - **Validates: Requirements 1.6**

  - [x] 5.4 Implementare `plan(kind)` in `agent/genOrchestrator.ts` (solo logica del piano)
    - Produce sempre l'ordine canonico `select-workflow → check-deps → set-inputs → execute → report`
    - _Requirements: 1.2_

  - [x] 5.5 Write property test per l'ordine canonico del piano
    - **Property 3: Il piano contiene le fasi richieste in ordine canonico**
    - **Validates: Requirements 1.2**

  - [x] 5.6 Implementare la proposta di workflow in `media/workflowProposal.ts`
    - Propone un workflow locale compatibile col tipo richiesto; elenca modelli/nodi richiesti tramite `referencedModels`/`usedClassTypes`
    - _Requirements: 4.1, 4.3_

  - [x] 5.7 Write property test per il workflow proposto compatibile col tipo
    - **Property 10: Il workflow proposto supporta il tipo richiesto**
    - **Validates: Requirements 4.1**

  - [x] 5.8 Write property test per le dipendenze coincidenti coi riferimenti
    - **Property 11: Le dipendenze indicate per un workflow coincidono con i suoi riferimenti**
    - **Validates: Requirements 4.3**

- [x] 6. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Logica pura di classificazione output e parsing avanzamento
  - [x] 7.1 Implementare `media/outputClassifier.ts`
    - Classifica output esecuzione e file in `video`/`image`; rileva "produce video"; preserva il formato originale nel percorso di destinazione
    - _Requirements: 5.5, 6.1, 6.2, 6.3, 6.4, 7.1_

  - [x] 7.2 Write property test per la coerenza "produce video" / nodi output
    - **Property 14: Coerenza tra rilevazione "produce video" e presenza di nodi di output video**
    - **Validates: Requirements 5.5**

  - [x] 7.3 Write property test per classificazione output video/immagine
    - **Property 15: Classificazione degli output in video/immagine**
    - **Validates: Requirements 6.1, 6.2**

  - [x] 7.4 Write property test per preservazione del formato video nel salvataggio
    - **Property 16: Il salvataggio preserva il formato originale del video**
    - **Validates: Requirements 6.3**

  - [x] 7.5 Write property test per il partizionamento totale immagini/video
    - **Property 17: Partizionamento totale di output ed elenchi in immagini e video**
    - **Validates: Requirements 6.4, 7.1**

  - [x] 7.6 Implementare il parsing puro degli eventi di avanzamento in `media/progressMonitor.ts`
    - Mappa eventi `progress`/`executing` in `ProgressUpdate` (`percent` in `[0,100]`, `currentNode`)
    - _Requirements: 8.1_

  - [x] 7.7 Write property test per gli eventi di avanzamento → stati validi
    - **Property 18: Gli eventi di avanzamento mappano a stati validi**
    - **Validates: Requirements 8.1**

- [x] 8. Logica pura di recupero errori e profili VRAM
  - [x] 8.1 Implementare `media/errorClassifier.ts`
    - `classifyError(message)` → `missing-node`/`missing-model`/`oom-vram`/`unknown`; `planRecovery(err, attempt)` con `MAX_RETRIES = 3`
    - _Requirements: 18.1, 18.2, 18.3, 18.4, 18.5, 18.6_

  - [x] 8.2 Write property test per la classificazione degli errori
    - **Property 30: Classificazione degli errori di esecuzione**
    - **Validates: Requirements 18.1**

  - [x] 8.3 Write property test per l'azione di recupero corrispondente alla causa
    - **Property 31: L'azione di recupero corrisponde alla causa**
    - **Validates: Requirements 18.2, 18.3**

  - [x] 8.4 Write property test per il budget di ritentativi
    - **Property 33: Budget di ritentativi limitato a 3**
    - **Validates: Requirements 18.5, 18.6**

  - [x] 8.5 Implementare `media/vramProfile.ts`
    - `defaultParams(limitGB)`, riduzione progressiva `MemoryTier`, preferenza GGUF a bassa VRAM
    - _Requirements: 19.1, 19.2, 19.3_

  - [x] 8.6 Write property test per la riduzione di memoria che non aumenta i parametri
    - **Property 32: La riduzione di memoria non aumenta i parametri e rispetta il minimo**
    - **Validates: Requirements 18.4, 19.2**

  - [x] 8.7 Write property test per i parametri predefiniti entro il limite VRAM
    - **Property 34: I parametri predefiniti rispettano il limite di VRAM**
    - **Validates: Requirements 19.1**

  - [x] 8.8 Write property test per la preferenza GGUF a bassa VRAM
    - **Property 35: A bassa VRAM si preferisce la variante GGUF quando disponibile**
    - **Validates: Requirements 19.3**

- [x] 9. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 10. Logica pura di conversione workflow UI→API
  - [x] 10.1 Implementare `media/workflowConverter.ts`
    - `isUiFormat`, `convertUiToApi(ui, objectInfo)` → `ConversionResult` (ordina `widgets_values` via `objectInfo`)
    - _Requirements: 15.2_

  - [x] 10.2 Write property test per il round-trip della conversione
    - **Property 26: Conversione UI→API che preserva nodi e topologia (round-trip)**
    - **Validates: Requirements 15.2**

- [x] 11. Logica pura di routing LLM, selezione backend, percorsi, telemetria e degrado
  - [x] 11.1 Estendere `llm/registry.ts` con `selectProvider(ctx)` e auto-route puri
    - Seleziona dai disponibili; local-first; vision quando ci sono immagini; instrada per complessità
    - _Requirements: 2.1, 2.2, 2.3, 2.5, 20.1_

  - [x] 11.2 Write property test per la selezione provider con local-first
    - **Property 4: Selezione provider LLM dall'insieme dei disponibili con local-first**
    - **Validates: Requirements 2.1, 2.5, 20.1**

  - [x] 11.3 Write property test per l'auto-route per complessità
    - **Property 5: Auto-route instrada per complessità**
    - **Validates: Requirements 2.2**

  - [x] 11.4 Write property test per la selezione di un modello vision
    - **Property 6: Con immagini si sceglie un modello vision quando disponibile**
    - **Validates: Requirements 2.3**

  - [x] 11.5 Implementare la selezione backend di generazione (in `imageGen.ts`/modulo backend)
    - Seleziona il primo backend disponibile per priorità; per i video sceglie un backend con capacità video
    - _Requirements: 11.1, 11.2_

  - [x] 11.6 Write property test per la selezione automatica del backend
    - **Property 24: Selezione automatica del backend di generazione disponibile**
    - **Validates: Requirements 11.1**

  - [x] 11.7 Write property test per la selezione di un backend con capacità video
    - **Property 25: La generazione video sceglie un backend con capacità video**
    - **Validates: Requirements 11.2**

  - [x] 11.8 Implementare le utility pure di percorso e il comando di avvio Windows in `util/paths.ts`
    - Costruzione percorsi coerente con l'OS; comando di avvio Windows con interprete embedded
    - _Requirements: 24.2, 24.3_

  - [x] 11.9 Write property test per il comando di avvio su Windows
    - **Property 38: Il comando di avvio su Windows usa l'invocazione attesa**
    - **Validates: Requirements 24.2**

  - [x] 11.10 Write property test per i separatori di percorso coerenti
    - **Property 39: La costruzione dei percorsi usa separatori coerenti con l'OS**
    - **Validates: Requirements 24.3**

  - [x] 11.11 Implementare la costruzione dell'evento di telemetria e il gating delle funzioni
    - Evento telemetria che esclude il testo del prompt; insieme di funzioni abilitate che esclude le dipendenti da ComfyUI quando indisponibile
    - _Requirements: 21.3, 23.1_

  - [x] 11.12 Write property test per l'esclusione dei prompt dalla telemetria
    - **Property 36: I prompt sono esclusi dalla telemetria**
    - **Validates: Requirements 21.3**

  - [x] 11.13 Write property test per il degrado che disabilita solo funzioni ComfyUI
    - **Property 37: Il degrado disabilita solo le funzioni dipendenti da ComfyUI**
    - **Validates: Requirements 23.1**

- [x] 12. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 13. Adapter ciclo di vita ComfyUI (`media/comfyLifecycle.ts`)
  - [x] 13.1 Implementare rilevamento, avvio, arresto e readiness
    - Probe `/system_stats` (timeout 3s); avvio con Python embedded; attesa readiness (timeout 120s); arresto del processo avviato; richiesta cartella se non configurata; elenchi checkpoint/LoRA/nodi
    - _Requirements: 12.1, 12.2, 12.3, 13.1, 13.2, 13.3, 13.4, 13.5, 24.1_

  - [x] 13.2 Implementare installazione di ComfyUI e ComfyUI-Manager con conferma
    - Conferma prima di scaricare/installare; configura la cartella; propone ComfyUI-Manager; gestione fallimento lasciando il sistema utilizzabile
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 22.3_

  - [x] 13.3 Write integration test per ciclo di vita e installazione (mock fetch/spawn)
    - Probe, readiness, avvio/arresto, installazione; verifica timeout (3s, 120s) e conferme
    - _Requirements: 12.1, 12.2, 13.2, 13.5, 14.1, 14.4_

- [x] 14. Adapter conversione, download modelli e installazione nodi (`media/workflowConverter.ts` adapter, `media/comfyHelper.ts`)
  - [x] 14.1 Integrare conversione: import API, fallback ComfyUI ed estrazione archivio
    - Import workflow API; fallback all'endpoint ComfyUI quando la conversione locale fallisce; estrazione da archivio prima dell'import; messaggio se non convertibile
    - _Requirements: 15.1, 15.3, 15.4, 15.5_

  - [x] 14.2 Cablare download modelli su `modelRefs` con conferma, progresso e annullamento
    - Riusa `modelRefs`/`missingModels`; conferma download; URL manuale se non risolvibile; progresso e annullamento; gestione errori
    - _Requirements: 16.1, 16.2, 16.3, 16.4, 16.5, 22.2_

  - [x] 14.3 Cablare installazione nodi su `nodeRefs` con conferma e riavvio
    - Riusa `nodeRefs`/`missingNodes`; conferma clonazione codice di terzi; clona e installa dipendenze; richiede riavvio; elenca nodi non risolvibili
    - _Requirements: 17.1, 17.2, 17.3, 17.4, 17.5, 22.1_

  - [x] 14.4 Write integration test per conversione, download e installazione (mock)
    - Fallback conversione, estrazione archivio; download con conferma/progresso/annullamento/errore; installazione nodi con conferma e riavvio
    - _Requirements: 15.3, 15.5, 16.3, 16.4, 16.5, 17.2, 17.4_

- [x] 15. Adapter monitor avanzamento e motore generazione (`media/progressMonitor.ts`, `media/videoGen.ts`)
  - [x] 15.1 Implementare il monitor WebSocket con fallback al polling
    - Connessione `/ws`; eventi progress/executing; annullamento via `/interrupt` entro 5s; fallback polling `/history`/`/queue` alla caduta connessione
    - _Requirements: 8.1, 8.2, 8.3, 8.4_

  - [x] 15.2 Implementare l'esecuzione dei workflow video e il recupero output
    - Estende `queueAndCollect` per output video; T2V e I2V (immagine iniziale al nodo di caricamento); applica frames/fps; recupera file video; segnala se nessun nodo output video
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 6.3, 6.4_

  - [x] 15.3 Write integration test per avanzamento, annullamento e recupero output (mock)
    - WebSocket mock, `/interrupt`, fallback polling; recupero file video; salvataggio immagini+video
    - _Requirements: 8.2, 8.3, 8.4, 6.4_

- [x] 16. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 17. Galleria immagini e video (`media/imageStudioView.ts`)
  - [x] 17.1 Estendere la Galleria per elencare, riprodurre, eliminare e aprire video
    - Elenca immagini+video; anteprima `<video>`; eliminazione con conferma; apertura nel SO
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 22.4_

  - [x] 17.2 Write integration test per la Galleria (render/eliminazione/apertura)
    - Render `<video>`, eliminazione con conferma, apertura nel SO
    - _Requirements: 7.2, 7.3, 7.4_

- [x] 18. Orchestratore: cablaggio end-to-end (`agent/genOrchestrator.ts`)
  - [x] 18.1 Implementare `classify` e `run` integrando tutti i moduli
    - `classify` via `requestClassifier` con conferma in caso di ambiguità; `run` esegue il piano (select-workflow → check-deps → set-inputs → execute → report); cabla router LLM, conversione, dipendenze, mappatura, generazione, monitor, recupero errori e galleria
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 2.4, 3.2_

  - [x] 18.2 Integrare il recupero errori nel ciclo di esecuzione
    - Su errore: `classifyError` → `planRecovery` (install nodo/download modello/riduzione memoria) con conferma; ritenta fino a `MAX_RETRIES`; riporta in linguaggio naturale a esaurimento
    - _Requirements: 18.2, 18.3, 18.4, 18.5, 18.6, 19.2, 23.2_

  - [x] 18.3 Integrare local-first, offline e privacy dei prompt nel flusso
    - Privilegia backend/modelli locali; segnala operazioni che richiedono rete in assenza di connessione; invia il prompt solo al servizio selezionato; degrado controllato con indicazioni
    - _Requirements: 20.1, 20.2, 20.3, 21.1, 21.2, 23.1, 23.3_

  - [x] 18.4 Write integration test per l'orchestrazione end-to-end (adapter mockati)
    - Percorso felice con riepilogo passi; stop su errore non recuperabile con causa; disambiguazione LLM; spy di rete per privacy del prompt
    - _Requirements: 1.3, 1.4, 1.5, 3.2, 21.1, 21.2_

- [x] 19. Final checkpoint - Ensure all tests pass
  - Compilare le estensioni (`npm run gulp compile-extensions`) e correggere ogni errore di compilazione
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Le sub-task contrassegnate con `*` sono test (property/unit/integration) opzionali e possono essere saltate per un MVP più rapido.
- Ogni task referenzia requisiti specifici per la tracciabilità; le proprietà di design sono mappate alle rispettive sub-task di property test.
- La logica pura è implementata e testata prima degli adapter di I/O, che a loro volta precedono il cablaggio nell'Orchestratore: nessun codice resta orfano.
- I test di proprietà usano `fast-check` con almeno 100 iterazioni e annotano la proprietà di design referenziata.
- I checkpoint garantiscono la validazione incrementale; dopo le modifiche sotto `extensions/` compilare prima di eseguire i test (modalità singola, non watch).

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["2.1", "4.1", "4.5", "5.1", "5.6", "7.1", "8.1", "8.5", "10.1", "11.1", "11.5", "11.8", "11.11"] },
    { "id": 2, "tasks": ["2.3", "5.4", "2.2", "4.2", "4.3", "4.4", "4.6", "5.2", "5.3", "5.7", "5.8", "7.2", "7.3", "7.4", "7.5", "8.2", "8.3", "8.4", "8.6", "8.7", "8.8", "10.2", "11.2", "11.3", "11.4", "11.6", "11.7", "11.9", "11.10", "11.12", "11.13"] },
    { "id": 3, "tasks": ["2.6", "2.4", "2.5", "5.5", "7.6", "13.1", "14.2", "14.3", "15.1", "17.1"] },
    { "id": 4, "tasks": ["2.7", "2.8", "2.9", "2.10", "2.11", "2.12", "7.7", "13.2", "14.1", "15.2"] },
    { "id": 5, "tasks": ["13.3", "14.4", "15.3", "17.2", "18.1"] },
    { "id": 6, "tasks": ["18.2", "18.3"] },
    { "id": 7, "tasks": ["18.4"] }
  ]
}
```
