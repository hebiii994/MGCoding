/*---------------------------------------------------------------------------------------------
 *  MGCoding - loop agentico (ReAct con protocollo tool JSON, compatibile Claude e Ollama)
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ProviderRegistry } from '../llm/registry';
import { AnthropicBlock, AnthropicMessage, ChatMessage, LLMProvider, parseDataUrl } from '../llm/types';
import { getMcpManager } from '../mcp/mcpClient';
import { beginCheckpoint } from '../edit/checkpoint';
import { parseToolCall, parseAllToolCalls, extractShellCommands, TOOL_RE } from '../util/parsing';
import { buildSystemPrompt, complete, streamChat } from './agent';
import { anthropicBuiltinTools, errorsForPaths, executeTool, ToolCall, ToolSpec, TOOL_SPECS } from './tools';

const MAX_ITERATIONS = 30;

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

function toolSystemPrompt(hint?: string): string {
	const specs = [...TOOL_SPECS, ...filteredMcpSpecs(hint)];
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

ESEMPIO. Richiesta: "avvia l'app". Risposta corretta (e nient'altro):
\`\`\`mg-tool
{"tool": "run_command", "args": {"command": "npm install"}}
\`\`\`
(poi, ricevuto il risultato, al messaggio dopo:)
\`\`\`mg-tool
{"tool": "run_command", "args": {"command": "npm run dev"}}
\`\`\`

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
function toolActionSchema(): object {
	const names = [
		...TOOL_SPECS.map(t => t.name),
		...(getMcpManager()?.toolSpecs().map(t => t.name) ?? []),
		'respond'
	];
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

/** Immagini dell'ultima chiamata a un tool MCP, come data URL (per i percorsi testuali). */
function mcpImageDataUrls(): string[] {
	return (getMcpManager()?.takeLastImages() ?? []).map(im => `data:${im.mediaType};base64,${im.data}`);
}

/** Quanti risultati tool recenti tenere integri e taglio per i più vecchi (solo percorso Ollama). */
const TRIM_KEEP_RECENT = 4;
const TRIM_MAX_CHARS = 700;

/**
 * Tronca i risultati tool più VECCHI nello storico del run (percorso testuale/structured,
 * cioè modelli locali con contesto piccolo): gli ultimi restano integri, i precedenti
 * vengono accorciati per non saturare il contesto nei run lunghi.
 */
