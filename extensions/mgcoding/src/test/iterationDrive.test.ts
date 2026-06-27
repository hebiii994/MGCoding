/*---------------------------------------------------------------------------------------------
 *  MGCoding - test end-to-end dell'ORCHESTRAZIONE del percorso structured per iterazione
 *  (`driveStructuredIteration` in `agent/agentLoop.ts`). Mentre `iterationPath.pbt.test.ts`
 *  verifica le funzioni pure `chooseIterationPath`/`onSchemaViolation` per singola chiamata,
 *  qui si esercita la SEQUENZA completa che lega quelle decisioni in una iterazione del loop:
 *  scelta del percorso → tentativo → retry su violazione → fallback a retry esauriti → e, su
 *  più iterazioni, il reset dello stato di retry (un fallback non disabilita lo structured dopo).
 *
 *  L'`attempt` reale (closure `attemptStructured` nel loop) ha effetti collaterali su rete/UI;
 *  qui lo si sostituisce con un finto scriptato che conta le chiamate, così il test non dipende
 *  da `vscode`/`fetch`/filesystem. `agentLoop.ts` fa `import * as vscode` ma NON usa `vscode` a
 *  load-time, quindi lo stub vuoto (importato per primo) è sufficiente.
 *
 *  Eseguibile con: node out/test/iterationDrive.test.js
 *  _Requirements: 2.1, 2.2, 2.3, 2.4_
 *--------------------------------------------------------------------------------------------*/

// Lo stub di `vscode` DEVE precedere il modulo sotto test (vedi vscodeStub.ts).
import './vscodeStub';
import * as assert from 'assert';
import { test, run } from './_harness';
import { driveStructuredIteration, StructuredAttemptOutcome } from '../agent/agentLoop';
import { CapabilityTier } from '../llm/types';

/**
 * Costruisce un finto `attempt` da una lista di esiti scriptati e ne conta le invocazioni.
 * Se gli esiti finiscono, ripete l'ultimo (utile per "violazione sempre").
 */
function scriptedAttempt(outcomes: StructuredAttemptOutcome[]): { fn: () => Promise<StructuredAttemptOutcome>; calls: () => number } {
	let i = 0;
	let calls = 0;
	const fn = async (): Promise<StructuredAttemptOutcome> => {
		calls++;
		const out = outcomes[Math.min(i, outcomes.length - 1)];
		i++;
		return out;
	};
	return { fn, calls: () => calls };
}

const STRUCTURED: CapabilityTier = 'structured';
const NATIVE: CapabilityTier = 'native';
const TEXTUAL: CapabilityTier = 'textual';

// --- Percorso non-structured: nessun tentativo, fallback immediato (Req. 2.1, 2.5) ----------

test('tier textual → fallback senza alcun tentativo structured', async () => {
	const a = scriptedAttempt(['continue']);
	const decision = await driveStructuredIteration(TEXTUAL, true, a.fn);
	assert.strictEqual(decision, 'fallback');
	assert.strictEqual(a.calls(), 0, 'su tier testuale attempt non deve essere chiamato');
});

test('flag structuredTools=false (tier capace) → fallback senza tentativi', async () => {
	const a = scriptedAttempt(['continue']);
	const decision = await driveStructuredIteration(NATIVE, false, a.fn);
	assert.strictEqual(decision, 'fallback');
	assert.strictEqual(a.calls(), 0, 'col flag disattivo attempt non deve essere chiamato');
});

// --- Percorso structured: esiti diretti (Req. 2.1) ------------------------------------------

test('structured + continue al primo colpo → continue, un solo tentativo', async () => {
	const a = scriptedAttempt(['continue']);
	const decision = await driveStructuredIteration(STRUCTURED, true, a.fn);
	assert.strictEqual(decision, 'continue');
	assert.strictEqual(a.calls(), 1);
});

test('structured + return → return, un solo tentativo', async () => {
	const a = scriptedAttempt(['return']);
	const decision = await driveStructuredIteration(NATIVE, true, a.fn);
	assert.strictEqual(decision, 'return');
	assert.strictEqual(a.calls(), 1);
});

// --- Retry per singola iterazione poi fallback (Req. 2.2, 2.3) ------------------------------

test('structured + violazione poi continue → retry una volta, decisione continue (2 tentativi)', async () => {
	const a = scriptedAttempt(['violation', 'continue']);
	const decision = await driveStructuredIteration(STRUCTURED, true, a.fn);
	assert.strictEqual(decision, 'continue');
	assert.strictEqual(a.calls(), 2, 'una violazione consuma il retry, poi il secondo tentativo riesce');
});

test('structured + violazione sempre (maxRetries=1) → fallback dopo esattamente 2 tentativi', async () => {
	const a = scriptedAttempt(['violation']);
	const decision = await driveStructuredIteration(STRUCTURED, true, a.fn);
	assert.strictEqual(decision, 'fallback');
	assert.strictEqual(a.calls(), 2, 'tentativo iniziale + un retry, poi fallback');
});

test('structured + violazione sempre con maxRetries=2 → fallback dopo 3 tentativi', async () => {
	const a = scriptedAttempt(['violation']);
	const decision = await driveStructuredIteration(STRUCTURED, true, a.fn, 2);
	assert.strictEqual(decision, 'fallback');
	assert.strictEqual(a.calls(), 3, 'tentativo iniziale + due retry, poi fallback');
});

// --- Multi-iterazione: il fallback NON disabilita lo structured nelle iterazioni dopo (Req. 2.4) ---

test('sequenza di iterazioni: dopo un fallback la successiva ritenta comunque lo structured', async () => {
	// Iterazione 1: l'attempt viola sempre → fallback (stato di retry locale, 2 tentativi).
	const it1 = scriptedAttempt(['violation']);
	const d1 = await driveStructuredIteration(STRUCTURED, true, it1.fn);
	assert.strictEqual(d1, 'fallback');
	assert.strictEqual(it1.calls(), 2);

	// Iterazione 2: nuovo stato fresco; l'attempt riesce subito → structured scelto di nuovo.
	// Prova che il fallback dell'iterazione 1 non ha "spento" lo structured (Req. 2.4).
	const it2 = scriptedAttempt(['continue']);
	const d2 = await driveStructuredIteration(STRUCTURED, true, it2.fn);
	assert.strictEqual(d2, 'continue');
	assert.strictEqual(it2.calls(), 1, 'la nuova iterazione riparte da uno stato di retry fresco');
});

void run();
