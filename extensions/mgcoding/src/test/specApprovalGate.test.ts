/*---------------------------------------------------------------------------------------------
 *  MGCoding - test unitari del gating dell'approvazione tra fasi dello workflow Spec (Task 7.6).
 *  Harness self-contained (assert + ok/FAIL + exit(1)), eseguibile con:
 *      node out/test/specApprovalGate.test.js
 *
 *  Obiettivo (Req. 6.6): "WHILE l'approvazione dell'utente per la fase corrente non è
 *  registrata, THE MGCoding SHALL impedire l'avvio della fase successiva dello workflow."
 *
 *  Verifichiamo il comportamento osservabile di `gatePhaseTransition` (in `specs/specs.ts`),
 *  che ritorna `true` SOLO quando è consentito avviare la fase successiva:
 *   1. Con documento valido (`canAdvance === true`) la fase successiva NON parte finché
 *      l'utente non registra l'approvazione esplicita "Approva e continua".
 *   2. Se l'utente non approva (chiude il dialogo → `undefined`, oppure sceglie altro), il
 *      gate ritorna `false`: la fase successiva resta bloccata.
 *   3. Quando la validazione non è superata (`canAdvance === false`, sezione mancante) il gate
 *      ritorna `false` SENZA nemmeno chiedere l'approvazione (Req. 6.3, 6.5 + 6.6).
 *
 *  `specs/specs.ts` usa `vscode` a RUNTIME: importiamo `./vscodeStub` PER PRIMO e popoliamo
 *  l'oggetto condiviso prima di caricare (require pigro) il modulo sotto test, così che la
 *  compilazione CommonJS di `import * as vscode` ne fotografi le proprietà al require.
 *--------------------------------------------------------------------------------------------*/

// IMPORTANTE: lo stub di `vscode` va importato PRIMA del modulo sotto test.
import { vscodeMock } from './vscodeStub';
import * as assert from 'assert';

// --- Mock minimale di `vscode.window` (i soli punti d'I/O usati dal gate) -------------------

/** Risposta che `showInformationMessage` deve restituire (la scelta dell'utente). */
let infoResponse: string | undefined;
/** Registro delle chiamate ai dialoghi, per asserire cosa è stato mostrato. */
const infoCalls: Array<{ message: string; options: unknown; items: string[] }> = [];
const warningCalls: Array<{ message: string; options: unknown; items: string[] }> = [];

/** Azzera lo stato del mock tra un test e l'altro. */
function resetMock(): void {
	infoResponse = undefined;
	infoCalls.length = 0;
	warningCalls.length = 0;
}

// Popola l'oggetto `vscode` condiviso PRIMA di caricare il modulo sotto test.
Object.assign(vscodeMock, {
	window: {
		showInformationMessage: async (message: string, options: unknown, ...items: string[]) => {
			infoCalls.push({ message, options, items });
			return infoResponse;
		},
		showWarningMessage: async (message: string, options: unknown, ...items: string[]) => {
			warningCalls.push({ message, options, items });
			return undefined;
		},
	},
});

// Import del modulo sotto test DOPO aver installato lo stub (require pigro per CommonJS).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { gatePhaseTransition } = require('../specs/specs') as typeof import('../specs/specs');

// --- Documenti di esempio per la fase `requirements` ---------------------------------------
// Sezioni attese per `requirements`: "Introduction" e "Requirements" (validazione strutturale).

/** Documento `requirements.md` strutturalmente valido (entrambe le sezioni presenti). */
const VALID_REQUIREMENTS = [
	'# Requisiti: esempio',
	'',
	'## Introduction',
	'Breve introduzione della funzionalità.',
	'',
	'## Requirements',
	'',
	'### Requirement 1',
	'1. THE SYSTEM SHALL fare qualcosa.',
].join('\n');

