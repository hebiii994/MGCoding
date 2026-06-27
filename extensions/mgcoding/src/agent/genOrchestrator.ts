/*---------------------------------------------------------------------------------------------
 *  MGCoding - Orchestratore del ciclo agentico di generazione.
 *
 *  Questo modulo coordina la generazione end-to-end: classifica la richiesta, produce un piano
 *  ordinato di passi, lo esegue e riporta l'esito (vedi design "Components and Interfaces >
 *  Orchestratore").
 *
 *  ARCHITETTURA: la logica di orchestrazione (`classify`, `plan`, `run`) è separata dagli
 *  adapter di I/O tramite l'interfaccia `OrchestratorAdapters` (iniezione delle dipendenze).
 *  Questo mantiene:
 *   - `plan` come LOGICA PURA (nessuna dipendenza da vscode/fetch), testabile sotto Node;
 *   - il modulo IMPORTABILE senza side effect vscode al caricamento — gli adapter reali che
 *     dipendono da `vscode`/`fetch` (ComfyUI, registry, generazione) sono caricati on-demand
 *     via `import()` dinamico nella factory `createDefaultAdapters`, mai al top-level;
 *   - l'orchestrazione TESTABILE con adapter mockati (task 18.4).
 *
 *  `AgentCallbacks`, `RouteContext` e `ProviderRegistry` sono importati come SOLO TIPO
 *  (erasure a compile time): nessun `require('vscode')` viene innescato al caricamento.
 *
 *  STATO (task 18.3): integrate le politiche LOCAL-FIRST / OFFLINE / PRIVACY DEI PROMPT nel
 *  flusso, oltre al percorso felice (18.1) e al ciclo di recupero errori (18.2):
 *   - LOCAL-FIRST (Req. 20.1): `routeContextFor` legge la preferenza utente `localFirst`
 *     (default `true`) tramite il seam `adapters.getPreferences`, invece di forzarla; la
 *     selezione provider/backend privilegia coerentemente i locali.
 *   - OFFLINE (Req. 20.2, 20.3): la generazione con risorse GIÀ presenti localmente resta
 *     possibile senza rete; le operazioni che RICHIEDONO rete (download modelli / installazione
 *     nodi mancanti) vengono SEGNALATE all'utente quando la connessione è assente
 *     (seam `adapters.isOnline`).
 *   - PRIVACY (Req. 21.1, 21.2, 21.3): il prompt è inoltrato SOLO al provider/backend selezionato
 *     per la richiesta; qualsiasi telemetria emessa passa per `buildTelemetryEvent`, che rimuove
 *     il testo dei prompt (seam `adapters.emitTelemetry`).
 *  _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 2.4, 3.2, 18.2, 18.3, 18.4, 18.5, 18.6, 19.2, 20.1, 20.2, 20.3, 21.1, 21.2, 21.3, 23.1, 23.2, 23.3_
 *--------------------------------------------------------------------------------------------*/

import type { AgentCallbacks } from './agentLoop';
import type { RouteContext, ProviderRegistry } from '../llm/registry';
import { GenKind, GenOutcome, GenRequest, GeneratedItem, PlanStepGen } from '../media/genTypes';
import { classify as classifyRequest } from '../media/requestClassifier';
import { ApiWorkflow, LogicalParams } from '../media/workflowGraph';
import { buildMapping, unmappedParams } from '../media/workflowMapping';
import { ModelRef, missingModels, referencedModels } from '../media/modelRefs';
import { missingNodes, usedClassTypes } from '../media/nodeRefs';
import { LocalWorkflow, proposeWorkflow } from '../media/workflowProposal';
import { extensionOf, producesVideo } from '../media/outputClassifier';
import { ClassifiedError, MAX_RETRIES, RecoveryAction, classifyError, planRecovery } from '../media/errorClassifier';
import { GenParams, MemoryTier, LOW_VRAM_GB, defaultParams, reduceForTier } from '../media/vramProfile';
import { TelemetryEvent, TelemetryInput, buildTelemetryEvent } from '../media/telemetryGating';

/**
 * Ordine canonico delle fasi del piano di generazione (Req. 1.2, Property 3):
 * `select-workflow → check-deps → set-inputs → execute → report`.
 *
 * L'ordine è una costante condivisa così che `plan` produca SEMPRE le fasi in indici
 * strettamente crescenti in questa sequenza, indipendentemente dal tipo di generazione.
 */
const CANONICAL_PHASES: readonly PlanStepGen['kind'][] = [
	'select-workflow',
	'check-deps',
	'set-inputs',
	'execute',
	'report',
] as const;

/** Descrizioni in linguaggio naturale di ciascuna fase canonica del piano. */
const PHASE_DESCRIPTIONS: Record<PlanStepGen['kind'], string> = {
	'select-workflow': 'Seleziona o propone un workflow compatibile con il tipo di generazione richiesto.',
	'check-deps': 'Verifica le dipendenze del workflow (modelli e nodi custom) e ne risolve le mancanze.',
	'set-inputs': 'Mappa e imposta gli input logici (prompt, immagine iniziale, seed, durata/fps) sul workflow.',
	'execute': 'Accoda ed esegue il workflow su ComfyUI monitorando l\'avanzamento.',
	'report': 'Riconosce e salva gli output e riporta all\'utente il risultato e i passi eseguiti.',
};

/**
 * Produce il piano ordinato per un tipo di generazione.
 *
 * Garanzia (Property 3): il piano contiene le fasi `select-workflow`, `check-deps`,
 * `set-inputs`, `execute` (e `report`) con indici strettamente crescenti nell'ordine canonico,
 * per OGNI `GenKind`.
 *
 * @param _kind Il tipo di generazione (`image`/`t2v`/`i2v`). Attualmente il piano è identico
 *              per tutti i tipi; il parametro è mantenuto per estensioni future.
 * @returns Un nuovo array di `PlanStepGen` nell'ordine canonico.
 */
