# Implementation Plan: self-healing

## Overview

Il piano implementa l'autodiagnostica assistita (Self_Healing di Livello 1) come componenti
puri e testabili con un guscio di I/O attorno all'infrastruttura esistente in
`extensions/mgcoding/src/`. Si parte dalle fondamenta (config + tipi), poi i nuclei puri
(Issue/report, verification compare, guard, budget) ciascuno con il suo property test
(`fast-check`, ≥ 100 iterazioni), infine il guscio (Diagnostic_Collector e
SelfHealingController) che riusa Autonomy_Controller (approvazione), checkpoint (reversibilità),
Provider_Router (routing heavy) e mgConfig (`.mg/` → `.kiro/`). La funzionalità è opt-in e a
default disattivata: i default preservano il comportamento esistente.

## Tasks

- [ ] 1. Fondamenta: Config_Key, comando e tipi di dominio
  - [ ] 1.1 Dichiarare Config_Key, comando e tipi condivisi
    - Aggiungere a `extensions/mgcoding/package.json` i Config_Key `mgcoding.selfHealing.enabled` (default `false`), `mgcoding.selfHealing.maxAttempts` (default `2`), `mgcoding.selfHealing.verifyCommand` (default `""`), `mgcoding.selfHealing.protectedGlobs` (default: pattern test/config) e il comando `mgcoding.selfHeal` ("MGCoding: Diagnostica e correggi")
    - Aggiungere i tipi di dominio (`Issue`, `IssueCategory`, `VerificationSnapshot`, `FixProposal`, `RegressionVerdict`, `AttemptDecision`, `ProposalStatus`, `GuardVerdict`) in `extensions/mgcoding/src/selfHealing/types.ts`
    - I default devono lasciare la funzionalità inerte finché non attivata
    - _Requirements: 8.3, 9.1, 9.2_

- [ ] 2. Issue model e report (nucleo puro)
  - [ ] 2.1 Implementare dedup, report e classificazione della proposta
    - Creare `extensions/mgcoding/src/selfHealing/issues.ts` con `dedupeIssues`, `buildIssueReport`, `classifyProposal`
    - Dedup per chiave `(category, file, line, message)` con ordine di prima comparsa; report raggruppato per file con `total`; `classifyProposal` = `proposed` sse diff ed explanation non vuoti
    - _Requirements: 1.3, 1.4, 2.1, 2.2, 3.2, 3.4_

  - [ ] 2.2 Property test per la dedup delle Issue
    - File `extensions/mgcoding/src/test/selfHealDedup.pbt.test.ts`
    - **Property 1: Dedup deterministica e categorizzata delle Issue**
    - **Validates: Requirements 1.3, 1.4**

  - [ ] 2.3 Property test per l'Issue_Report
    - File `extensions/mgcoding/src/test/issueReport.pbt.test.ts`
    - **Property 2: L'Issue_Report è raggruppato per file e coerente col totale**
    - **Validates: Requirements 2.1, 2.2**

  - [ ] 2.4 Property test per la classificazione della proposta
    - File `extensions/mgcoding/src/test/proposalClassify.pbt.test.ts`
    - **Property 3: Classificazione della proposta in funzione di diff e spiegazione**
    - **Validates: Requirements 3.2, 3.4**

- [ ] 3. Verification_Gate (nucleo puro per il confronto)
  - [ ] 3.1 Implementare il confronto degli snapshot di verifica
    - Creare `extensions/mgcoding/src/selfHealing/verification.ts` con `compareVerification`
    - `regression` se errori o test rossi aumentano; `ok` se gli errori calano e i test rossi non aumentano; `no-change` altrimenti; funzione totale
    - _Requirements: 6.2, 6.3_

  - [ ] 3.2 Property test per il verdetto di regressione
    - File `extensions/mgcoding/src/test/verificationCompare.pbt.test.ts`
    - **Property 4: Semantica del verdetto di regressione**
    - **Validates: Requirements 6.2, 6.3**

- [ ] 4. Reward_Hacking_Guard (nucleo puro)
  - [ ] 4.1 Implementare i guardrail anti-imbroglio
    - Creare `extensions/mgcoding/src/selfHealing/guard.ts` con `isProtectedPath`, `checkPathsGuard`, `checkTestCountGuard`
    - `checkPathsGuard` rifiuta se un `touchedPath` è protetto (con motivo); `checkTestCountGuard` rifiuta se `after.totalTests < baseline.totalTests`
    - _Requirements: 7.1, 7.2, 7.3_

  - [ ] 4.2 Property test per i Protected_Path
    - File `extensions/mgcoding/src/test/guardProtectedPath.pbt.test.ts`
    - **Property 5: Il guard rifiuta le proposte che toccano Protected_Path**
    - **Validates: Requirements 7.1, 7.2**

  - [ ] 4.3 Property test per la riduzione del numero di test
    - File `extensions/mgcoding/src/test/guardTestCount.pbt.test.ts`
    - **Property 6: Il guard rifiuta la riduzione del numero di test**
    - **Validates: Requirements 7.3**

