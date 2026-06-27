/*---------------------------------------------------------------------------------------------
 *  MGCoding - Context_Manager (nucleo puro)
 *
 *  Nucleo puro per il budgeting dei token: stima dei token, derivazione di num_ctx
 *  e calcolo dello spazio disponibile per la cronologia. Nessuna dipendenza da
 *  `vscode`, `fetch` o filesystem: i valori di configurazione arrivano come parametri.
 *  La riduzione/riassunto della cronologia è implementata nel task 2.3.
 *--------------------------------------------------------------------------------------------*/

import type { ChatMessage } from './types';

/** num_ctx di default quando la finestra del modello non è determinabile (Req. 1.4). */
export const DEFAULT_NUM_CTX = 8192;

/** Riserva minima per la risposta del modello (Req. 4.2). */
export const MIN_RESPONSE_RESERVE = 1024;

/**
 * Stima dei token di un testo (euristica deterministica ~4 char/token).
 * Restituisce sempre un intero non negativo.
 */
export function estimateTokens(text: string): number {
	if (!text) {
		return 0;
	}
	// Euristica: circa 4 caratteri per token, arrotondata per eccesso.
	return Math.ceil(text.length / 4);
}

/**
 * Stima dei token di un elenco di messaggi: somma del ruolo, del contenuto e di
 * un piccolo overhead per messaggio (delimitatori di ruolo/struttura).
 */
export function estimateMessagesTokens(messages: ChatMessage[]): number {
	let total = 0;
	for (const m of messages) {
		// Overhead per messaggio + token del ruolo + token del contenuto.
		total += 3 + estimateTokens(m.role) + estimateTokens(m.content);
	}
	return total;
}

export interface ContextBudgetInput {
	/** Finestra di contesto massima del modello, se nota (da /api/show o tabella). */
	modelMaxCtx?: number;
	/** Override esplicito mgcoding.ollama.numCtx (intero positivo) se impostato. */
	configNumCtx?: number;
	/** Token del system prompt già composto. */
	systemTokens: number;
	/** Token delle definizioni dei tool esposti. */
	toolTokens: number;
	/** Riserva minima per la risposta del modello (>= 1024). */
	responseReserve: number;
}

export interface ContextBudget {
	/** num_ctx effettivo da inviare a Ollama (intero positivo). */
	numCtx: number;
	/** Spazio disponibile per la cronologia = numCtx - system - tools - reserve. */
	historyBudget: number;
}

/** Vero se il valore è un intero positivo (> 0). */
function isPositiveInt(value: number | undefined): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * Deriva num_ctx e lo spazio per la cronologia (Req. 1.2, 1.4, 4.1, 4.2).
 * Precedenza: configNumCtx (se intero positivo) > modelMaxCtx (se intero positivo)
 * > DEFAULT_NUM_CTX. La riserva risposta è alzata almeno a MIN_RESPONSE_RESERVE.
 */
export function computeBudget(input: ContextBudgetInput): ContextBudget {
	// Precedenza nella derivazione di num_ctx (Req. 1.2, 1.3, 1.4).
	let numCtx: number;
	if (isPositiveInt(input.configNumCtx)) {
		numCtx = input.configNumCtx;
	} else if (isPositiveInt(input.modelMaxCtx)) {
		numCtx = input.modelMaxCtx;
	} else {
		numCtx = DEFAULT_NUM_CTX;
	}

	// La riserva per la risposta non scende mai sotto il minimo (Req. 4.2).
	const reserve = Math.max(input.responseReserve, MIN_RESPONSE_RESERVE);

	// I token di system e tool non possono essere negativi.
	const systemTokens = Math.max(0, input.systemTokens);
	const toolTokens = Math.max(0, input.toolTokens);

	// Spazio per la cronologia: ciò che resta dopo system, tool e riserva risposta.
	// Può essere negativo se system+tool+reserve eccedono numCtx; in tal caso il
	// chiamante saprà che non c'è spazio per la cronologia.
	const historyBudget = numCtx - systemTokens - toolTokens - reserve;

	return { numCtx, historyBudget };
}

// --- Riduzione della cronologia consapevole dei token (Req. 1.5, 4.3, 4.4, 4.5, 4.6) ---

/** Numero di risultati tool recenti mantenuti integri di default (Req. 4.3). */
export const DEFAULT_KEEP_RECENT = 4;

/** Lunghezza massima del corpo di un risultato tool quando si tronca senza riassumere (Req. 4.6). */
export const TRUNCATE_MAX_CHARS = 700;

/** Avviso di troncamento (NON è un marcatore di riassunto sintetizzato). */
export const TRUNCATE_NOTICE = '\n… [risultato più vecchio troncato per non saturare il contesto]';

/** Prefisso del marcatore di riassunto sintetizzato (usato solo con summarize=true). */
export const SUMMARY_PREFIX = '[Riassunto tool]';

/**
 * Riconosce un messaggio che rappresenta il risultato di un tool/comando: è un
 * messaggio dell'utente il cui contenuto inizia con "Risultato del tool|comando ...",
 * coerentemente con come l'Agent_Loop inserisce i risultati nella cronologia.
 */
const TOOL_RESULT_RE = /^Risultato del (?:tool|comando)\b/;

function isToolResult(m: ChatMessage): boolean {
	return m.role === 'user' && TOOL_RESULT_RE.test(m.content);
}

/** Estrae il nome del tool dall'intestazione "Risultato del tool <nome> ...". */
function extractToolName(content: string): string | undefined {
	const m = /^Risultato del (?:tool|comando)\s+(\S+)/.exec(content);
	return m ? m[1] : undefined;
}