/** Documento `requirements.md` con la sezione "Introduction" mancante → `canAdvance` false. */
const INVALID_REQUIREMENTS = [
	'# Requisiti: esempio',
	'',
	'## Requirements',
	'',
	'### Requirement 1',
	'1. THE SYSTEM SHALL fare qualcosa.',
].join('\n');

const APPROVAL_PROMPT = 'Requirements generati. Procedo col design?';

// --- Harness --------------------------------------------------------------------------------

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
	try {
		await fn();
		passed++;
		console.log(`ok   - ${name}`);
	} catch (e) {
		failed++;
		console.error(`FAIL - ${name}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
	}
}

// --- Test ------------------------------------------------------------------------------------

async function main(): Promise<void> {
	// (1) Documento valido + approvazione registrata → la fase successiva può partire (true).
	await test('approvazione registrata: con documento valido il gate consente la fase successiva', async () => {
		resetMock();
		infoResponse = 'Approva e continua'; // l'utente registra l'approvazione
		const ok = await gatePhaseTransition('requirements', VALID_REQUIREMENTS, APPROVAL_PROMPT);
		assert.strictEqual(ok, true, 'con approvazione registrata il gate deve consentire l\'avanzamento');
		// L'approvazione è richiesta in modo esplicito e modale, con l\'azione "Approva e continua".
		assert.strictEqual(infoCalls.length, 1, 'deve chiedere l\'approvazione esattamente una volta');
		assert.deepStrictEqual(infoCalls[0].options, { modal: true }, 'la richiesta di approvazione deve essere modale');
		assert.ok(infoCalls[0].items.includes('Approva e continua'), 'deve offrire l\'azione "Approva e continua"');
		// Documento valido: nessun avviso di validazione fallita.
		assert.strictEqual(warningCalls.length, 0, 'nessun avviso di validazione con documento valido');
	});

	// (2a) Documento valido ma approvazione NON registrata (dialogo chiuso → undefined) → blocco.
	await test('approvazione non registrata (dialogo chiuso): la fase successiva resta bloccata', async () => {
		resetMock();
		infoResponse = undefined; // l'utente chiude / annulla senza approvare
		const ok = await gatePhaseTransition('requirements', VALID_REQUIREMENTS, APPROVAL_PROMPT);
		assert.strictEqual(ok, false, 'senza approvazione registrata il gate deve bloccare l\'avanzamento');
		assert.strictEqual(infoCalls.length, 1, 'l\'approvazione deve comunque essere stata richiesta');
	});

	// (2b) Documento valido ma l'utente sceglie qualcos'altro (non l'azione di approvazione) → blocco.
	await test('approvazione non registrata (scelta diversa): la fase successiva resta bloccata', async () => {
		resetMock();
		infoResponse = 'Annulla'; // qualunque risposta diversa da "Approva e continua"
		const ok = await gatePhaseTransition('requirements', VALID_REQUIREMENTS, APPROVAL_PROMPT);
		assert.strictEqual(ok, false, 'solo "Approva e continua" registra l\'approvazione');
	});

	// (3) Validazione non superata (sezione mancante): blocco SENZA richiedere l'approvazione.
	await test('validazione fallita: blocca e non chiede nemmeno l\'approvazione', async () => {
		resetMock();
		infoResponse = 'Approva e continua'; // anche se l'utente approverebbe, il gate non glielo chiede
		const ok = await gatePhaseTransition('requirements', INVALID_REQUIREMENTS, APPROVAL_PROMPT);
		assert.strictEqual(ok, false, 'con canAdvance=false il gate deve bloccare l\'avanzamento');
		assert.strictEqual(infoCalls.length, 0, 'l\'approvazione non deve essere richiesta se la validazione fallisce');
		assert.strictEqual(warningCalls.length, 1, 'deve mostrare l\'avviso dei problemi di validazione');
		assert.deepStrictEqual(warningCalls[0].options, { modal: true }, 'l\'avviso di validazione deve essere modale');
	});

	console.log(`\n${passed} passed, ${failed} failed`);
	if (failed > 0) {
		process.exit(1);
	}
}

void main();
