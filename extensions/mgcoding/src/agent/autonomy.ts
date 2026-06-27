/*---------------------------------------------------------------------------------------------
 *  MGCoding - Autonomy_Controller (nucleo puro)
 *
 *  Logica PURA di decisione delle azioni dell'Agent_Loop: nessuna dipendenza da
 *  `vscode`, dal filesystem o da `child_process`. Il guscio I/O (classe
 *  `AutonomyController`, con checkpoint/revert) è implementato in un task successivo.
 *
 *  Convenzioni: identificatori di codice in inglese, prosa/commenti in italiano.
 *  Vincolo Windows-first (`win32`, shell `cmd`).
 *--------------------------------------------------------------------------------------------*/

/** Modalità di autonomia attiva (Req. 5.1). */
export type AutonomyMode = 'autopilot' | 'supervised';

/** Azione che l'Agent_Loop intende eseguire e che va sottoposta al gating. */
export interface ActionRequest {
	kind: 'file_edit' | 'shell_command';
	/** Comando shell (per kind='shell_command'). */
	command?: string;
	/** Percorso file (per kind='file_edit'). */
	path?: string;
}

/** Esito della decisione di gating per una azione. */
export interface ActionDecision {
	/** True se serve l'approvazione esplicita dell'utente. */
	requiresApproval: boolean;
	/** True se va creato un checkpoint reversibile prima di agire. */
	needsCheckpoint: boolean;
	/** Motivazione leggibile della decisione (in italiano). */
	reason: string;
}

/**
 * Pattern di comandi shell considerati distruttivi (Windows-first).
 * Ogni voce è valutata sul singolo segmento del comando, già normalizzato a
 * minuscolo e con spazi compattati. I confini di parola (`\b`) e gli ancoraggi
 * di inizio segmento (`^`) evitano falsi positivi su nomi più lunghi
 * (es. `format` non deve scattare per `formatter`).
 */
const DESTRUCTIVE_PATTERNS: readonly RegExp[] = [
	// --- Cancellazione file/cartelle su Windows (cmd) ---
	/^del\b/,                       // del <file>
	/^erase\b/,                     // erase <file> (alias di del)
	/^rd\b/,                        // rd <dir>
	/^rmdir\b/,                     // rmdir <dir>
	// --- Cancellazione in stile Unix (git-bash / WSL / rm portati) ---
	/\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/, // rm -rf / rm -fr (flag combinati)
	/\brm\s+-[a-z]*r\b/,            // rm -r / rm -R (ricorsivo)
	/\brm\s+--recursive\b/,         // rm --recursive
	// --- Formattazione/partizionamento dischi ---
	/^format\b/,                    // format <drive>
	/^diskpart\b/,                  // diskpart
	/\bmkfs(\.[a-z0-9]+)?\b/,       // mkfs / mkfs.ext4 ...
	/^dd\b/,                        // dd if=... of=...
	// --- PowerShell distruttivo ---
	/\bremove-item\b.*\b-recurse\b/, // Remove-Item ... -Recurse
	/\bremove-item\b.*\b-force\b/,   // Remove-Item ... -Force
	/\bri\b.*\b-recurse\b/,          // alias 'ri' di Remove-Item
	/\bclear-content\b/,             // Clear-Content (svuota un file)
	// --- Git distruttivo ---
	/\bgit\s+reset\s+--hard\b/,     // git reset --hard
	/\bgit\s+clean\s+-[a-z]*f/,     // git clean -f / -fd / -fdx
	/\bgit\s+checkout\s+--\s/,      // git checkout -- <path> (scarta modifiche)
	/\bgit\s+checkout\s+-[a-z]*f/,  // git checkout -f (force)
	/\bgit\s+push\s+.*--force\b/,   // git push --force
	/\bgit\s+push\s+.*-f\b/,        // git push -f
	/\bgit\s+branch\s+-d\b/,        // git branch -D (elimina forzato)
	// --- Troncamento/azzeramento file ---
	/\btruncate\b/,                 // truncate -s 0 <file>
];