- [ ] 5. Budget dei tentativi (nucleo puro)
  - [ ] 5.1 Implementare la decisione sui tentativi
    - Creare `extensions/mgcoding/src/selfHealing/budget.ts` con `decideAttempt`
    - `stop-budget` se `attempts >= maxAttempts`; poi `stop-no-progress` se `errorsAfter >= errorsBefore`; altrimenti `continue`
    - _Requirements: 8.1, 8.2_

  - [ ] 5.2 Property test per il budget dei tentativi
    - File `extensions/mgcoding/src/test/attemptBudget.pbt.test.ts`
    - **Property 7: Budget dei tentativi e arresto sull'assenza di progresso**
    - **Validates: Requirements 8.1, 8.2**

- [~] 6. Checkpoint - Verifica dei nuclei puri
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 7. Diagnostic_Collector (guscio I/O)
  - [ ] 7.1 Implementare la raccolta e la baseline
    - Creare `extensions/mgcoding/src/selfHealing/collector.ts`: raccoglie le `vscode.Diagnostic` di severità errore → `Issue{category:'diagnostica'}`; esegue il `Verification_Command` (auto-detect o `mgcoding.selfHealing.verifyCommand`) via `cmd` su Windows e ne estrae `Issue` build/test + `VerificationSnapshot` (baseline); informa l'utente e termina se nessun errore
    - Riusa il parser dell'output per gli snapshot; nessuna modifica ai file
    - _Requirements: 1.1, 1.2, 1.5, 6.1, 9.4_

  - [ ] 7.2 Integration test per il collector
    - Mock di `vscode.languages.getDiagnostics` e `child_process`: mapping diagnostiche → Issue ed esecuzione del Verification_Command via `cmd` su Windows (pattern di `ollamaUnreachableWinShell.int.test.ts`)
    - _Requirements: 1.1, 9.4_

- [ ] 8. SelfHealingController e cablaggio del comando (guscio I/O)
  - [ ] 8.1 Implementare l'orchestrazione
    - Creare `extensions/mgcoding/src/selfHealing/selfHealing.ts` (`SelfHealingController`): legge la config con `readFeatureConfig` (`.mg/` → `.kiro/` → default) ed esce se `enabled` è falso/assente; evidenzia l'Issue_Report senza modificare file; per Issue esegue diagnosi via Agent_Loop con `Provider_Router` (`complexity:'heavy'`), `classifyProposal`, `checkPathsGuard`, approvazione via `Autonomy_Controller` (`supervised`), `beginCheckpoint`, applicazione, `Verification_Gate` + `checkTestCountGuard`, e su regressione propone `revertCheckpoint`; `decideAttempt` governa i ritentativi
    - _Requirements: 2.3, 3.1, 3.3, 4.1, 4.2, 4.3, 5.1, 5.2, 6.2, 6.3, 7.3, 8.2, 9.2, 9.3_

  - [ ] 8.2 Registrare il comando
    - Registrare `mgcoding.selfHeal` in `extensions/mgcoding/src/extension.ts` e collegarlo al `SelfHealingController`
    - _Requirements: 9.1_

  - [ ] 8.3 Unit test per l'opt-in disattivato
    - Verificare che il comando sia inerte (nessuna raccolta, nessuna modifica) quando `mgcoding.selfHealing.enabled` è assente/falso
    - _Requirements: 9.2_

  - [ ] 8.4 Integration test end-to-end del flusso
    - Provider e verifica finti: Issue → proposta → guard → approvazione finta → checkpoint → applicazione → verifica → esito, incluso il ramo regressione → proposta di revert
    - _Requirements: 4.1, 5.2, 6.2_

- [~] 9. Checkpoint finale - Verifica end-to-end
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- I task referenziano criteri di requisito specifici per la tracciabilità.
- I requisiti 4 (approvazione), 5 (checkpoint/revert) e 9.3 (precedenza config) riusano componenti già implementati e testati in `local-model-kiro-parity` (Property 13, 17, 28): non si re-implementa la logica, la si cabla.
- I property test validano le proprietà universali del design (1 test per proprietà, ≥ 100 iterazioni con `fast-check`).
- Gli unit/integration test coprono esempi, casi limite e wiring di I/O con mock di `vscode`/`child_process` e `test/vscodeStub.ts` (+ `loadAfterMock` per i moduli che leggono `vscode` a load-time).
- I test girano in modalità singola (`npm test`), mai in watch.
- Identificatori di codice in inglese, prosa/commenti in italiano; configurazione scritta sotto `.mg/` con lettura legacy `.kiro/`; comandi di verifica via `cmd` su Windows.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1", "3.1", "4.1", "5.1"] },
    { "id": 1, "tasks": ["2.2", "2.3", "2.4", "3.2", "4.2", "4.3", "5.2", "7.1"] },
    { "id": 2, "tasks": ["7.2", "8.1"] },
    { "id": 3, "tasks": ["8.2", "8.3", "8.4"] }
  ]
}
```
