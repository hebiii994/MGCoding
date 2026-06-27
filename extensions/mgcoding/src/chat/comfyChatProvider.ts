/*---------------------------------------------------------------------------------------------
 *  MGCoding - ComfyChat: chat dedicata collegata a ComfyUI.
 *
 *  Due capacità:
 *   1. GENERAZIONE — instrada le richieste di generazione (immagine / T2V / I2V) all'Orchestratore
 *      (`GenOrchestrator`), che classifica, sceglie il workflow, esegue e salva in Galleria.
 *   2. DIAGNOSTICA — raccoglie lo STATO REALE di ComfyUI (raggiungibilità, nodi/modelli mancanti
 *      del workflow attivo, ultimo errore di esecuzione da /history), lo fa spiegare all'LLM in
 *      linguaggio naturale e propone PULSANTI d'azione che eseguono comandi sicuri di MGCoding
 *      (installa nodi/modelli, riavvia ComfyUI, importa workflow). Affidabile con qualsiasi modello.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import type { AgentCallbacks } from '../agent/agentLoop';
import type { ProviderRegistry } from '../llm/registry';
import type { ChatMessage } from '../llm/types';
import type { GenKind, GenRequest, GeneratedItem } from '../media/genTypes';
import { classify } from '../media/requestClassifier';
import { createDefaultOrchestrator } from '../agent/genOrchestrator';
import { detectComfyStatus, comfyLists, comfyEndpoint } from '../media/comfyLifecycle';
import { loadWorkflow, missingNodes, missingModels, generatedDirUri, installComfyPythonModule, findSuspiciousModelFiles } from '../media/comfyHelper';

/** Azione proposta nella chat: etichetta + comando MGCoding (o modulo Python da installare). */
interface ChatAction {
	label: string;
	command: string;
	/** Se valorizzato, il click installa questo modulo Python nel python embedded di ComfyUI. */
	module?: string;
}

/** Problema RICONOSCIUTO da una firma deterministica nell'errore: causa precisa + azioni mirate. */
interface KnownIssue {
	id: string;
	title: string;
	/** Causa radice in linguaggio naturale (specifica, niente genericità). */
	rootCause: string;
	/** Passi concreti per risolvere (markdown breve). */
	fix: string;
	actions: ChatAction[];
}

/** Diagnostica strutturata dello stato di ComfyUI. */
interface ComfyDiagnostics {
	reachable: boolean;
	endpoint: string;
	checkpoints: number;
	loras: number;
	nodes: number;
	activeWorkflow: string;
	missingNodes: string[];
	missingModels: string[];
	lastError?: string;
	/** Nome del modulo Python mancante estratto da un ModuleNotFoundError (se presente). */
	missingPyModule?: string;
	/** Riepilogo della CONFIG REALE dei nodi dell'ultimo run (dal grafo /history). */
	config?: string;
	/** Note euristiche sulla configurazione reale (es. VAE incoerente, pochi step senza LoRA). */
	configNotes?: string[];
	/** Testo compatto da passare all'LLM come contesto. */
	summary: string;
}

/**
 * Estrae la RISPOSTA visibile da un testo che può contenere il ragionamento del modello tra
 * tag `<think>…</think>` (o `<thinking>`). Rimuove i blocchi completi e, se un tag di apertura
 * è ancora aperto (streaming in corso), nasconde tutto ciò che segue finché non si chiude.
 * Così la chat mostra SOLO la risposta vera, mai il "ragionamento".
 */
function visibleAnswer(s: string): string {
	let out = s.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '');
	const open = out.search(/<think(?:ing)?>/i);
	if (open !== -1) {
		out = out.slice(0, open);
	}
	return out.replace(/^\s+/, '');
}

/**
 * "Capacità" di MGCoding richiamabili come pulsanti: un piccolo insieme FISSO di azioni. Gli
 * errori NON aggiungono pulsanti propri: si limitano a SELEZIONARE quali capacità sono utili
 * (vedi COMFY_SIGNALS). Così aggiungere un nuovo errore = aggiungere una riga di dati, non codice.
 */
const COMFY_CAP = {
	repairTriton: { label: '🛠 Ripara Triton (python libs)', command: 'mgcoding.repairComfyTriton' },
	restart: { label: '🔄 Riavvia ComfyUI', command: 'mgcoding.restartComfyUI' },
	start: { label: '▶ Avvia ComfyUI', command: 'mgcoding.startComfyUI' },
	openModels: { label: '📂 Apri cartella modelli ComfyUI', command: 'mgcoding.openComfyModelsFolder' },
	downloadModels: { label: '⬇ Scarica modelli del workflow', command: 'mgcoding.installMissingModels' },
	installNodes: { label: '🧩 Installa nodi da workflow', command: 'mgcoding.installNodesFromFile' },
	importWorkflow: { label: '⬆ Importa workflow', command: 'mgcoding.importWorkflow' },
} as const satisfies Record<string, ChatAction>;

type ComfyCapId = keyof typeof COMFY_CAP;

/**
 * Catalogo DATA-DRIVEN dei problemi noti: ogni voce è una firma testuale (regex sull'ultimo
 * errore) con causa, soluzione e le CAPACITÀ pertinenti. La prima che combacia vince. Per
 * coprire un nuovo errore basta aggiungere una riga qui, senza toccare la logica.
 */