export function plan(_kind: GenKind): PlanStepGen[] {
	return CANONICAL_PHASES.map(kind => ({
		kind,
		description: PHASE_DESCRIPTIONS[kind],
	}));
}

/**
 * Classifica una richiesta di generazione riusando la logica PURA di `requestClassifier`.
 * Restituisce un tipo concreto (`image`/`t2v`/`i2v`) oppure `'ambiguous'` quando il tipo non
 * è determinabile dal prompt/immagine: in tal caso `run` chiede conferma all'utente (Req. 1.6).
 * _Requirements: 1.1, 1.6_
 */
export function classify(req: GenRequest): GenKind | 'ambiguous' {
	return classifyRequest(req);
}

/**
 * Contratto dell'Orchestratore del ciclo agentico di generazione.
 * Implementato da `GenOrchestrator`.
 */
export interface IOrchestrator {
	/** Classifica la richiesta. Restituisce `'ambiguous'` se il tipo non è determinabile. */
	classify(req: GenRequest): GenKind | 'ambiguous';
	/** Produce il piano ordinato per un tipo di richiesta. */
	plan(kind: GenKind): PlanStepGen[];
	/** Esegue il piano fino a completamento o primo errore non recuperabile. */
	run(req: GenRequest, cb: AgentCallbacks, signal?: AbortSignal): Promise<GenOutcome>;
}

/* -------------------------------------------------------------------------------------------
 * Adapter di I/O (seam) — punto di iniezione che disaccoppia l'orchestrazione dal mondo reale.
 * Le implementazioni reali (ComfyUI, registry LLM, motori di generazione) vivono nei rispettivi
 * moduli e sono cablate da `createDefaultAdapters`; i test (18.4) iniettano dei mock.
 * ----------------------------------------------------------------------------------------- */

/** Provider LLM selezionato dal Router_LLM (forma minimale usata dall'Orchestratore). */
export interface SelectedProvider {
	id: string;
	label: string;
}

/**
 * Preferenze dell'utente che influenzano l'orchestrazione. Attualmente espone la sola
 * preferenza LOCAL-FIRST (Req. 20.1): quando attiva, la selezione di provider/backend e
 * modelli privilegia le opzioni locali rispetto al cloud.
 */
export interface OrchestratorPreferences {
	/** Vero se l'utente preferisce backend/modelli locali ai provider cloud (default `true`). */
	localFirst: boolean;
}

/** Stato di ComfyUI ed elenchi necessari al calcolo delle dipendenze mancanti (Req. 16.1, 17.1). */
export interface ComfyAvailabilityInfo {
	/** Vero se ComfyUI è raggiungibile sull'endpoint. */
	reachable: boolean;
	/** Endpoint HTTP di ComfyUI. */
	endpoint: string;
	/** Nomi dei modelli disponibili (checkpoint, LoRA, ecc.). */
	models: Set<string>;
	/** `class_type` dei nodi registrati in ComfyUI. */
	nodes: Set<string>;
}

/** Contesto passato all'adapter di esecuzione del workflow risolto. */
export interface ExecuteContext {
	kind: GenKind;
	endpoint: string;
	/** Workflow API selezionato (il motore applica la mappatura degli input internamente). */
	workflow: ApiWorkflow;
	request: GenRequest;
	signal?: AbortSignal;
	/**
	 * Parametri di generazione a consumo di memoria ridotto, valorizzati dal Recupero_Errori al
	 * ritentativo dopo un errore di VRAM insufficiente (Req. 18.4, 19.2). Assente al primo
	 * tentativo (il motore usa i propri valori predefiniti).
	 */
	params?: GenParams;
	/** Aggiornamenti di avanzamento dal Monitor_Avanzamento (Req. 8.1). */
	onProgress?(percent: number, currentNode?: string): void;
}

/**
 * Contesto per le azioni di recupero che toccano ComfyUI (installazione nodi / download
 * modelli). Passato agli adapter dedicati così che l'orchestrazione resti testabile.
 */
export interface RecoveryContext {
	/** Endpoint HTTP di ComfyUI. */
	endpoint: string;
	/** Nome del workflow attivo (gli adapter reali ne risolvono dipendenze e cartelle). */
	workflowName: string;
	/** Nome del nodo/modello coinvolto, se estratto dal messaggio di errore. */
	subject?: string;
}

/**
 * Adapter di I/O dell'Orchestratore. Ogni metodo incapsula una dipendenza esterna così che
 * l'orchestrazione resti deterministica e testabile.
 */
