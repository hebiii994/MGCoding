/*---------------------------------------------------------------------------------------------
 *  MGCoding - loop agentico (ReAct con protocollo tool JSON, compatibile Claude e Ollama)
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ProviderRegistry } from '../llm/registry';
import { AnthropicBlock, AnthropicMessage, CapabilityTier, ChatMessage, LLMProvider, parseDataUrl } from '../llm/types';
import { CapabilityCache, classifyTier, downgradeTier } from '../llm/capability';
import { computeBudget, estimateTokens, reduceHistory } from '../llm/contextManager';
import { compose } from './promptComposer';
import { getMcpManager } from '../mcp/mcpClient';
import { beginCheckpoint } from '../edit/checkpoint';
import { parseToolCall, parseAllToolCalls, extractShellCommands, TOOL_RE } from '../util/parsing';
import { buildSystemPrompt, complete, setActiveComposition, streamChat } from './agent';
import { statsBeginRun, statsEndRun, statsIteration, statsMarkLimit, statsTool } from './agentStats';
import { activeDevServer, anthropicBuiltinTools, errorsForPaths, executeTool, ToolCall, ToolSpec, TOOL_SPECS } from './tools';

const MAX_ITERATIONS = 30;

/* -------------------------------------------------------------------------------------------
 * Cache delle capacità per la SESSIONE corrente (Req. 9.6).
 *
 * Vive a livello di modulo nell'Agent_Loop: i declassamenti dovuti all'assenza di tool-call
 * valide persistono tra run successivi della stessa sessione, così che le esecuzioni
 * seguenti usino il tier più basso. La risoluzione completa del tier (override di config →
 * probe funzionale → classifyTier) è cablata in `resolveTier` e memorizzata qui per la
 * durata della sessione (Req. 3.4, 3.6, 9.6).
 * ----------------------------------------------------------------------------------------- */
const sessionCapabilityCache = new CapabilityCache();

/** Chiave di cache del modello attivo per il provider corrente. */
function activeModelKey(registry: ProviderRegistry, provider: LLMProvider): string {
	return provider.id === 'ollama' ? registry.currentOllamaModel() : provider.modelName();
}

/**
 * Interfaccia minima del guscio Ollama usata dall'Agent_Loop per la risoluzione del tier
 * (probe funzionale + capability dichiarata) e per il budgeting del contesto (num_ctx).
 */
interface OllamaCapabilities {
	supportsTools(model: string): Promise<boolean>;
	probeToolUse(model: string): Promise<boolean>;
	effectiveNumCtx(model?: string): Promise<number>;
}

/** Restituisce il guscio Ollama se il provider lo è e ne espone i metodi, altrimenti undefined. */
function asOllama(provider: LLMProvider): OllamaCapabilities | undefined {
	const p = provider as Partial<OllamaCapabilities> & LLMProvider;
	if (provider.id === 'ollama'
		&& typeof p.supportsTools === 'function'
		&& typeof p.probeToolUse === 'function'
		&& typeof p.effectiveNumCtx === 'function') {
		return p as OllamaCapabilities;
	}
	return undefined;
}

/** Type guard per i valori di Capability_Tier provenienti dalla config (untyped). */
function isCapabilityTier(value: unknown): value is CapabilityTier {
	return value === 'native' || value === 'structured' || value === 'textual';
}

/** num_ctx oltre la soglia compatta usato per i provider cloud (finestra ampia → variante completa). */
const CLOUD_NUM_CTX = 131072;

/**
 * num_ctx effettivo del modello attivo (Req. 1.5, 7.1): per Ollama riusa la risoluzione del
 * guscio (config > finestra max del modello > default); per i provider cloud usa una finestra
 * ampia, così la composizione del prompt resta sulla variante completa.
 */
async function activeNumCtx(provider: LLMProvider): Promise<number> {
	const ollama = asOllama(provider);
	if (ollama) {
		try {
			return await ollama.effectiveNumCtx();
		} catch {
			// best-effort: in caso di errore I/O si ripiega sul default cloud
		}
	}
	return CLOUD_NUM_CTX;
}

/**
 * Risoluzione del Capability_Tier del modello attivo (Capability_Detector, Req. 3.1-3.6):
 *  - se la sessione ha già un tier per il modello (risolto o declassato) lo riusa (Req. 3.4, 9.6);
 *  - se esiste l'override `mgcoding.model.capabilityTier[model]` vince e salta la probe (Req. 3.5);
 *  - per Ollama interroga la capability `tools` dichiarata e, se presente, la verifica con la
 *    probe funzionale: `native` solo se la probe passa, altrimenti al massimo `structured` (Req. 3.2, 3.3);
 *  - per i provider senza guscio di probe la classificazione si basa solo su override/declaresTools.
 * L'esito viene memorizzato nella cache di sessione.
 */
async function resolveTier(provider: LLMProvider, modelKey: string): Promise<CapabilityTier> {
	const cached = sessionCapabilityCache.get(modelKey);
	if (cached !== undefined) {
		return cached;
	}
	const overrides = vscode.workspace.getConfiguration('mgcoding').get<Record<string, string>>('model.capabilityTier', {}) ?? {};
	const configOverride = isCapabilityTier(overrides[modelKey]) ? overrides[modelKey] as CapabilityTier : undefined;

	let declaresTools = false;
	let functionalProbePassed: boolean | undefined;
	const ollama = asOllama(provider);
	if (configOverride === undefined && ollama) {
		try {
			declaresTools = await ollama.supportsTools(modelKey);
			// La probe funzionale si esegue solo se il modello dichiara `tools` (Req. 3.2, 3.3).
			if (declaresTools) {
				functionalProbePassed = await ollama.probeToolUse(modelKey);
			}
		} catch {
			// best-effort: in caso di errore I/O si ricade su una classificazione conservativa
		}
	}
	const tier = classifyTier({ declaresTools, functionalProbePassed, configOverride });
	sessionCapabilityCache.set(modelKey, tier);
	return tier;
}

/**
 * Declassa il tier del modello per la sessione corrente (Req. 9.6): invocato quando un
 * modello che dichiara tool-use NON emette alcuna chiamata a tool valida entro le iterazioni
 * configurate. Al primo declassamento parte dal tier effettivo corrente applicando
 * `downgradeTier`; ai declassamenti successivi delega a `CapabilityCache.downgrade` (che a
 * sua volta applica `downgradeTier` sul valore già in cache). Il limite inferiore è `textual`.
 */
function downgradeSessionTier(modelKey: string, currentTier: CapabilityTier): CapabilityTier {
	if (sessionCapabilityCache.get(modelKey) === undefined) {
		const lowered = downgradeTier(currentTier);
		sessionCapabilityCache.set(modelKey, lowered);
		return lowered;
	}
	return sessionCapabilityCache.downgrade(modelKey);
}

/* -------------------------------------------------------------------------------------------
 * Logica pura del percorso di tool-calling per iterazione (Req. 2.1-2.5, 3.6).
 *
 * Queste funzioni e tipi sono PURI (nessuna dipendenza da `vscode`, da `fetch` o dal
 * filesystem): concentrano le decisioni sul percorso di tool-calling di una singola
 * iterazione e sono verificabili con property-based testing. Il cablaggio nel loop
 * effettivo avverrà in un task successivo.
 * ----------------------------------------------------------------------------------------- */

/**
 * Esito del percorso di tool-calling per una singola iterazione.
 *  - `tool`: il modello ha richiesto l'esecuzione di un tool;
 *  - `final`: il modello ha prodotto la risposta finale (nessun tool);
 *  - `fallback`: l'iterazione è ricaduta sul percorso testuale `mg-tool`.
 */
export interface IterationToolOutcome {
	kind: 'tool' | 'final' | 'fallback';
	tool?: string;
	args?: Record<string, unknown>;
	finalText?: string;
}

/** Stato di retry locale a UNA iterazione (Req. 2.2, 2.3). */
export interface IterationRetryState {
	retries: number;       // azzerato a ogni nuova iterazione
	maxRetries: number;    // default 1 → un retry prima di cambiare percorso
	usedFallback: boolean; // true se questa iterazione è ricaduta su mg-tool
}