/**
 * Determina l'esito (OK/ERRORE) dal risultato: privilegia un marcatore esplicito
 * nell'intestazione; in assenza, applica la stessa euristica dell'Agent_Loop
 * (un risultato che parla di "errore" è ERRORE, altrimenti OK).
 */
function extractOutcome(content: string): 'OK' | 'ERRORE' {
	const marker = /\b(ERRORE|OK)\b/.exec(content);
	if (marker) {
		return marker[1] as 'OK' | 'ERRORE';
	}
	return /errore/i.test(content) ? 'ERRORE' : 'OK';
}

/**
 * Riassume un risultato di tool conservandone identità ed esito (Req. 4.4):
 * il testo prodotto contiene sempre il nome del tool e il marcatore OK/ERRORE.
 */
function summarizeToolResult(content: string): string {
	const tool = extractToolName(content) ?? 'tool';
	const outcome = extractOutcome(content);
	return `${SUMMARY_PREFIX} ${tool} — ${outcome} (dettagli rimossi per rientrare nel contesto)`;
}

/**
 * Tronca un risultato di tool senza generare alcun riassunto sintetizzato (Req. 4.6):
 * se il contenuto supera TRUNCATE_MAX_CHARS lo accorcia aggiungendo solo l'avviso di
 * troncamento; non aggiunge mai SUMMARY_PREFIX.
 */
function truncateToolResult(content: string): string {
	if (content.length <= TRUNCATE_MAX_CHARS) {
		return content;
	}
	return content.slice(0, TRUNCATE_MAX_CHARS) + TRUNCATE_NOTICE;
}

/** Indice dell'ultimo messaggio con il ruolo indicato, o -1 se assente. */
function lastIndexOfRole(messages: ChatMessage[], role: ChatMessage['role']): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === role) {
			return i;
		}
	}
	return -1;
}

export interface ReductionInput {
	messages: ChatMessage[];
	/** Spazio (in token) disponibile per la cronologia. */
	historyBudget: number;
	/** Se false, tronca i risultati vecchi senza riassumere (Req. 4.6). */
	summarize: boolean;
	/** Numero di risultati tool recenti da mantenere integri (Req. 4.3). */
	keepRecent: number; // default 4
}

export interface ReductionResult {
	messages: ChatMessage[];
	/** True se, esaurite le riduzioni, la richiesta resta oltre il budget (Req. 4.5). */
	stillOverBudget: boolean;
}

/**
 * Riduce la cronologia fino a rientrare in historyBudget (Req. 1.5, 4.3-4.5):
 *  1) riassume/tronca i risultati tool più vecchi (mantiene integri i keepRecent
 *     più recenti), conservando identità del tool ed esito (OK/ERRORE) nel riassunto
 *     (Req. 4.4); con summarize=false applica solo il troncamento (Req. 4.6);
 *  2) se ancora oltre budget, rimuove i turni più vecchi rimovibili;
 *  3) procede comunque (stillOverBudget=true) se nulla è più rimovibile (Req. 4.5).
 * L'ultimo messaggio utente e i keepRecent risultati tool più recenti non sono mai rimossi.
 * La funzione non muta gli oggetti del chiamante (opera su copie superficiali).
 */
export function reduceHistory(input: ReductionInput): ReductionResult {
	// keepRecent valido = intero non negativo; altrimenti il default.
	const keepRecent = Number.isInteger(input.keepRecent) && input.keepRecent >= 0
		? input.keepRecent
		: DEFAULT_KEEP_RECENT;

	// Copia superficiale: non mutiamo i messaggi del chiamante.
	const work: ChatMessage[] = input.messages.map(m => ({ ...m }));

	// Indici dei risultati di tool nella cronologia.
	const toolIdx: number[] = [];
	for (let i = 0; i < work.length; i++) {
		if (isToolResult(work[i])) {
			toolIdx.push(i);
		}
	}

	// I keepRecent risultati tool più recenti restano integri byte-a-byte (Req. 4.3).
	const keepFrom = Math.max(0, toolIdx.length - keepRecent);
	const recentProtected = new Set<number>(toolIdx.slice(keepFrom));

	// Fase 1: riassunto/troncamento dei risultati tool più vecchi (non protetti).
	for (const i of toolIdx) {
		if (recentProtected.has(i)) {
			continue;
		}
		work[i].content = input.summarize
			? summarizeToolResult(work[i].content)
			: truncateToolResult(work[i].content);
	}

	// Insieme dei messaggi protetti (per riferimento) dalla rimozione:
	//  - ultimo messaggio utente (mai rimosso, Req. 4.5);
	//  - keepRecent risultati tool più recenti (integri, Req. 4.3).
	const protectedRefs = new Set<ChatMessage>();
	const lastUserIdx = lastIndexOfRole(work, 'user');
	if (lastUserIdx >= 0) {
		protectedRefs.add(work[lastUserIdx]);
	}
	for (const i of recentProtected) {
		protectedRefs.add(work[i]);
	}

	// Fase 2: rimozione dei turni più vecchi rimovibili finché si rientra nel budget.
	// Termina sempre: a ogni iterazione si rimuove un messaggio oppure si esce (break).
	while (estimateMessagesTokens(work) > input.historyBudget) {
		const removeAt = work.findIndex(m => !protectedRefs.has(m));
		if (removeAt < 0) {
			break; // nulla di più rimovibile: si procede comunque (Req. 4.5)
		}
		work.splice(removeAt, 1);
	}

	const stillOverBudget = estimateMessagesTokens(work) > input.historyBudget;
	return { messages: work, stillOverBudget };
}
