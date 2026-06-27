/*---------------------------------------------------------------------------------------------
 *  MGCoding - Test di integrazione (node puro) per l'Orchestratore del ciclo agentico di
 *  generazione (`GenOrchestrator`), con adapter (`OrchestratorAdapters`) e callback
 *  (`AgentCallbacks`) interamente MOCKATI: nessun I/O reale, nessuna dipendenza da `vscode`.
 *  Eseguibile con: node out/test/orchestrator.int.test.js
 *
 *  Copre (asserzioni a esempi, niente property-based):
 *   - PERCORSO FELICE: classify → plan → run restituisce `status: 'success'` con i media
 *     prodotti e `stepsExecuted` nell'ORDINE CANONICO (select-workflow → check-deps →
 *     set-inputs → execute → report), e riepilogo riportato via `onAssistantText`. (Req 1.3, 1.4)
 *   - STOP su errore NON recuperabile con causa in linguaggio naturale e passo fallito:
 *       · provider LLM assente (Req 2.4) → fail su `select-workflow`;
 *       · ComfyUI irraggiungibile → fail su `check-deps`;
 *       · parametri non mappabili (Req 3.4) → fail su `set-inputs`.
 *     In tutti i casi `status: 'failed'` con `failedStep` + `cause`. (Req 1.5, 3.2)
 *   - DISAMBIGUAZIONE LLM: richiesta ambigua → `run` usa `cb.onAsk` per confermare il tipo,
 *     poi procede con il tipo scelto fino al successo. (Req 1.6, 3.2)
 *   - PRIVACY DEL PROMPT: uno spy di telemetria verifica che il testo del prompt NON compaia
 *     in alcun evento di telemetria emesso; il prompt raggiunge SOLO l'adapter di esecuzione
 *     (il servizio selezionato per la richiesta). (Req 21.1, 21.2)
 *
 *  Nota: `genOrchestrator.ts` importa `AgentCallbacks`/`RouteContext`/`ProviderRegistry` solo
 *  come TYPE (cancellati a runtime) e tutti i moduli di logica caricati sono puri. Importiamo
 *  comunque lo stub `vscode` PER PRIMO per coerenza con gli altri test e per robustezza.
 *  _Requirements: 1.3, 1.4, 1.5, 3.2, 21.1, 21.2_
 *--------------------------------------------------------------------------------------------*/

import './vscodeStub';
import * as assert from 'assert';
import type { AgentCallbacks } from '../agent/agentLoop';
import {
	GenOrchestrator,
	type OrchestratorAdapters,
	type SelectedProvider,
	type ComfyAvailabilityInfo,
	type ExecuteContext,
	type RecoveryContext,
} from '../agent/genOrchestrator';
import type { LocalWorkflow } from '../media/workflowProposal';
import type { GenRequest, GeneratedItem, PlanStepGen } from '../media/genTypes';
import type { ApiWorkflow } from '../media/workflowGraph';
import type { RouteContext } from '../llm/registry';
import type { TelemetryEvent } from '../media/telemetryGating';

let passed = 0;
let failed = 0;
const cases: Array<{ name: string; fn: () => void | Promise<void> }> = [];
/** Registra un test; l'esecuzione è sequenziale e deterministica (vedi `run`). */
function test(name: string, fn: () => void | Promise<void>): void {
	cases.push({ name, fn });
}

// --------------------------------------------------------------------------------------------
// Helper: workflow API minimali ma VALIDI per la mappatura
// --------------------------------------------------------------------------------------------

/**
 * Workflow immagine: un sampler il cui input `positive` risale a un nodo `CLIPTextEncode`,
 * così `buildMapping` risolve `positivePrompt`. Include `SaveImage` come nodo di output.
 */
function imageWorkflow(): ApiWorkflow {
	return {
		'2': { class_type: 'CLIPTextEncode', inputs: { text: '' } },
		'3': { class_type: 'KSampler', inputs: { seed: 0, positive: ['2', 0], negative: ['2', 0] } },
		'4': { class_type: 'SaveImage', inputs: { images: ['3', 0] } },
	};
}

/**
 * Workflow video (T2V): come quello immagine ma con un nodo di OUTPUT VIDEO
 * (`VHS_VideoCombine`), così `producesVideo` è vero. `positivePrompt` resta mappabile.
 */