export interface OrchestratorAdapters {
	/**
	 * Router_LLM: seleziona un provider raggiungibile per il compito. Restituisce `undefined`
	 * se nessun provider è configurato/raggiungibile (Req. 2.4).
	 */
	selectProvider(ctx: RouteContext): Promise<SelectedProvider | undefined>;
	/** Elenca i workflow locali disponibili con le rispettive capacità (Req. 4.1). */
	listWorkflows(): Promise<LocalWorkflow[]>;
	/** Rileva stato ed elenchi di ComfyUI per la verifica delle dipendenze (Req. 12, 16.1, 17.1). */
	comfyAvailability(): Promise<ComfyAvailabilityInfo>;
	/** Esegue il workflow risolto (immagine via `imageGen`, video via `videoGen`) (Req. 5, 11). */
	execute(ctx: ExecuteContext): Promise<GeneratedItem[]>;
	/**
	 * Recupero_Errori — installa i nodi custom mancanti per il workflow, RICHIEDENDO conferma
	 * esplicita (clona codice di terzi, Req. 18.2, 22). Restituisce `true` se l'azione è stata
	 * intrapresa (così l'Orchestratore può ritentare), `false` se non è possibile/è stata
	 * rifiutata. Opzionale: se assente, la causa "nodo mancante" non è auto-recuperabile e si
	 * applica il degrado controllato (Req. 23.2).
	 */
	installMissingNodes?(ctx: RecoveryContext): Promise<boolean>;
	/**
	 * Recupero_Errori — scarica i modelli mancanti per il workflow, RICHIEDENDO conferma
	 * esplicita (Req. 18.3, 22). Restituisce `true` se l'azione è stata intrapresa, `false`
	 * altrimenti. Opzionale: se assente, la causa "modello mancante" non è auto-recuperabile e
	 * si applica il degrado controllato (Req. 23.2).
	 */
	downloadMissingModels?(ctx: RecoveryContext): Promise<boolean>;
	/**
	 * LOCAL-FIRST (Req. 20.1) — legge le preferenze dell'utente che influenzano l'orchestrazione.
	 * Opzionale: se assente (o se l'implementazione non valorizza il campo), si assume
	 * `localFirst: true`, mantenendo il comportamento LOCAL-FIRST predefinito.
	 */
	getPreferences?(): Promise<OrchestratorPreferences>;
	/**
	 * OFFLINE (Req. 20.2, 20.3) — vero se è disponibile una connessione di rete (Internet).
	 * Opzionale: se assente si assume `true` (online), così le operazioni di rete vengono
	 * tentate come prima. Quando restituisce `false`, l'Orchestratore NON tenta operazioni che
	 * richiedono rete (download modelli / installazione nodi mancanti) e segnala all'utente che
	 * l'operazione richiede una connessione, mentre la generazione con risorse GIÀ presenti
	 * localmente resta possibile.
	 */
	isOnline?(): Promise<boolean>;
	/**
	 * PRIVACY (Req. 21.3) — sink di telemetria. Riceve eventi GIÀ sanificati dal testo dei prompt
	 * (l'Orchestratore li costruisce sempre tramite `buildTelemetryEvent`). Opzionale: se assente,
	 * nessuna telemetria viene emessa. Il sink NON deve mai ricevere il testo dei prompt.
	 */
	emitTelemetry?(event: TelemetryEvent): void;
}

/* -------------------------------------------------------------------------------------------
 * Helper PURI di supporto all'orchestrazione.
 * ----------------------------------------------------------------------------------------- */

/** Vero se il workflow espone un nodo di caricamento immagine (ingresso I2V). */
function hasImageLoader(wf: ApiWorkflow): boolean {
	return Object.values(wf).some(n => typeof n?.class_type === 'string' && /loadimage/i.test(n.class_type));
}

/**
 * Deduce i tipi di generazione supportati da un workflow API:
 * - se produce video (`producesVideo`): supporta `t2v` e, se ha un nodo di caricamento
 *   immagine, anche `i2v`;
 * - altrimenti supporta `image`.
 */
export function inferKinds(wf: ApiWorkflow): GenKind[] {
	if (producesVideo(wf)) {
		return hasImageLoader(wf) ? ['t2v', 'i2v'] : ['t2v'];
	}
	return ['image'];
}

/**
 * Parametri logici che devono risultare mappabili sul workflow per la richiesta data.
 * Usato per segnalare (Req. 3.4) quando un parametro richiesto non trova alcun nodo.
 */
function requiredParamsFor(kind: GenKind, req: GenRequest): (keyof LogicalParams)[] {
	const required: (keyof LogicalParams)[] = [];
	if (typeof req.prompt === 'string' && req.prompt.trim().length > 0) {
		required.push('positivePrompt');
	}
	if (kind === 'i2v' || (typeof req.initImage === 'string' && req.initImage.length > 0)) {
		required.push('initImageRef');
	}
	if (kind === 't2v' || kind === 'i2v') {
		if (req.frames !== undefined) {
			required.push('frames');
		}
		if (req.fps !== undefined) {
			required.push('fps');
		}
	}
	return required;
}

/**
 * Costruisce il contesto di instradamento per il Router_LLM a partire dalla richiesta.
 *
 * PRIVACY (Req. 21.1, 21.2): l'unico testo del prompt qui propagato è `hint`, usato dal
 * Router_LLM come euristica di complessità per scegliere il provider; il prompt non viene
 * inoltrato altrove da questa funzione.
 * LOCAL-FIRST (Req. 20.1): `localFirst` proviene dalle preferenze dell'utente (default `true`),
 * così la selezione del provider privilegia i modelli locali quando richiesto.
 */
function routeContextFor(req: GenRequest, kind: GenKind, localFirst: boolean): RouteContext {
	return {
		hint: req.prompt,
		hasImages: typeof req.initImage === 'string' && req.initImage.length > 0,
		// La generazione video è il compito più impegnativo: instradalo come "heavy".
		complexity: kind === 'image' ? 'light' : 'heavy',
		// LOCAL-FIRST (Req. 20.1): preferenza letta dall'utente, non più forzata (task 18.3).
		localFirst,
	};
}

/** Descrizione in linguaggio naturale delle dipendenze mancanti (Req. 1.5). */
function describeMissingDeps(models: ModelRef[], nodes: string[]): string {
	const parts: string[] = [];
	if (models.length > 0) {
		parts.push(`modelli mancanti: ${models.map(m => `${m.filename} (cartella ${m.dir})`).join(', ')}`);
	}
	if (nodes.length > 0) {
		parts.push(`nodi custom mancanti: ${nodes.join(', ')}`);
	}
	return `Il workflow richiede dipendenze non presenti in ComfyUI — ${parts.join('; ')}. `
		+ 'Scarica i modelli e installa i nodi mancanti, poi riprova.';
}