const COMFY_SIGNALS: { id: string; re: RegExp; title: string; cause: string; fix: string; caps: ComfyCapId[] }[] = [
	{
		id: 'sage-triton',
		re: /sageattention|attention_sage|failed to find python libs|triton.*(tcc|cuda_utils|compile|non-zero exit|build\.py|\.lib|\.pyd)/,
		title: 'SageAttention/Triton non riesce a compilare a runtime',
		cause: 'Il workflow usa SageAttention (di norma il nodo KJNodes "Patch Sage Attention"), che si appoggia a Triton: Triton compila al volo un modulo CUDA con il compilatore C (tcc.exe). La build fallisce perché il Python EMBEDDED di ComfyUI non contiene le librerie di sviluppo (pythonXY.lib e gli header in Include/): da qui il messaggio "Failed to find Python libs".',
		fix: '1. **Sicura (consigliata):** disabilita Sage Attention nel workflow — nodo KJNodes "Patch Sage Attention KJ" su **disabled**, oppure bypass/mute del nodo (Ctrl+B / Ctrl+M). Gira con l\'attention di PyTorch.\n2. **Prestazioni:** premi «🛠 Ripara Triton» (aggiunge le dev libs Python mancanti e reinstalla triton-windows), poi riavvia ComfyUI.',
		caps: ['repairTriton', 'restart'],
	},
	{
		id: 'oom',
		re: /out of memory|cuda out of memory|outofmemoryerror|hip out of memory|insufficient.{0,10}memory|alloc(ate)?.{0,20}memory/,
		title: 'Memoria GPU (VRAM) insufficiente',
		cause: 'L\'esecuzione ha esaurito la VRAM della GPU. Con i modelli video (WAN) e risoluzioni/frame elevati 12 GB si saturano facilmente.',
		fix: 'Riduci risoluzione, numero di frame e/o batch; usa una quantizzazione più leggera (GGUF Q4/Q5); avvia ComfyUI con `--lowvram` (o `--novram`); chiudi altre app che usano la GPU. Poi riprova.',
		caps: ['restart'],
	},
	{
		id: 'corrupt-model',
		re: /expecting value: line 1 column 1|json\.?decoder|invalid load key|unpicklingerror|headertoolarge|pytorchstreamreader failed|not a zip( file)?| central directory|unexpected eof|eoferror|ran out of input|safetensorerror/,
		title: 'File del modello corrotto o incompleto',
		cause: 'Il caricamento del modello fallisce perché il file è vuoto, troncato o non valido (errore tipico: "Expecting value: line 1 column 1 (char 0)"). Di solito è un download interrotto, un file da pochi KB (una pagina HTML d\'errore al posto del modello) o un puntatore Git LFS non risolto.',
		fix: 'Apri la cartella modelli di ComfyUI e individua il file usato da quel nodo (es. models/upscale_models, models/vae, models/checkpoints): se è di **0 byte o pochi KB** è corrotto. **Eliminalo e riscaricalo** dalla fonte ufficiale, poi riavvia ComfyUI.',
		caps: ['openModels', 'downloadModels', 'restart'],
	},
	{
		id: 'model-mismatch',
		re: /size mismatch|error\(s\) in loading state_dict|shapes cannot be multiplied|mat1 and mat2|expected.{0,30}channels|dimension out of range/,
		title: 'Modello incompatibile con il workflow',
		cause: 'I tensori non combaciano (size/shape mismatch): di norma stai caricando un modello della famiglia o versione sbagliata (es. VAE/CLIP/checkpoint non compatibili, un SD1.5 dove serve SDXL/FLUX/WAN, o un LoRA per un\'altra base).',
		fix: 'Verifica che checkpoint, VAE, CLIP/text-encoder e LoRA appartengano alla STESSA famiglia richiesta dal workflow. Sostituisci il modello incompatibile con quello corretto e riprova.',
		caps: ['openModels', 'restart'],
	},
];

/** Nodo del grafo API di ComfyUI (come appare in /history): tipo + input (widget o link). */
type GraphNode = { class_type?: string; inputs?: Record<string, unknown> };