/**
 * Decide il percorso della prossima iterazione (Req. 2.1, 2.4, 2.5, 3.6):
 *  - tier∈{structured,native} e structuredToolsEnabled → 'structured';
 *  - structuredToolsEnabled==false → sempre 'textual';
 *  - tier=='textual' → 'textual'.
 * Ogni iterazione riparte da capo: un fallback pregresso non disabilita le iterazioni
 * successive (la decisione non dipende dalle iterazioni precedenti).
 */
export function chooseIterationPath(
	tier: CapabilityTier,
	structuredToolsEnabled: boolean
): 'structured' | 'textual' {
	if (structuredToolsEnabled && (tier === 'structured' || tier === 'native')) {
		return 'structured';
	}
	return 'textual';
}

/**
 * Aggiorna lo stato di retry su output non conforme allo schema (Req. 2.2, 2.3):
 *  - se retries < maxRetries → incrementa di esattamente uno e ritenta structured;
 *  - altrimenti → segna usedFallback e passa a mg-tool per QUESTA iterazione.
 */
export function onSchemaViolation(state: IterationRetryState): 'retry' | 'fallback' {
	if (state.retries < state.maxRetries) {
		state.retries += 1;
		return 'retry';
	}
	state.usedFallback = true;
	return 'fallback';
}

/**
 * Esito di un singolo tentativo dello Structured_Tool_Engine per l'iterazione corrente:
 *  - `continue`: tool eseguito (o verifica iniettata), l'iterazione è conclusa e il loop prosegue;
 *  - `return`: il modello ha prodotto la risposta finale, il loop termina;
 *  - `violation`: output non conforme allo schema (o parse/connessione), gestito dal retry.
 */
export type StructuredAttemptOutcome = 'continue' | 'return' | 'violation';

/**
 * Decisione del loop per l'iterazione corrente dopo l'orchestrazione structured:
 *  - `return`: termina il loop (risposta finale);
 *  - `continue`: passa all'iterazione successiva;
 *  - `fallback`: prosegui sul percorso testuale `mg-tool` per QUESTA iterazione.
 */
export type StructuredIterationDecision = 'return' | 'continue' | 'fallback';

/**
 * Orchestrazione del percorso structured per UNA iterazione (Req. 2.1-2.4). È la logica che
 * lega `chooseIterationPath` e `onSchemaViolation` in una sequenza completa, estratta dal loop
 * per renderla verificabile end-to-end con un `attempt` finto (senza dipendere da vscode/rete):
 *  - se il percorso scelto NON è structured → `fallback` (si va sul testuale) senza tentativi;
 *  - altrimenti, stato di retry FRESCO a questa iterazione (`maxRetries`, default 1): tenta lo
 *    structured; su `violation` ritenta finché restano retry; poi mappa l'esito finale su
 *    `return`/`continue`, oppure su `fallback` quando i retry sono esauriti (Req. 2.3).
 * Lo stato di retry è locale: un fallback in questa iterazione NON influenza le successive
 * (la decisione di percorso è ricalcolata ogni volta da `chooseIterationPath`, Req. 2.4).
 */
export async function driveStructuredIteration(
	tier: CapabilityTier,
	structuredToolsEnabled: boolean,
	attempt: () => Promise<StructuredAttemptOutcome>,
	maxRetries = 1
): Promise<StructuredIterationDecision> {
	if (chooseIterationPath(tier, structuredToolsEnabled) !== 'structured') {
		return 'fallback';
	}
	const retry: IterationRetryState = { retries: 0, maxRetries, usedFallback: false };
	let step = await attempt();
	while (step === 'violation' && onSchemaViolation(retry) === 'retry') {
		step = await attempt();
	}
	if (step === 'return') {
		return 'return';
	}
	if (step === 'continue') {
		return 'continue';
	}
	return 'fallback';
}

/** Tool senza effetti collaterali: eseguibili in parallelo nello stesso turno. */
const READ_ONLY_TOOLS = new Set(['read_file', 'list_dir', 'find_files', 'search_text', 'search_code', 'get_diagnostics', 'get_command_output', 'fetch_url']);

/** Tool che modificano file (per la verifica automatica). */
const WRITE_TOOLS = new Set(['write_file', 'apply_patch']);
/** Numero massimo di giri di auto-correzione dopo la verifica. */
const MAX_VERIFY_ROUNDS = 2;

/**
 * Verifica automatica: dopo le modifiche, raccoglie gli ERRORI dei language server sui file
 * toccati. Ritorna un messaggio di correzione (o '' se è tutto pulito o disabilitata).
 */
async function autoVerify(changed: Set<string>): Promise<string> {
	if (!changed.size || !vscode.workspace.getConfiguration('mgcoding').get<boolean>('autoVerify', true)) {
		return '';
	}
	// Lascia ai language server il tempo di analizzare i file appena scritti: attende il
	// primo aggiornamento delle diagnostiche (+ assestamento), con un tetto massimo.
	await new Promise<void>(resolve => {
		const timer = setTimeout(() => { sub.dispose(); resolve(); }, 2500);
		const sub = vscode.languages.onDidChangeDiagnostics(() => {
			clearTimeout(timer);
			sub.dispose();
			setTimeout(resolve, 400);
		});
	});
	const errs = await errorsForPaths([...changed]);
	if (!errs) {
		return '';
	}
	return `[Verifica automatica] Dopo le tue modifiche i language server segnalano questi ERRORI da correggere:\n${errs}\n\nCorreggi questi errori (leggi i file se serve) e poi concludi.`;
}

/**
 * Seleziona i tool MCP più PERTINENTI alla richiesta corrente quando sono troppi:
 * decine di tool confondono i modelli (soprattutto quelli locali) e gonfiano il contesto.
 * I tool non esposti restano comunque richiamabili (hasTool li risolve lo stesso).
 */
function filteredMcpSpecs(hint?: string): ToolSpec[] {
	const all = getMcpManager()?.toolSpecs() ?? [];
	const max = Math.max(4, vscode.workspace.getConfiguration('mgcoding').get<number>('mcp.maxTools', 12));
	if (all.length <= max) {
		return all;
	}
	const req = (hint ?? '').toLowerCase();
	const words = req.split(/[^a-zàèéìíòóùú0-9_]+/).filter(w => w.length > 3);
	const score = (s: ToolSpec): number => {
		const text = `${s.name} ${s.description}`.toLowerCase();
		let n = 0;
		for (const w of words) {
			if (text.includes(w)) {
				n++;
			}
		}
		// Se l'utente nomina il server (es. "unity"), tutti i suoi tool salgono di priorità.
		const server = s.name.split('__')[0].toLowerCase();
		if (server && req.includes(server)) {
			n += 3;
		}
		return n;
	};
	const scored = all.map(s => ({ s, n: score(s) }));
	const hits = scored.filter(x => x.n > 0).sort((a, b) => b.n - a.n).map(x => x.s);
	const rest = scored.filter(x => x.n === 0).map(x => x.s);
	return [...hits, ...rest].slice(0, max);
}

/**
 * Verifica WEB automatica: se durante questo run è stato avviato un dev server, è il
 * SISTEMA a controllare che risponda (GET su URL, div di mount, entry script raggiungibile),
 * senza affidarsi alla buona volontà del modello. Ritorna un messaggio di correzione,
 * o '' se è tutto a posto (in quel caso mostra l'esito OK in chat).
 */
