/*---------------------------------------------------------------------------------------------
 *  MGCoding - Gestore_Nodi: rilevamento puro dei nodi custom richiesti da un workflow.
 *  Logica PURA (nessuna dipendenza da vscode/fetch): gli adapter di clone/installazione
 *  dipendenze restano in `comfyHelper.ts`.
 *  Vedi design "Components and Interfaces > Gestore_Modelli e Gestore_Nodi" e Req. 17.1.
 *--------------------------------------------------------------------------------------------*/

import { ApiWorkflow } from './workflowGraph';

/**
 * Elenco delle `class_type` usate dal workflow, senza duplicati e nell'ordine di prima
 * apparizione. Base per rilevare i nodi non registrati in ComfyUI (Req. 17.1).
 */
export function usedClassTypes(wf: ApiWorkflow): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const node of Object.values(wf)) {
		const classType = node?.class_type;
		if (typeof classType === 'string' && !seen.has(classType)) {
			seen.add(classType);
			result.push(classType);
		}
	}
	return result;
}

/**
 * Differenza insiemistica: le `class_type` usate (`used`) che non risultano registrate
 * in ComfyUI (`known`). Preserva l'ordine di `used` e rimuove eventuali duplicati (Req. 17.1).
 */
export function missingNodes(used: string[], known: Set<string>): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const classType of used) {
		if (!known.has(classType) && !seen.has(classType)) {
			seen.add(classType);
			result.push(classType);
		}
	}
	return result;
}
