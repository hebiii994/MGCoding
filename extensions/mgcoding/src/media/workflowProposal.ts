/*---------------------------------------------------------------------------------------------
 *  MGCoding - Orchestratore: proposta e raccomandazione di workflow (Req. 4).
 *  Logica PURA (nessuna dipendenza da vscode/fetch): dato un elenco di workflow disponibili
 *  localmente con le rispettive capacità (i tipi di generazione che supportano) e un tipo
 *  richiesto, propone un workflow compatibile; inoltre elenca i modelli e i nodi richiesti da
 *  un workflow riusando `referencedModels` (modelRefs) e `usedClassTypes` (nodeRefs).
 *  Vedi design "Components and Interfaces" e le Property 10 e 11.
 *--------------------------------------------------------------------------------------------*/

import { GenKind } from './genTypes';
import { ApiWorkflow } from './workflowGraph';
import { ModelRef, referencedModels } from './modelRefs';
import { usedClassTypes } from './nodeRefs';

/**
 * Una voce di workflow disponibile localmente: un nome identificativo, l'insieme dei tipi di
 * generazione che il workflow è in grado di produrre e il workflow stesso in formato API.
 */
export interface LocalWorkflow {
	/** Nome identificativo del workflow (file/etichetta). */
	name: string;
	/** Tipi di generazione supportati dal workflow (`image`/`t2v`/`i2v`). */
	kinds: GenKind[];
	/** Il workflow in formato API. */
	workflow: ApiWorkflow;
}

/**
 * Dipendenze richieste da un workflow: i modelli referenziati (incl. GGUF) e i nodi
 * (`class_type`) usati. Coincidono esattamente con `referencedModels`/`usedClassTypes`.
 */
export interface WorkflowDependencies {
	models: ModelRef[];
	nodes: string[];
}

/**
 * Propone un workflow locale compatibile con il tipo di generazione richiesto (Req. 4.1).
 *
 * Scorre l'elenco nell'ordine fornito e restituisce il **primo** workflow che dichiara di
 * supportare `kind` tra le sue `kinds`. Se nessun workflow supporta il tipo richiesto,
 * restituisce `undefined` (nessuna proposta). Funzione pura: non muta l'input.
 *
 * Garantisce la Property 10: se viene proposto un workflow allora quel workflow supporta il
 * tipo richiesto; se nessuno lo supporta, non viene proposto alcun workflow.
 */
export function proposeWorkflow(local: readonly LocalWorkflow[], kind: GenKind): LocalWorkflow | undefined {
	return local.find(w => w.kinds.includes(kind));
}

/**
 * Elenca le dipendenze richieste da un workflow (Req. 4.3): i modelli referenziati tramite
 * `referencedModels` e i nodi usati tramite `usedClassTypes`. Funzione pura.
 *
 * Garantisce la Property 11: l'insieme di modelli e nodi indicati come richiesti coincide
 * con `referencedModels` e `usedClassTypes` del workflow.
 */
export function workflowDependencies(wf: ApiWorkflow): WorkflowDependencies {
	return {
		models: referencedModels(wf),
		nodes: usedClassTypes(wf)
	};
}
