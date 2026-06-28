/*---------------------------------------------------------------------------------------------
 *  MGCoding - tipi di dominio dell'autodiagnostica assistita (Self_Healing, Livello 1).
 *  Tipi puri condivisi dai nuclei (`issues`, `verification`, `guard`, `budget`) e dal guscio.
 *--------------------------------------------------------------------------------------------*/

/** Categoria di un problema rilevato. */
export type IssueCategory = 'diagnostica' | 'build' | 'test' | 'runtime';

/** Un singolo problema rilevato nel progetto. */
export interface Issue {
	category: IssueCategory;
	/** Percorso relativo alla radice del workspace, se noto. */
	file?: string;
	/** Riga 1-based, se nota. */
	line?: number;
	message: string;
	/** Origine: es. 'ts', 'eslint', 'vitest', 'tsc', 'run_command'. */
	source: string;
}

/** Gruppo di Issue dello stesso file (`''` per le Issue senza file). */
export interface FileGroup {
	file: string;
	issues: Issue[];
}

/** Insieme ordinato e deduplicato delle Issue presentato all'utente. */
export interface IssueReport {
	issues: Issue[];
	byFile: FileGroup[];
	total: number;
}

/** Esito della classificazione di una proposta del modello. */
export type ProposalStatus = 'proposed' | 'unresolved';

/** Misura di errori/test usata come Baseline e per il confronto post-applicazione. */
export interface VerificationSnapshot {
	/** Errori di build/typecheck + diagnostiche di errore. */
	errorCount: number;
	/** Test rossi rilevati. */
	failingTests: number;
	/** Numero totale di test rilevati (per il guard anti-imbroglio). */
	totalTests: number;
}

/** Verdetto del confronto tra uno snapshot e la Baseline. */
export type RegressionVerdict = 'ok' | 'regression' | 'no-change';

/** Una modifica proposta dal modello per risolvere una Issue. */
export interface FixProposal {
	issue: Issue;
	diff: string;
	explanation: string;
	/** Percorsi modificati dal diff (relativi alla radice del workspace). */
	touchedPaths: string[];
}

/** Configurazione del Reward_Hacking_Guard. */
export interface GuardConfig {
	/** Glob dei percorsi protetti: file di test e configurazioni di build/test. */
	protectedGlobs: string[];
}

/** Esito di un guardrail: ok, oppure rifiuto con motivo. */
export type GuardVerdict = { ok: true } | { ok: false; reason: string };

/** Stato dei tentativi di correzione su una singola Issue. */
export interface AttemptState {
	attempts: number;
	maxAttempts: number;
	errorsBefore: number;
	errorsAfter: number;
}

/** Decisione sul proseguimento dei tentativi. */
export type AttemptDecision = 'continue' | 'stop-budget' | 'stop-no-progress';

/** Glob protetti di default (file di test e configurazioni di build/test). */
export const DEFAULT_PROTECTED_GLOBS: readonly string[] = [
	'**/*.test.*',
	'**/*.spec.*',
	'**/test/**',
	'**/tests/**',
	'**/__tests__/**',
	'**/vitest.config.*',
	'**/jest.config.*',
	'**/tsconfig*.json',
	'**/.mocharc*'
];