/**
 * Variante OFFLINE di `describeMissingDeps` (Req. 20.2, 20.3): quando mancano dipendenze ma non
 * c'è connessione, il loro recupero (download modelli / installazione nodi) RICHIEDE rete e non
 * può essere effettuato. Segnala all'utente che l'operazione richiede una connessione, ricordando
 * che la generazione con risorse GIÀ presenti localmente resta possibile.
 */
function describeOfflineMissingDeps(models: ModelRef[], nodes: string[]): string {
	const parts: string[] = [];
	if (models.length > 0) {
		parts.push(`modelli mancanti: ${models.map(m => `${m.filename} (cartella ${m.dir})`).join(', ')}`);
	}
	if (nodes.length > 0) {
		parts.push(`nodi custom mancanti: ${nodes.join(', ')}`);
	}
	return `Il workflow richiede dipendenze non presenti localmente — ${parts.join('; ')}. `
		+ 'Il loro recupero (download dei modelli e installazione dei nodi) richiede una connessione '
		+ 'di rete, attualmente non disponibile. Connettiti a Internet e riprova, oppure scegli un '
		+ 'workflow che usi solo risorse già presenti localmente.';
}

/**
 * Riporta in linguaggio naturale un errore di esecuzione non recuperabile (causa sconosciuta o
 * tentativi esauriti), con l'azione suggerita all'utente in base alla causa classificata
 * (Req. 18.5).
 */
function describeGiveUp(err: ClassifiedError): string {
	const base = err.detail && err.detail.trim().length > 0 ? err.detail.trim() : 'errore di esecuzione sconosciuto';
	let suggestion: string;
	switch (err.cause) {
		case 'missing-node':
			suggestion = `Installa il nodo custom mancante${err.subject ? ` "${err.subject}"` : ''} (es. tramite ComfyUI-Manager) e riprova.`;
			break;
		case 'missing-model':
			suggestion = `Scarica il modello mancante${err.subject ? ` "${err.subject}"` : ''} nella cartella corretta e riprova.`;
			break;
		case 'oom-vram':
			suggestion = 'Riduci ulteriormente la risoluzione o i passi, oppure libera VRAM (chiudi altre applicazioni che usano la GPU) e riprova.';
			break;
		default:
			suggestion = 'Controlla i log di ComfyUI per il dettaglio dell\'errore e riprova.';
	}
	return `L'esecuzione non è riuscita: ${base}. Azione suggerita: ${suggestion}`;
}

/** Estrae un messaggio di causa in linguaggio naturale da un errore qualsiasi. */
function naturalCause(err: unknown): string {
	if (err instanceof Error) {
		return err.message;
	}
	return String(err);
}

/** Mappa la risposta dell'utente alla domanda di disambiguazione su un `GenKind`. */
function mapAnswerToKind(answer: string): GenKind | undefined {
	const a = answer.toLowerCase();
	if (/i2v|da un'immagine|da immagine|image[\s-]?to[\s-]?video/.test(a)) {
		return 'i2v';
	}
	if (/t2v|da testo|text[\s-]?to[\s-]?video|\bvideo\b/.test(a)) {
		return 't2v';
	}
	if (/immagine|image|foto|picture/.test(a)) {
		return 'image';
	}
	return undefined;
}

/** Opzioni mostrate all'utente quando il tipo di contenuto è ambiguo (Req. 1.6). */
const KIND_OPTIONS: readonly string[] = [
	'Immagine',
	'Video da testo (T2V)',
	'Video da un\'immagine (I2V)',
];

/* -------------------------------------------------------------------------------------------
 * GenOrchestrator — implementazione dell'IOrchestrator che cabla i moduli puri e gli adapter.
 * ----------------------------------------------------------------------------------------- */

export class GenOrchestrator implements IOrchestrator {
	constructor(private readonly adapters: OrchestratorAdapters) { }

	/** @inheritdoc */
	classify(req: GenRequest): GenKind | 'ambiguous' {
		return classify(req);
	}

	/** @inheritdoc */
	plan(kind: GenKind): PlanStepGen[] {
		return plan(kind);
	}

