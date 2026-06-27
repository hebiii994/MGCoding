/*---------------------------------------------------------------------------------------------
 *  MGCoding - Property-based test dell'Autonomy_Controller (logica pura `decideAction` e
 *  `isDestructiveCommand` in `agent/autonomy.ts`).
 *  Harness self-contained (assert + ok/FAIL + exit(1)), eseguibile con:
 *      node out/test/autonomyDecision.pbt.test.js
 *
 *  Lo stub di `vscode` DEVE essere importato PRIMA del modulo sotto test: `autonomy.ts`
 *  fa `import * as vscode from 'vscode'` (per il guscio `AutonomyController`), modulo che
 *  fuori dall'Extension Host non esiste. Le funzioni pure qui verificate non usano alcuna
 *  API di `vscode`, quindi il mock vuoto è sufficiente.
 *
 *  Questo file copre quattro proprietà di correttezza del design:
 *
 *  Property 13: In supervised ogni azione richiede approvazione (Validates: 5.2)
 *  Property 14: In autopilot le azioni non distruttive non richiedono approvazione (Validates: 5.3)
 *  Property 15: In autopilot una modifica a file richiede un checkpoint (Validates: 5.4)
 *  Property 16: I comandi distruttivi richiedono approvazione anche in autopilot (Validates: 5.7)
 *--------------------------------------------------------------------------------------------*/

// Lo stub di `vscode` DEVE essere importato prima del modulo sotto test (vedi vscodeStub.ts).
import './vscodeStub';
import * as assert from 'assert';
import * as fc from 'fast-check';
import { decideAction, isDestructiveCommand, ActionRequest } from '../agent/autonomy';

const RUNS = 200;

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

// --- Generatori --------------------------------------------------------------------------

/** Argomento generico di un comando (token senza operatori di shell). */
const arbArg: fc.Arbitrary<string> = fc.stringMatching(/^[A-Za-z0-9_.:/\\-]{1,16}$/);

/** Comandi noti come NON distruttivi (build, status, lettura, creazione, ...). */
const SAFE_COMMANDS: readonly string[] = [
	'npm run build',
	'npm test',
	'git status',
	'git commit -m messaggio',
	'git add .',
	'git log',
	'ls -la',
	'dir',
	'echo hello',
	'node index.js',
	'python app.py',
	'mkdir build',
	'cat README.md',
	'type file.txt',
	'tsc -p .',
	'cd src',
];

/** Prefissi di comandi noti come DISTRUTTIVI (Windows-first + git-bash/PowerShell/git). */
const DESTRUCTIVE_PREFIXES: readonly string[] = [
	'del',
	'erase',
	'rd',
	'rmdir /s',
	'format c:',
	'diskpart',
	'dd if=src of=dst',
	'rm -rf',
	'rm -fr',
	'rm -r',
	'rm --recursive',
	'mkfs',
	'mkfs.ext4',
	'truncate -s 0',
	'git reset --hard',
	'git clean -fd',
	'git clean -f',
	'git checkout --',
	'git checkout -f',
	'git push origin --force',
	'git push origin -f',
	'git branch -D',
	'Remove-Item -Recurse',
	'Remove-Item -Force',
	'ri -Recurse',
	'Clear-Content',
];

/** ActionRequest arbitraria (file_edit o shell_command con comando qualsiasi). */
const arbActionRequest: fc.Arbitrary<ActionRequest> = fc.oneof(
	fc.record({
		kind: fc.constant<'file_edit'>('file_edit'),
		path: fc.stringMatching(/^[A-Za-z0-9_./\\-]{1,24}$/),
	}),
	fc.record({
		kind: fc.constant<'shell_command'>('shell_command'),
		command: fc.oneof(fc.constantFrom(...SAFE_COMMANDS, ...DESTRUCTIVE_PREFIXES), fc.string()),
	}),
);

/** ActionRequest di sola modifica file. */
const arbFileEdit: fc.Arbitrary<ActionRequest> = fc.record({
	kind: fc.constant<'file_edit'>('file_edit'),
	path: fc.stringMatching(/^[A-Za-z0-9_./\\-]{1,24}$/),
});