function trimOldToolResults(msgs: ChatMessage[]): void {
	let recent = 0;
	for (let k = msgs.length - 1; k >= 0; k--) {
		const m = msgs[k];
		if (m.role === 'user' && /^Risultato del (?:tool|comando)/.test(m.content)) {
			recent++;
			if (recent > TRIM_KEEP_RECENT && m.content.length > TRIM_MAX_CHARS) {
				m.content = `${m.content.slice(0, TRIM_MAX_CHARS)}\n… [risultato più vecchio troncato per non saturare il contesto]`;
			}
		}
	}
}
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
	let ollamaNative = true;
	if (provider.id === 'ollama') {
		ollamaNative = vscode.workspace.getConfiguration('mgcoding').get<boolean>('ollama.nativeTools', false);
	}
	try {
		if (typeof provider.streamAgent === 'function' && ollamaNative) {
			await runNativeAgent(registry, provider, messages, cb, signal, systemExtra, 0);
		} else {
			await runJsonAgent(registry, provider, messages, cb, signal, systemExtra, 0);
		}
	} finally {
		registry.setOllamaModelOverride(undefined);
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
	const reqHint = [...messages].reverse().find(m => m.role === 'user')?.content;
	const sys = systemExtra ? `${toolSystemPrompt(reqHint)}\n\n${systemExtra}` : toolSystemPrompt(reqHint);
	const streaming = typeof cb.onStreamDelta === 'function';
	const callCounts = new Map<string, number>();
	let sawAnyTool = false;
	let nudges = 0;
	let shellRuns = 0;
	const changed = new Set<string>();
	let verifyRounds = 0;

	const dedup = makeResultDedup();
	// Esegue un tool gestendo i casi speciali (ask/remember/delegate/plan) o quelli reali.
	const execOne = async (toolName: string, args: Record<string, unknown>): Promise<string> =>
		dedup(toolName, args,
			(await handleAskTool(toolName, args, cb))
			?? (await handleRememberTool(toolName, args, cb))
			?? (await handleDelegateTool(toolName, args, registry, provider, signal, depth, systemExtra))
			?? handlePlanTool(toolName, args, cb)
			?? await executeTool({ tool: toolName, args }));

	// Tool calling RIGOROSO (Ollama): output vincolato a uno schema → niente JSON spazzatura.
	let structuredOllama = provider.id === 'ollama'
		&& vscode.workspace.getConfiguration('mgcoding').get<boolean>('ollama.structuredTools', false)
		&& typeof (provider as { chatStructured?: unknown }).chatStructured === 'function';

	for (let i = 0; i < MAX_ITERATIONS; i++) {
		if (signal?.aborted) {
			return;
		}
		// Nei run lunghi accorcia i risultati tool più vecchi (contesto piccolo dei locali).
		if (i > 0) {
			trimOldToolResults(messages);
		}

		// --- Percorso RIGOROSO (Ollama structured): output vincolato a schema JSON ---
		if (structuredOllama) {
			try {
				const raw = await (provider as unknown as { chatStructured(s: string | undefined, m: { role: string; content: string }[], schema: object, sig?: AbortSignal): Promise<string> })
					.chatStructured(sys + STRUCTURED_INSTRUCTION, messages.map(m => ({ role: m.role, content: m.content })), toolActionSchema(), signal);
				const parsed = JSON.parse(raw) as { reasoning?: string; tool?: string; args?: Record<string, unknown> };
				const tool = String(parsed.tool ?? '').trim();
				const reasoning = String(parsed.reasoning ?? '').trim();
				const args = (parsed.args && typeof parsed.args === 'object') ? parsed.args : {};
				if (!tool || /^(?:respond|final|none|answer|done)$/i.test(tool)) {
					const finalText = reasoning || String((args as { message?: unknown }).message ?? '');
					messages.push({ role: 'assistant', content: finalText });
					cb.onAssistantText(finalText);
					if (verifyRounds < MAX_VERIFY_ROUNDS) {
						const verify = await autoVerify(changed);
						if (verify) { verifyRounds++; changed.clear(); cb.onToolStart({ tool: 'verifica', args: {} }); cb.onToolResult(verify); messages.push({ role: 'user', content: verify }); continue; }
					}
					return;
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
				const structuredUserMsg: ChatMessage = { role: 'user', content: `Risultato del tool ${tool}:\n${result}` };
				const structuredImgs = mcpImageDataUrls();
				if (structuredImgs.length) {
					structuredUserMsg.images = structuredImgs;
				}
				messages.push(structuredUserMsg);
				continue;
			} catch {
				// Errore (schema/parse/connessione): disattiva la modalità strutturata per il
				// resto del run e prosegui col percorso testuale (niente retry sprecati).
				structuredOllama = false;
			}
		}

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
				const verify = await autoVerify(changed);
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
				const r = dedup(c.tool, c.args, await executeTool({ tool: c.tool, args: c.args }));
				cb.onToolResult(r);
				return `Risultato del tool ${c.tool} (${JSON.stringify(c.args)}):\n${r}`;
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
		const toolUserMsg: ChatMessage = { role: 'user', content: `Risultato del tool ${call.tool}:\n${result}${hint}` };
		const toolImgs = mcpImageDataUrls();
		if (toolImgs.length) {
			toolUserMsg.images = toolImgs;
		}
		messages.push(toolUserMsg);
	}

	cb.onAssistantText('_(raggiunto il limite massimo di passi dell\'agente)_');
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
	const lastUserMsg = [...history].reverse().find(m => m.role === 'user');
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

	for (let i = 0; i < MAX_ITERATIONS; i++) {
		if (signal?.aborted) {
			return;
		}

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
				const verify = await autoVerify(changed);
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

	cb.onAssistantText('_(raggiunto il limite massimo di passi dell\'agente)_');
}