function videoWorkflow(): ApiWorkflow {
	return {
		'2': { class_type: 'CLIPTextEncode', inputs: { text: '' } },
		'3': { class_type: 'KSampler', inputs: { seed: 0, positive: ['2', 0], negative: ['2', 0] } },
		'5': { class_type: 'VHS_VideoCombine', inputs: { images: ['3', 0], frame_rate: 8 } },
	};
}

/** Workflow senza sampler/nodo di testo: `positivePrompt` NON è mappabile (Req 3.4). */
function unmappableWorkflow(): ApiWorkflow {
	return {
		'1': { class_type: 'SaveImage', inputs: { images: ['x', 0] } },
	};
}

/** Insieme generoso di `class_type` "noti" a ComfyUI, così non risultano nodi mancanti. */
const KNOWN_NODES = new Set<string>(['CLIPTextEncode', 'KSampler', 'SaveImage', 'VHS_VideoCombine']);

/** Costruisce un `GeneratedItem` finto di tipo immagine o video. */
function fakeItem(kind: 'image' | 'video', prompt: string): GeneratedItem {
	return {
		uri: `mem://${kind}-0.${kind === 'image' ? 'png' : 'mp4'}`,
		kind,
		format: kind === 'image' ? 'png' : 'mp4',
		createdAt: new Date(0).toISOString(),
		sourcePrompt: prompt,
	};
}

// --------------------------------------------------------------------------------------------
// Helper: callback dell'agente con cattura di ciò che l'Orchestratore comunica
// --------------------------------------------------------------------------------------------

interface CapturedCallbacks {
	cb: AgentCallbacks;
	assistantTexts: string[];
	toolStarts: Array<{ tool: string; args: unknown }>;
	toolResults: string[];
	asks: Array<{ question: string; options: string[] }>;
}

/**
 * Crea un `AgentCallbacks` mock. `askAnswer` (se fornito) è la risposta restituita da `onAsk`
 * alla domanda di disambiguazione (Req 1.6); se assente, `onAsk` non è esposto.
 */
function makeCallbacks(askAnswer?: string): CapturedCallbacks {
	const assistantTexts: string[] = [];
	const toolStarts: Array<{ tool: string; args: unknown }> = [];
	const toolResults: string[] = [];
	const asks: Array<{ question: string; options: string[] }> = [];
	const cb: AgentCallbacks = {
		onAssistantText: t => assistantTexts.push(t),
		onToolStart: c => toolStarts.push({ tool: c.tool, args: c.args }),
		onToolResult: r => toolResults.push(r),
		...(askAnswer !== undefined
			? { onAsk: async (question: string, options: string[]) => { asks.push({ question, options }); return askAnswer; } }
			: {}),
	};
	return { cb, assistantTexts, toolStarts, toolResults, asks };
}

// --------------------------------------------------------------------------------------------
// Helper: adapter mockati con override puntuali
// --------------------------------------------------------------------------------------------

interface AdapterSpies {
	adapters: OrchestratorAdapters;
	executeCalls: ExecuteContext[];
	telemetry: TelemetryEvent[];
	recoveryCalls: RecoveryContext[];
}

interface AdapterOptions {
	provider?: SelectedProvider | undefined;
	workflows?: LocalWorkflow[];
	availability?: ComfyAvailabilityInfo;
	/** Media restituiti da `execute`; se è una funzione, può lanciare per simulare errori. */
	execute?: (ctx: ExecuteContext) => GeneratedItem[] | Promise<GeneratedItem[]>;
	installMissingNodes?: (ctx: RecoveryContext) => Promise<boolean>;
	downloadMissingModels?: (ctx: RecoveryContext) => Promise<boolean>;
}

const ENDPOINT = 'http://127.0.0.1:8188';

/** Disponibilità ComfyUI "tutto a posto" (raggiungibile, nessuna dipendenza mancante). */
function reachableAvailability(): ComfyAvailabilityInfo {
	return { reachable: true, endpoint: ENDPOINT, models: new Set<string>(), nodes: new Set(KNOWN_NODES) };
}

