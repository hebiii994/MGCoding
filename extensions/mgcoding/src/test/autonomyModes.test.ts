/*---------------------------------------------------------------------------------------------
 *  MGCoding - test unitari per le Autonomy_Mode accettate e la lettura della config (Task 6.5).
 *  Harness self-contained (assert + ok/FAIL + exit(1)), eseguibile con:
 *      node out/test/autonomyModes.test.js
 *
 *  Obiettivo (Req. 5.1, 5.6):
 *   1. L'Autonomy_Controller supporta esattamente due Autonomy_Mode, `supervised` e
 *      `autopilot`, e il nucleo puro `decideAction` produce un esito coerente per entrambe
 *      su ogni tipo di azione (`file_edit` / `shell_command`).
 *   2. Il guscio `AutonomyController.getMode()` legge il Config_Key `mgcoding.autonomyMode`
 *      dalla configurazione di VS Code: default `supervised`; il valore `autopilot` è
 *      rispettato; l'interruttore legacy `autoApprove=true` eleva comunque ad `autopilot`.
 *
 *  Il modulo `agent/autonomy.ts` usa `vscode.workspace.getConfiguration` a RUNTIME (in
 *  `getMode`): importiamo `./vscodeStub` PER PRIMO e popoliamo l'oggetto condiviso con una
 *  configurazione controllabile prima di esercitare il modulo sotto test.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
// IMPORTANTE: lo stub di `vscode` va importato PRIMA del modulo sotto test.
import { vscodeMock } from './vscodeStub';

// --- Configurazione di VS Code controllabile dai test --------------------------------------

/**
 * Store dei valori di configurazione del namespace `mgcoding`, indicizzato per chiave.
 * I test lo popolano prima di chiamare `getMode()`; le chiavi assenti ricadono sul default
 * passato a `cfg.get(key, default)`, esattamente come la vera API di VS Code.
 */
const configStore = new Map<string, unknown>();

/** Azzera la configurazione tra un test e l'altro (nessun valore impostato dall'utente). */
function resetConfig(): void {
	configStore.clear();
}

/** Imposta (o sovrascrive) un valore di configurazione per il prossimo `getMode()`. */
function setConfig(key: string, value: unknown): void {
	configStore.set(key, value);
}

// Popola l'oggetto `vscode` condiviso PRIMA di importare/esercitare il modulo sotto test.
// `getConfiguration(ns)` restituisce un oggetto con `.get(key, default)` che legge dallo store.
vscodeMock.workspace = {
	getConfiguration(ns: string) {
		// Il controller usa il namespace 'mgcoding'; lo verifichiamo per sicurezza.
		assert.strictEqual(ns, 'mgcoding', `namespace di configurazione inatteso: ${ns}`);
		return {
			get<T>(key: string, def: T): T {
				return configStore.has(key) ? (configStore.get(key) as T) : def;
			},
		};
	},
};

// Import del modulo sotto test DOPO aver installato lo stub.
import { AutonomyController, decideAction, AutonomyMode, ActionRequest } from '../agent/autonomy';

// --- Harness --------------------------------------------------------------------------------

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void): void {
	try {
		fn();
		passed++;
		console.log(`ok   - ${name}`);
	} catch (e) {
		failed++;
		console.error(`FAIL - ${name}: ${e instanceof Error ? e.message : String(e)}`);
	}
}

// --- Test ------------------------------------------------------------------------------------

function run(): void {
	const controller = new AutonomyController();

	// (1) Entrambe le Autonomy_Mode sono supportate dal nucleo puro `decideAction` (Req. 5.1).
	//     Per ogni modalità e ogni tipo di azione l'esito è ben formato e coerente.
	const modes: AutonomyMode[] = ['supervised', 'autopilot'];
	const actions: ActionRequest[] = [
		{ kind: 'file_edit', path: 'src/file.ts' },
		{ kind: 'shell_command', command: 'npm run build' },
	];
	for (const mode of modes) {
		for (const action of actions) {
			test(`decideAction supporta la modalità '${mode}' per l'azione '${action.kind}'`, () => {
				const decision = decideAction(mode, action);
				assert.strictEqual(typeof decision.requiresApproval, 'boolean', 'requiresApproval non booleano');
				assert.strictEqual(typeof decision.needsCheckpoint, 'boolean', 'needsCheckpoint non booleano');
				assert.ok(decision.reason.length > 0, 'reason vuota');
			});
		}
	}

	// In supervised ogni azione richiede approvazione; in autopilot un'azione non distruttiva no.
	test("supervised richiede approvazione, autopilot (azione non distruttiva) no", () => {
		assert.strictEqual(decideAction('supervised', actions[0]).requiresApproval, true);
		assert.strictEqual(decideAction('supervised', actions[1]).requiresApproval, true);
		assert.strictEqual(decideAction('autopilot', actions[1]).requiresApproval, false);
		// autopilot + file_edit non richiede approvazione ma impone un checkpoint.
		assert.strictEqual(decideAction('autopilot', actions[0]).requiresApproval, false);
		assert.strictEqual(decideAction('autopilot', actions[0]).needsCheckpoint, true);
	});

	// (2a) getMode: default 'supervised' quando nessuna config è impostata (Req. 5.6).
	test("getMode ritorna 'supervised' per default (nessun Config_Key impostato)", () => {
		resetConfig();
		assert.strictEqual(controller.getMode(), 'supervised');
	});

	// (2b) getMode legge esplicitamente mgcoding.autonomyMode='autopilot' (Req. 5.6).
	test("getMode legge mgcoding.autonomyMode='autopilot'", () => {
		resetConfig();
		setConfig('autonomyMode', 'autopilot');
		assert.strictEqual(controller.getMode(), 'autopilot');
	});

	// (2c) getMode legge esplicitamente mgcoding.autonomyMode='supervised' (Req. 5.6).
	test("getMode legge mgcoding.autonomyMode='supervised'", () => {
		resetConfig();
		setConfig('autonomyMode', 'supervised');
		assert.strictEqual(controller.getMode(), 'supervised');
	});

	// (2d) Un valore non riconosciuto di autonomyMode ricade in modo sicuro su 'supervised'.
	test("getMode normalizza un valore sconosciuto di autonomyMode su 'supervised'", () => {
		resetConfig();
		setConfig('autonomyMode', 'banana');
		assert.strictEqual(controller.getMode(), 'supervised');
	});

	// (2e) L'interruttore legacy autoApprove=true eleva ad 'autopilot' (retrocompatibilità).
	test("getMode: autoApprove=true mappa su 'autopilot' anche con autonomyMode='supervised'", () => {
		resetConfig();
		setConfig('autoApprove', true);
		setConfig('autonomyMode', 'supervised');
		assert.strictEqual(controller.getMode(), 'autopilot');
	});

	// (2f) autoApprove=false non altera la lettura esplicita di autonomyMode.
	test("getMode: autoApprove=false rispetta autonomyMode='autopilot'", () => {
		resetConfig();
		setConfig('autoApprove', false);
		setConfig('autonomyMode', 'autopilot');
		assert.strictEqual(controller.getMode(), 'autopilot');
	});

	console.log(`\n${passed} passed, ${failed} failed`);
	if (failed > 0) {
		process.exit(1);
	}
}

run();