	/**
	 * Esegue il ciclo agentico: classifica (con conferma in caso di ambiguità), pianifica ed
	 * esegue i passi in sequenza fino al completamento o al primo errore non recuperabile.
	 * _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 2.4, 3.2_
	 */
	async run(req: GenRequest, cb: AgentCallbacks, signal?: AbortSignal): Promise<GenOutcome> {
		const stepsExecuted: PlanStepGen[] = [];

		// LOCAL-FIRST (Req. 20.1) e OFFLINE (Req. 20.2, 20.3): leggi le preferenze e lo stato di
		// rete dai seam (con default sicuri: local-first attivo, online assunto se non rilevabile).
		const localFirst = (await this.adapters.getPreferences?.())?.localFirst ?? true;
		const online = (await this.adapters.isOnline?.()) ?? true;

		// PRIVACY (Req. 21.3): qualsiasi telemetria emessa passa per `buildTelemetryEvent`, che
		// rimuove il testo dei prompt. NB: `req.prompt` è passato come `prompt` proprio per essere
		// ESCLUSO dall'evento risultante (non viene mai serializzato nella telemetria).
		this.emitTelemetry({ event: 'gen.start', prompt: req.prompt, properties: { localFirst, online } });

		// (1) Classificazione + conferma in caso di ambiguità (Req. 1.1, 1.6).
		let kind = this.classify(req);
		if (kind === 'ambiguous') {
			const confirmed = await this.confirmKind(cb);
			if (!confirmed) {
				return {
					status: 'needs-confirmation',
					media: [],
					stepsExecuted,
					cause: 'Tipo di contenuto ambiguo: serve confermare se generare un\'immagine, un video da testo (T2V) o un video da un\'immagine (I2V).',
				};
			}
			kind = confirmed;
		}

		const steps = plan(kind);
		const stepByKind = (k: PlanStepGen['kind']): PlanStepGen => steps.find(s => s.kind === k)!;

		/** Costruisce un esito di fallimento (stop sul primo errore non recuperabile, Req. 1.5). */
		const fail = (failedStep: PlanStepGen, cause: string): GenOutcome => ({
			status: 'failed',
			media: [],
			stepsExecuted: [...stepsExecuted],
			failedStep,
			cause,
		});

		/** Esito di annullamento (Req. 8.3). */
		const cancelled = (media: GeneratedItem[] = []): GenOutcome => ({
			status: 'cancelled',
			media,
			stepsExecuted: [...stepsExecuted],
			cause: 'Esecuzione annullata dall\'utente.',
		});

		try {
			// (2) select-workflow: Router_LLM + proposta di workflow compatibile.
			const swStep = stepByKind('select-workflow');
			if (signal?.aborted) {
				return cancelled();
			}
			const provider = await this.adapters.selectProvider(routeContextFor(req, kind, localFirst));
			if (!provider) {
				// Req. 2.4: nessun provider configurato/raggiungibile.
				return fail(swStep, 'Nessun provider LLM è configurato o raggiungibile. Configura un provider '
					+ '(Ollama in locale oppure una chiave per un provider cloud) e riprova.');
			}
			const local = await this.adapters.listWorkflows();
			const proposed = proposeWorkflow(local, kind);
			if (!proposed) {
				// Req. 4.2: nessun workflow locale adatto.
				return fail(swStep, `Nessun workflow locale è compatibile con il tipo di generazione "${kind}". `
					+ 'Importa o scarica un workflow adatto e riprova.');
			}
			cb.onAssistantText(`Workflow selezionato: ${proposed.name} (provider LLM: ${provider.label}).`);
			stepsExecuted.push(swStep);

			// (3) check-deps: stato ComfyUI + dipendenze mancanti (modelli/nodi).
			const cdStep = stepByKind('check-deps');
			let availability = await this.adapters.comfyAvailability();
			if (!availability.reachable) {
				// ComfyUI è un servizio LOCALE: la sua irraggiungibilità è distinta dall'assenza di
				// rete (gestita più sotto). Senza ComfyUI non è possibile generare (Req. 23.1: le
				// funzioni dipendenti da ComfyUI sono indisponibili).
				return fail(cdStep, 'ComfyUI non è raggiungibile. Avvia ComfyUI (o installalo) e riprova.');
			}
			// Recupero PROATTIVO delle dipendenze mancanti: propone download/installazione (con
			// conferma negli adapter) e RI-VERIFICA, entro il budget di tentativi (Req. 18.2,
			// 18.3, 18.6, 23.2). A esaurimento, riporta le dipendenze ancora mancanti.
			let lackingModels = missingModels(referencedModels(proposed.workflow), availability.models);
			let lackingNodes = missingNodes(usedClassTypes(proposed.workflow), availability.nodes);
			let depAttempt = 0;
			while (lackingModels.length > 0 || lackingNodes.length > 0) {
				if (signal?.aborted) {
					return cancelled();
				}
				if (depAttempt >= MAX_RETRIES) {
					return fail(cdStep, describeMissingDeps(lackingModels, lackingNodes));
				}
				// OFFLINE (Req. 20.2, 20.3): il recupero delle dipendenze mancanti (download
				// modelli / installazione nodi) RICHIEDE rete. Se offline, NON lo tentiamo e
				// segnaliamo che l'operazione richiede una connessione; la generazione con risorse
				// già presenti localmente (loop saltato) resta invece possibile.
				if (!online) {
					return fail(cdStep, describeOfflineMissingDeps(lackingModels, lackingNodes));
				}
				let acted = false;
				if (lackingNodes.length > 0 && this.adapters.installMissingNodes) {
					cb.onAssistantText(`Nodi custom mancanti (${lackingNodes.join(', ')}): propongo l'installazione e riprovo.`);
					acted = (await this.adapters.installMissingNodes({ endpoint: availability.endpoint, workflowName: proposed.name })) || acted;
				}
				if (lackingModels.length > 0 && this.adapters.downloadMissingModels) {
					cb.onAssistantText(`Modelli mancanti (${lackingModels.map(m => m.filename).join(', ')}): propongo il download e riprovo.`);
					acted = (await this.adapters.downloadMissingModels({ endpoint: availability.endpoint, workflowName: proposed.name })) || acted;
				}
				if (!acted) {
					// Nessun adapter di recupero disponibile o azione non intrapresa: degrado
					// controllato con indicazioni su cosa installare (Req. 23.2).
					return fail(cdStep, describeMissingDeps(lackingModels, lackingNodes));
				}
				depAttempt++;
				availability = await this.adapters.comfyAvailability();
				if (!availability.reachable) {
					return fail(cdStep, 'ComfyUI non è più raggiungibile dopo il recupero delle dipendenze. Avvia ComfyUI e riprova.');
				}
				lackingModels = missingModels(referencedModels(proposed.workflow), availability.models);
				lackingNodes = missingNodes(usedClassTypes(proposed.workflow), availability.nodes);
			}
			stepsExecuted.push(cdStep);

			// (4) set-inputs: mappatura dei parametri logici e verifica di mappabilità (Req. 3.1, 3.4).
			const siStep = stepByKind('set-inputs');
			const mapping = buildMapping(proposed.workflow);
			const unmapped = unmappedParams(requiredParamsFor(kind, req), mapping);
			if (unmapped.length > 0) {
				// Req. 3.4: un parametro logico richiesto non trova alcun nodo corrispondente.
				return fail(siStep, `Impossibile mappare alcuni parametri richiesti sul workflow: ${unmapped.join(', ')}. `
					+ 'Scegli un workflow che esponga questi parametri.');
			}
			stepsExecuted.push(siStep);

			// (5) execute: generazione (immagine o video) con monitor di avanzamento e CICLO DI
			// RECUPERO ERRORI: su eccezione, classifica la causa, pianifica l'azione correttiva e
			// ritenta, entro `MAX_RETRIES` (Req. 18.2, 18.3, 18.4, 18.5, 18.6, 19.2, 23.2).
			const exStep = stepByKind('execute');
			// Base dei parametri a basso consumo (Req. 19.2): partiamo dal profilo a bassa VRAM e
			// scendiamo per livelli a ogni errore di memoria. `tier 0` = parametri di base.
			const baseParams = defaultParams(LOW_VRAM_GB);
			let memoryTier: MemoryTier = 0;
			let params: GenParams | undefined;
			let attempt = 0;
			for (; ;) {
				if (signal?.aborted) {
					return cancelled();
				}
				cb.onToolStart({
					tool: 'genera',
					args: attempt === 0
						? { kind, workflow: proposed.name }
						: { kind, workflow: proposed.name, tentativo: attempt + 1 },
				});
				let lastNode: string | undefined;
				try {
					// PRIVACY (Req. 21.1, 21.2): `req` (incluso `req.prompt`) è inoltrato SOLO
					// all'adapter di esecuzione, che lo invia esclusivamente al backend selezionato
					// per QUESTA richiesta. Il prompt non viene propagato ad altri servizi.
					const media = await this.adapters.execute({
						kind,
						endpoint: availability.endpoint,
						workflow: proposed.workflow,
						request: req,
						signal,
						params,
						onProgress: (percent, node) => {
							if (node && node !== lastNode) {
								lastNode = node;
								cb.onToolResult(`Avanzamento ${Math.round(percent)}% — nodo ${node}`);
							}
						},
					});
					cb.onToolResult(`Generati ${media.length} elemento/i.`);
					if (signal?.aborted) {
						return cancelled(media);
					}
					stepsExecuted.push(exStep);

					// (6) report: riepilogo all'utente (Req. 1.4).
					const rpStep = stepByKind('report');
					stepsExecuted.push(rpStep);
					cb.onAssistantText(this.summarize(kind, proposed.name, media, stepsExecuted));

					// PRIVACY (Req. 21.3): telemetria di completamento sanificata (nessun prompt).
					this.emitTelemetry({
						event: 'gen.complete',
						prompt: req.prompt,
						properties: { kind, workflow: proposed.name, status: 'success' },
						measurements: { items: media.length, attempts: attempt + 1 },
					});

					return { status: 'success', media, stepsExecuted };
				} catch (err) {
					if (signal?.aborted) {
						return cancelled();
					}
					// Classifica l'errore e pianifica l'azione correttiva (logica pura).
					const classified = classifyError(naturalCause(err));
					const action = planRecovery(classified, attempt);
					if (action.kind === 'give-up') {
						// Causa sconosciuta o tentativi esauriti: riporta in linguaggio naturale
						// con l'azione suggerita (Req. 18.5, 18.6).
						return fail(exStep, describeGiveUp(classified));
					}
					attempt++;
					const recovered = await this.applyRecovery(action, classified, availability.endpoint, proposed.name, cb);
					if (!recovered) {
						// Azione di recupero non disponibile o rifiutata: degrado controllato
						// con l'azione suggerita (Req. 23.2).
						return fail(exStep, describeGiveUp(classified));
					}
					if (action.kind === 'reduce-memory') {
						// Riduzione PROGRESSIVA di memoria: scende di un livello e applica i nuovi
						// parametri al prossimo tentativo (Req. 18.4, 19.2).
						memoryTier = Math.min(3, memoryTier + 1) as MemoryTier;
						params = reduceForTier(baseParams, memoryTier);
					}
					// Ritenta l'esecuzione (stesso piano, dipendenze/parametri aggiornati).
				}
			}
		} catch (err) {
			// Errore non recuperabile PRIMA dell'esecuzione (provider/workflow/dipendenze/mappatura):
			// riporta passo fallito + causa in linguaggio naturale (Req. 1.3, 1.5). Gli errori DI
			// esecuzione sono gestiti dal ciclo di recupero qui sopra (Req. 18.x).
			const failedStep = steps[stepsExecuted.length] ?? steps[steps.length - 1];
			return {
				status: 'failed',
				media: [],
				stepsExecuted: [...stepsExecuted],
				failedStep,
				cause: naturalCause(err),
			};
		}
	}