async function autoWebVerify(runStart: number, cb: AgentCallbacks): Promise<string> {
	if (!vscode.workspace.getConfiguration('mgcoding').get<boolean>('autoVerify', true)) {
		return '';
	}
	const srv = activeDevServer();
	if (!srv || srv.startedAt < runStart) {
		return ''; // nessun dev server avviato in QUESTO run
	}
	cb.onToolStart({ tool: 'verifica web', args: { url: srv.url } });
	try {
		const res = await fetch(srv.url, { signal: AbortSignal.timeout(8000) });
		const html = await res.text();
		if (!res.ok) {
			cb.onToolResult(`HTTP ${res.status}`);
			return `[Verifica automatica web] ${srv.url} risponde HTTP ${res.status}. La pagina NON funziona: leggi l'output del server con get_command_output, individua la causa, correggi e riverifica con fetch_url prima di concludere.`;
		}
		// Lo script entry deve essere servito senza errori (un 404/500 = pagina bianca).
		const scripts = [...html.matchAll(/<script[^>]+src="(?<src>[^"]+)"/g)].map(m => m.groups!.src);
		for (const s of scripts.slice(0, 4)) {
			const u = new URL(s, srv.url).toString();
			const r2 = await fetch(u, { signal: AbortSignal.timeout(8000) }).catch(() => undefined);
			if (!r2 || !r2.ok) {
				cb.onToolResult(`entry "${s}" → ${r2 ? `HTTP ${r2.status}` : 'irraggiungibile'}`);
				return `[Verifica automatica web] La pagina ${srv.url} risponde, ma lo script entry "${s}" dà ${r2 ? `HTTP ${r2.status}` : 'errore di rete'} → è questa la causa della pagina bianca. Controlla index.html (il percorso dello <script>) e che il file entry esista e compili; correggi e poi concludi.`;
			}
			const js = r2 ? await r2.text().catch(() => '') : '';
			if (/vite:import-analysis|Failed to resolve import/.test(js)) {
				cb.onToolResult(`entry "${s}" → errore di import`);
				return `[Verifica automatica web] Lo script entry "${s}" contiene un ERRORE di import di Vite. Leggi l'output del server con get_command_output per il dettaglio, correggi il file indicato e poi concludi.`;
			}
		}
		if (!/<div[^>]+id=["'](?:root|app)["']/.test(html)) {
			cb.onToolResult('manca il div di mount');
			return `[Verifica automatica web] L'HTML servito da ${srv.url} NON contiene un div di mount (id "root" o "app") → pagina bianca probabile. Controlla index.html e l'entry che fa il render; correggi e poi concludi.`;
		}
		cb.onToolResult(`OK: HTTP 200 su ${srv.url}, div di mount presente, entry script raggiungibile.`);
		return '';
	} catch (err) {
		cb.onToolResult('server non raggiungibile');
		return `[Verifica automatica web] ${srv.url} NON risponde (${err instanceof Error ? err.message : String(err)}). Il server potrebbe essere crollato: leggi l'output con get_command_output, correggi e riavvialo se serve.`;
	}
}

function toolSystemPrompt(hint?: string, exposedTools?: readonly string[]): string {
	let specs = [...TOOL_SPECS, ...filteredMcpSpecs(hint)];
	// In variante compatta espone esclusivamente il sottoinsieme ridotto di tool (Req. 7.3).
	if (exposedTools) {
		const allow = new Set(exposedTools);
		specs = specs.filter(t => allow.has(t.name));
	}
	const list = specs.map(t => `- ${t.name}: ${t.description} args: ${t.args}`).join('\n');
	return `Puoi AGIRE sul progetto SOLO tramite i tool: per eseguire un'azione (leggere/scrivere file, lanciare comandi) DEVI emettere un blocco tool, non descriverla.
Quando usi un tool, rispondi ESCLUSIVAMENTE con UN blocco così e nient'altro (un solo tool per messaggio), poi FERMATI e ASPETTA:
\`\`\`mg-tool
{"tool": "<nome>", "args": { ... }}
\`\`\`
REGOLE FERREE:
- Per le AZIONI (write_file, apply_patch, run_command) emetti UN SOLO tool per messaggio, poi interrompi e aspetta il risultato.
- Per INDAGARE puoi emettere PIÙ blocchi di SOLA LETTURA insieme nello stesso messaggio (read_file, list_dir, search_text, find_files, search_code, get_diagnostics, get_command_output) — verranno eseguiti tutti in una volta: sfruttalo per leggere più file/cartelle in un colpo solo invece di un turno per file.
- NON inventare MAI l'output di un tool (es. l'output di run_command): te lo fornirò io. Non scrivere finti log di successo.
- Per "avvia/esegui/installa/crea" DEVI usare run_command/write_file: VIETATO limitarti a spiegare o a scrivere i comandi in un blocco di testo. Se scrivi "esegui questi comandi" SBAGLI: eseguili tu col tool.
- Quando il compito è COMPLETO, rispondi in Markdown SENZA blocchi mg-tool.

ESEMPIO COMPLETO. Richiesta: "avvia l'app". Risposta corretta (e nient'altro):
\`\`\`mg-tool
{"tool": "run_command", "args": {"command": "npm install"}}
\`\`\`
(ricevi il risultato → al messaggio dopo:)
\`\`\`mg-tool
{"tool": "run_command", "args": {"command": "npm run dev"}}
\`\`\`
(ricevi l'output del server: se mostra errori li correggi, altrimenti CONCLUDI con la risposta finale in Markdown, breve e senza blocchi tool:)
Fatto: dipendenze installate e dev server avviato su http://localhost:5173.

Tool disponibili:
${list}

Usa percorsi relativi alla radice del workspace.`;
}

export interface AgentCallbacks {
	/** Testo "statico" dell'assistente (ragionamento prima di un tool, o fallback non-streaming). */
	onAssistantText(text: string): void;
	onToolStart(call: ToolCall): void;
	onToolResult(result: string): void;
	/** Callback di streaming (opzionali): se onStreamDelta è presente, il loop usa lo streaming. */
	onStreamStart?(): void;
	onStreamDelta?(text: string): void;
	onStreamEnd?(): void;
	onStreamCancel?(): void;
	/** Piano di lavoro a step aggiornato dall'agente (tool update_plan). */
	onPlan?(steps: PlanStep[]): void;
	/** Domanda con opzioni all'utente (tool ask_user): risolve con la risposta scelta. */
	onAsk?(question: string, options: string[], multiSelect: boolean): Promise<string>;
	/** Memorizza un fatto/preferenza nel profilo utente attivo (tool remember). */
	onRemember?(fact: string): Promise<void>;
	/** Comunica il modello scelto dal router AutoModel per questo turno. */
	onModel?(model: string): void;
}

export interface PlanStep {
	text: string;
	status?: 'pending' | 'in_progress' | 'done';
}

/** Rileva quando il modello ANNUNCIA un'azione (es. "sto controllando X") senza poi agire. */
const ANNOUNCE_RE = /\b(sto (?:controllando|analizzando|verificando|cercando|esaminando|leggendo|preparando|implementando|creando|scrivendo|aprendo|eseguendo)|adesso (?:controllo|verifico|leggo|implemento|procedo|eseguo)|ora (?:controllo|verifico|leggo|procedo)|procedo (?:a|con|ad)\b|lasciami (?:controllare|verificare|leggere|dare)|sto per |i['’]?m (?:going to|checking|analyzing|looking)|let me (?:check|look|analyze|read))/i;
const CONCLUDE_RE = /\b(fatto|completato|in sintesi|riepilogo|conclus|ecco (?:il|la|i|le|qui)|in conclusione|done|summary)\b/i;

/** Rileva quando il modello SCRIVE comandi/istruzioni invece di eseguirli con i tool. */
const SHELL_INSTRUCTION_RE = /```[\s\S]*?\b(npm|yarn|pnpm|bun|pip|python|node|git|vite|next|cargo|go run|make|dotnet|mvn|gradle|\.\/)\b[\s\S]*?```|esegui questi comandi|nel terminale|uno alla volta|npm (install|run|start)|yarn (dev|install)/i;

/** True se il testo annuncia/descrive un'azione (o scrive comandi) ma non l'ha eseguita. */
function looksLikeUnfulfilledAnnouncement(text: string): boolean {
	const t = text.trim();
	if (!t || CONCLUDE_RE.test(t)) {
		return false;
	}
	return ANNOUNCE_RE.test(t) || SHELL_INSTRUCTION_RE.test(t);
}

/** Messaggio di "nudge" iniettato per far agire davvero il modello. */
const NUDGE_MESSAGE = '[Sistema] NON hai usato alcuno strumento: hai solo descritto o scritto i comandi. Questo è sbagliato. ESEGUILI TU ADESSO con i tool, UNO alla volta. Ad esempio per installare/avviare emetti SUBITO e SOLO:\n```mg-tool\n{"tool": "run_command", "args": {"command": "npm install"}}\n```\nNiente spiegazioni, niente blocchi di shell: solo il blocco mg-tool del primo comando.';

/**
 * Schema per il tool calling rigoroso (Ollama format/grammar): azione sempre ben formata.
 * Il nome del tool è vincolato con un enum ai tool realmente esistenti (+ "respond"):
 * la grammar impedisce fisicamente al modello di inventare tool inesistenti.
 */
function toolActionSchema(exposedTools?: readonly string[]): object {
	let names = [
		...TOOL_SPECS.map(t => t.name),
		...(getMcpManager()?.toolSpecs().map(t => t.name) ?? [])
	];
	// In variante compatta vincola l'enum al solo sottoinsieme esposto (Req. 7.3).
	if (exposedTools) {
		const allow = new Set(exposedTools);
		names = names.filter(n => allow.has(n));
	}
	names.push('respond');
	return {
		type: 'object',
		properties: {
			reasoning: { type: 'string' },
			tool: { type: 'string', enum: names },
			args: { type: 'object' }
		},
		required: ['tool', 'reasoning']
	};
}

/**
 * Dedup per-run dei risultati di sola lettura: se il modello ripete l'identica chiamata
 * ottenendo l'identico risultato, lo sostituisce con un marker corto (risparmia contesto
 * e segnala esplicitamente che rileggere non serve).
 */
function makeResultDedup(): (name: string, args: unknown, result: string) => string {
	const seen = new Map<string, string>();
	return (name, args, result) => {
		if (!READ_ONLY_TOOLS.has(name)) {
			return result;
		}
		const sig = `${name}:${JSON.stringify(args)}`;
		if (seen.get(sig) === result) {
			return `[Risultato IDENTICO alla precedente chiamata di ${name} con gli stessi argomenti: nulla è cambiato. Non ripetere la lettura: usa le informazioni già ottenute e agisci.]`;
		}
		seen.set(sig, result);
		return result;
	};
}

/** System prompt del PLANNER (planner/executor con AutoModel: il reasoning pianifica, il coder esegue). */
const PLANNER_SYS = 'Sei un PLANNER di sviluppo software. Dato il compito dell\'utente, rispondi SOLO con un elenco numerato di 3-6 step concreti e verificabili (una riga per step, in italiano), nell\'ordine giusto. Niente premesse, niente spiegazioni, niente codice: solo l\'elenco numerato.';

/** Estrae gli step numerati dalla risposta del planner (ripulita dal ragionamento). */
function parsePlanSteps(raw: string): PlanStep[] {
	const clean = raw.replace(/<think>[\s\S]*?<\/think>/g, '');
	const steps: PlanStep[] = [];
	for (const line of clean.split('\n')) {
		const m = /^\s*\d+[.)]\s+(?<step>.+)/.exec(line);
		if (m?.groups?.step) {
			steps.push({ text: m.groups.step.trim(), status: 'pending' });
		}
	}
	return steps.slice(0, 8);
}

/** Il compito merita una fase di pianificazione separata? */
function deservesPlanning(hint?: string): boolean {
	return !!hint && hint.length > 40
		&& /\b(crea|implementa|aggiungi|rifattorizza|refactor|correggi|fix|sistema|avvia|configura|setup|migra|integra|costruisci|build)\b/i.test(hint);
}

/** Etichetta esito per i risultati tool (i modelli deboli capiscono meglio OK/ERRORE espliciti). */
function resultLabel(result: string): string {
	return /^\[?errore/i.test(result.trim()) ? 'ERRORE' : 'OK';
}

/** Immagini dell'ultima chiamata a un tool MCP, come data URL (per i percorsi testuali). */
function mcpImageDataUrls(): string[] {
	return (getMcpManager()?.takeLastImages() ?? []).map(im => `data:${im.mediaType};base64,${im.data}`);
}

/** Quanti risultati tool recenti tenere integri durante la riduzione della cronologia. */
const TRIM_KEEP_RECENT = 4;
/** Istruzione aggiunta al system prompt in modalità strutturata. */
const STRUCTURED_INSTRUCTION = '\n\nRISPONDI SEMPRE con un oggetto JSON {"reasoning": "...", "tool": "<nome_tool o respond>", "args": {...}}. Per usare un tool metti il suo nome in "tool" e i parametri in "args". Per dare la risposta finale all\'utente usa "tool":"respond" e metti il testo in "args":{"message":"..."}. Un solo tool per volta.';

/** Intercetta il tool update_plan: aggiorna il piano in UI senza passare da executeTool. */
function handlePlanTool(name: string, input: unknown, cb: AgentCallbacks): string | undefined {
	if (name !== 'update_plan') {
		return undefined;
	}
	const raw = (input as { steps?: unknown })?.steps;
	const steps: PlanStep[] = Array.isArray(raw)
		? raw.map(s => ({ text: String((s as PlanStep).text ?? ''), status: (s as PlanStep).status })).filter(s => s.text)
		: [];
	cb.onPlan?.(steps);
	return `Piano aggiornato (${steps.length} step).`;
}

/**
 * Intercetta il tool ask_user: mostra una domanda con opzioni cliccabili e attende la
 * scelta dell'utente, restituendola come risultato del tool. Stile Kiro.
 */
async function handleAskTool(name: string, input: unknown, cb: AgentCallbacks): Promise<string | undefined> {
	if (name !== 'ask_user') {
		return undefined;
	}
	const question = String((input as { question?: unknown })?.question ?? '').trim();
	const rawOpts = (input as { options?: unknown })?.options;
	const options = Array.isArray(rawOpts) ? rawOpts.map(o => String(o)).filter(o => o.trim()) : [];
	const multiSelect = !!(input as { multiSelect?: unknown })?.multiSelect;
	if (!question || options.length === 0) {
		return 'Errore: ask_user richiede "question" (testo) e "options" (lista non vuota di risposte).';
	}
	if (!cb.onAsk) {
		return 'Non posso porre domande in questo contesto: procedi con l\'ipotesi più ragionevole.';
	}
	const answer = await cb.onAsk(question, options, multiSelect);
	return `Risposta dell'utente: ${answer}`;
}

/** Intercetta il tool remember: salva una preferenza duratura nel profilo utente attivo. */
async function handleRememberTool(name: string, input: unknown, cb: AgentCallbacks): Promise<string | undefined> {
	if (name !== 'remember') {
		return undefined;
	}
	const fact = String((input as { fact?: unknown })?.fact ?? '').trim();
	if (!fact) {
		return 'Errore: remember richiede "fact" (la preferenza da ricordare).';
	}
	if (!cb.onRemember) {
		return 'Memoria non disponibile in questo contesto.';
	}
	await cb.onRemember(fact);
	return `Memorizzato nel profilo utente: ${fact}`;
}

/**
 * Esegue un SUBAGENT focalizzato: un giro d'agente isolato (storico proprio, niente streaming
 * in UI) per un singolo sottocompito, restituendo un report conciso del risultato.
 */
async function runDelegated(registry: ProviderRegistry, provider: LLMProvider, task: string, signal: AbortSignal | undefined, depth: number, systemExtra?: string): Promise<string> {
	const messages: ChatMessage[] = [{ role: 'user', content: task }];
	let finalText = '';
	const tools: string[] = [];
	const cb: AgentCallbacks = {
		onAssistantText: t => { finalText = t; },
		onToolStart: c => { tools.push(c.tool); },
		onToolResult: () => { /* non inoltrato all'orchestratore */ }
	};
	if (typeof provider.streamAgent === 'function') {
		await runNativeAgent(registry, provider, messages, cb, signal, systemExtra, depth + 1);
	} else {
		await runJsonAgent(registry, provider, messages, cb, signal, systemExtra, depth + 1);
	}
	const used = tools.length ? `\n[subagent · tool: ${[...new Set(tools)].join(', ')}]` : '';
	return `${finalText.trim() || '(nessun risultato testuale)'}${used}`;
}

/** Intercetta il tool delegate: affida un sottocompito a un subagent (un livello di profondità). */
async function handleDelegateTool(name: string, input: unknown, registry: ProviderRegistry, provider: LLMProvider, signal: AbortSignal | undefined, depth: number, systemExtra?: string): Promise<string | undefined> {
	if (name !== 'delegate') {
		return undefined;
	}
	if (depth >= 1) {
		return 'Un subagent non può delegare ulteriormente: svolgi tu direttamente il compito.';
	}
	const task = String((input as { task?: unknown })?.task ?? '').trim();
	if (!task) {
		return 'Errore: delegate richiede "task" (il sottocompito da svolgere).';
	}
	const ctx = String((input as { context?: unknown })?.context ?? '').trim();
	return await runDelegated(registry, provider, ctx ? `${task}\n\nContesto:\n${ctx}` : task, signal, depth, systemExtra);
}

/**
 * Esegue il loop agentico finché il modello smette di invocare tool o si raggiunge il limite.
 * `messages` include già il messaggio utente corrente.
 * Se vengono forniti i callback di streaming, i token sono emessi in tempo reale; il parsing
 * dei tool avviene comunque sul testo completo della risposta.
 */
export async function runAgent(
	registry: ProviderRegistry,
	messages: ChatMessage[],
	cb: AgentCallbacks,
	signal?: AbortSignal,
	systemExtra?: string
): Promise<void> {
	beginCheckpoint();
	const lastUser = [...messages].reverse().find(m => m.role === 'user');
	const hint = lastUser?.content;
	const provider = registry.pickProvider(hint);
	// AutoModel: se attivo e il provider è Ollama, scegli il modello adatto alla richiesta.
	registry.setOllamaModelOverride(undefined);
	if (provider.id === 'ollama' && vscode.workspace.getConfiguration('mgcoding').get<boolean>('ollama.autoModel', false)) {
		try {
			const hasImages = !!lastUser?.images?.length;
			const chosen = await registry.chooseOllamaModel(hint, hasImages);
			if (chosen) {
				registry.setOllamaModelOverride(chosen);
				cb.onModel?.(chosen);
			}
		} catch {
			// routing best-effort
		}
	}
	// Claude/OpenAI: tool-use NATIVO sempre. Per OLLAMA, di default si usa il PROTOCOLLO
	// TESTUALE: molti modelli (es. i *coder*) dichiarano la capability "tools" ma poi emettono
	// la chiamata come TESTO JSON invece che come tool-call nativa → sul percorso nativo non
	// verrebbe eseguita. Il protocollo testuale invece la riconosce ed esegue. I tool nativi
	// per Ollama restano un opt-in esplicito (toggle "Tool nativi").
	// PLANNER/EXECUTOR (AutoModel): se è installato anche un modello reasoning, fagli
	// produrre il piano; l'executor (coder) lo segue. I reasoning pianificano meglio,
	// i coder eseguono meglio: ciascuno fa la sua parte.
	let extra = systemExtra;
	const mgCfg = vscode.workspace.getConfiguration('mgcoding');
	if (provider.id === 'ollama' && mgCfg.get<boolean>('ollama.autoModel', false)
		&& mgCfg.get<boolean>('ollama.planFirst', true) && deservesPlanning(hint)) {
		try {
			const executor = registry.currentOllamaModel();
			const planner = await registry.pickOllamaPlannerModel();
			if (planner && planner !== executor) {
				registry.setOllamaModelOverride(planner);
				const planRaw = await complete(registry, [{ role: 'user', content: hint! }], PLANNER_SYS, signal, provider, true);
				registry.setOllamaModelOverride(executor || undefined);
				const steps = parsePlanSteps(planRaw);
				if (steps.length >= 2) {
					cb.onPlan?.(steps);
					extra = `${extra ? `${extra}\n\n` : ''}[Piano preparato da un modello planner]\n${steps.map((s, idx) => `${idx + 1}. ${s.text}`).join('\n')}\nSegui questi step nell'ordine, adattandoli se la realtà del codice lo richiede.`;
				}
			}
		} catch {
			// pianificazione best-effort: senza piano si procede comunque
		}
	}
	let ollamaNative = true;
	if (provider.id === 'ollama') {
		ollamaNative = vscode.workspace.getConfiguration('mgcoding').get<boolean>('ollama.nativeTools', false);
	}
	statsBeginRun(provider.id, provider.id === 'ollama' ? registry.currentOllamaModel() : provider.modelName());
	try {
		if (typeof provider.streamAgent === 'function' && ollamaNative) {
			await runNativeAgent(registry, provider, messages, cb, signal, extra, 0);
		} else {
			await runJsonAgent(registry, provider, messages, cb, signal, extra, 0);
		}
	} finally {
		registry.setOllamaModelOverride(undefined);
		await statsEndRun(!!signal?.aborted);
	}
}

/**
 * Loop agentico con protocollo tool testuale (mg-tool), usato dai modelli senza tool-use
 * nativo (es. Ollama).
 */
async function runJsonAgent(
	registry: ProviderRegistry,
	provider: LLMProvider,
	messages: ChatMessage[],
	cb: AgentCallbacks,
	signal?: AbortSignal,
	systemExtra?: string,
	depth = 0
): Promise<void> {
	const runStart = Date.now();
	const reqHint = [...messages].reverse().find(m => m.role === 'user')?.content;
	const streaming = typeof cb.onStreamDelta === 'function';
	const callCounts = new Map<string, number>();
	let sawAnyTool = false;
	let nudges = 0;
	let shellRuns = 0;
	const changed = new Set<string>();
	let verifyRounds = 0;

	const dedup = makeResultDedup();
	// Esegue un tool gestendo i casi speciali (ask/remember/delegate/plan) o quelli reali.
	const execOne = async (toolName: string, args: Record<string, unknown>): Promise<string> => {
		const raw = (await handleAskTool(toolName, args, cb))
			?? (await handleRememberTool(toolName, args, cb))
			?? (await handleDelegateTool(toolName, args, registry, provider, signal, depth, systemExtra))
			?? handlePlanTool(toolName, args, cb)
			?? await executeTool({ tool: toolName, args });
		statsTool(toolName, resultLabel(raw) === 'OK');
		return dedup(toolName, args, raw);
	};

	// Tool calling RIGOROSO (Ollama structured): output vincolato a uno schema (Req. 2.1).
	// `canStructured` indica la sola DISPONIBILITÀ del motore strutturato (provider locale che
	// espone chatStructured); il flag utente `ollama.structuredTools` lo abilita.
	const canStructured = provider.id === 'ollama'
		&& typeof (provider as { chatStructured?: unknown }).chatStructured === 'function';
	// Flag che abilita lo Structured_Tool_Engine: con `false` l'Agent_Loop usa SEMPRE il
	// percorso testuale `mg-tool` senza tentare lo structured (Req. 2.5).
	const structuredToolsEnabled = canStructured
		&& vscode.workspace.getConfiguration('mgcoding').get<boolean>('ollama.structuredTools', false);
	// Capability_Detector: risoluzione reale del Capability_Tier del modello attivo (Req. 3.6),
	// tramite override di config → probe funzionale → classifyTier, con cache di sessione.
	// La scelta del percorso per iterazione resta delegata a `chooseIterationPath`.
	const modelKey = activeModelKey(registry, provider);
	const tier = await resolveTier(provider, modelKey);

	// Context_Manager + Prompt_Composer: num_ctx effettivo del modello, budget per la cronologia
	// e composizione (variante prompt + sottoinsieme tool) in base al budget effettivo (Req. 1.5, 7.1, 7.4).
	const numCtx = await activeNumCtx(provider);
	const allToolNames = [...TOOL_SPECS.map(t => t.name), ...filteredMcpSpecs(reqHint).map(t => t.name)];
	const composition = compose(tier, numCtx, allToolNames);
	// In variante compatta si filtra al sottoinsieme ridotto; in completa nessun filtro (Req. 7.3, 7.5).
	const exposed = composition.variant === 'compact' ? composition.exposedTools : undefined;
	const sys = systemExtra
		? `${toolSystemPrompt(reqHint, exposed)}\n\n${systemExtra}`
		: toolSystemPrompt(reqHint, exposed);
	// Comunica la composizione a buildSystemPrompt così la variante (compact/full) del system
	// prompt dipenda dal Context_Budget e non dal solo nome del modello (Req. 7.1, 7.4).
	setActiveComposition(composition);

	// Parametri di riduzione della cronologia (Context_Manager, Req. 1.5, 4.2, 4.6).
	const ctxCfg = vscode.workspace.getConfiguration('mgcoding');
	const responseReserve = ctxCfg.get<number>('context.responseReserve', 1024);
	const summarize = ctxCfg.get<boolean>('context.summarize', true);
	// historyBudget = num_ctx − (token di system+tool stimati) − riserva risposta. La stima usa
	// `sys` (che include già le definizioni dei tool esposti); i token aggiuntivi del prompt di
	// base sono trascurati nell'euristica.
	const historyBudget = computeBudget({
		configNumCtx: numCtx,
		systemTokens: estimateTokens(sys),
		toolTokens: 0,
		responseReserve
	}).historyBudget;

	/**
	 * Tenta UNA chiamata allo Structured_Tool_Engine per l'iterazione corrente (Req. 2.1).
	 * Esegue il tool richiesto o gestisce la risposta finale, aggiornando storico e UI.
	 * Ritorna:
	 *  - 'continue': l'iterazione è conclusa sul percorso structured (il loop prosegue);
	 *  - 'return': il modello ha prodotto la risposta finale (il loop termina);
	 *  - 'violation': output non conforme/parse/connessione → gestito dal retry per iterazione.
	 */
	const attemptStructured = async (): Promise<'continue' | 'return' | 'violation'> => {
		try {
			const raw = await (provider as unknown as { chatStructured(s: string | undefined, m: { role: string; content: string }[], schema: object, sig?: AbortSignal): Promise<string> })
				.chatStructured(sys + STRUCTURED_INSTRUCTION, messages.map(m => ({ role: m.role, content: m.content })), toolActionSchema(exposed), signal);
			const parsed = JSON.parse(raw) as { reasoning?: string; tool?: string; args?: Record<string, unknown> };
			const tool = String(parsed.tool ?? '').trim();
			const reasoning = String(parsed.reasoning ?? '').trim();
			const args = (parsed.args && typeof parsed.args === 'object') ? parsed.args : {};
			if (!tool || /^(?:respond|final|none|answer|done)$/i.test(tool)) {
				const finalText = reasoning || String((args as { message?: unknown }).message ?? '');
				messages.push({ role: 'assistant', content: finalText });
				cb.onAssistantText(finalText);
				if (verifyRounds < MAX_VERIFY_ROUNDS) {
					const verify = (await autoVerify(changed)) || (await autoWebVerify(runStart, cb));
					if (verify) { verifyRounds++; changed.clear(); cb.onToolStart({ tool: 'verifica', args: {} }); cb.onToolResult(verify); messages.push({ role: 'user', content: verify }); return 'continue'; }
				}
				return 'return';
			}
			sawAnyTool = true;
			if (reasoning) {
				cb.onAssistantText(reasoning);
			}
			// Nello storico va la forma mg-tool leggibile (non il JSON grezzo), così un
			// eventuale fallback al percorso testuale vede una conversazione coerente.
			messages.push({ role: 'assistant', content: `${reasoning ? `${reasoning}\n` : ''}\`\`\`mg-tool\n${JSON.stringify({ tool, args })}\n\`\`\`` });
			if (WRITE_TOOLS.has(tool) && typeof args.path === 'string') {
				changed.add(args.path);
			}
			cb.onToolStart({ tool, args });
			const result = await execOne(tool, args);
			cb.onToolResult(result);
			const structuredUserMsg: ChatMessage = { role: 'user', content: `Risultato del tool ${tool} (${resultLabel(result)}):\n${result}` };
			const structuredImgs = mcpImageDataUrls();
			if (structuredImgs.length) {
				structuredUserMsg.images = structuredImgs;
			}
			messages.push(structuredUserMsg);
			return 'continue';
		} catch {
			// Output non conforme allo schema (o parse/connessione): segnala la violazione,
			// la gestione del retry/fallback per iterazione decide il da farsi (Req. 2.2, 2.3).
			return 'violation';
		}
	};

	try {
		for (let i = 0; i < MAX_ITERATIONS; i++) {
			if (signal?.aborted) {
				return;
			}
			statsIteration();
			// Context_Manager: riduce la cronologia INVIATA per rientrare nel budget di contesto
			// (Req. 1.5) — riassume/tronca i risultati tool più vecchi e, se serve, rimuove i turni
			// più vecchi, mantenendo integri i più recenti e l'ultimo messaggio utente.
			if (i > 0) {
				const reduced = reduceHistory({ messages, historyBudget, summarize, keepRecent: TRIM_KEEP_RECENT }).messages;
				messages.splice(0, messages.length, ...reduced);
			}
			// Anti-deriva: ogni 8 iterazioni ricorda l'obiettivo (i modelli deboli lo perdono).
			if (i > 0 && i % 8 === 0 && reqHint) {
				messages.push({ role: 'user', content: `[Promemoria] L'obiettivo resta: "${reqHint.slice(0, 300)}". Non ricominciare da capo e non deviare: completa solo ciò che manca, poi concludi.` });
			}

			// --- Percorso di tool-calling per QUESTA iterazione (Req. 2.1, 2.4, 2.5) ---
			// La decisione è ricalcolata a ogni iterazione: un fallback testuale pregresso NON
			// disabilita lo structured nelle iterazioni successive (lo stato di retry è locale).
			// `attemptStructured` esegue UN tentativo; l'orchestrazione di retry/fallback per
			// iterazione è centralizzata in `driveStructuredIteration` (testata a parte), che
			// riparte da uno stato di retry fresco a ogni giro (Req. 2.2, 2.3, 2.4).
			const structuredDecision = await driveStructuredIteration(tier, structuredToolsEnabled, attemptStructured);
			if (structuredDecision === 'return') {
				return;
			}
			if (structuredDecision === 'continue') {
				continue;
			}
			// structuredDecision === 'fallback' → percorso testuale `mg-tool` per QUESTA iterazione
			// (sia quando il percorso scelto è già testuale, sia quando i retry structured sono esauriti).

			let reply: string;
			if (streaming) {
				cb.onStreamStart?.();
				reply = await streamChat(registry, messages, d => cb.onStreamDelta!(d), signal, sys, provider);
			} else {
				reply = await complete(registry, messages, sys, signal, provider);
			}

			const calls = parseAllToolCalls(reply);
			const call = calls[0];

			if (!call) {
				if (streaming) {
					cb.onStreamEnd?.();
				} else {
					cb.onAssistantText(reply);
				}
				messages.push({ role: 'assistant', content: reply });
				// Se il modello ha SCRITTO comandi da terminale invece di chiamare il tool,
				// eseguili noi (così "scrivere il comando" = eseguirlo, niente giro sprecato).
				const shellCmds = extractShellCommands(reply);
				if (shellCmds.length && shellRuns < 5) {
					shellRuns++;
					sawAnyTool = true;
					const parts: string[] = [];
					for (const cmd of shellCmds.slice(0, 4)) {
						cb.onToolStart({ tool: 'run_command', args: { command: cmd } });
						const r = await executeTool({ tool: 'run_command', args: { command: cmd } });
						cb.onToolResult(r);
						parts.push(`Risultato del comando "${cmd}":\n${r}`);
					}
					messages.push({ role: 'user', content: `${parts.join('\n\n')}\n\n(Ho eseguito io i comandi che avevi scritto: NON riscriverli. Prosegui in base al risultato reale qui sopra.)` });
					continue;
				}
				// Nudge: ha annunciato un'azione ma non ha usato tool → invitalo a farlo davvero.
				if (!sawAnyTool && nudges < 2 && looksLikeUnfulfilledAnnouncement(reply)) {
					nudges++;
					messages.push({ role: 'user', content: NUDGE_MESSAGE });
					continue;
				}
				// Auto-verifica: se ha modificato file, controlla gli errori e fagli correggere.
				if (verifyRounds < MAX_VERIFY_ROUNDS) {
					const verify = (await autoVerify(changed)) || (await autoWebVerify(runStart, cb));
					if (verify) {
						verifyRounds++;
						changed.clear();
						cb.onToolStart({ tool: 'verifica', args: {} });
						cb.onToolResult(verify);
						messages.push({ role: 'user', content: verify });
						continue;
					}
				}
				return;
			}
			sawAnyTool = true;
			if (WRITE_TOOLS.has(call.tool) && call.args.path) {
				changed.add(String(call.args.path));
			}

			// È una tool-call: in streaming annulliamo la bolla mostrata (conteneva il JSON del tool)
			if (streaming) {
				cb.onStreamCancel?.();
			}
			// testo eventuale prima del blocco tool (ragionamento) mostrato come testo statico
			const before = reply.slice(0, TOOL_RE.exec(reply)?.index ?? 0).trim();
			if (before) {
				cb.onAssistantText(before);
			}
			messages.push({ role: 'assistant', content: reply });

			// BATCH: se il modello ha emesso PIÙ tool di sola lettura nello stesso messaggio,
			// eseguili tutti insieme (in parallelo) → molti meno turni nelle fasi di indagine.
			if (calls.length > 1 && calls.every(c => READ_ONLY_TOOLS.has(c.tool))) {
				const results = await Promise.all(calls.map(async c => {
					cb.onToolStart(c);
					const rawBatch = await executeTool({ tool: c.tool, args: c.args });
					statsTool(c.tool, resultLabel(rawBatch) === 'OK');
					const r = dedup(c.tool, c.args, rawBatch);
					cb.onToolResult(r);
					return `Risultato del tool ${c.tool} (${JSON.stringify(c.args)}) — ${resultLabel(r)}:\n${r}`;
				}));
				messages.push({ role: 'user', content: results.join('\n\n') });
				continue;
			}

			// Guard anti-loop: i modelli deboli ripetono la stessa chiamata all'infinito.
			const sig = `${call.tool}:${JSON.stringify(call.args)}`;
			const n = (callCounts.get(sig) ?? 0) + 1;
			callCounts.set(sig, n);
			if (n > 4) {
				cb.onAssistantText('_(interrotto: chiamata ripetuta troppe volte allo stesso tool senza progresso)_');
				return;
			}

			cb.onToolStart(call);
			const result = await execOne(call.tool, call.args);
			cb.onToolResult(result);
			const hint = n >= 3 ? `\n\n[AVVISO: hai già chiamato ${call.tool} con questi stessi argomenti ${n} volte. Cambia approccio (altro tool/argomenti) oppure, se hai le informazioni, procedi o concludi.]` : '';
			const toolUserMsg: ChatMessage = { role: 'user', content: `Risultato del tool ${call.tool} (${resultLabel(result)}):\n${result}${hint}` };
			const toolImgs = mcpImageDataUrls();
			if (toolImgs.length) {
				toolUserMsg.images = toolImgs;
			}
			messages.push(toolUserMsg);
		}

		statsMarkLimit();
		cb.onAssistantText('_(raggiunto il limite massimo di passi dell\'agente)_');
	} finally {
		// Azzera la composizione del prompt impostata per questo run (Req. 7.1).
		setActiveComposition(undefined);
		// Declassamento di sessione (Req. 9.6): se il modello dichiara tool-use (tier capace)
		// ma NON ha emesso alcuna chiamata a tool valida entro le iterazioni configurate,
		// abbassa il suo Capability_Tier per la sessione corrente, così i run successivi
		// useranno un percorso più robusto. Saltato in caso di abort (run interrotto).
		if (!signal?.aborted && !sawAnyTool && tier !== 'textual') {
			downgradeSessionTier(modelKey, tier);
		}
	}
}

// --- Percorso tool-use NATIVO (Claude) ---

interface AccBlock {
	type: 'text' | 'tool_use' | 'thinking';
	text?: string;
	id?: string;
	name?: string;
	json?: string;
	sig?: string;
}

/**
 * Loop agentico con tool-use NATIVO (function calling Anthropic): più affidabile,
 * stile Kiro. I tool sono passati come schema; il modello risponde con blocchi tool_use
 * e noi rispondiamo con tool_result.
 */
async function runNativeAgent(
	registry: ProviderRegistry,
	provider: LLMProvider,
	history: ChatMessage[],
	cb: AgentCallbacks,
	signal?: AbortSignal,
	systemExtra?: string,
	depth = 0
): Promise<void> {
	const runStart = Date.now();
	const lastUserMsg = [...history].reverse().find(m => m.role === 'user');
	// Prompt_Composer: la variante del system prompt dipende dal Context_Budget effettivo
	// (Req. 7.1, 7.4). Il percorso nativo usa tool-use nativo (tier `native`); la scelta della
	// variante resta governata dal solo budget. I tool nativi restano completi (ask/delegate/plan).
	const numCtx = await activeNumCtx(provider);
	setActiveComposition(compose('native', numCtx, []));
	const system = await buildSystemPrompt(systemExtra, lastUserMsg?.content);
	// Un subagent (depth>0) non espone il tool delegate, per evitare ricorsione.
	// I tool MCP sono filtrati per pertinenza alla richiesta (vedi filteredMcpSpecs).
	const tools = [
		...anthropicBuiltinTools().filter(t => depth === 0 || t.name !== 'delegate'),
		...filteredMcpSpecs(lastUserMsg?.content).map(s => ({ name: s.name, description: s.description, input_schema: s.inputSchema }))
	];
	const streaming = typeof cb.onStreamDelta === 'function';
	const callCounts = new Map<string, number>();
	let sawAnyTool = false;
	let nudges = 0;
	let textFallbacks = 0;
	let shellRuns = 0;
	const changed = new Set<string>();
	let verifyRounds = 0;
	// Chiave del modello attivo per il declassamento di sessione (Req. 9.6): il percorso
	// nativo usa tool-use NATIVO, quindi il tier effettivo è `native`.
	const modelKey = activeModelKey(registry, provider);
	const dedup = makeResultDedup();
	// Esegue un tool con guard anti-loop (modelli che ripetono la stessa chiamata).
	const runToolGuarded = async (name: string, input: unknown): Promise<string> => {
		const ask = await handleAskTool(name, input, cb);
		if (ask !== undefined) {
			return ask;
		}
		const mem = await handleRememberTool(name, input, cb);
		if (mem !== undefined) {
			return mem;
		}
		const del = await handleDelegateTool(name, input, registry, provider, signal, depth, systemExtra);
		if (del !== undefined) {
			return del;
		}
		const plan = handlePlanTool(name, input, cb);
		if (plan !== undefined) {
			return plan;
		}
		const sig = `${name}:${JSON.stringify(input)}`;
		const n = (callCounts.get(sig) ?? 0) + 1;
		callCounts.set(sig, n);
		if (n > 4) {
			return `[interrotto: hai già chiamato ${name} con questi stessi argomenti ${n} volte senza progresso. Cambia approccio o concludi.]`;
		}
		const result = await executeTool({ tool: name, args: input as Record<string, unknown> });
		statsTool(name, resultLabel(result) === 'OK');
		return dedup(name, input, n >= 3 ? `${result}\n\n[AVVISO: chiamata a ${name} ripetuta ${n} volte; cambia strategia o concludi.]` : result);
	};

	// Costruisce i messaggi Anthropic dallo storico testuale.
	const messages: AnthropicMessage[] = history.map(m => {
		const content: AnthropicBlock[] = [];
		if (m.images?.length && m.role === 'user') {
			for (const img of m.images) {
				const p = parseDataUrl(img);
				if (p) {
					content.push({ type: 'image', source: { type: 'base64', media_type: p.mediaType, data: p.data } });
				}
			}
		}
		content.push({ type: 'text', text: m.content });
		return { role: m.role === 'assistant' ? 'assistant' : 'user', content };
	});

	try {
		for (let i = 0; i < MAX_ITERATIONS; i++) {
			if (signal?.aborted) {
				return;
			}
			statsIteration();

			if (streaming) {
				cb.onStreamStart?.();
			}

			const blocks = new Map<number, AccBlock>();
			let textAcc = '';
			let stopReason: string | undefined;
			let thinkingOpen = false;

			for await (const evt of provider.streamAgent!({ system, messages, tools, signal })) {
				if (evt.type === 'content_block_start' && evt.content_block && evt.index !== undefined) {
					if (evt.content_block.type === 'tool_use') {
						blocks.set(evt.index, { type: 'tool_use', id: evt.content_block.id, name: evt.content_block.name, json: '' });
					} else if (evt.content_block.type === 'thinking') {
						blocks.set(evt.index, { type: 'thinking', text: '', sig: '' });
					} else if (evt.content_block.type === 'text') {
						blocks.set(evt.index, { type: 'text', text: '' });
					}
				} else if (evt.type === 'content_block_delta' && evt.delta && evt.index !== undefined) {
					const b = blocks.get(evt.index);
					if (evt.delta.type === 'thinking_delta' && evt.delta.thinking) {
						if (streaming && !thinkingOpen) {
							cb.onStreamDelta!('<think>');
							thinkingOpen = true;
						}
						if (streaming) {
							cb.onStreamDelta!(evt.delta.thinking);
						}
						if (b && b.type === 'thinking') {
							b.text = (b.text ?? '') + evt.delta.thinking;
						}
					} else if (evt.delta.type === 'signature_delta' && evt.delta.signature && b && b.type === 'thinking') {
						b.sig = (b.sig ?? '') + evt.delta.signature;
					} else if (evt.delta.type === 'text_delta' && evt.delta.text) {
						if (streaming && thinkingOpen) {
							cb.onStreamDelta!('</think>');
							thinkingOpen = false;
						}
						textAcc += evt.delta.text;
						if (streaming) {
							cb.onStreamDelta!(evt.delta.text);
						}
						if (b && b.type === 'text') {
							b.text = (b.text ?? '') + evt.delta.text;
						}
					} else if (evt.delta.type === 'input_json_delta' && evt.delta.partial_json && b && b.type === 'tool_use') {
						b.json = (b.json ?? '') + evt.delta.partial_json;
					}
				} else if (evt.type === 'message_delta' && evt.delta?.stop_reason) {
					stopReason = evt.delta.stop_reason;
				} else if (evt.type === 'error') {
					throw new Error('Errore nello stream Anthropic.');
				}
			}
			if (streaming && thinkingOpen) {
				cb.onStreamDelta!('</think>');
				thinkingOpen = false;
			}

			// Ricostruisce i blocchi della risposta in ordine di indice.
			const assistantContent: AnthropicBlock[] = [];
			for (const [, b] of [...blocks.entries()].sort((a, c) => a[0] - c[0])) {
				if (b.type === 'thinking' && b.text) {
					assistantContent.push({ type: 'thinking', thinking: b.text, ...(b.sig ? { signature: b.sig } : {}) });
				} else if (b.type === 'text' && b.text) {
					assistantContent.push({ type: 'text', text: b.text });
				} else if (b.type === 'tool_use' && b.id && b.name) {
					let input: Record<string, unknown> = {};
					try {
						input = b.json ? JSON.parse(b.json) : {};
					} catch {
						input = {};
					}
					assistantContent.push({ type: 'tool_use', id: b.id, name: b.name, input });
				}
			}
			if (assistantContent.length === 0) {
				assistantContent.push({ type: 'text', text: textAcc });
			}
			messages.push({ role: 'assistant', content: assistantContent });

			const toolUses = assistantContent.filter((b): b is Extract<AnthropicBlock, { type: 'tool_use' }> => b.type === 'tool_use');

			if (stopReason !== 'tool_use' || toolUses.length === 0) {
				// FALLBACK: alcuni modelli (es. coder) scrivono la tool-call come TESTO invece di
				// chiamarla nativamente. Se nel testo c'è una tool-call valida e nota, eseguila
				// davvero (così non "racconta" e non inventa l'output).
				const textCall = parseToolCall(textAcc);
				const isKnownTool = !!textCall && (TOOL_SPECS.some(t => t.name === textCall.tool)
					|| ['ask_user', 'remember', 'delegate'].includes(textCall.tool)
					|| !!getMcpManager()?.hasTool(textCall.tool));
				if (textCall && isKnownTool && textFallbacks < 8) {
					textFallbacks++;
					sawAnyTool = true;
					if (streaming) {
						cb.onStreamCancel?.();
					}
					cb.onToolStart({ tool: textCall.tool, args: textCall.args });
					const result = await runToolGuarded(textCall.tool, textCall.args);
					cb.onToolResult(result);
					const p = (textCall.args as { path?: unknown }).path;
					if (WRITE_TOOLS.has(textCall.tool) && typeof p === 'string') {
						changed.add(p);
					}
					messages.push({ role: 'user', content: [{ type: 'text', text: `Risultato REALE del tool ${textCall.tool}:\n${result}\n(Non inventare l'output: usa questo.)` }] });
					continue;
				}
				// Risposta finale.
				if (streaming) {
					cb.onStreamEnd?.();
				} else {
					cb.onAssistantText(textAcc);
				}
				history.push({ role: 'assistant', content: textAcc });
				// Se il modello ha SCRITTO comandi da terminale invece di chiamarli, eseguili noi.
				const shellCmds = extractShellCommands(textAcc);
				if (shellCmds.length && shellRuns < 5) {
					shellRuns++;
					sawAnyTool = true;
					const parts: string[] = [];
					for (const cmd of shellCmds.slice(0, 4)) {
						cb.onToolStart({ tool: 'run_command', args: { command: cmd } });
						const r = await runToolGuarded('run_command', { command: cmd });
						cb.onToolResult(r);
						parts.push(`Risultato del comando "${cmd}":\n${r}`);
					}
					messages.push({ role: 'user', content: [{ type: 'text', text: `${parts.join('\n\n')}\n\n(Ho eseguito io i comandi che avevi scritto: NON riscriverli. Prosegui in base al risultato reale.)` }] });
					continue;
				}
				// Nudge: ha annunciato un'azione ma non ha usato tool → invitalo a farlo davvero.
				if (!sawAnyTool && nudges < 2 && looksLikeUnfulfilledAnnouncement(textAcc)) {
					nudges++;
					messages.push({ role: 'user', content: [{ type: 'text', text: NUDGE_MESSAGE }] });
					continue;
				}
				// Auto-verifica: se ha modificato file, controlla gli errori e fagli correggere.
				if (verifyRounds < MAX_VERIFY_ROUNDS) {
					const verify = (await autoVerify(changed)) || (await autoWebVerify(runStart, cb));
					if (verify) {
						verifyRounds++;
						changed.clear();
						cb.onToolStart({ tool: 'verifica', args: {} });
						cb.onToolResult(verify);
						messages.push({ role: 'user', content: [{ type: 'text', text: verify }] });
						continue;
					}
				}
				return;
			}
			sawAnyTool = true;

			// Chiude la bolla di testo (vuota -> annulla; con testo -> mantiene).
			if (streaming) {
				if (textAcc.trim()) {
					cb.onStreamEnd?.();
				} else {
					cb.onStreamCancel?.();
				}
			} else if (textAcc.trim()) {
				cb.onAssistantText(textAcc);
			}

			// Esegue i tool e prepara i tool_result. Se nella stessa risposta ci sono PIÙ
			// tool di sola lettura, li esegue in PARALLELO (più veloce); le scritture/comandi
			// restano sequenziali (ordine e conferme).
			const resultBlocks: AnthropicBlock[] = [];
			if (toolUses.length > 1 && toolUses.every(tu => READ_ONLY_TOOLS.has(tu.name))) {
				const results = await Promise.all(toolUses.map(async tu => {
					cb.onToolStart({ tool: tu.name, args: tu.input });
					const result = await runToolGuarded(tu.name, tu.input);
					cb.onToolResult(result);
					return { id: tu.id, result };
				}));
				for (const r of results) {
					resultBlocks.push({ type: 'tool_result', tool_use_id: r.id, content: r.result });
				}
			} else {
				for (const tu of toolUses) {
					cb.onToolStart({ tool: tu.name, args: tu.input });
					const result = await runToolGuarded(tu.name, tu.input);
					cb.onToolResult(result);
					const p = (tu.input as { path?: unknown })?.path;
					if (WRITE_TOOLS.has(tu.name) && typeof p === 'string') {
						changed.add(p);
					}
					// Immagini dai tool MCP (es. screenshot della scena Unity): allegate al
					// tool_result così i modelli vision le VEDONO davvero.
					const mcpImgs = getMcpManager()?.takeLastImages() ?? [];
					resultBlocks.push(mcpImgs.length
						? {
							type: 'tool_result', tool_use_id: tu.id, content: [
								{ type: 'text', text: result },
								...mcpImgs.map(im => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: im.mediaType, data: im.data } }))
							]
						}
						: { type: 'tool_result', tool_use_id: tu.id, content: result });
				}
			}
			messages.push({ role: 'user', content: resultBlocks });
		}

		statsMarkLimit();
		cb.onAssistantText('_(raggiunto il limite massimo di passi dell\'agente)_');
	} finally {
		// Azzera la composizione del prompt impostata per questo run (Req. 7.1).
		setActiveComposition(undefined);
		// Declassamento di sessione (Req. 9.6): il percorso nativo dichiara tool-use; se NON
		// emette alcuna chiamata a tool valida entro le iterazioni configurate, abbassa il
		// Capability_Tier per la sessione corrente (parte da `native`). Saltato in caso di abort.
		if (!signal?.aborted && !sawAnyTool) {
			downgradeSessionTier(modelKey, 'native');
		}
	}
}