/** Valore "letterale" di un input (widget): stringa/numero/bool. I link sono array → undefined. */
function litValue(v: unknown): string | number | boolean | undefined {
	return (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') ? v : undefined;
}

/**
 * Estrae dal grafo API REALE (l'ultimo run da /history) un riepilogo leggibile della
 * configurazione dei nodi chiave (modello, VAE, CLIP, LoRA, sampler, shift, upscale, dimensioni)
 * e alcune NOTE euristiche sui problemi tipici (pochi step senza LoRA, VAE incoerente col
 * modello, stadi del sampler non contigui). Logica PURA: niente vscode/fetch → testabile.
 */
function summarizeComfyGraph(graph: Record<string, GraphNode>): { summary: string; notes: string[] } {
	const lines: string[] = [];
	const notes: string[] = [];
	const samplers: { id: string; steps?: number; cfg?: number; sampler?: string; scheduler?: string; denoise?: number; start?: number; end?: number; addNoise?: string; leftover?: string }[] = [];
	const loras: { name?: string; sm?: number; sc?: number }[] = [];
	const modelNames: string[] = [];
	const clipNames: string[] = [];
	let vaeName: string | undefined;
	let hasVaeLoader = false;
	let shift: number | undefined;
	let upscale: string | undefined;
	const sizes: string[] = [];

	for (const [id, node] of Object.entries(graph)) {
		const ct = node?.class_type ?? '';
		const inp = node?.inputs ?? {};
		if (/KSampler/i.test(ct)) {
			samplers.push({
				id,
				steps: litValue(inp.steps) as number | undefined,
				cfg: litValue(inp.cfg) as number | undefined,
				sampler: litValue(inp.sampler_name) as string | undefined,
				scheduler: litValue(inp.scheduler) as string | undefined,
				denoise: litValue(inp.denoise) as number | undefined,
				start: litValue(inp.start_at_step) as number | undefined,
				end: litValue(inp.end_at_step) as number | undefined,
				addNoise: litValue(inp.add_noise) as string | undefined,
				leftover: litValue(inp.return_with_leftover_noise) as string | undefined,
			});
		} else if (/VAELoader/i.test(ct)) {
			hasVaeLoader = true;
			vaeName = litValue(inp.vae_name) as string | undefined;
		} else if (/(CheckpointLoader|UNETLoader|UnetLoaderGGUF|DiffusionModelLoader|DiffusersLoader)/i.test(ct)) {
			const n = litValue(inp.ckpt_name) ?? litValue(inp.unet_name) ?? litValue(inp.model_name);
			if (n) { modelNames.push(String(n)); }
		} else if (/(CLIPLoader|DualCLIPLoader|CLIPLoaderGGUF|QuadrupleCLIPLoader|TripleCLIPLoader)/i.test(ct)) {
			for (const k of ['clip_name', 'clip_name1', 'clip_name2', 'clip_name3']) {
				const n = litValue(inp[k]);
				if (n) { clipNames.push(String(n)); }
			}
		} else if (/Lora/i.test(ct)) {
			loras.push({ name: litValue(inp.lora_name) as string | undefined, sm: litValue(inp.strength_model) as number | undefined, sc: litValue(inp.strength_clip) as number | undefined });
		} else if (/ModelSampling/i.test(ct)) {
			const s = litValue(inp.shift);
			if (typeof s === 'number') { shift = s; }
		} else if (/UpscaleModelLoader/i.test(ct)) {
			upscale = litValue(inp.model_name) as string | undefined;
		} else if (/(EmptyLatent|EmptyHunyuan|EmptySD3|EmptyMochi|WanImageToVideo|.*LatentVideo|EmptyCosmos)/i.test(ct)) {
			const w = litValue(inp.width);
			const h = litValue(inp.height);
			const len = litValue(inp.length) ?? litValue(inp.frames) ?? litValue(inp.batch_size);
			if (w || h || len !== undefined) {
				sizes.push(`${w ?? '?'}x${h ?? '?'}${len !== undefined ? ` · ${len} frame/batch` : ''}`);
			}
		}
	}

	if (modelNames.length) { lines.push(`Modello: ${modelNames.join(', ')}`); }
	if (clipNames.length) { lines.push(`Text-encoder/CLIP: ${clipNames.join(', ')}`); }
	lines.push(`VAE: ${hasVaeLoader ? (vaeName ?? '(loader senza nome)') : '(nessun VAELoader: usa la VAE del checkpoint)'}`);
	lines.push(loras.length ? `LoRA: ${loras.map(l => `${l.name ?? '?'} (model ${l.sm ?? '?'}, clip ${l.sc ?? '?'})`).join('; ')}` : 'LoRA: nessuna');
	if (shift !== undefined) { lines.push(`Shift (ModelSampling): ${shift}`); }
	if (upscale) { lines.push(`Upscale model: ${upscale}`); }
	if (sizes.length) { lines.push(`Dimensioni/frame: ${sizes.join(', ')}`); }
	samplers.forEach((s, i) => lines.push(
		`Sampler ${i + 1} (${s.id}): steps ${s.steps ?? '?'}, cfg ${s.cfg ?? '?'}, ${s.sampler ?? '?'}/${s.scheduler ?? '?'}`
		+ `${s.denoise !== undefined ? `, denoise ${s.denoise}` : ''}`
		+ `${s.start !== undefined || s.end !== undefined ? `, step ${s.start ?? '?'}->${s.end ?? '?'}` : ''}`
		+ `${s.addNoise ? `, add_noise ${s.addNoise}` : ''}${s.leftover ? `, leftover ${s.leftover}` : ''}`
	));

	// --- Euristiche sui problemi tipici (sulla CONFIG REALE) ---
	const stepVals = samplers.map(s => s.steps).filter((x): x is number => typeof x === 'number');
	const cfgVals = samplers.map(s => s.cfg).filter((x): x is number => typeof x === 'number');
	const maxSteps = stepVals.length ? Math.max(...stepVals) : 0;
	const minCfg = cfgVals.length ? Math.min(...cfgVals) : Infinity;
	if (samplers.length && maxSteps > 0 && maxSteps <= 8 && minCfg <= 1.5 && loras.length === 0) {
		notes.push('Pochi step (≤8) con CFG basso (≤1.5) e NESSUNA LoRA caricata: senza una LoRA distillata (WAN2.2-Lightning / LightX2V) il latente non viene denoisato → rumore. Aggiungi la LoRA distillata, oppure alza gli step (20-30) e il CFG (5-7).');
	}
	const looksWan = modelNames.concat(clipNames).some(n => /wan|umt5/i.test(n));
	if (looksWan && hasVaeLoader && vaeName && !/wan/i.test(vaeName)) {
		notes.push(`Il modello sembra WAN ma la VAE selezionata è "${vaeName}" (non sembra una VAE WAN): una VAE sbagliata produce proprio rumore colorato. Usa la VAE di WAN.`);
	}
	if (samplers.length >= 2) {
		const a = samplers[0];
		const b = samplers[1];
		if (typeof a.end === 'number' && typeof b.start === 'number' && a.end !== b.start) {
			notes.push(`I due stadi del sampler non sono contigui: lo stadio 1 finisce allo step ${a.end}, lo stadio 2 inizia a ${b.start} (dovrebbero combaciare per un denoise completo).`);
		}
	}
	return { summary: lines.join('\n'), notes };
}

export class ComfyChatProvider implements vscode.WebviewViewProvider {
	static readonly viewType = 'mgcoding.comfyChat';
	private view?: vscode.WebviewView;
	private abort?: AbortController;
	/** Storico conversazione (per dare contesto all'LLM nelle domande diagnostiche). */
	private readonly history: ChatMessage[] = [];

	constructor(private readonly extensionUri: vscode.Uri, private readonly registry: ProviderRegistry) { }

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		view.webview.options = {
			enableScripts: true,
			localResourceRoots: [this.extensionUri, generatedDirUri(), ...(vscode.workspace.workspaceFolders?.map(f => f.uri) ?? [])]
		};
		view.webview.html = this.html();
		view.webview.onDidReceiveMessage(async (msg: { type: string;[k: string]: unknown }) => {
			switch (msg.type) {
				case 'send':
					await this.handleSend(String(msg.text ?? '').trim());
					break;
				case 'cancel':
					this.abort?.abort();
					break;
				case 'cmd':
					await vscode.commands.executeCommand(String(msg.command));
					break;
				case 'installPy':
					await installComfyPythonModule(String(msg.module ?? ''));
					break;
			}
		});
	}

	/** Mostra il pannello e gli dà focus. */
	focus(): void {
		void vscode.commands.executeCommand('mgcoding.comfyChat.focus');
	}

	// ---- Invio messaggio dell'utente -------------------------------------------------------

	private async handleSend(text: string): Promise<void> {
		if (!text || !this.view) {
			return;
		}
		this.post({ type: 'user', text });
		this.busy(true);
		this.abort = new AbortController();
		try {
			if (this.isGenerationRequest(text)) {
				await this.runGeneration(text);
			} else {
				await this.runDiagnosticOrAnswer(text);
			}
		} catch (err) {
			this.post({ type: 'assistant', text: `Errore: ${err instanceof Error ? err.message : String(err)}` });
		} finally {
			this.busy(false);
			this.abort = undefined;
		}
	}

	/** Euristica d'intento: la richiesta chiede di GENERARE qualcosa (vs diagnosi/domanda)? */
	private isGenerationRequest(text: string): boolean {
		const t = text.toLowerCase();
		const wantsGen = /\b(genera|generami|crea(mi)?|disegna|fammi|produci|rendi|renderizza|anima|animazione|immagine|imm\b|foto|ritratto|video|clip|t2v|i2v)\b/.test(t);
		const wantsDiag = /\b(error|errore|non funziona|non va|problema|perch[eé]|risolvi|aggiusta|sistema|diagnos|stato|log|riavvia|manca(no)?|missing)\b/.test(t);
		// Se chiede esplicitamente di generare e NON è una domanda diagnostica, è generazione.
		return wantsGen && !wantsDiag;
	}

	// ---- Generazione via Orchestratore -----------------------------------------------------

	private async runGeneration(text: string): Promise<void> {
		const req: GenRequest = { prompt: text };
		const kind = classify(req);
		this.post({ type: 'status', text: kind === 'ambiguous' ? 'Richiesta da chiarire…' : `Tipo rilevato: ${this.kindLabel(kind)}` });

		const cb: AgentCallbacks = {
			onAssistantText: (t: string) => this.post({ type: 'assistant', text: t }),
			onToolStart: (c) => this.post({ type: 'status', text: `▶ ${c.tool}` }),
			onToolResult: (r: string) => this.post({ type: 'status', text: r }),
			// Disambiguazione del tipo di contenuto (Req 1.6): chiede all'utente con un quick pick.
			onAsk: async (question: string, options: string[]) => {
				const pick = await vscode.window.showQuickPick(options, { title: question, placeHolder: question });
				return pick ?? '';
			},
		};

		const orch = createDefaultOrchestrator(this.registry);
		const outcome = await orch.run(req, cb, this.abort?.signal);

		if (outcome.status === 'success') {
			this.postMedia(outcome.media);
			if (outcome.media.length === 0) {
				this.post({ type: 'assistant', text: 'Esecuzione completata, ma nessun file prodotto.' });
			}
		} else if (outcome.status === 'needs-confirmation') {
			this.post({ type: 'assistant', text: outcome.cause ?? 'Serve confermare il tipo di contenuto.' });
		} else if (outcome.status === 'cancelled') {
			this.post({ type: 'assistant', text: 'Generazione annullata.' });
		} else {
			// Fallita: spiega la causa e proponi azioni pertinenti.
			const step = outcome.failedStep ? ` (fase: ${outcome.failedStep.kind})` : '';
			this.post({ type: 'assistant', text: `Non sono riuscito a generare${step}: ${outcome.cause ?? 'causa sconosciuta'}` });
			this.post({ type: 'actions', items: await this.suggestActionsForFailure(outcome.cause ?? '') });
		}
	}

	/** Pubblica i media generati nel webview (anteprima immagine/video). */
	private postMedia(media: GeneratedItem[]): void {
		if (!this.view || media.length === 0) {
			return;
		}
		const items = media.map(m => ({
			name: m.uri.split(/[\\/]/).pop() ?? m.uri,
			src: this.view!.webview.asWebviewUri(vscode.Uri.file(m.uri)).toString(),
			path: m.uri,
			kind: m.kind,
			format: m.format,
		}));
		this.post({ type: 'media', items });
	}

	// ---- Diagnostica + risposta LLM --------------------------------------------------------

	private async runDiagnosticOrAnswer(text: string): Promise<void> {
		this.post({ type: 'status', text: 'Controllo lo stato di ComfyUI…' });
		const diag = await this.collectDiagnostics();

		// Richiesta ESPLICITA di vedere la configurazione del workflow → mostra il grafo reale
		// dell'ultimo run (deterministico, niente LLM) e basta.
		if (this.isConfigRequest(text)) {
			if (diag.config) {
				const notes = diag.configNotes && diag.configNotes.length
					? `\n\nPossibili anomalie:\n${diag.configNotes.map(n => `• ${n}`).join('\n')}`
					: '';
				this.post({ type: 'assistant', text: `🧩 Configurazione REALE dell'ultimo run (letta dai nodi):\n\n${diag.config}${notes}` });
			} else if (!diag.reachable) {
				this.post({ type: 'assistant', text: 'ComfyUI non è raggiungibile: avvialo per poter leggere la configurazione dei nodi.' });
			} else {
				this.post({ type: 'assistant', text: 'Non trovo un run recente in /history da cui leggere la configurazione. Esegui una volta il workflow (Run) in ComfyUI, poi richiedimelo.' });
			}
			this.post({ type: 'actions', items: this.dedupActions(this.suggestActionsForDiagnostics(diag)) });
			return;
		}

		// Un errore di esecuzione ha la precedenza; altrimenti, se l'utente lamenta la QUALITÀ
		// dell'output (rumore/artefatti) senza che ci sia un errore, dai la checklist dedicata.
		const known = this.classifyKnownIssue(diag) ?? this.classifyQualityComplaint(text);

		// (1) DETERMINISTICO: se l'errore corrisponde a un problema noto, dai SUBITO la diagnosi
		// precisa (causa + soluzione). È sempre corretta e specifica, a prescindere dall'LLM:
		// risolve il "consiglio generico ripetuto". Testo PULITO (il webview mostra testo semplice).
		// AUTONOMIA: per i problemi "modello corrotto/errore generico" scansiono la cartella modelli
		// e segnalo io stesso i file troppo piccoli (probabile download fallito), col nome e i KB.
		let suspiciousNote = '';
		if (known && (known.id === 'corrupt-model' || known.id === 'generic-exec-error')) {
			try {
				const small = await findSuspiciousModelFiles();
				if (small.length) {
					suspiciousNote = '\n\nFile modello SOSPETTI (troppo piccoli per essere validi → probabile download corrotto):\n'
						+ small.map(s => `• ${s.rel} — ${s.kb} KB`).join('\n')
						+ '\nUn modello reale pesa decine/centinaia di MB. Se un file è di pochi KB, eliminalo e riscaricalo: spesso è una pagina HTML o un puntatore Git LFS salvato al posto del file. Su HuggingFace usa il link "download" diretto del file, non la pagina del repo.';
				}
			} catch { /* scan best-effort */ }
		}
		// Inspector: per problemi di qualità/errori generici mostra le anomalie trovate nella
		// CONFIG REALE dei nodi (es. VAE incoerente, pochi step senza LoRA, stadi non contigui).
		let configNote = '';
		if (known && (known.id === 'quality' || known.id === 'generic-exec-error') && diag.configNotes && diag.configNotes.length) {
			configNote = '\n\nDalla configurazione REALE dei nodi dell\'ultimo run rilevo:\n' + diag.configNotes.map(n => `• ${n}`).join('\n');
		}
		if (known) {
			const clean = (t: string): string => t.replace(/\*\*/g, '').replace(/`/g, '');
			this.post({ type: 'assistant', text: `🔎 ${clean(known.title)}\n\nCausa: ${clean(known.rootCause)}\n\nCome risolvere:\n${clean(known.fix)}${suspiciousNote}${configNote}` });
		}

		// (2) LLM: elaborazione/risposta alla domanda, ANCORATA allo stato reale e (se presente)
		// al problema riconosciuto, con istruzione esplicita di NON essere generico.
		const system = 'Sei l\'assistente ComfyUI di MGCoding. Ti fornisco lo STATO REALE di ComfyUI'
			+ (known ? ' e un PROBLEMA RICONOSCIUTO con causa e soluzione già accertate.' : '.')
			+ ' Rispondi in italiano, conciso e concreto, basandoti SOLO sui dati forniti: non inventare nodi, modelli o errori. '
			+ (known
				? 'Il problema è GIÀ stato diagnosticato qui sopra: NON ripetere consigli generici (tipo "controlla compatibilità", "cerca nella community"). Aggiungi solo dettagli utili e operativi sulla soluzione indicata, o rispondi a ciò che chiede l\'utente. '
				: 'Se servono azioni (installare nodi/modelli, riparare Triton, riavviare ComfyUI, importare un workflow), indicale chiaramente: ')
			+ 'l\'utente ha pulsanti dedicati sotto la risposta.';
		const brief = known
			? `\n\n=== PROBLEMA RICONOSCIUTO ===\nTitolo: ${known.title}\nCausa: ${known.rootCause}\nSoluzione: ${known.fix}${suspiciousNote}`
			: '';
		const userMsg = `Domanda: ${text}\n\n=== STATO COMFYUI ===\n${diag.summary}${brief}`;
		this.history.push({ role: 'user', content: userMsg });

		// L'LLM serve solo quando NON c'è una diagnosi deterministica completa: per un problema
		// noto e specifico la risposta qui sopra è già esaustiva, quindi evitiamo il giro LLM
		// (niente ridondanza né "ragionamento" misto alla risposta). Per gli errori generici o
		// le domande libere, invece, l'LLM elabora.
		const useLLM = !known || known.id === 'generic-exec-error' || known.id === 'quality';
		if (useLLM) {
			await this.streamLLM(system, this.history);
		} else {
			this.history.push({ role: 'assistant', content: `${known.title}. ${known.rootCause}` });
		}

		// (3) Pulsanti d'azione: prima quelli specifici del problema noto, poi quelli generali
		// dello stato; deduplicati per comando/modulo.
		const actions = known ? [...known.actions, ...this.suggestActionsForDiagnostics(diag)] : this.suggestActionsForDiagnostics(diag);
		this.post({ type: 'actions', items: this.dedupActions(actions) });
	}

	/** Rimuove i pulsanti duplicati (stesso comando o stesso modulo Python). */
	private dedupActions(actions: ChatAction[]): ChatAction[] {
		const seen = new Set<string>();
		const out: ChatAction[] = [];
		for (const a of actions) {
			const key = a.module ? `py:${a.module}` : `cmd:${a.command}`;
			if (!seen.has(key)) {
				seen.add(key);
				out.push(a);
			}
		}
		return out;
	}

	/**
	 * Riconosce problemi NOTI dalla firma testuale dell'ultimo errore (deterministico). Restituisce
	 * causa precisa, soluzione e azioni mirate, così la chat non ripiega su consigli generici.
	 */
	private classifyKnownIssue(d: ComfyDiagnostics): KnownIssue | undefined {
		const err = (d.lastError ?? '').toLowerCase();
		if (!err && !d.missingPyModule) {
			return undefined;
		}
		// Nodo coinvolto, se presente nel messaggio (formato "(nodo TYPE #id)").
		const node = /\(nodo ([^)]+)\)/.exec(d.lastError ?? '')?.[1];
		const withNode = (t: string): string => (node ? `${t} (nodo ${node})` : t);

		// (1) Firma NOTA dal catalogo data-driven: la prima che combacia vince.
		for (const s of COMFY_SIGNALS) {
			if (s.re.test(err)) {
				return {
					id: s.id,
					title: withNode(s.title),
					rootCause: (node ? `Nodo coinvolto: ${node}. ` : '') + s.cause,
					fix: s.fix,
					actions: s.caps.map(c => ({ ...COMFY_CAP[c] })),
				};
			}
		}

		// (2) Dipendenza Python mancante (azione dinamica: serve il nome del modulo).
		if (d.missingPyModule) {
			return {
				id: 'missing-py-module',
				title: `Manca la dipendenza Python "${d.missingPyModule}"`,
				rootCause: `Un nodo richiede il modulo Python "${d.missingPyModule}", non installato nel python embedded di ComfyUI.`,
				fix: 'Installa la dipendenza nel python embedded col pulsante qui sotto, poi riavvia ComfyUI.',
				actions: [
					{ label: `📦 Installa dipendenza Python (${d.missingPyModule})`, command: '__installPy', module: d.missingPyModule },
					{ ...COMFY_CAP.restart },
				],
			};
		}

		// (3) Errore NON in catalogo → diagnosi generica deterministica + azioni utili. Così la
		// chat resta autonoma anche sugli errori imprevisti, senza dover codificare ogni caso.
		if (err) {
			return {
				id: 'generic-exec-error',
				title: withNode('Errore di esecuzione di ComfyUI'),
				rootCause: `ComfyUI ha interrotto l'esecuzione con: "${(d.lastError ?? '').slice(0, 300)}".${node ? ` Il nodo ${node} è il punto in cui si è fermato.` : ''}`,
				fix: 'Cause più comuni: un modello mancante/corrotto o incompatibile, un nodo custom non installato, o memoria insufficiente. Controlla il file/modello usato da quel nodo (apri la cartella modelli), verifica nodi/modelli del workflow e, se serve, riavvia ComfyUI.',
				actions: [
					{ ...COMFY_CAP.openModels },
					{ ...COMFY_CAP.installNodes },
					{ ...COMFY_CAP.downloadModels },
					{ ...COMFY_CAP.restart },
				],
			};
		}
		return undefined;
	}

	/**
	 * Riconosce una LAMENTELA sulla QUALITÀ dell'output (rumore/artefatti/sgranato) dal testo
	 * dell'utente, anche quando ComfyUI NON ha dato errore (il run è "riuscito" ma il risultato è
	 * brutto). Fornisce una checklist deterministica delle cause più comuni (step/CFG/LoRA
	 * distillata, VAE sbagliata, sampler a due stadi WAN, shift/encoder).
	 */
	private classifyQualityComplaint(text: string): KnownIssue | undefined {
		const t = text.toLowerCase();
		if (!/(rumore|noise|sgranat|disturbat|venut[oa] male|fatt[oa] male|brutt|artefatt|tutto colorato|puntini|granulos|fritt|fried|non assomigl|pessim|orribile|schifo|sfocat|blurry|di bassa qualit|qualità (bassa|pessima|scarsa))/.test(t)) {
			return undefined;
		}
		return {
			id: 'quality',
			title: 'Output rumoroso o di bassa qualità (nessun errore di esecuzione)',
			rootCause: 'La generazione è andata a buon fine ma il risultato è rumore/artefatti: non è un crash, è un problema di PARAMETRI o di modelli accoppiati male. Cause tipiche: pochi step di sampling senza una LoRA distillata (es. 4 step con CFG ~1 senza la LoRA Lightning/LightX2V → il latente non viene denoisato e resta rumore colorato), VAE sbagliata per l\'architettura (dà esattamente puntini arcobaleno), scheduler/shift errati, o i due stadi del sampler dei modelli WAN 2.2 (high/low noise) con step non coerenti.',
			fix: 'Controlla in quest\'ordine:\n1. Step/CFG: se usi 4-6 step con CFG ~1 serve la LoRA distillata (WAN2.2-Lightning / LightX2V) caricata e collegata ai model; senza, alza gli step (20-30) e il CFG (5-7).\n2. VAE: usa la VAE CORRETTA dell\'architettura (per WAN la sua VAE, non una SD/SDXL). Una VAE sbagliata produce proprio questo rumore colorato.\n3. Sampler a due stadi (WAN 2.2 high+low noise): i KSampler Advanced devono avere step coerenti (es. 0→N/2 con return_with_leftover_noise = enable, poi N/2→N con add_noise = disable) e lo stesso totale di step.\n4. Shift / ModelSamplingSD3 e text-encoder (umt5) corretti e collegati.\nSe non sei sicuro, parti da un workflow di riferimento ufficiale (WAN 2.2 I2V) per isolare il parametro sbagliato.',
			actions: [
				{ ...COMFY_CAP.openModels },
				{ ...COMFY_CAP.restart },
			],
		};
	}

	/**
	 * Riconosce la richiesta ESPLICITA di vedere la configurazione/parametri del workflow
	 * (es. "mostrami la configurazione", "che parametri ho", "com'è impostato il sampler").
	 */
	private isConfigRequest(text: string): boolean {
		const t = text.toLowerCase();
		return /(config\w*|configurazione|parametr|impostazion|settaggi|com'?è impostat|che (workflow|nodi|sampler|vae|lora|modelli)|quali (parametri|nodi|modelli|impostazioni)|mostrami (il|la|i) (workflow|config|nodi|parametr)|vedi (la|il) (config|workflow))/.test(t);
	}

	/** Streama la risposta del modello nel webview, accumulando nello storico. */
	private async streamLLM(system: string, messages: ChatMessage[]): Promise<void> {
		const provider = this.registry.current();
		let raw = '';
		let shown = 0;
		try {
			for await (const delta of provider.stream({ system, messages, signal: this.abort?.signal })) {
				raw += delta;
				// Mostra SOLO la risposta vera: il ragionamento <think> resta nascosto.
				const vis = visibleAnswer(raw);
				if (vis.length > shown) {
					this.post({ type: 'assistantDelta', text: vis.slice(shown) });
					shown = vis.length;
				}
			}
		} catch (err) {
			if (shown === 0) {
				this.post({ type: 'assistantDelta', text: `(LLM non disponibile: ${err instanceof Error ? err.message : String(err)})` });
			}
		}
		this.post({ type: 'assistantEnd' });
		const answer = visibleAnswer(raw).trim();
		if (answer) {
			this.history.push({ role: 'assistant', content: answer });
		}
	}

	/** Raccoglie lo stato reale di ComfyUI (deterministico, nessuna invenzione). */
	private async collectDiagnostics(): Promise<ComfyDiagnostics> {
		const status = await detectComfyStatus();
		const endpoint = status.endpoint || comfyEndpoint();
		const cfg = vscode.workspace.getConfiguration('mgcoding');
		const activeWorkflow = cfg.get<string>('image.workflow', '') || '';

		const d: ComfyDiagnostics = {
			reachable: status.availability === 'available',
			endpoint,
			checkpoints: 0, loras: 0, nodes: 0,
			activeWorkflow,
			missingNodes: [], missingModels: [],
			summary: '',
		};

		if (d.reachable) {
			try {
				const lists = await comfyLists(endpoint);
				d.checkpoints = lists.checkpoints.length;
				d.loras = lists.loras.length;
				d.nodes = lists.nodes.length;
			} catch { /* elenchi non disponibili */ }

			if (activeWorkflow) {
				const wf = await loadWorkflow(activeWorkflow);
				if (wf) {
					try { d.missingNodes = await missingNodes(endpoint, wf); } catch { /* ignora */ }
					try { d.missingModels = await missingModels(endpoint, wf); } catch { /* ignora */ }
				}
			}
			d.lastError = await this.lastExecutionError(endpoint);
			// Estrai un eventuale modulo Python mancante (ModuleNotFoundError) dall'ultimo errore.
			const mod = d.lastError && /No module named ['"]([^'"]+)['"]/.exec(d.lastError);
			if (mod) {
				d.missingPyModule = mod[1];
			}
			// INSPECTOR: leggi la CONFIG REALE dei nodi dell'ultimo run dal grafo /history.
			try {
				const graph = await this.lastRunGraph(endpoint);
				if (graph) {
					const c = summarizeComfyGraph(graph);
					d.config = c.summary;
					d.configNotes = c.notes;
				}
			} catch { /* config non disponibile */ }
		}

		d.summary = this.formatDiagnostics(d);
		return d;
	}

	/**
	 * Estrae l'errore dell'ULTIMO run da /history. Sceglie l'entry col numero di coda PIÙ ALTO
	 * (il run più recente), così non riporta errori vecchi quando l'ordine del dizionario di
	 * /history non è cronologico. Se l'ultimo run è andato a buon fine, ritorna undefined.
	 */
	private async lastExecutionError(endpoint: string): Promise<string | undefined> {
		try {
			const res = await fetch(`${endpoint.replace(/\/$/, '')}/history?max_items=50`, { signal: AbortSignal.timeout(8000) });
			if (!res.ok) {
				return undefined;
			}
			const hist = await res.json() as Record<string, { prompt?: unknown[]; status?: { status_str?: string; messages?: unknown[] } }>;
			// Individua l'entry del run più recente (numero di coda massimo: prompt[0]).
			let latestNum = -Infinity;
			let latestStatus: { status_str?: string; messages?: unknown[] } | undefined;
			for (const entry of Object.values(hist)) {
				const num = Array.isArray(entry?.prompt) && typeof entry.prompt[0] === 'number' ? entry.prompt[0] as number : -1;
				if (num >= latestNum) {
					latestNum = num;
					latestStatus = entry?.status;
				}
			}
			if (!latestStatus) {
				return undefined;
			}
			// Estrai l'errore di esecuzione SOLO dall'ultimo run (se presente).
			const msgs = Array.isArray(latestStatus.messages) ? latestStatus.messages : [];
			for (const m of msgs) {
				if (Array.isArray(m) && m[0] === 'execution_error' && m[1] && typeof m[1] === 'object') {
					const data = m[1] as { exception_message?: string; node_type?: string; node_id?: string };
					const node = data.node_type ? ` (nodo ${data.node_type}${data.node_id ? ` #${data.node_id}` : ''})` : '';
					return `${data.exception_message ?? 'errore di esecuzione'}${node}`;
				}
			}
			if (latestStatus.status_str === 'error') {
				return 'ultima esecuzione terminata con errore (dettaglio non disponibile).';
			}
			return undefined;
		} catch { /* history non disponibile */ }
		return undefined;
	}

	/**
	 * Restituisce il GRAFO API REALE dell'ultimo run (entry col numero di coda più alto) da
	 * /history: `entry.prompt[2]` è il dizionario `{nodeId: {class_type, inputs}}`. Permette
	 * all'inspector di "vedere" la configurazione effettiva dei nodi che ha prodotto l'output.
	 */
	private async lastRunGraph(endpoint: string): Promise<Record<string, GraphNode> | undefined> {
		const res = await fetch(`${endpoint.replace(/\/$/, '')}/history?max_items=50`, { signal: AbortSignal.timeout(8000) });
		if (!res.ok) {
			return undefined;
		}
		const hist = await res.json() as Record<string, { prompt?: unknown[] }>;
		let latestNum = -Infinity;
		let graph: Record<string, GraphNode> | undefined;
		for (const entry of Object.values(hist)) {
			const p = entry?.prompt;
			const num = Array.isArray(p) && typeof p[0] === 'number' ? p[0] as number : -1;
			if (num >= latestNum && Array.isArray(p) && p[2] && typeof p[2] === 'object') {
				latestNum = num;
				graph = p[2] as Record<string, GraphNode>;
			}
		}
		return graph;
	}

	/** Compone il riepilogo testuale dello stato per l'LLM e per l'utente. */
	private formatDiagnostics(d: ComfyDiagnostics): string {
		const lines: string[] = [];
		lines.push(`Endpoint: ${d.endpoint}`);
		lines.push(`Raggiungibile: ${d.reachable ? 'sì' : 'NO'}`);
		if (d.reachable) {
			lines.push(`Checkpoint installati: ${d.checkpoints} · LoRA: ${d.loras} · class_type note: ${d.nodes}`);
			lines.push(`Workflow attivo: ${d.activeWorkflow || '(nessuno)'}`);
			lines.push(`Nodi custom mancanti: ${d.missingNodes.length ? d.missingNodes.join(', ') : 'nessuno'}`);
			lines.push(`Modelli mancanti: ${d.missingModels.length ? d.missingModels.join(', ') : 'nessuno'}`);
			lines.push(`Ultimo errore di esecuzione: ${d.lastError ?? 'nessuno'}`);
			if (d.missingPyModule) {
				lines.push(`Dipendenza Python mancante: ${d.missingPyModule} (installabile nel python embedded)`);
			}
			if (d.config) {
				lines.push(`\nConfigurazione REALE dell'ultimo run (letta dai nodi):\n${d.config}`);
			}
			if (d.configNotes && d.configNotes.length) {
				lines.push(`\nPossibili anomalie nella configurazione:\n${d.configNotes.map(n => `- ${n}`).join('\n')}`);
			}
		} else {
			lines.push('ComfyUI non risponde: probabilmente non è avviato.');
		}
		return lines.join('\n');
	}

	/** Pulsanti d'azione in base ai problemi rilevati. */
	private suggestActionsForDiagnostics(d: ComfyDiagnostics): ChatAction[] {
		const actions: ChatAction[] = [];
		if (!d.reachable) {
			actions.push({ label: '▶ Avvia ComfyUI', command: 'mgcoding.startComfyUI' });
			actions.push({ label: '🔄 Riavvia ComfyUI', command: 'mgcoding.restartComfyUI' });
			return actions;
		}
		if (d.missingNodes.length > 0) {
			actions.push({ label: '🧩 Installa nodi da workflow', command: 'mgcoding.installNodesFromFile' });
		}
		if (d.missingModels.length > 0) {
			actions.push({ label: '⬇ Scarica modelli mancanti', command: 'mgcoding.installMissingModels' });
		}
		if (d.missingPyModule) {
			actions.push({ label: `📦 Installa dipendenza Python (${d.missingPyModule})`, command: '__installPy', module: d.missingPyModule });
		}
		// Se c'è un errore di esecuzione non altrimenti coperto, dai accesso ai modelli (spesso
		// la causa è un modello corrotto/incompatibile) oltre alle azioni generali.
		if (d.lastError && d.missingNodes.length === 0 && d.missingModels.length === 0) {
			actions.push({ label: '📂 Apri cartella modelli ComfyUI', command: 'mgcoding.openComfyModelsFolder' });
		}
		actions.push({ label: '🔄 Riavvia ComfyUI', command: 'mgcoding.restartComfyUI' });
		actions.push({ label: '⬆ Importa workflow', command: 'mgcoding.importWorkflow' });
		return actions;
	}

	/** Azioni proposte quando una generazione fallisce (in base alla causa testuale). */
	private async suggestActionsForFailure(cause: string): Promise<ChatAction[]> {
		const c = cause.toLowerCase();
		const actions: ChatAction[] = [];
		if (/raggiungibile|avvia|non risponde/.test(c)) {
			actions.push({ label: '▶ Avvia ComfyUI', command: 'mgcoding.startComfyUI' });
		}
		if (/nod/.test(c)) {
			actions.push({ label: '🧩 Installa nodi da workflow', command: 'mgcoding.installNodesFromFile' });
		}
		if (/model/.test(c)) {
			actions.push({ label: '⬇ Scarica modelli mancanti', command: 'mgcoding.installMissingModels' });
		}
		if (/workflow|compatibile/.test(c)) {
			actions.push({ label: '⬆ Importa workflow', command: 'mgcoding.importWorkflow' });
		}
		actions.push({ label: '🔄 Riavvia ComfyUI', command: 'mgcoding.restartComfyUI' });
		return actions;
	}

	private kindLabel(kind: GenKind | 'ambiguous'): string {
		switch (kind) {
			case 'image': return 'immagine';
			case 't2v': return 'video da testo (T2V)';
			case 'i2v': return 'video da immagine (I2V)';
			default: return 'da chiarire';
		}
	}

	// ---- Utilità webview -------------------------------------------------------------------

	private post(msg: Record<string, unknown>): void {
		void this.view?.webview.postMessage(msg);
	}

	private busy(on: boolean): void {
		this.post({ type: 'busy', on });
	}

	private html(): string {
		const nonce = String(Date.now());
		const csp = this.view?.webview.cspSource ?? '';
		return `<!DOCTYPE html><html lang="it"><head><meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${csp} data:; media-src ${csp} blob:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<style>
	:root { --acc: var(--vscode-charts-green, #3fb950); --bd: var(--vscode-panel-border, #2a2a2a); --bg2: var(--vscode-editorWidget-background); }
	* { box-sizing: border-box; }
	body { font-family: var(--vscode-font-family); font-size: 13px; color: var(--vscode-foreground); margin: 0; display: flex; flex-direction: column; height: 100vh; }
	#log { flex: 1; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 8px; }
	.msg { padding: 8px 10px; border-radius: 10px; max-width: 92%; white-space: pre-wrap; word-break: break-word; }
	.user { align-self: flex-end; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
	.assistant { align-self: flex-start; background: var(--bg2); border: 1px solid var(--bd); }
	.status { align-self: flex-start; opacity: .65; font-size: 11.5px; font-style: italic; }
	.actions { display: flex; flex-wrap: wrap; gap: 6px; align-self: flex-start; }
	.actions button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; border-radius: 7px; padding: 6px 9px; cursor: pointer; font-size: 12px; }
	.actions button:hover { filter: brightness(1.15); }
	.media { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 8px; align-self: stretch; }
	.media .item { border: 1px solid var(--bd); border-radius: 8px; overflow: hidden; background: #000; }
	.media img, .media video { width: 100%; display: block; }
	#bar { display: flex; gap: 6px; padding: 8px; border-top: 1px solid var(--bd); }
	#inp { flex: 1; resize: none; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--bd)); border-radius: 8px; padding: 7px 9px; font-family: inherit; font-size: 13px; }
	#send, #stop { border: none; border-radius: 8px; padding: 0 12px; cursor: pointer; }
	#send { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
	#stop { background: #d29922; color: #1a1a1a; display: none; }
	body.busy #stop { display: inline-block; }
	body.busy #send { display: none; }
	.hint { opacity: .6; font-size: 11px; padding: 0 10px 6px; }
</style></head><body>
	<div id="log">
		<div class="msg assistant">Ciao! Sono la chat ComfyUI. Posso <b>generare</b> immagini e video (es. "genera un video di onde dal mio workflow") oppure <b>diagnosticare</b> ComfyUI (es. "perché non funziona?", "che errori ho?"). </div>
	</div>
	<div class="hint">Generazione: usa il workflow attivo. Diagnostica: leggo stato reale di ComfyUI e propongo azioni.</div>
	<div id="bar">
		<textarea id="inp" rows="2" placeholder="Scrivi qui… (Invio per inviare)"></textarea>
		<button id="send">Invia</button>
		<button id="stop">Stop</button>
	</div>
<script nonce="${nonce}">
	var vscode = acquireVsCodeApi();
	var log = document.getElementById('log');
	var inp = document.getElementById('inp');
	var streamEl = null;
	function scroll(){ log.scrollTop = log.scrollHeight; }
	function add(cls, text){ var d=document.createElement('div'); d.className='msg '+cls; d.textContent=text; log.appendChild(d); scroll(); return d; }
	function send(){ var t=inp.value.trim(); if(!t) return; inp.value=''; vscode.postMessage({type:'send', text:t}); }
	document.getElementById('send').addEventListener('click', send);
	document.getElementById('stop').addEventListener('click', function(){ vscode.postMessage({type:'cancel'}); });
	inp.addEventListener('keydown', function(e){ if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); send(); } });
	window.addEventListener('message', function(e){
		var m = e.data;
		if(m.type==='user'){ add('user', m.text); }
		else if(m.type==='assistant'){ add('assistant', m.text); }
		else if(m.type==='status'){ add('status', m.text); }
		else if(m.type==='busy'){ document.body.classList.toggle('busy', !!m.on); }
		else if(m.type==='assistantStart'){ streamEl = add('assistant', ''); }
		else if(m.type==='assistantDelta'){ if(!streamEl){ streamEl = add('assistant',''); } streamEl.textContent += m.text; scroll(); }
		else if(m.type==='assistantEnd'){ streamEl = null; }
		else if(m.type==='actions'){
			if(!m.items || !m.items.length) return;
			var wrap=document.createElement('div'); wrap.className='actions';
			m.items.forEach(function(a){ var b=document.createElement('button'); b.textContent=a.label; b.addEventListener('click', function(){ if(a.module){ vscode.postMessage({type:'installPy', module:a.module}); } else { vscode.postMessage({type:'cmd', command:a.command}); } }); wrap.appendChild(b); });
			log.appendChild(wrap); scroll();
		}
		else if(m.type==='media'){
			var grid=document.createElement('div'); grid.className='media';
			m.items.forEach(function(it){
				var box=document.createElement('div'); box.className='item';
				var el = it.kind==='video' ? document.createElement('video') : document.createElement('img');
				if(it.kind==='video'){ el.src=it.src; el.controls=true; } else { el.src=it.src; }
				box.appendChild(el); grid.appendChild(box);
			});
			log.appendChild(grid); scroll();
		}
	});
</script></body></html>`;
	}
}