	/**
	 * Chiede all'utente di confermare il tipo di contenuto quando la richiesta è ambigua
	 * (Req. 1.6). Restituisce `undefined` se non è possibile porre la domanda o se la risposta
	 * non è interpretabile.
	 */
	private async confirmKind(cb: AgentCallbacks): Promise<GenKind | undefined> {
		if (!cb.onAsk) {
			return undefined;
		}
		const answer = await cb.onAsk(
			'Che tipo di contenuto vuoi generare?',
			[...KIND_OPTIONS],
			false,
		);
		return mapAnswerToKind(answer);
	}

	/**
	 * Esegue l'azione correttiva pianificata dal Recupero_Errori prima di ritentare:
	 * - `install-node` → installa i nodi mancanti tramite l'adapter (con conferma) (Req. 18.2);
	 * - `download-model` → scarica i modelli mancanti tramite l'adapter (con conferma) (Req. 18.3);
	 * - `reduce-memory` → nessuna azione esterna: la riduzione dei parametri è applicata dal
	 *   chiamante prima del ritentativo (Req. 18.4, 19.2).
	 * Restituisce `true` se è possibile ritentare, `false` se l'azione non è disponibile o non è
	 * stata intrapresa (in tal caso si applica il degrado controllato, Req. 23.2).
	 */
	private async applyRecovery(
		action: RecoveryAction,
		err: ClassifiedError,
		endpoint: string,
		workflowName: string,
		cb: AgentCallbacks,
	): Promise<boolean> {
		switch (action.kind) {
			case 'install-node': {
				if (!this.adapters.installMissingNodes) {
					return false;
				}
				cb.onAssistantText(`Errore: nodo custom mancante${err.subject ? ` ("${err.subject}")` : ''}. Propongo l'installazione e riprovo.`);
				return this.adapters.installMissingNodes({ endpoint, workflowName, subject: err.subject });
			}
			case 'download-model': {
				if (!this.adapters.downloadMissingModels) {
					return false;
				}
				cb.onAssistantText(`Errore: modello mancante${err.subject ? ` ("${err.subject}")` : ''}. Propongo il download e riprovo.`);
				return this.adapters.downloadMissingModels({ endpoint, workflowName, subject: err.subject });
			}
			case 'reduce-memory': {
				cb.onAssistantText('Errore: memoria VRAM insufficiente. Riduco la configurazione di generazione e riprovo.');
				return true;
			}
			default:
				return false;
		}
	}

