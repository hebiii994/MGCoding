/*---------------------------------------------------------------------------------------------
 *  MGCoding - registry/selezione provider LLM + gestione API key + status bar
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ClaudeProvider } from './claudeProvider';
import { GLMConfig, GLMProvider } from './glmProvider';
import { OllamaProvider } from './ollamaProvider';
import { OpenAIProvider } from './openaiProvider';
import { CapabilityTier, LLMError, LLMProvider, RouteResult } from './types';

const SECRET_CLAUDE_KEY = 'mgcoding.claude.apiKey';
const SECRET_OPENAI_KEY = 'mgcoding.openai.apiKey';
const SECRET_GLM_KEY = 'mgcoding.glm.apiKey';

/** Endpoint OpenAI-compat di GLM di default (Z.ai), usato se la config non lo specifica. */
const GLM_DEFAULT_OPENAI_ENDPOINT = 'https://api.z.ai/api/paas/v4';
/** Endpoint Anthropic-compat (Messages API) di GLM di default (Z.ai). */
const GLM_DEFAULT_ANTHROPIC_ENDPOINT = 'https://api.z.ai/api/anthropic';

/** Preset di servizi OpenAI-compatibili pronti all'uso. */
interface OpenAIPreset {
	id: string;
	label: string;
	endpoint: string;
	model: string;
	azure?: boolean;
	/** true => chiede all'utente endpoint/deployment (Azure o custom). */
	prompt?: boolean;
	/** Pagina dove ottenere la API key (mostrata nella configurazione guidata). */
	keyUrl?: string;
	/** Nota mostrata nella configurazione guidata. */
	note?: string;
}