/** Costruisce gli adapter mock con spy su `execute`, `emitTelemetry` e i recuperi. */
function makeAdapters(opts: AdapterOptions = {}): AdapterSpies {
	const executeCalls: ExecuteContext[] = [];
	const telemetry: TelemetryEvent[] = [];
	const recoveryCalls: RecoveryContext[] = [];

	const provider: SelectedProvider | undefined =
		'provider' in opts ? opts.provider : { id: 'ollama', label: 'Ollama (locale)' };
	const workflows = opts.workflows ?? [{ name: 'sd-base', kinds: ['image'], workflow: imageWorkflow() }];
	const availability = opts.availability ?? reachableAvailability();

	const adapters: OrchestratorAdapters = {
		async selectProvider(_ctx: RouteContext): Promise<SelectedProvider | undefined> {
			return provider;
		},
		async listWorkflows(): Promise<LocalWorkflow[]> {
			return workflows;
		},
		async comfyAvailability(): Promise<ComfyAvailabilityInfo> {
			return availability;
		},
		async execute(ctx: ExecuteContext): Promise<GeneratedItem[]> {
			executeCalls.push(ctx);
			if (opts.execute) {
				return opts.execute(ctx);
			}
			return [fakeItem(ctx.kind === 'image' ? 'image' : 'video', ctx.request.prompt)];
		},
		emitTelemetry(event: TelemetryEvent): void {
			telemetry.push(event);
		},
		...(opts.installMissingNodes
			? { installMissingNodes: async (ctx: RecoveryContext) => { recoveryCalls.push(ctx); return opts.installMissingNodes!(ctx); } }
			: {}),
		...(opts.downloadMissingModels
			? { downloadMissingModels: async (ctx: RecoveryContext) => { recoveryCalls.push(ctx); return opts.downloadMissingModels!(ctx); } }
			: {}),
	};

	return { adapters, executeCalls, telemetry, recoveryCalls };
}

/** Ordine canonico atteso delle fasi del piano (Req 1.2). */
const CANONICAL: PlanStepGen['kind'][] = ['select-workflow', 'check-deps', 'set-inputs', 'execute', 'report'];

// --------------------------------------------------------------------------------------------
// 1) PERCORSO FELICE (immagine): success + media + stepsExecuted in ordine canonico (Req 1.3, 1.4)
// --------------------------------------------------------------------------------------------
test('percorso felice immagine: status success, media e passi in ordine canonico + riepilogo', async () => {
	const { adapters, executeCalls } = makeAdapters();
	const orch = new GenOrchestrator(adapters);

	const req: GenRequest = { prompt: 'un ritratto fotografico di un gatto' };
	assert.strictEqual(orch.classify(req), 'image', 'la richiesta con marcatore immagine è classificata image');

	const { cb, assistantTexts } = makeCallbacks();
	const outcome = await orch.run(req, cb);

	assert.strictEqual(outcome.status, 'success', 'il percorso felice deve avere status success');
	assert.strictEqual(outcome.media.length, 1, 'deve restituire i media prodotti');
	assert.strictEqual(outcome.media[0].kind, 'image', 'il media prodotto è un\'immagine');
	assert.strictEqual(outcome.failedStep, undefined, 'nessun passo fallito nel percorso felice');

	// stepsExecuted nell'ORDINE CANONICO completo (Req 1.2, 1.3).
	assert.deepStrictEqual(outcome.stepsExecuted.map(s => s.kind), CANONICAL, 'i passi eseguiti sono nell\'ordine canonico');

	// L'adapter di esecuzione è stato invocato con il tipo e il prompt corretti.
	assert.strictEqual(executeCalls.length, 1, 'execute invocato una volta');
	assert.strictEqual(executeCalls[0].kind, 'image');
	assert.strictEqual(executeCalls[0].request.prompt, req.prompt);

	// Riepilogo riportato all'utente (Req 1.4): cita esito, output e passi eseguiti.
	const summary = assistantTexts.find(t => /completata/i.test(t));
	assert.ok(summary, 'deve riportare un riepilogo di completamento');
	assert.ok(/select-workflow → check-deps → set-inputs → execute → report/.test(summary!), 'il riepilogo elenca i passi eseguiti');
});

