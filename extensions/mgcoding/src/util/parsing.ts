/*---------------------------------------------------------------------------------------------
 *  MGCoding - funzioni di parsing pure (senza dipendenze da vscode), testabili in isolamento
 *--------------------------------------------------------------------------------------------*/

export type HookEventType = 'onSave' | 'onCreate' | 'onDelete' | 'manual';
export type HookActionType = 'ask' | 'command';

export interface ParsedToolCall {
	tool: string;
	args: Record<string, unknown>;
}

export interface InternalHook {
	name: string;
	description?: string;
	event: HookEventType;
	filePattern?: string;
	action: HookActionType;
	prompt?: string;
	command?: string;
	enabled: boolean;
}

/** Regex per il blocco tool nel protocollo testuale (mg-tool o json). */
export const TOOL_RE = /```(?:mg-tool|json)?\s*([\s\S]*?)```/;

/** Prova a interpretare una stringa JSON come tool-call. */
function tryParseToolJson(jsonStr: string): ParsedToolCall | undefined {
	try {
		const obj = JSON.parse(jsonStr);
		const name = obj.tool ?? obj.name;
		const args = obj.args ?? obj.arguments ?? {};
		if (typeof name === 'string') {
			return { tool: name, args };
		}
	} catch {
		// JSON malformato
	}
	return undefined;
}

/** Estrae una tool-call accettando {tool,args} (mg-tool) o {name,arguments} (function-call). */
export function parseToolCall(text: string): ParsedToolCall | undefined {
	const m = TOOL_RE.exec(text);
	if (m) {
		return tryParseToolJson(m[1].trim());
	}
	if (text.trim().startsWith('{') && text.trim().endsWith('}')) {
		return tryParseToolJson(text.trim());
	}
	return undefined;
}

/** Estrae TUTTE le tool-call presenti nel testo (più blocchi), in ordine. */
export function parseAllToolCalls(text: string): ParsedToolCall[] {
	const out: ParsedToolCall[] = [];
	const re = /```(?:mg-tool|json)?\s*([\s\S]*?)```/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		const c = tryParseToolJson(m[1].trim());
		if (c) {
			out.push(c);
		}
	}
	if (out.length === 0) {
		const single = parseToolCall(text);
		if (single) {
			out.push(single);
		}
	}
	return out;
}

/** Comandi (primo token) che è sicuro auto-eseguire se il modello li scrive come testo. */
const SAFE_CMD = /^(npm|npx|yarn|pnpm|bun|node|deno|python3?|pip3?|git|vite|tsc|tsx|cargo|go|make|dotnet|mvn|gradle|\.\/gradlew|ng|next|nest|jest|vitest|eslint|prettier|php|composer|ruby|rails|bundle|dir|ls|cat|type)\b/i;

/**
 * Estrae comandi da terminale scritti come blocchi di codice (shell), così se il modello li
 * "scrive" invece di chiamarli col tool possiamo eseguirli comunque. Solo comandi in whitelist.
 */
export function extractShellCommands(text: string): string[] {
	const out: string[] = [];
	const re = /```(bash|sh|shell|zsh|console|powershell|cmd|terminal)?\s*([\s\S]*?)```/gi;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		const lang = (m[1] || '').toLowerCase();
		// Salta i blocchi di codice sorgente (js/ts/json/html…): solo shell o senza lingua.
		if (lang && !['bash', 'sh', 'shell', 'zsh', 'console', 'powershell', 'cmd', 'terminal'].includes(lang)) {
			continue;
		}
		for (let line of m[2].split('\n')) {
			line = line.trim().replace(/^[$#>]\s+/, ''); // togli prompt tipo "$ "
			if (line && !line.startsWith('#') && SAFE_CMD.test(line)) {
				out.push(line);
			}
		}
	}
	return out;
}

/** Combina una cartella base opzionale con un glob. */
export function scopedGlob(pattern: string, base?: unknown): string {
	const b = base ? String(base).replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/$/, '') : '';
	if (!b) {
		return pattern;
	}
	return pattern.startsWith('**') ? `${b}/${pattern}` : `${b}/**/${pattern}`;
}

/** Converte un hook in formato Kiro (when/then) nel modello interno. */
export function kiroHookToInternal(raw: any): InternalHook | undefined {
	if (!raw?.name) {
		return undefined;
	}
	const whenType = raw.when?.type ?? '';
	const event: HookEventType =
		whenType === 'fileCreated' ? 'onCreate' :
			whenType === 'fileDeleted' ? 'onDelete' :
				whenType === 'userTriggered' || whenType === 'manual' ? 'manual' :
					'onSave';
	const action: HookActionType = raw.then?.type === 'runCommand' ? 'command' : 'ask';
	return {
		name: raw.name,
		description: raw.description,
		event,
		filePattern: (raw.when?.patterns ?? [])[0],
		action,
		prompt: raw.then?.prompt,
		command: raw.then?.command,
		enabled: raw.enabled !== false
	};
}

/** Separa il ragionamento <think>…</think> dalla risposta. */
export function splitThink(raw: string): { think: string; answer: string; thinking: boolean } {
	const open = raw.indexOf('<think>');
	if (open < 0) {
		return { think: '', answer: raw, thinking: false };
	}
	const close = raw.indexOf('</think>', open);
	if (close < 0) {
		return { think: raw.slice(open + 7), answer: raw.slice(0, open), thinking: true };
	}
	return { think: raw.slice(open + 7, close), answer: raw.slice(0, open) + raw.slice(close + 8), thinking: false };
}