const OPENAI_PRESETS: OpenAIPreset[] = [
	{ id: 'chatgpt', label: 'ChatGPT (OpenAI)', endpoint: 'https://api.openai.com/v1', model: 'gpt-4o', keyUrl: 'https://platform.openai.com/api-keys', note: 'Serve una API key di OpenAI Platform (a consumo): l\'abbonamento ChatGPT web non è sufficiente.' },
	{ id: 'gemini', label: 'Google Gemini', endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-pro', keyUrl: 'https://aistudio.google.com/apikey', note: 'Serve una API key gratuita di Google AI Studio: l\'abbonamento Gemini Advanced non è sufficiente.' },
	{ id: 'openrouter', label: 'OpenRouter (tutti i modelli)', endpoint: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-3.7-sonnet', keyUrl: 'https://openrouter.ai/keys' },
	{ id: 'azure', label: 'Azure OpenAI (aziendale)', endpoint: '', model: '', azure: true, prompt: true, note: 'Inserisci l\'URL del deployment Azure e la relativa key.' },
	{ id: 'lmstudio', label: 'LM Studio (locale)', endpoint: 'http://localhost:1234/v1', model: 'local-model', note: 'Assicurati che LM Studio sia in esecuzione con il server locale attivo.' },
	{ id: 'custom', label: 'Endpoint personalizzato…', endpoint: '', model: '', prompt: true }
];

/** Nome del secret per la API key di uno specifico endpoint (chiavi multiple coesistono). */
function openAiSecretKeyFor(endpoint: string): string {
	return endpoint ? `${SECRET_OPENAI_KEY}:${endpoint}` : SECRET_OPENAI_KEY;
}

// ---------------------------------------------------------------------------
//  Router_LLM — selezione provider per i compiti di generazione (logica pura)
// ---------------------------------------------------------------------------

/** Contesto di instradamento per la selezione del provider LLM. */
export interface RouteContext {
	/** Testo della richiesta, usato come euristica di complessità a monte. */
	hint?: string;
	/** Vero se la richiesta include immagini (serve un modello vision). */
	hasImages: boolean;
	/** Complessità stimata della richiesta: instrada heavy/light. */
	complexity: 'light' | 'heavy';
	/** Vero se l'utente preferisce i modelli locali ai provider cloud. */
	localFirst: boolean;
	/** Tier minimo richiesto per soddisfare una richiesta `heavy` (Req. 8.6, 8.7). */
	requiredTier?: CapabilityTier;
}

/**
 * Descrittore puro di un provider: cattura i soli flag rilevanti alla decisione
 * (raggiungibilità, località, capacità vision, tier e costo) senza alcuna
 * dipendenza da I/O.
 */
export interface ProviderDescriptor {
	/** Identificativo del provider (es. 'ollama', 'claude', 'openai', 'glm'). */
	id: string;
	/** Vero se il provider è configurato e raggiungibile. */
	available: boolean;
	/** Vero se il provider è locale (es. Ollama o endpoint su localhost). */
	local: boolean;
	/** Vero se il provider può elaborare immagini (capacità vision). */
	vision: boolean;
	/** Tier massimo raggiungibile dal miglior modello del provider (per i locali). */
	maxTier?: CapabilityTier;
	/** Vero se il provider è cloud a pagamento (per il logging del ripiego, Req. 10.3). */
	paid?: boolean;
	/** Vero se è un modello cloud gratuito (Req. 10.4, 10.5). */
	free?: boolean;
}

/** Designazione dell'instradamento automatico per complessità. */
export interface RouteConfig {
	/** Id del provider designato per le richieste pesanti. */
	heavyId: string;
	/** Id del provider designato per le richieste leggere. */
	lightId: string;
	/** Vero se l'instradamento automatico per complessità è attivo. */
	autoRoute: boolean;
}

/** Router LLM: seleziona un provider raggiungibile per un compito di generazione. */
export interface ILLMRouter {
	/** Sceglie provider raggiungibile; vision se hasImages; locale se localFirst. */
	selectProvider(ctx: RouteContext): Promise<LLMProvider | undefined>;
}

/**
 * Logica PURA di selezione del provider su una lista di descrittori, con
 * consapevolezza del tier di capacità, di GLM/cloud heavy e del costo.
 *
 * Precedenza (allineata al design, Req. 8.5-8.7, 9.5, 10.1-10.5):
 *  1. Solo i provider disponibili (raggiungibili). Se nessuno è disponibile →
 *     `RouteResult{ provider: undefined, fallbackReason }` (Req. 9.5).
 *  2. Local-first: se `ctx.localFirst` ed esiste almeno un provider locale
 *     disponibile, la scelta è ristretta ai soli locali per l'intera decisione
 *     (Req. 10.1). Il filtro vision si applica entro i locali.
 *  3. Vision: con immagini, si restringe ai candidati con capacità vision se
 *     ne esistono (Req. 2.3).
 *  4. Heavy senza local-first vincolante: se nessun locale raggiunge
 *     `requiredTier` → (a) cloud gratuito adeguato (Req. 10.5); (b) cloud
 *     heavy/GLM configurato, con `fallbackReason` (Req. 8.5, 8.6, 10.2); (c)
 *     miglior locale anche se insufficiente, con `degradedLocal` (Req. 8.7).
 *     Se un locale è adeguato: cloud gratuito → heavy designato → miglior locale.
 *  5. Light: preferisce il cloud gratuito se presente (Req. 10.4), poi il
 *     provider designato light (auto-route), infine il primo candidato.
 *  6. Fallback: il primo candidato rimasto.
 *
 * La funzione restituisce sempre un descrittore appartenente all'insieme dei
 * disponibili (o `provider: undefined` se vuoto): è quindi testabile con PBT.
 */
export function chooseProvider(
	descriptors: readonly ProviderDescriptor[],
	ctx: RouteContext,
	route?: RouteConfig
): RouteResult {
	// 1) Solo i provider raggiungibili.
	const available = descriptors.filter(d => d.available);
	if (available.length === 0) {
		return { provider: undefined, fallbackReason: 'Nessun provider configurato o raggiungibile.' };
	}

	// Rango ordinale dei tier (textual < structured < native).
	const tierRank = (t?: CapabilityTier): number => (t === 'native' ? 2 : t === 'structured' ? 1 : 0);
	// Tier effettivo: i locali senza dichiarazione sono prudentemente `textual`,
	// i cloud senza dichiarazione si assumono pienamente capaci (`native`).
	const effectiveTier = (d: ProviderDescriptor): CapabilityTier => d.maxTier ?? (d.local ? 'textual' : 'native');
	// Un descrittore soddisfa il tier richiesto se non è richiesto alcun tier
	// oppure se il suo tier effettivo è almeno pari a quello richiesto.
	const meetsTier = (d: ProviderDescriptor): boolean =>
		ctx.requiredTier === undefined ? true : tierRank(effectiveTier(d)) >= tierRank(ctx.requiredTier);
	// Miglior candidato per capacità: il primo con tier effettivo massimo (deterministico).
	const bestByTier = (list: readonly ProviderDescriptor[]): ProviderDescriptor =>
		list.reduce((best, d) => (tierRank(effectiveTier(d)) > tierRank(effectiveTier(best)) ? d : best));
	// Restringe ai vision-capable se servono immagini e ne esistono, altrimenti invariato.
	const visionNarrow = (list: ProviderDescriptor[]): ProviderDescriptor[] => {
		if (!ctx.hasImages) {
			return list;
		}
		const v = list.filter(d => d.vision);
		return v.length > 0 ? v : list;
	};

	const isHeavy = ctx.complexity === 'heavy';
	const locals = available.filter(d => d.local);
	// Local-first vincolante: richiesto e con almeno un locale disponibile (Req. 10.1).
	const hardLocalFirst = ctx.localFirst && locals.length > 0;

	// 2-3) Local-first: scelta ristretta ai locali (con eventuale filtro vision).
	if (hardLocalFirst) {
		const localCands = visionNarrow(locals);
		if (isHeavy) {
			// Per le richieste pesanti privilegia il locale più capace disponibile.
			return { provider: bestByTier(localCands) };
		}
		if (route?.autoRoute) {
			const designated = localCands.find(d => d.id === route.lightId);
			if (designated) {
				return { provider: designated };
			}
		}
		return { provider: localCands[0] };
	}

	// Senza local-first vincolante si ragiona sull'intero insieme disponibile.
	const cands = visionNarrow(available);
	const freeCloud = (list: readonly ProviderDescriptor[]): ProviderDescriptor | undefined =>
		list.find(d => !d.local && d.free === true && meetsTier(d));
	// Cloud heavy/GLM: preferisci il provider designato heavy, poi un cloud a
	// pagamento, infine un qualsiasi cloud raggiungibile.
	const heavyCloud = (list: readonly ProviderDescriptor[]): ProviderDescriptor | undefined =>
		(route?.autoRoute ? list.find(d => !d.local && d.id === route.heavyId) : undefined)
		?? list.find(d => !d.local && d.paid === true)
		?? list.find(d => !d.local);

	let result: RouteResult;
	if (isHeavy) {
		const anyLocalAdequate = cands.some(d => d.local && meetsTier(d));
		const free = freeCloud(cands);
		if (free) {
			// (a) Cloud gratuito adeguato: preferito al cloud a pagamento (Req. 10.5).
			result = { provider: free };
		} else if (!anyLocalAdequate) {
			// Nessun locale raggiunge il tier richiesto (Req. 8.6, 8.7, 10.2).
			const cloud = heavyCloud(cands);
			if (cloud) {
				// (b) Ripiego sul cloud heavy/GLM, motivato per il logging.
				result = { provider: cloud, fallbackReason: 'Nessun modello locale raggiunge il tier richiesto: ripiego sul cloud heavy.' };
			} else {
				const localsHere = cands.filter(d => d.local);
				if (localsHere.length > 0) {
					// (c) Nessun cloud: si usa il miglior locale anche se insufficiente (Req. 8.7).
					result = { provider: bestByTier(localsHere), degradedLocal: true };
				} else {
					result = { provider: cands[0] };
				}
			}
		} else if (route?.autoRoute && route.heavyId) {
			// Esiste un locale adeguato: rispetta l'instradamento heavy designato (Req. 8.5).
			const designated = cands.find(d => d.id === route.heavyId);
			result = { provider: designated ?? bestByTier(cands.filter(d => d.local && meetsTier(d))) };
		} else {
			// Preferisci il locale adeguato più capace (coscienza dei costi).
			result = { provider: bestByTier(cands.filter(d => d.local && meetsTier(d))) };
		}
	} else {
		// Richieste leggere: preferisci il cloud gratuito (Req. 10.4), poi il designato light.
		const free = cands.find(d => !d.local && d.free === true);
		if (free) {
			result = { provider: free };
		} else if (route?.autoRoute) {
			const designated = cands.find(d => d.id === route.lightId);
			result = { provider: designated ?? cands[0] };
		} else {
			result = { provider: cands[0] };
		}
	}

	// Req. 10.3: se con local-first si finisce su un cloud a pagamento, motiva il ripiego.
	if (ctx.localFirst && result.provider && !result.provider.local && result.provider.paid === true && !result.fallbackReason) {
		result.fallbackReason = 'Local-first attivo ma nessun provider locale adeguato: ripiego sul cloud a pagamento.';
	}
	return result;
}

export class ProviderRegistry implements vscode.Disposable, ILLMRouter {

	private readonly claude: ClaudeProvider;
	private readonly ollama: OllamaProvider;
	private readonly openai: OpenAIProvider;
	private readonly glm: GLMProvider;
	private readonly statusBar: vscode.StatusBarItem;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly context: vscode.ExtensionContext) {
		this.claude = new ClaudeProvider(
			() => Promise.resolve(this.context.secrets.get(SECRET_CLAUDE_KEY)),
			() => {
				const c = vscode.workspace.getConfiguration('mgcoding');
				return {
					model: c.get<string>('claude.model', 'claude-opus-4-8'),
					maxTokens: c.get<number>('claude.maxTokens', 8192),
					thinking: c.get<boolean>('claude.thinking', false),
					thinkingAuto: c.get<boolean>('claude.thinkingAuto', true),
					thinkingBudget: c.get<number>('claude.thinkingBudget', 2048),
					effort: c.get<string>('claude.effort', 'high')
				};
			}
		);
		this.ollama = new OllamaProvider(() => {
			const c = vscode.workspace.getConfiguration('mgcoding');
			return {
				// modelOverride: impostato dal router AutoModel per il singolo turno.
				endpoint: c.get<string>('ollama.endpoint', 'http://localhost:11434'),
				model: this.ollamaModelOverride ?? c.get<string>('ollama.model', 'qwen2.5-coder:14b'),
				think: c.get<boolean>('ollama.think', false),
				temperature: c.get<number>('ollama.temperature', 0.2),
				numCtx: c.get<number>('ollama.numCtx', 0)
			};
		});
		this.openai = new OpenAIProvider(
			() => {
				const endpoint = vscode.workspace.getConfiguration('mgcoding').get<string>('openai.endpoint', 'http://localhost:1234/v1');
				return Promise.resolve(this.context.secrets.get(openAiSecretKeyFor(endpoint)));
			},
			() => {
				const c = vscode.workspace.getConfiguration('mgcoding');
				return {
					endpoint: c.get<string>('openai.endpoint', 'http://localhost:1234/v1'),
					model: c.get<string>('openai.model', 'local-model'),
					azure: c.get<boolean>('openai.azure', false),
					apiVersion: c.get<string>('openai.apiVersion', '2024-08-01-preview')
				};
			}
		);

		// Provider GLM (Zhipu/Z.ai): chiave in SecretStorage `mgcoding.glm.apiKey`, configurazione
		// da `mgcoding.glm.*`. Mantiene disponibili sia il percorso OpenAI-compat sia quello
		// Anthropic-compat (flag `useAnthropicEndpoint`) senza alterare il comportamento esistente.
		this.glm = new GLMProvider(
			() => Promise.resolve(this.context.secrets.get(SECRET_GLM_KEY)),
			(): GLMConfig => {
				const c = vscode.workspace.getConfiguration('mgcoding');
				return {
					openaiEndpoint: c.get<string>('glm.endpoint', GLM_DEFAULT_OPENAI_ENDPOINT),
					anthropicEndpoint: c.get<string>('glm.anthropicEndpoint', GLM_DEFAULT_ANTHROPIC_ENDPOINT),
					model: c.get<string>('glm.model', 'glm-4.6'),
					useAnthropicEndpoint: c.get<boolean>('glm.useAnthropicEndpoint', false)
				};
			}
		);

		this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
		this.statusBar.command = 'mgcoding.switchProvider';
		this.disposables.push(this.statusBar);
		this.updateStatusBar();
		this.statusBar.show();

		this.disposables.push(vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('mgcoding')) {
				this.updateStatusBar();
			}
		}));
	}

	private byId(id: string): LLMProvider {
		return id === 'claude' ? this.claude
			: id === 'openai' ? this.openai
				: id === 'glm' ? this.glm
					: this.ollama;
	}

	current(): LLMProvider {
		return this.byId(vscode.workspace.getConfiguration('mgcoding').get<string>('provider', 'ollama'));
	}

	/** Sceglie il provider per una richiesta: se autoRoute è attivo, instrada per complessità. */
	pickProvider(hint?: string): LLMProvider {
		const c = vscode.workspace.getConfiguration('mgcoding');
		if (!c.get<boolean>('autoRoute', false)) {
			return this.current();
		}
		const heavy = /refactor|architett|design|implementa|\bspec\b|multipl|test|debug|ottimizz|migrazion|intero|tutti i file|codebase|refactoring/i;
		const isHeavy = !!hint && (hint.length > 600 || heavy.test(hint));
		return this.byId(isHeavy ? c.get<string>('route.heavy', 'claude') : c.get<string>('route.light', 'ollama'));
	}

	/**
	 * Router_LLM: seleziona un provider raggiungibile per un compito di generazione.
	 * Costruisce i descrittori puri (raggiungibilità/località/vision) interrogando i
	 * provider reali, poi delega la decisione alla logica pura {@link chooseProvider}.
	 * Restituisce `undefined` se nessun provider è configurato/raggiungibile (Req. 2.4).
	 */
	async selectProvider(ctx: RouteContext): Promise<LLMProvider | undefined> {
		const c = vscode.workspace.getConfiguration('mgcoding');

		// Raggiungibilità (I/O) dei tre provider, in parallelo e tollerante agli errori.
		const [claudeOk, ollamaOk, openaiOk, glmOk] = await Promise.all([
			this.claude.isConfigured().catch(() => false),
			this.ollama.isConfigured().catch(() => false),
			this.openai.isConfigured().catch(() => false),
			this.glm.isConfigured().catch(() => false)
		]);

		// Capacità vision di Ollama: rilevata solo se serve (immagini) ed è raggiungibile.
		let ollamaVision = false;
		if (ollamaOk && ctx.hasImages) {
			try {
				const models = await this.ollama.listModels();
				for (const m of models) {
					if (await this.ollama.supportsVision(m).catch(() => false)) {
						ollamaVision = true;
						break;
					}
				}
			} catch {
				// elenco modelli non disponibile: si assume nessun modello vision locale
			}
		}

		// L'endpoint OpenAI-compatibile è "locale" se punta a localhost (es. LM Studio).
		const openaiEndpoint = c.get<string>('openai.endpoint', 'http://localhost:1234/v1');
		const openaiLocal = /localhost|127\.0\.0\.1|0\.0\.0\.0|::1/i.test(openaiEndpoint);

		// Tier massimo del miglior modello locale: se l'utente ha dichiarato un override
		// in `mgcoding.model.capabilityTier`, lo si propaga al descrittore (Req. 3.5); altrimenti
		// si lascia indefinito e la logica pura assume prudentemente `textual` per i locali.
		const tierOverrides = c.get<Record<string, CapabilityTier>>('model.capabilityTier', {});
		const ollamaModel = this.currentOllamaModel();
		const ollamaMaxTier: CapabilityTier | undefined = ollamaModel ? tierOverrides[ollamaModel] : undefined;

		const descriptors: ProviderDescriptor[] = [
			{ id: 'ollama', available: ollamaOk, local: true, vision: ollamaVision, maxTier: ollamaMaxTier },
			// Claude è un cloud a pagamento: lo si marca per il logging del ripiego (Req. 10.3).
			{ id: 'claude', available: claudeOk, local: false, vision: true, paid: true },
			// OpenAI-compat: locale (LM Studio) oppure cloud a pagamento (marcato per Req. 10.3).
			{ id: 'openai', available: openaiOk, local: openaiLocal, vision: true, paid: !openaiLocal },
			// GLM (Zhipu/Z.ai): cloud a pagamento, candidato per l'instradamento heavy (Req. 8.5).
			{ id: 'glm', available: glmOk, local: false, vision: false, paid: true }
		];

		const route: RouteConfig = {
			heavyId: c.get<string>('route.heavy', 'claude'),
			lightId: c.get<string>('route.light', 'ollama'),
			autoRoute: c.get<boolean>('autoRoute', false)
		};

		// Decisione pura: legge `.provider` dal RouteResult e ne mappa l'id sul provider reale.
		const chosen = chooseProvider(descriptors, ctx, route);
		// Req. 10.3: registra il motivo del ripiego al cloud (o l'uso degradato di un locale),
		// così l'utente attento ai costi capisce perché non si è restati in locale.
		if (chosen.fallbackReason) {
			console.warn(`[MGCoding] Router_LLM: ${chosen.fallbackReason}`);
		}
		if (chosen.degradedLocal) {
			console.warn('[MGCoding] Router_LLM: nessun cloud disponibile, uso un modello locale insufficiente per il tier richiesto.');
		}
		return chosen.provider ? this.byId(chosen.provider.id) : undefined;
	}

	/** Override temporaneo del modello Ollama (router AutoModel), valido per il turno. */
	private ollamaModelOverride?: string;
	setOllamaModelOverride(model?: string): void {
		this.ollamaModelOverride = model;
	}

	/** Modello Ollama effettivo: override del router se presente, altrimenti l'impostazione. */
	currentOllamaModel(): string {
		return this.ollamaModelOverride ?? vscode.workspace.getConfiguration('mgcoding').get<string>('ollama.model', '');
	}

	/**
	 * AutoModel: sceglie tra i modelli Ollama installati il più adatto alla richiesta.
	 * Euristica locale: vision se ci sono immagini, poi reasoning, coding, leggero.
	 * Ritorna undefined se non c'è una scelta migliore del modello attuale.
	 */
	async chooseOllamaModel(hint: string | undefined, hasImages: boolean): Promise<string | undefined> {
		let installed: string[];
		try {
			installed = await this.ollama.listModels();
		} catch {
			return undefined;
		}
		if (installed.length < 2) {
			return undefined;
		}
		const h = (hint ?? '').toLowerCase();
		const paramSize = (m: string): number => {
			const n = m.match(/(\d+(?:\.\d+)?)\s*b\b/);
			return n ? parseFloat(n[1]) : 99;
		};
		// 1) Immagini → modello vision.
		if (hasImages) {
			for (const m of installed) {
				if (await this.ollama.supportsVision(m).catch(() => false)) {
					return m;
				}
			}
		}
		const action = /avvia|esegui|installa|lancia|crea|implementa|scriv|corregg|aggiung|refactor|genera|costruisci|modific|build|run|start|fix|debug|test/;
		const reasoning = /perch[eé]|ragiona|spiega|progett|architett|analizz|confront|strategia|why|design|valuta|pro e contro/;
		const coding = /codice|funzione|classe|bug|file|metodo|api|compil|codebase|stack|code|function|class/;
		const isAction = action.test(h);
		const isShort = h.length > 0 && h.length < 60 && !isAction;
		const byName = (re: RegExp): string | undefined => installed.find(m => re.test(m.toLowerCase()));
		const REASON_ONLY = /r1|reason/; // modelli che non gestiscono bene i tool: evitali per le azioni
		const firstToolCapable = async (avoidReasonOnly: boolean): Promise<string | undefined> => {
			for (const m of installed) {
				if (avoidReasonOnly && REASON_ONLY.test(m.toLowerCase())) {
					continue;
				}
				if (await this.ollama.supportsTools(m).catch(() => false)) {
					return m;
				}
			}
			return undefined;
		};
		// 2) Azione o coding → serve un modello che USI i tool: preferisci un coder, poi un
		//    tool-capable; EVITA i reasoning-only (r1): inventano l'output dei comandi.
		if (isAction || coding.test(h)) {
			const cdr = installed.find(m => /coder|codestral|codegemma|code/.test(m.toLowerCase()) && !REASON_ONLY.test(m.toLowerCase()));
			if (cdr) { return cdr; }
			const tc = await firstToolCapable(true);
			if (tc) { return tc; }
		}
		// 3) Ragionamento PURO (nessuna azione) → modello reasoning.
		if (reasoning.test(h) && !isAction) {
			const r = byName(/r1|deepseek|qwen3|phi|magistral/);
			if (r) { return r; }
		}
		// 4) Richiesta breve/semplice → il modello più leggero installato.
		if (isShort) {
			const light = [...installed].sort((a, b) => paramSize(a) - paramSize(b))[0];
			if (light) { return light; }
		}
		return undefined;
	}

	/**
	 * Sceglie tra i modelli installati un "reasoning" da usare come PLANNER
	 * (architettura planner/executor: il reasoning pianifica, il coder esegue).
	 */
	async pickOllamaPlannerModel(): Promise<string | undefined> {
		let installed: string[];
		try {
			installed = await this.ollama.listModels();
		} catch {
			return undefined;
		}
		if (installed.length < 2) {
			return undefined;
		}
		return installed.find(m => /r1|reason|qwq|qwen3|deepseek|magistral|phi-?4|think/.test(m.toLowerCase()));
	}

	/**
	 * Chiavi cloud riutilizzabili per la generazione immagini/video: legge il secret della
	 * key Gemini (endpoint generativelanguage) e quello della key OpenAI ufficiale, se presenti.
	 */
	async getMediaKeys(): Promise<{ geminiKey?: string; openaiKey?: string }> {
		const geminiKey = await this.context.secrets.get(openAiSecretKeyFor('https://generativelanguage.googleapis.com/v1beta/openai'));
		const openaiKey = await this.context.secrets.get(openAiSecretKeyFor('https://api.openai.com/v1'));
		return { geminiKey: geminiKey || undefined, openaiKey: openaiKey || undefined };
	}

	listOllamaModels(): Promise<string[]> {
		return this.ollama.listModels();
	}

	/** True se il modello Ollama dichiara di supportare il tool-use nativo. */
	ollamaModelSupportsTools(model: string): Promise<boolean> {
		return this.ollama.supportsTools(model);
	}

	listOpenAIModels(): Promise<string[]> {
		return this.openai.listModels();
	}

	/** True se esiste una API key salvata per l'endpoint OpenAI-compatibile attuale. */
	async hasOpenAIKey(): Promise<boolean> {
		const endpoint = vscode.workspace.getConfiguration('mgcoding').get<string>('openai.endpoint', 'http://localhost:1234/v1');
		const key = await this.context.secrets.get(openAiSecretKeyFor(endpoint));
		return !!(key && key.trim());
	}

	async setOpenAIKey(): Promise<void> {
		const endpoint = vscode.workspace.getConfiguration('mgcoding').get<string>('openai.endpoint', 'http://localhost:1234/v1');
		const key = await vscode.window.showInputBox({
			prompt: `API key per ${endpoint || 'l\'endpoint OpenAI-compatibile'} (lascia vuoto per locale senza chiave)`,
			password: true,
			ignoreFocusOut: true
		});
		if (key !== undefined) {
			await this.context.secrets.store(openAiSecretKeyFor(endpoint), key.trim());
			vscode.window.showInformationMessage('API key OpenAI-compat salvata.');
			this.updateStatusBar();
		}
	}

	/** True se esiste una API key GLM (Zhipu/Z.ai) salvata in SecretStorage. */
	async hasGlmKey(): Promise<boolean> {
		const key = await this.context.secrets.get(SECRET_GLM_KEY);
		return !!(key && key.trim());
	}

	/** Chiede e salva la API key GLM in SecretStorage con chiave `mgcoding.glm.apiKey` (Req. 8.4). */
	async setGlmKey(): Promise<void> {
		const key = await vscode.window.showInputBox({
			prompt: 'Incolla la tua API key GLM (Zhipu/Z.ai)',
			password: true,
			ignoreFocusOut: true
		});
		if (key) {
			await this.context.secrets.store(SECRET_GLM_KEY, key.trim());
			vscode.window.showInformationMessage('API key GLM salvata in modo sicuro.');
			this.updateStatusBar();
		}
	}

	/** Applica un preset OpenAI-compatibile: aggiorna config, chiede endpoint/modello/key se serve. */
	private async applyOpenAiPreset(preset: OpenAIPreset, forceKey = false): Promise<boolean> {
		const c = vscode.workspace.getConfiguration('mgcoding');
		let endpoint = preset.endpoint;
		let model = preset.model;

		if (preset.prompt) {
			const ph = preset.azure
				? 'https://<risorsa>.openai.azure.com/openai/deployments/<deployment>'
				: 'https://… (base URL OpenAI-compatibile, es. .../v1)';
			const ep = await vscode.window.showInputBox({ prompt: 'Endpoint (base URL)', placeHolder: ph, value: endpoint, ignoreFocusOut: true });
			if (!ep) {
				return false;
			}
			endpoint = ep.trim();
			const md = await vscode.window.showInputBox({ prompt: 'Nome modello / deployment', value: model, ignoreFocusOut: true });
			if (md === undefined) {
				return false;
			}
			model = md.trim();
		}

		await c.update('provider', 'openai', vscode.ConfigurationTarget.Global);
		await c.update('openai.endpoint', endpoint, vscode.ConfigurationTarget.Global);
		await c.update('openai.model', model, vscode.ConfigurationTarget.Global);
		await c.update('openai.azure', !!preset.azure, vscode.ConfigurationTarget.Global);

		// Chiedi la API key se richiesto esplicitamente o se non già memorizzata per questo endpoint.
		const existing = await this.context.secrets.get(openAiSecretKeyFor(endpoint));
		if (forceKey || !existing) {
			await this.setOpenAIKey();
		}
		this.updateStatusBar();
		return true;
	}

	/** Testa la raggiungibilità del provider e mostra l'esito. */
	private async testAndReport(provider: LLMProvider, label: string): Promise<void> {
		const ok = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: `Verifica connessione a ${label}…`, cancellable: false },
			() => provider.isConfigured()
		);
		this.updateStatusBar();
		if (ok) {
			vscode.window.showInformationMessage(`✓ ${label} configurato e raggiungibile.`);
		} else {
			vscode.window.showWarningMessage(`⚠ ${label} configurato, ma il test di connessione non è riuscito. Verifica la chiave o l'endpoint.`);
		}
	}

	/** Procedura guidata: scegli un servizio, ottieni la chiave, testala, scegli il modello. */
	async guidedSetup(): Promise<void> {
		type Item = vscode.QuickPickItem & { target: 'preset' | 'claude' | 'ollama'; presetId?: string };
		const items: Item[] = [
			{ label: '$(sparkle) Google Gemini', detail: 'API key gratuita da Google AI Studio', target: 'preset', presetId: 'gemini' },
			{ label: 'ChatGPT (OpenAI)', detail: 'API key da OpenAI Platform', target: 'preset', presetId: 'chatgpt' },
			{ label: 'Claude (Anthropic)', detail: 'API key da console.anthropic.com', target: 'claude' },
			{ label: 'OpenRouter', detail: 'Tutti i modelli con una sola key', target: 'preset', presetId: 'openrouter' },
			{ label: 'Azure OpenAI', detail: 'Endpoint aziendale', target: 'preset', presetId: 'azure' },
			{ label: 'Ollama (locale)', detail: 'Modelli in locale, nessuna chiave', target: 'ollama' },
			{ label: 'LM Studio (locale)', detail: 'Server locale OpenAI-compatibile', target: 'preset', presetId: 'lmstudio' }
		];
		const pick = await vscode.window.showQuickPick(items, { title: 'Configurazione provider e API key', placeHolder: 'Scegli il servizio: ti chiederò qui la API key (Gemini, ChatGPT, Claude…)', ignoreFocusOut: true });
		if (!pick) {
			return;
		}

		if (pick.target === 'claude') {
			const go = await vscode.window.showInformationMessage(
				'Claude richiede una API key Anthropic (sk-ant-…).',
				'Apri pagina chiave',
				'Ho già la chiave'
			);
			if (go === 'Apri pagina chiave') {
				await vscode.env.openExternal(vscode.Uri.parse('https://console.anthropic.com/settings/keys'));
			}
			if (!go) {
				return;
			}
			await vscode.workspace.getConfiguration('mgcoding').update('provider', 'claude', vscode.ConfigurationTarget.Global);
			await this.setApiKey();
			await this.testAndReport(this.claude, 'Claude');
			return;
		}

		if (pick.target === 'ollama') {
			const c = vscode.workspace.getConfiguration('mgcoding');
			await c.update('provider', 'ollama', vscode.ConfigurationTarget.Global);
			const endpoint = c.get<string>('ollama.endpoint', 'http://localhost:11434');
			const models = await this.ollama.listModels();
			if (!models.length) {
				vscode.window.showWarningMessage(`Ollama non raggiungibile su ${endpoint}. Avvia Ollama (e scarica un modello con "ollama pull") poi riprova.`);
				return;
			}
			const model = await vscode.window.showQuickPick(models, { placeHolder: 'Scegli il modello Ollama da usare' });
			if (model) {
				await c.update('ollama.model', model, vscode.ConfigurationTarget.Global);
			}
			await this.testAndReport(this.ollama, 'Ollama');
			return;
		}

		// Servizi OpenAI-compatibili (preset)
		const preset = OPENAI_PRESETS.find(p => p.id === pick.presetId);
		if (!preset) {
			return;
		}
		if (preset.keyUrl) {
			const go = await vscode.window.showInformationMessage(
				`${preset.label}. ${preset.note ?? ''}`.trim(),
				'Apri pagina chiave',
				'Ho già la chiave'
			);
			if (!go) {
				return;
			}
			if (go === 'Apri pagina chiave') {
				await vscode.env.openExternal(vscode.Uri.parse(preset.keyUrl));
			}
		} else if (preset.note) {
			vscode.window.showInformationMessage(preset.note);
		}
		const ok = await this.applyOpenAiPreset(preset, true);
		if (!ok) {
			return;
		}
		// Offri la scelta del modello tra quelli esposti dall'endpoint, se disponibili.
		try {
			const models = await this.openai.listModels();
			if (models.length) {
				const current = vscode.workspace.getConfiguration('mgcoding').get<string>('openai.model', '');
				const sorted = [current, ...models.filter(m => m !== current)].filter(Boolean);
				const model = await vscode.window.showQuickPick(sorted, { placeHolder: `Scegli il modello (${preset.label})` });
				if (model) {
					await vscode.workspace.getConfiguration('mgcoding').update('openai.model', model, vscode.ConfigurationTarget.Global);
				}
			}
		} catch {
			// elenco modelli non disponibile: si tiene il default del preset
		}
		await this.testAndReport(this.openai, preset.label);
	}

	private updateStatusBar(): void {
		const p = this.current();
		this.statusBar.text = `$(sparkle) MGCoding: ${p.label} (${p.modelName()})`;
		this.statusBar.tooltip = 'Clicca per cambiare provider/modello MGCoding';
	}

	async switchProvider(): Promise<void> {
		type Item = vscode.QuickPickItem & { id: string; preset?: OpenAIPreset };
		const items: Item[] = [
			{ label: 'Ollama (locale)', id: 'ollama' },
			{ label: 'Claude (Anthropic)', id: 'claude' },
			{ label: 'GLM (Zhipu/Z.ai)', id: 'glm' },
			{ label: 'Servizi OpenAI-compatibili', kind: vscode.QuickPickItemKind.Separator, id: '' },
			...OPENAI_PRESETS.map(p => ({
				label: p.label,
				description: p.endpoint || (p.azure ? 'Azure' : 'personalizzato'),
				id: 'openai',
				preset: p
			}))
		];
		const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Seleziona il provider/servizio LLM' });
		if (!picked) {
			return;
		}
		if (picked.id === 'openai' && picked.preset) {
			await this.applyOpenAiPreset(picked.preset);
			return;
		}
		await vscode.workspace.getConfiguration('mgcoding').update('provider', picked.id, vscode.ConfigurationTarget.Global);
		if (picked.id === 'claude' && !(await this.claude.isConfigured())) {
			const set = await vscode.window.showInformationMessage(
				'Nessuna API key Claude impostata. Vuoi impostarla ora?',
				'Imposta'
			);
			if (set) {
				await this.setApiKey();
			}
		}
		if (picked.id === 'glm' && !(await this.hasGlmKey())) {
			const set = await vscode.window.showInformationMessage(
				'Nessuna API key GLM impostata. Vuoi impostarla ora?',
				'Imposta'
			);
			if (set) {
				await this.setGlmKey();
			}
		}
		this.updateStatusBar();
	}

	async setApiKey(): Promise<void> {
		const key = await vscode.window.showInputBox({
			prompt: 'Incolla la tua API key Anthropic (sk-ant-...)',
			password: true,
			ignoreFocusOut: true
		});
		if (key) {
			await this.context.secrets.store(SECRET_CLAUDE_KEY, key.trim());
			vscode.window.showInformationMessage('API key Claude salvata in modo sicuro.');
			this.updateStatusBar();
		}
	}

	dispose(): void {
		this.disposables.forEach(d => d.dispose());
	}

	// -----------------------------------------------------------------------
	//  Gestione uniforme degli errori dei provider (Req. 9.2, 9.4, 9.5)
	// -----------------------------------------------------------------------

	/** True se almeno un provider è configurato e raggiungibile (Req. 9.5). */
	async anyProviderAvailable(): Promise<boolean> {
		const results = await Promise.all([
			this.ollama.isConfigured().catch(() => false),
			this.claude.isConfigured().catch(() => false),
			this.openai.isConfigured().catch(() => false),
			this.glm.isConfigured().catch(() => false)
		]);
		return results.some(Boolean);
	}

	/** Etichetta del primo provider raggiungibile diverso da `excludeId` (proposta di ripiego, Req. 9.4). */
	private async firstAvailableLabel(excludeId?: string): Promise<string | undefined> {
		const candidates: LLMProvider[] = [this.ollama, this.claude, this.openai, this.glm];
		for (const p of candidates) {
			if (p.id === excludeId) {
				continue;
			}
			if (await p.isConfigured().catch(() => false)) {
				return p.label;
			}
		}
		return undefined;
	}

	/** Chiede all'utente la chiave del provider colpito (Req. 9.2), instradando al flusso giusto. */
	private async promptKeyFor(providerId?: string): Promise<void> {
		switch (providerId) {
			case 'claude':
				await this.setApiKey();
				break;
			case 'openai':
				await this.setOpenAIKey();
				break;
			case 'glm':
				await this.setGlmKey();
				break;
			default:
				await this.guidedSetup();
				break;
		}
	}

	/**
	 * Reagisce a un errore di provider e restituisce il messaggio da mostrare all'utente (Req. 9):
	 *  - `missing_key` → chiede la chiave API e interrompe la richiesta corrente (Req. 9.2);
	 *  - `invalid_key` → messaggio dedicato di chiave non valida (Req. 9.3);
	 *  - `rate_limit` → segnala il limite e propone un provider di ripiego se disponibile (Req. 9.4);
	 *  - `unreachable` → se nessun provider è raggiungibile, comunica l'assenza di provider (Req. 9.5).
	 * Gli errori non-LLM o non classificati restituiscono semplicemente il loro messaggio.
	 */
	async handleProviderError(err: unknown): Promise<string> {
		if (!(err instanceof LLMError)) {
			return err instanceof Error ? err.message : String(err);
		}
		switch (err.kind) {
			case 'missing_key':
				// La richiesta corrente è già interrotta dal throw: ora chiediamo la chiave.
				await this.promptKeyFor(err.providerId);
				return err.message;
			case 'rate_limit': {
				const alt = await this.firstAvailableLabel(err.providerId);
				return alt
					? `${err.message} Provider di ripiego disponibile: ${alt} (cambialo dalla barra di stato o con "MGCoding: Cambia provider").`
					: err.message;
			}
			case 'unreachable':
				if (!(await this.anyProviderAvailable())) {
					return 'Nessun provider disponibile: nessun modello locale o cloud è raggiungibile. Configura Ollama o un provider cloud con "MGCoding: Configurazione guidata".';
				}
				return err.message;
			default:
				return err.message;
		}
	}
}