// --------------------------------------------------------------------------------------------
// 1b) PERCORSO FELICE (video T2V): success con media video e ordine canonico
// --------------------------------------------------------------------------------------------
test('percorso felice video T2V: status success con media video', async () => {
	const { adapters, executeCalls } = makeAdapters({
		workflows: [{ name: 'wan-t2v', kinds: ['t2v'], workflow: videoWorkflow() }],
	});
	const orch = new GenOrchestrator(adapters);

	const req: GenRequest = { prompt: 'un breve video di onde che si infrangono' };
	assert.strictEqual(orch.classify(req), 't2v', 'la richiesta con marcatore video è classificata t2v');

	const { cb } = makeCallbacks();
	const outcome = await orch.run(req, cb);

	assert.strictEqual(outcome.status, 'success', 'il percorso felice video deve avere status success');
	assert.strictEqual(outcome.media[0].kind, 'video', 'il media prodotto è un video');
	assert.deepStrictEqual(outcome.stepsExecuted.map(s => s.kind), CANONICAL, 'ordine canonico anche per il video');
	assert.strictEqual(executeCalls[0].kind, 't2v', 'execute invocato per il tipo t2v');
});

// --------------------------------------------------------------------------------------------
// 2a) STOP: nessun provider LLM → fail su select-workflow con causa (Req 2.4, 1.5)
// --------------------------------------------------------------------------------------------
test('stop su provider assente: failed su select-workflow con causa in linguaggio naturale', async () => {
	const { adapters, executeCalls } = makeAdapters({ provider: undefined });
	const orch = new GenOrchestrator(adapters);

	const { cb } = makeCallbacks();
	const outcome = await orch.run({ prompt: 'una foto di montagne' }, cb);

	assert.strictEqual(outcome.status, 'failed', 'senza provider il run fallisce');
	assert.ok(outcome.failedStep, 'deve indicare il passo fallito');
	assert.strictEqual(outcome.failedStep!.kind, 'select-workflow', 'fallisce alla selezione');
	assert.ok(outcome.cause && /provider/i.test(outcome.cause), 'la causa cita il provider mancante');
	assert.strictEqual(outcome.stepsExecuted.length, 0, 'nessun passo completato prima del fallimento');
	assert.strictEqual(executeCalls.length, 0, 'execute non deve essere invocato');
});

// --------------------------------------------------------------------------------------------
// 2b) STOP: ComfyUI irraggiungibile → fail su check-deps con causa (Req 1.5)
// --------------------------------------------------------------------------------------------
test('stop su ComfyUI irraggiungibile: failed su check-deps con causa', async () => {
	const { adapters } = makeAdapters({
		availability: { reachable: false, endpoint: ENDPOINT, models: new Set(), nodes: new Set() },
	});
	const orch = new GenOrchestrator(adapters);

	const { cb } = makeCallbacks();
	const outcome = await orch.run({ prompt: 'una foto di montagne' }, cb);

	assert.strictEqual(outcome.status, 'failed');
	assert.strictEqual(outcome.failedStep!.kind, 'check-deps', 'fallisce alla verifica delle dipendenze');
	assert.ok(outcome.cause && /ComfyUI/i.test(outcome.cause), 'la causa cita ComfyUI non raggiungibile');
	// select-workflow è stato completato prima dello stop.
	assert.deepStrictEqual(outcome.stepsExecuted.map(s => s.kind), ['select-workflow']);
});

// --------------------------------------------------------------------------------------------
// 2c) STOP: parametri non mappabili → fail su set-inputs con causa (Req 3.4, 3.2, 1.5)
// --------------------------------------------------------------------------------------------
test('stop su parametri non mappabili: failed su set-inputs con causa', async () => {
	const { adapters, executeCalls } = makeAdapters({
		workflows: [{ name: 'broken', kinds: ['image'], workflow: unmappableWorkflow() }],
	});
	const orch = new GenOrchestrator(adapters);

	const { cb } = makeCallbacks();
	const outcome = await orch.run({ prompt: 'un disegno di una casa' }, cb);

	assert.strictEqual(outcome.status, 'failed');
	assert.strictEqual(outcome.failedStep!.kind, 'set-inputs', 'fallisce alla mappatura degli input');
	assert.ok(outcome.cause && /positivePrompt/.test(outcome.cause), 'la causa elenca il parametro non mappabile');
	assert.deepStrictEqual(outcome.stepsExecuted.map(s => s.kind), ['select-workflow', 'check-deps']);
	assert.strictEqual(executeCalls.length, 0, 'execute non invocato se gli input non sono mappabili');
});

