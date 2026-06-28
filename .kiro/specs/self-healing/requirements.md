# Requirements Document

## Introduction

Questa funzionalità aggiunge a MGCoding una **autodiagnostica assistita** (Self_Healing di Livello 1): MGCoding raccoglie gli errori di un progetto utente (diagnostiche dei language server, fallimenti di build/typecheck, test rossi, output di comandi falliti), li **evidenzia** in modo chiaro e usa il modello per **proporre una soluzione** per ciascun problema. La proposta NON viene mai applicata da sola: l'utente la rivede e decide se applicarla. Quando l'utente approva, la modifica è **reversibile** (checkpoint) e viene **verificata** automaticamente; se peggiora la situazione viene segnalata e proposto il ripristino.

L'ambito di questa versione è deliberatamente ristretto e sicuro:

1. **Solo progetti utente**, non l'auto-modifica di MGCoding stesso (rimandata a una fase successiva).
2. **Proponi, non applicare**: nessuna scrittura su file senza approvazione esplicita (coerente con la Autonomy_Mode `supervised`).
3. **Riuso dell'infrastruttura esistente**: verifica post-modifica (`autoVerify`), checkpoint/revert, gating dell'autonomia, routing dei provider, suite di test.
4. **Guardrail anti-imbroglio**: i fix non possono indebolire o eliminare i test né le configurazioni per "far passare" la verifica.

I vincoli di prodotto restano quelli del progetto: Windows-first (`win32`, shell `cmd`); identificatori di codice in inglese, prosa/commenti in italiano; configurazione scritta sotto `.mg/` con lettura legacy `.kiro/`; chiavi provider in SecretStorage; piena retrocompatibilità con il comportamento esistente (la funzionalità è opt-in e a default disattivata).

## Glossary

- **MGCoding**: l'estensione VS Code che fornisce le esperienze Vibe e Spec; sistema contenitore.
- **Self_Healing**: la funzionalità di autodiagnostica assistita oggetto di questo documento.
- **Diagnostic_Collector**: il componente che raccoglie e normalizza gli errori da più fonti in un elenco di Issue.
- **Issue**: un singolo problema rilevato, con categoria (diagnostica / build / test / runtime), posizione (file, riga quando disponibile), messaggio e fonte.
- **Issue_Report**: l'insieme ordinato e deduplicato delle Issue presentato all'utente.
- **Diagnosis**: l'analisi prodotta dal modello per una Issue (causa probabile e file coinvolti).
- **Fix_Proposal**: la modifica proposta dal modello per risolvere una Issue, espressa come diff applicabile, con una spiegazione.
- **Verification_Command**: il comando di verifica del progetto (typecheck/build/test), rilevato automaticamente o configurato (riusa `mgcoding.spec.verifyAfterTask`).
- **Verification_Gate**: il controllo automatico che, dopo l'applicazione di un Fix_Proposal, riesegue la verifica e confronta l'esito con la baseline.
- **Baseline**: lo stato di errori/test misurato PRIMA di applicare un Fix_Proposal, usato per rilevare regressioni.
- **Checkpoint**: il punto di ripristino reversibile creato prima di applicare una modifica (infrastruttura `edit/checkpoint.ts`).
- **Capability_Tier**: la classe di capacità di un modello (`native`/`structured`/`textual`), già definita in MGCoding.
- **Provider_Router**: la logica di selezione del provider/modello (`llm/registry.ts`).
- **Autonomy_Mode**: la modalità di autonomia attiva (`supervised`/`autopilot`), già definita in MGCoding.
- **Reward_Hacking_Guard**: il controllo che impedisce a un Fix_Proposal di modificare i file di test/configurazione o di ridurre il numero di test per superare la verifica.
- **Protected_Path**: un percorso (file di test, configurazioni di build/test) che il Reward_Hacking_Guard rende non modificabile durante il Self_Healing.
- **Config_Key**: una chiave di configurazione sotto il namespace `mgcoding`.

## Requirements

### Requirement 1: Raccolta e normalizzazione degli errori

**User Story:** Come utente, voglio che MGCoding raccolga in un unico posto gli errori del mio progetto, così che io veda subito cosa non va senza cercarli in più strumenti.

#### Acceptance Criteria

1. WHEN l'utente avvia il Self_Healing, THE Diagnostic_Collector SHALL raccogliere le diagnostiche di severità errore esposte dai language server per i file del workspace.
2. WHEN esiste un Verification_Command, THE Diagnostic_Collector SHALL eseguirlo e raccogliere gli errori di build/typecheck e i fallimenti dei test dal suo output.
3. WHEN una fonte produce più errori riferiti alla stessa posizione e allo stesso messaggio, THE Diagnostic_Collector SHALL deduplicare le Issue corrispondenti in una sola voce.
4. THE Diagnostic_Collector SHALL associare a ogni Issue una categoria tra `diagnostica`, `build`, `test` e `runtime`.
5. IF nessuna fonte produce errori, THEN THE MGCoding SHALL informare l'utente che non sono stati rilevati problemi e SHALL terminare senza proporre modifiche.

### Requirement 2: Evidenziazione delle Issue all'utente

**User Story:** Come utente, voglio vedere gli errori evidenziati in modo chiaro e ordinato, così che io possa capire la portata dei problemi prima di qualunque correzione.

#### Acceptance Criteria

1. WHEN il Diagnostic_Collector ha prodotto delle Issue, THE MGCoding SHALL presentare un Issue_Report che elenca ogni Issue con categoria, posizione (file e riga quando disponibile) e messaggio.
2. THE MGCoding SHALL raggruppare le Issue dell'Issue_Report per file.
3. WHILE non è stata prodotta alcuna Fix_Proposal, THE MGCoding SHALL NOT modificare alcun file del workspace.

