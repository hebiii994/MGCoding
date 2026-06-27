/*---------------------------------------------------------------------------------------------
 *  MGCoding - Prompt_Composer (nucleo puro)
 *
 *  Seleziona la variante del system prompt e il sottoinsieme di tool da esporre al modello
 *  in base alla Capability_Tier e al Context_Budget effettivo. Modulo PURO: nessuna dipendenza
 *  da `vscode`, da `fetch` o dal filesystem. Il guscio I/O (in `agent/agent.ts`) usa l'esito di
 *  `compose` per scegliere il testo del prompt e filtrare le definizioni dei tool.
 *--------------------------------------------------------------------------------------------*/

import { CapabilityTier } from '../llm/capability';

/**
 * Soglia di Context_Budget (in token) al di sotto o pari alla quale si usa la variante
 * compatta del prompt e il sottoinsieme ridotto di tool (Req. 7.2, 7.3).
 */
export const COMPACT_BUDGET_THRESHOLD = 8192;

export interface PromptComposition {
	/** Variante del system prompt scelta in base al budget. */
	variant: 'compact' | 'full';
	/** Nomi dei tool da esporre al modello in questo turno. */
	exposedTools: string[];
}

/**
 * Sottoinsieme ridotto di tool per le finestre di contesto piccole (Req. 7.3).
 * Contiene solo i tool essenziali al ciclo agentico di base (lettura/scrittura/modifica file,
 * esplorazione, ricerca ed esecuzione comandi), così da non consumare il contesto utile con
 * definizioni di tool secondari.
 */
export const SMALL_WINDOW_TOOLS: readonly string[] = [
	'read_file',
	'write_file',
	'apply_patch',
	'list_dir',
	'find_files',
	'search_text',
	'run_command',
];

/**
 * Sceglie variante e sottoinsieme di tool (Req. 7.1-7.5):
 *  - contextBudget <= COMPACT_BUDGET_THRESHOLD → variante 'compact' ed espone esclusivamente
 *    l'intersezione tra SMALL_WINDOW_TOOLS e i tool effettivamente disponibili;
 *  - altrimenti → variante 'full' ed espone tutti i tool disponibili.
 * La scelta dipende dal Context_Budget effettivo, non dal nome del modello (Req. 7.4).
 * Il parametro `tier` è accettato per la firma prevista dal design ma non altera la decisione,
 * che resta governata dal solo budget.
 */
export function compose(
	tier: CapabilityTier,
	contextBudget: number,
	allToolNames: readonly string[]
): PromptComposition {
	void tier; // la decisione dipende dal budget, non dal tier (Req. 7.4)
	if (contextBudget <= COMPACT_BUDGET_THRESHOLD) {
		// Variante compatta: espone solo il sottoinsieme ridotto effettivamente disponibile
		// (intersezione SMALL_WINDOW_TOOLS ∩ allToolNames), preservando l'ordine del sottoinsieme.
		const available = new Set(allToolNames);
		const exposedTools = SMALL_WINDOW_TOOLS.filter(name => available.has(name));
		return { variant: 'compact', exposedTools };
	}
	// Variante completa: tutti i tool disponibili (Req. 7.5).
	return { variant: 'full', exposedTools: [...allToolNames] };
}