// --------------------------------------------------------------------------------------------
// 3) DISAMBIGUAZIONE LLM: richiesta ambigua → onAsk conferma il tipo → procede (Req 1.6, 3.2)
// --------------------------------------------------------------------------------------------
test('disambiguazione: richiesta ambigua usa onAsk e poi procede con il tipo scelto', async () => {
	const { adapters, executeCalls } = makeAdapters(); // workflow immagine di default
	const orch = new GenOrchestrator(adapters);

	const req: GenRequest = { prompt: 'un castello sulla collina al tramonto' };
	assert.strictEqual(orch.classify(req), 'ambiguous', 'senza marcatori di tipo la richiesta è ambigua');

	// onAsk risponde "Immagine" → l'Orchestratore deve adottare il tipo image e procedere.
	const { cb, asks } = makeCallbacks('Immagine');
	const outcome = await orch.run(req, cb);

	assert.strictEqual(asks.length, 1, 'deve porre esattamente una domanda di disambiguazione');
	assert.ok(/tipo di contenuto/i.test(asks[0].question), 'la domanda chiede il tipo di contenuto');
	assert.ok(asks[0].options.length >= 2, 'offre opzioni tra cui scegliere');

	assert.strictEqual(outcome.status, 'success', 'dopo la conferma il run completa con successo');
	assert.deepStrictEqual(outcome.stepsExecuted.map(s => s.kind), CANONICAL, 'procede con tutte le fasi');
	assert.strictEqual(executeCalls[0].kind, 'image', 'esegue il tipo confermato dall\'utente');
});

// --------------------------------------------------------------------------------------------
// 3b) DISAMBIGUAZIONE: senza onAsk il tipo ambiguo resta non confermato (needs-confirmation)
// --------------------------------------------------------------------------------------------
test('disambiguazione: senza canale di domanda l\'esito è needs-confirmation', async () => {
	const { adapters, executeCalls } = makeAdapters();
	const orch = new GenOrchestrator(adapters);

	const { cb } = makeCallbacks(); // niente onAsk
	const outcome = await orch.run({ prompt: 'un castello sulla collina al tramonto' }, cb);

	assert.strictEqual(outcome.status, 'needs-confirmation', 'senza conferma non si procede');
	assert.ok(outcome.cause && /ambigu/i.test(outcome.cause), 'la causa segnala l\'ambiguità');
	assert.strictEqual(executeCalls.length, 0, 'non esegue nulla senza conferma del tipo');
});

// --------------------------------------------------------------------------------------------
// 4) PRIVACY DEL PROMPT: il prompt non compare in alcun evento di telemetria (Req 21.1, 21.2)
// --------------------------------------------------------------------------------------------
test('privacy: il testo del prompt non raggiunge la telemetria, solo l\'adapter di esecuzione', async () => {
	const { adapters, executeCalls, telemetry } = makeAdapters();
	const orch = new GenOrchestrator(adapters);

	// Prompt con un token unico facile da cercare in qualsiasi serializzazione.
	const SECRET = 'TOKEN_SEGRETO_PROMPT_9f3a2b';
	const req: GenRequest = { prompt: `una foto con ${SECRET} dettaglio` };

	const { cb } = makeCallbacks();
	const outcome = await orch.run(req, cb);
	assert.strictEqual(outcome.status, 'success');

	// Lo spy di telemetria deve aver catturato eventi (start + complete): la verifica è significativa.
	assert.ok(telemetry.length >= 1, 'devono essere stati emessi eventi di telemetria');

	// Il token del prompt NON deve comparire in NESSUN evento serializzato (Req 21.1, 21.2).
	for (const ev of telemetry) {
		const serialized = JSON.stringify(ev);
		assert.ok(!serialized.includes(SECRET), `la telemetria non deve contenere il prompt: ${serialized}`);
	}

	// Il prompt RAGGIUNGE invece il servizio selezionato per la richiesta (adapter execute).
	assert.strictEqual(executeCalls.length, 1, 'execute invocato una volta');
	assert.strictEqual(executeCalls[0].request.prompt, req.prompt, 'il prompt è inoltrato all\'adapter di esecuzione');
	assert.ok(executeCalls[0].request.prompt.includes(SECRET), 'il backend selezionato riceve il prompt completo');
});

// --------------------------------------------------------------------------------------------
// Runner sequenziale
// --------------------------------------------------------------------------------------------
async function run(): Promise<void> {
	for (const { name, fn } of cases) {
		try {
			await fn();
			passed++;
			console.log(`ok   - ${name}`);
		} catch (e) {
			failed++;
			console.error(`FAIL - ${name}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
	console.log(`\n${passed} passed, ${failed} failed`);
	if (failed > 0) {
		process.exit(1);
	}
}

void run();