### Requirement 3: Diagnosi e proposta di soluzione

**User Story:** Come utente, voglio che il modello mi proponga una soluzione per ogni errore, così che io non debba diagnosticarlo da solo.

#### Acceptance Criteria

1. WHEN l'utente chiede di correggere una Issue, THE MGCoding SHALL produrre una Diagnosis con la causa probabile e i file coinvolti.
2. WHEN MGCoding produce una Fix_Proposal, THE Fix_Proposal SHALL includere un diff applicabile e una spiegazione testuale della modifica.
3. WHERE la richiesta di diagnosi è classificata come `heavy`, THE Provider_Router SHALL instradare la diagnosi verso un modello con Capability_Tier adeguata, preferendo un modello capace anche cloud quando il modello locale non è adeguato.
4. IF il modello non è in grado di produrre una Fix_Proposal per una Issue, THEN THE MGCoding SHALL segnalare la Issue come non risolta automaticamente, senza bloccare le altre.

### Requirement 4: Approvazione obbligatoria prima dell'applicazione

**User Story:** Come utente, voglio approvare ogni modifica prima che venga scritta, così che mantenga il controllo sul mio codice.

#### Acceptance Criteria

1. WHEN esiste una Fix_Proposal, THE MGCoding SHALL mostrarla all'utente e SHALL richiedere un'approvazione esplicita prima di applicarla.
2. IF l'utente rifiuta una Fix_Proposal, THEN THE MGCoding SHALL NOT applicarla e SHALL lasciare i file invariati.
3. WHERE la Autonomy_Mode è `supervised`, THE MGCoding SHALL richiedere l'approvazione per ogni Fix_Proposal anche quando ne propone più di una.

### Requirement 5: Applicazione reversibile con checkpoint

**User Story:** Come utente, voglio poter annullare una correzione applicata, così che un fix sbagliato non lasci il progetto peggiore di prima.

#### Acceptance Criteria

1. WHEN l'utente approva una Fix_Proposal, THE MGCoding SHALL creare un Checkpoint prima di applicare la modifica.
2. WHEN l'utente richiede il ripristino dopo un'applicazione, THE MGCoding SHALL riportare i file allo stato del Checkpoint.

### Requirement 6: Verifica automatica post-correzione

**User Story:** Come utente, voglio che dopo aver applicato un fix MGCoding verifichi da solo se ha funzionato, così che io non debba fidarmi della parola del modello.

#### Acceptance Criteria

1. WHEN una Fix_Proposal è stata applicata ed esiste un Verification_Command, THE Verification_Gate SHALL rieseguire la verifica e confrontarne l'esito con la Baseline.
2. IF la verifica dopo l'applicazione mostra più errori o test rossi rispetto alla Baseline, THEN THE Verification_Gate SHALL segnalare la regressione e SHALL proporre il ripristino del Checkpoint.
3. WHEN la verifica dopo l'applicazione non mostra regressioni e risolve la Issue mirata, THE MGCoding SHALL riportare l'esito positivo all'utente.

### Requirement 7: Guardrail anti-imbroglio

**User Story:** Come utente, voglio essere certo che un fix non "bari" indebolendo i test, così che il verde sia reale e non simulato.

#### Acceptance Criteria

1. THE Reward_Hacking_Guard SHALL trattare i file di test e le configurazioni di build/test come Protected_Path durante il Self_Healing.
2. IF una Fix_Proposal modifica un Protected_Path, THEN THE MGCoding SHALL rifiutare la proposta e SHALL segnalarne il motivo all'utente.
3. IF una Fix_Proposal riduce il numero complessivo di test rispetto alla Baseline, THEN THE MGCoding SHALL rifiutare la proposta.

### Requirement 8: Budget dei tentativi e arresto sull'assenza di progresso

**User Story:** Come utente, voglio che MGCoding si fermi se non sta facendo progressi, così da non entrare in cicli inutili.

#### Acceptance Criteria

1. THE MGCoding SHALL limitare a un numero massimo configurabile i tentativi di correzione automatica per ogni Issue.
2. IF dopo un tentativo il numero di errori non diminuisce, THEN THE MGCoding SHALL interrompere i tentativi su quella Issue e SHALL chiedere all'utente come procedere.
3. THE MGCoding SHALL leggere il numero massimo di tentativi dal Config_Key `mgcoding.selfHealing.maxAttempts`, con un default che preserva un comportamento prudente.

### Requirement 9: Attivazione, comando e retrocompatibilità

**User Story:** Come utente esistente, voglio che la funzionalità sia opt-in e non cambi il comportamento attuale finché non la attivo.

#### Acceptance Criteria

1. THE MGCoding SHALL esporre un comando `MGCoding: Diagnostica e correggi` che avvia il Self_Healing sul workspace corrente.
2. WHERE il Config_Key `mgcoding.selfHealing.enabled` non è impostato, THE MGCoding SHALL considerare la funzionalità disattivata e SHALL preservare il comportamento precedente.
3. WHEN MGCoding legge o scrive la configurazione del Self_Healing, THE MGCoding SHALL scrivere sotto la cartella `.mg/` e SHALL leggere la configurazione legacy sotto `.kiro/` se `.mg/` non contiene il dato.
4. WHEN la funzionalità esegue un Verification_Command su Windows, THE MGCoding SHALL eseguirlo tramite `cmd`.