/**
 * Divide un comando composto nei suoi segmenti eseguibili, separando sugli
 * operatori di concatenazione di shell (`&&`, `||`, `|`, `;`, `&`). In questo
 * modo un comando distruttivo presente in qualsiasi punto della catena viene
 * rilevato (es. `npm run build && rmdir /s out`).
 */
function splitSegments(command: string): string[] {
	return command
		.split(/&&|\|\||[;|&]/)
		.map(s => s.trim())
		.filter(s => s.length > 0);
}

/**
 * Classifica un comando shell come distruttivo (Req. 5.7). Windows-first:
 * riconosce del/rd/rmdir/format/rm -rf/git reset --hard/git clean -fd/ecc.
 * La valutazione avviene per singolo segmento, così la presenza di un comando
 * distruttivo in una catena rende distruttiva l'intera richiesta.
 */
export function isDestructiveCommand(command: string): boolean {
	if (!command) {
		return false;
	}
	// Normalizza: minuscolo e spazi compattati per un matching stabile.
	const normalized = command.toLowerCase().replace(/\s+/g, ' ').trim();
	if (!normalized) {
		return false;
	}
	const segments = splitSegments(normalized);
	const candidates = segments.length > 0 ? segments : [normalized];
	return candidates.some(seg => DESTRUCTIVE_PATTERNS.some(re => re.test(seg)));
}

/**
 * Decide il gating di un'azione (Req. 5.2-5.4, 5.7):
 *  - supervised → requiresApproval=true per ogni file_edit/shell_command;
 *  - autopilot → requiresApproval=false, MA true se comando distruttivo (5.7);
 *  - autopilot + file_edit → needsCheckpoint=true (5.4).
 */
export function decideAction(mode: AutonomyMode, req: ActionRequest): ActionDecision {
	// In supervised ogni azione a rischio richiede l'approvazione dell'utente (Req. 5.2).
	if (mode === 'supervised') {
		return {
			requiresApproval: true,
			needsCheckpoint: false,
			reason: 'Modalità supervised: approvazione richiesta prima di ogni modifica a file o comando di shell.',
		};
	}

	// Da qui in poi siamo in autopilot.
	if (req.kind === 'shell_command') {
		// I comandi distruttivi richiedono comunque approvazione (Req. 5.7).
		if (isDestructiveCommand(req.command ?? '')) {
			return {
				requiresApproval: true,
				needsCheckpoint: false,
				reason: 'Modalità autopilot: comando classificato come distruttivo, approvazione richiesta.',
			};
		}
		// Comando non distruttivo in autopilot: nessuna approvazione (Req. 5.3).
		return {
			requiresApproval: false,
			needsCheckpoint: false,
			reason: 'Modalità autopilot: comando non distruttivo eseguito senza approvazione.',
		};
	}

	// req.kind === 'file_edit' in autopilot: nessuna approvazione (Req. 5.3),
	// ma è richiesto un checkpoint reversibile prima della modifica (Req. 5.4).
	return {
		requiresApproval: false,
		needsCheckpoint: true,
		reason: 'Modalità autopilot: modifica a file applicata senza approvazione previa creazione di un checkpoint.',
	};
}

/*---------------------------------------------------------------------------------------------
 *  AutonomyController (guscio I/O)
 *
 *  Applica la Autonomy_Mode alle azioni dell'Agent_Loop appoggiandosi al nucleo
 *  puro `decideAction`. Si occupa dell'I/O che il nucleo non può toccare:
 *   - lettura della modalità dal Config_Key `mgcoding.autonomyMode` (Req. 5.6);
 *   - creazione del checkpoint reversibile prima delle modifiche in autopilot,
 *     tramite `beginCheckpoint`/`recordOriginal` di `edit/checkpoint.ts` (Req. 5.4);
 *   - ripristino dei file allo stato del checkpoint via `revertCheckpoint` (Req. 5.5);
 *   - richiesta di conferma all'utente quando il gating la impone (Req. 5.2, 5.7).
 *
 *  Mappatura sulle config esistenti (retrocompatibilità):
 *   - `supervised` ⇔ conferma richiesta (come l'attuale `diffApproval` / conferma `run_command`);
 *   - `autopilot`  ⇔ `autoApprove` (esecuzione senza conferma).
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { beginCheckpoint, recordOriginal, revertCheckpoint } from '../edit/checkpoint';
import { confirmWrite } from '../edit/diffApproval';

/** Namespace di configurazione dell'estensione. */
const CONFIG_NS = 'mgcoding';