	/**
	 * PRIVACY (Req. 21.3): unico punto da cui l'Orchestratore emette telemetria. Costruisce
	 * SEMPRE l'evento tramite `buildTelemetryEvent` (che rimuove il testo dei prompt) prima di
	 * inoltrarlo all'eventuale sink. Difesa in profondità: anche se un chiamante passasse il
	 * prompt in `prompt`, esso non finisce mai nell'evento serializzato. Se nessun sink è
	 * configurato, l'evento sanificato viene semplicemente scartato.
	 */
	private emitTelemetry(input: TelemetryInput): void {
		if (!this.adapters.emitTelemetry) {
			return;
		}
		this.adapters.emitTelemetry(buildTelemetryEvent(input));
	}

	/** Riepilogo in linguaggio naturale dei passi eseguiti e degli output prodotti (Req. 1.4). */
	private summarize(kind: GenKind, workflowName: string, media: GeneratedItem[], steps: PlanStepGen[]): string {
		const images = media.filter(m => m.kind === 'image').length;
		const videos = media.filter(m => m.kind === 'video').length;
		const outputs: string[] = [];
		if (images > 0) {
			outputs.push(`${images} immagine/i`);
		}
		if (videos > 0) {
			outputs.push(`${videos} video`);
		}
		const outputText = outputs.length > 0 ? outputs.join(' e ') : 'nessun output';
		const stepText = steps.map(s => s.kind).join(' → ');
		return `Generazione "${kind}" completata con il workflow ${workflowName}: prodotti ${outputText}. `
			+ `Passi eseguiti: ${stepText}.`;
	}
}

/* -------------------------------------------------------------------------------------------
 * Factory degli adapter REALI — cabla i moduli che dipendono da vscode/fetch.
 * Tutti gli import sono DINAMICI (`import()`), così il modulo resta importabile sotto Node
 * (i test di logica pura non li caricano mai). Usata dall'estensione a runtime.
 * ----------------------------------------------------------------------------------------- */

/**
 * Crea gli adapter reali cablati ai moduli di MGCoding:
 * - `selectProvider` → `ProviderRegistry.selectProvider` (Router_LLM, Req. 2);
 * - `listWorkflows` → `comfyHelper.listWorkflows`/`loadWorkflow` (Req. 4);
 * - `comfyAvailability` → `comfyLifecycle.detectComfyStatus`/`comfyLists` (Req. 12, 16, 17);
 * - `execute` → `imageGen.generateImage` (immagini) o `videoGen.generateVideo` (video), con
 *   `progressMonitor` per l'avanzamento e salvataggio nella cartella della Galleria (Req. 5, 6, 8).
 */
