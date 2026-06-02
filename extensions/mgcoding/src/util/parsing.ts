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

/** Estrae una tool-call accettando {tool,args} (mg-tool) o {name,arguments} (function-call). */
export function parseToolCall(text: string): ParsedToolCall | undefined {
	let jsonStr: string | undefined;
	const m = TOOL_RE.exec(text);
	if (m) {
		jsonStr = m[1].trim();
	} else if (text.trim().startsWith('{') && text.trim().endsWith('}')) {
		jsonStr = text.trim();
	}
	if (!jsonStr) {
		return undefined;
	}
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