export class AutonomyController {
	/**
	 * Risolve la Autonomy_Mode effettiva (Req. 5.1, 5.6).
	 *
	 * Precedenza, per preservare il comportamento esistente:
	 *  1) l'interruttore legacy `autoApprove`, se attivo, eleva ad `autopilot`
	 *     (è il toggle già esposto nella status bar / chat);
	 *  2) altrimenti vale il Config_Key esplicito `mgcoding.autonomyMode`
	 *     (default `supervised`).
	 */
	getMode(): AutonomyMode {
		const cfg = vscode.workspace.getConfiguration(CONFIG_NS);
		if (cfg.get<boolean>('autoApprove', false)) {
			return 'autopilot';
		}
		const explicit = cfg.get<string>('autonomyMode', 'supervised');
		return explicit === 'autopilot' ? 'autopilot' : 'supervised';
	}

	/**
	 * Decide il gating di un'azione delegando al nucleo puro `decideAction`,
	 * usando la modalità corrente letta dalla configurazione (Req. 5.2-5.4, 5.7).
	 */
	decide(req: ActionRequest): ActionDecision {
		return decideAction(this.getMode(), req);
	}

	/**
	 * Apre un nuovo checkpoint per il gruppo di modifiche imminente (Req. 5.4).
	 * Da invocare all'inizio di un'esecuzione/turno che potrà modificare file,
	 * così che `revert()` possa successivamente ripristinarne lo stato.
	 */
	startCheckpoint(): void {
		beginCheckpoint();
	}

	/**
	 * Da chiamare PRIMA di applicare una modifica a un file (Req. 5.4).
	 * In autopilot registra il contenuto originale nel checkpoint corrente,
	 * rendendo la modifica reversibile. Ritorna la decisione di gating così che
	 * il chiamante sappia se serve anche l'approvazione dell'utente.
	 */
	async beforeFileEdit(uri: vscode.Uri): Promise<ActionDecision> {
		const decision = this.decide({ kind: 'file_edit', path: uri.fsPath });
		if (decision.needsCheckpoint) {
			await recordOriginal(uri);
		}
		return decision;
	}

	/**
	 * Ripristina i file allo stato del checkpoint corrente (Req. 5.5).
	 * Ritorna il numero di file ripristinati.
	 */
	async revert(): Promise<number> {
		return revertCheckpoint();
	}

	/**
	 * Conferma di una modifica a file quando il gating la richiede (Req. 5.2).
	 * Riusa l'anteprima diff esistente (`confirmWrite`). Ritorna true se l'utente
	 * approva oppure se la modalità corrente non richiede approvazione.
	 */
	async confirmFileEdit(relPath: string, oldContent: string, newContent: string): Promise<boolean> {
		const decision = this.decide({ kind: 'file_edit', path: relPath });
		if (!decision.requiresApproval) {
			return true;
		}
		return confirmWrite(relPath, oldContent, newContent);
	}

	/**
	 * Conferma dell'esecuzione di un comando di shell quando il gating la
	 * richiede (Req. 5.2, 5.7). In supervised serve sempre; in autopilot solo
	 * per i comandi distruttivi. Ritorna true se approvato o non necessario.
	 */
	async confirmCommand(command: string): Promise<boolean> {
		const decision = this.decide({ kind: 'shell_command', command });
		if (!decision.requiresApproval) {
			return true;
		}
		const choice = await vscode.window.showWarningMessage(
			`Eseguire il comando di shell?\n\n${command}`,
			{ modal: true },
			'Esegui'
		);
		return choice === 'Esegui';
	}
}