export function createDefaultAdapters(registry: ProviderRegistry): OrchestratorAdapters {
	return {
		async selectProvider(ctx: RouteContext): Promise<SelectedProvider | undefined> {
			const provider = await registry.selectProvider(ctx);
			return provider ? { id: provider.id, label: provider.label } : undefined;
		},

		async listWorkflows(): Promise<LocalWorkflow[]> {
			const { listWorkflows, loadWorkflow } = await import('../media/comfyHelper');
			const names = await listWorkflows();
			const result: LocalWorkflow[] = [];
			for (const name of names) {
				const wf = await loadWorkflow(name);
				if (!wf) {
					continue;
				}
				const api = wf as unknown as ApiWorkflow;
				result.push({ name, kinds: inferKinds(api), workflow: api });
			}
			return result;
		},

		async comfyAvailability(): Promise<ComfyAvailabilityInfo> {
			const { detectComfyStatus, comfyLists } = await import('../media/comfyLifecycle');
			const status = await detectComfyStatus();
			const reachable = status.availability === 'available';
			let models = new Set<string>();
			let nodes = new Set<string>();
			if (reachable) {
				const lists = await comfyLists(status.endpoint);
				models = new Set<string>([...lists.checkpoints, ...lists.loras]);
				nodes = new Set<string>(lists.nodes);
			}
			return { reachable, endpoint: status.endpoint, models, nodes };
		},

		async execute(ctx: ExecuteContext): Promise<GeneratedItem[]> {
			const vscodeNs = await import('vscode');
			const { generatedDirUri } = await import('../media/comfyHelper');
			const dir = generatedDirUri();
			await vscodeNs.workspace.fs.createDirectory(dir);

			const save = async (base64: string, baseName: string, ext: string): Promise<string> => {
				const uri = vscodeNs.Uri.joinPath(dir, `${baseName}.${ext}`);
				await vscodeNs.workspace.fs.writeFile(uri, Buffer.from(base64, 'base64'));
				return uri.fsPath;
			};
			const now = (): string => new Date().toISOString();
			const stamp = Date.now();

			if (ctx.kind === 'image') {
				const { detectImageBackend, generateImage } = await import('../media/imageGen');
				// LOCAL-FIRST (Req. 20.1): `detectImageBackend('auto', …)` con chiave cloud vuota
				// privilegia i backend locali (ComfyUI/A1111). PRIVACY (Req. 21.1, 21.2): il prompt
				// è passato solo a questo backend per la richiesta corrente.
				const backend = await detectImageBackend('auto', '', ctx.endpoint, {});
				if (!backend) {
					throw new Error('Nessun backend immagine disponibile (ComfyUI/A1111 in locale o una chiave cloud).');
				}
				const res = await generateImage(backend, ctx.request.prompt, {
					aspect: ctx.request.aspect,
					initImage: ctx.request.initImage,
					seed: ctx.request.seed,
					// Recupero VRAM: al ritentativo applica i passi/cfg ridotti (Req. 18.4, 19.2).
					...(ctx.params ? { steps: ctx.params.steps, cfg: ctx.params.cfg } : {}),
				}, {}, ctx.signal);
				const ext = res.mediaType.includes('jpeg') ? 'jpg' : res.mediaType.includes('webp') ? 'webp' : 'png';
				const items: GeneratedItem[] = [];
				for (let i = 0; i < res.images.length; i++) {
					const uri = await save(res.images[i], `mg_${stamp}_${i}`, ext);
					items.push({ uri, kind: 'image', format: ext, createdAt: now(), sourcePrompt: ctx.request.prompt });
				}
				return items;
			}

			// Video (t2v/i2v): genera con videoGen e collega il Monitor_Avanzamento.
			const { generateVideo } = await import('../media/videoGen');
			const { ComfyProgressMonitor } = await import('../media/progressMonitor');
			const monitor = new ComfyProgressMonitor(ctx.endpoint, {});
			const sub = monitor.onUpdate(u => ctx.onProgress?.(u.percent, u.currentNode));
			monitor.start();
			try {
				const res = await generateVideo(ctx.endpoint, ctx.workflow, {
					prompt: ctx.request.prompt,
					initImage: ctx.request.initImage,
					frames: ctx.params?.frames ?? ctx.request.frames,
					fps: ctx.request.fps,
					seed: ctx.request.seed,
					// Recupero VRAM: al ritentativo applica i parametri ridotti (Req. 18.4, 19.2).
					...(ctx.params ? { width: ctx.params.width, height: ctx.params.height, steps: ctx.params.steps, cfg: ctx.params.cfg } : {}),
				}, { signal: ctx.signal });

				const items: GeneratedItem[] = [];
				let idx = 0;
				for (const file of res.videos) {
					const ext = extensionOf(file.filename) || file.format || 'mp4';
					const uri = await save(file.data, `mg_${stamp}_${idx++}`, ext);
					items.push({ uri, kind: 'video', format: ext, createdAt: now(), sourcePrompt: ctx.request.prompt });
				}
				for (const file of res.images) {
					const ext = extensionOf(file.filename) || file.format || 'png';
					const uri = await save(file.data, `mg_${stamp}_${idx++}`, ext);
					items.push({ uri, kind: 'image', format: ext, createdAt: now(), sourcePrompt: ctx.request.prompt });
				}
				return items;
			} finally {
				sub.dispose();
				monitor.dispose();
			}
		},

		async installMissingNodes(ctx: RecoveryContext): Promise<boolean> {
			// Riusa l'helper esistente: risolve i nodi mancanti via ComfyUI-Manager, li clona in
			// custom_nodes/ e installa le dipendenze. Mostra il proprio dialog di CONFERMA (clona
			// codice di terzi, Req. 18.2, 22). Restituisce `true`: l'azione è stata intrapresa.
			const { installMissingNodesForWorkflow } = await import('../media/comfyHelper');
			await installMissingNodesForWorkflow(ctx.endpoint, ctx.workflowName);
			return true;
		},

		async downloadMissingModels(ctx: RecoveryContext): Promise<boolean> {
			// Riusa l'helper esistente: risolve i modelli mancanti via la lista curata di
			// ComfyUI-Manager e li scarica nelle cartelle corrette. Mostra il proprio dialog di
			// CONFERMA (Req. 18.3, 22). Restituisce `true`: l'azione è stata intrapresa.
			const { installMissingModelsForWorkflow } = await import('../media/comfyHelper');
			await installMissingModelsForWorkflow(ctx.endpoint, ctx.workflowName);
			return true;
		},

		async getPreferences(): Promise<OrchestratorPreferences> {
			// LOCAL-FIRST (Req. 20.1): legge `mgcoding.localFirst` dalla configurazione utente,
			// con default `true` (comportamento local-first predefinito).
			const vscodeNs = await import('vscode');
			const cfg = vscodeNs.workspace.getConfiguration('mgcoding');
			return { localFirst: cfg.get<boolean>('localFirst', true) };
		},

		async isOnline(): Promise<boolean> {
			// OFFLINE (Req. 20.2, 20.3): rilevamento leggero della connettività tramite risoluzione
			// DNS (nessun dato applicativo inviato). In caso di errore si assume offline.
			try {
				const dns = await import('dns');
				await dns.promises.lookup('huggingface.co');
				return true;
			} catch {
				return false;
			}
		},
	};
}

/**
 * Crea un `GenOrchestrator` cablato agli adapter reali a partire dal `ProviderRegistry`.
 * Comoda da usare a runtime nell'estensione.
 */
export function createDefaultOrchestrator(registry: ProviderRegistry): GenOrchestrator {
	return new GenOrchestrator(createDefaultAdapters(registry));
}