/** ActionRequest NON distruttiva: file_edit oppure shell_command con comando sicuro. */
const arbNonDestructiveRequest: fc.Arbitrary<ActionRequest> = fc.oneof(
	arbFileEdit,
	fc.record({
		kind: fc.constant<'shell_command'>('shell_command'),
		command: fc.oneof(fc.constantFrom(...SAFE_COMMANDS), fc.string()),
	}),
);

/** Comando distruttivo: prefisso noto + argomenti, anche annidato in una catena di shell. */
const arbDestructiveCommand: fc.Arbitrary<string> = fc
	.tuple(
		fc.constantFrom(...DESTRUCTIVE_PREFIXES),
		fc.array(arbArg, { maxLength: 3 }),
		// Eventuale prefisso "sicuro" concatenato con && per simulare comandi composti.
		fc.option(fc.constantFrom('npm run build', 'echo ok', 'git status'), { nil: undefined }),
	)
	.map(([prefix, args, leading]) => {
		const dangerous = [prefix, ...args].join(' ');
		return leading ? `${leading} && ${dangerous}` : dangerous;
	});

// --- Property 13: in supervised ogni azione richiede approvazione (Req. 5.2) -----------------
test('Property 13: in supervised ogni azione richiede approvazione', () => {
	fc.assert(
		fc.property(arbActionRequest, req => {
			const decision = decideAction('supervised', req);
			assert.strictEqual(
				decision.requiresApproval, true,
				`in supervised requiresApproval deve essere true per ${JSON.stringify(req)}`,
			);
		}),
		{ numRuns: RUNS },
	);
});

// --- Property 14: in autopilot le azioni non distruttive non richiedono approvazione (Req. 5.3) ---
test('Property 14: in autopilot le azioni non distruttive non richiedono approvazione', () => {
	fc.assert(
		fc.property(arbNonDestructiveRequest, req => {
			// Vincolo: per i comandi shell la proprietà vale solo se non sono distruttivi.
			if (req.kind === 'shell_command') {
				fc.pre(!isDestructiveCommand(req.command ?? ''));
			}
			const decision = decideAction('autopilot', req);
			assert.strictEqual(
				decision.requiresApproval, false,
				`in autopilot un'azione non distruttiva non deve richiedere approvazione: ${JSON.stringify(req)}`,
			);
		}),
		{ numRuns: RUNS },
	);
});

// --- Property 15: in autopilot una modifica a file richiede un checkpoint (Req. 5.4) ---------
test('Property 15: in autopilot una modifica a file richiede un checkpoint', () => {
	fc.assert(
		fc.property(arbFileEdit, req => {
			const decision = decideAction('autopilot', req);
			assert.strictEqual(
				decision.needsCheckpoint, true,
				`in autopilot una modifica a file deve richiedere un checkpoint: ${JSON.stringify(req)}`,
			);
		}),
		{ numRuns: RUNS },
	);
});

// --- Property 16: i comandi distruttivi richiedono approvazione anche in autopilot (Req. 5.7) ---
// La proprietà è un'IMPLICAZIONE quantificata sui comandi per cui `isDestructiveCommand`
// è true: per QUESTI, in autopilot, `requiresApproval` deve essere true. La completezza
// della classificazione (quali comandi siano distruttivi) NON fa parte di questa proprietà,
// quindi i comandi non classificati come distruttivi sono fuori dal dominio (vacuamente veri).
// Generiamo prefissi noti come distruttivi (più stringhe arbitrarie) e verifichiamo
// l'implicazione solo quando `isDestructiveCommand` conferma la natura distruttiva.
test('Property 16: i comandi distruttivi richiedono approvazione anche in autopilot', () => {
	fc.assert(
		fc.property(fc.oneof(arbDestructiveCommand, fc.string()), command => {
			if (!isDestructiveCommand(command)) {
				return; // fuori dal dominio della proprietà
			}
			const decision = decideAction('autopilot', { kind: 'shell_command', command });
			assert.strictEqual(
				decision.requiresApproval, true,
				`in autopilot un comando distruttivo deve richiedere approvazione: ${command}`,
			);
		}),
		{ numRuns: RUNS },
	);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
}
