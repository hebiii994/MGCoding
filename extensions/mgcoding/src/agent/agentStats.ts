/*---------------------------------------------------------------------------------------------
 *  MGCoding - statistiche LOCALI dell'agente (iterazioni, tool, errori, durata per run).
 *  Nessun dato lascia il PC: servono a capire quali modelli/tool funzionano peggio e a
 *  ottimizzare sui dati reali invece che a sensazione. Comando: "MGCoding: Statistiche agente".
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

interface RunStat {
	ts: number;
	provider: string;
	model: string;
	iterations: number;
	toolCalls: number;
	toolErrors: number;
	durationMs: number;
	outcome: 'ok' | 'limit' | 'aborted';
	failedTools: Record<string, number>;
}

const STORE_KEY = 'mgcoding.agentStats.v1';
const MAX_RUNS = 200;

let memento: vscode.Memento | undefined;
let current: {
	ts: number; provider: string; model: string;
	iterations: number; toolCalls: number; toolErrors: number;
	failedTools: Record<string, number>; hitLimit: boolean;
} | undefined;

export function initAgentStats(m: vscode.Memento): void {
	memento = m;
}

export function statsBeginRun(provider: string, model: string): void {
	current = { ts: Date.now(), provider, model, iterations: 0, toolCalls: 0, toolErrors: 0, failedTools: {}, hitLimit: false };
}

export function statsIteration(): void {
	if (current) {
		current.iterations++;
	}
}

export function statsTool(name: string, ok: boolean): void {
	if (!current) {
		return;
	}
	current.toolCalls++;
	if (!ok) {
		current.toolErrors++;
		current.failedTools[name] = (current.failedTools[name] ?? 0) + 1;
	}
}

export function statsMarkLimit(): void {
	if (current) {
		current.hitLimit = true;
	}
}

export async function statsEndRun(aborted: boolean): Promise<void> {
	if (!current || !memento) {
		current = undefined;
		return;
	}
	const run: RunStat = {
		ts: current.ts,
		provider: current.provider,
		model: current.model,
		iterations: current.iterations,
		toolCalls: current.toolCalls,
		toolErrors: current.toolErrors,
		durationMs: Date.now() - current.ts,
		outcome: aborted ? 'aborted' : current.hitLimit ? 'limit' : 'ok',
		failedTools: current.failedTools
	};
	current = undefined;
	const runs = memento.get<RunStat[]>(STORE_KEY, []);
	runs.push(run);
	await memento.update(STORE_KEY, runs.slice(-MAX_RUNS));
}

/** Report Markdown aggregato sugli ultimi run (per modello + tool più problematici). */
export function statsSummary(): string {
	const runs = memento?.get<RunStat[]>(STORE_KEY, []) ?? [];
	if (!runs.length) {
		return '# Statistiche agente\n\nNessun run registrato ancora: usa l\'agente in chat e torna qui.';
	}
	const byModel = new Map<string, RunStat[]>();
	for (const r of runs) {
		const key = `${r.provider} · ${r.model || '(default)'}`;
		byModel.set(key, [...(byModel.get(key) ?? []), r]);
	}
	const avg = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
	const lines: string[] = [
		'# Statistiche agente (locali)',
		'',
		`Run registrati: **${runs.length}** (ultimi ${MAX_RUNS}). Nessun dato lascia il PC.`,
		'',
		'| Modello | Run | Iterazioni medie | Durata media | Tool falliti | Limite raggiunto |',
		'|---|---|---|---|---|---|'
	];
	for (const [key, rs] of [...byModel.entries()].sort((a, b) => b[1].length - a[1].length)) {
		const calls = rs.reduce((a, r) => a + r.toolCalls, 0);
		const errs = rs.reduce((a, r) => a + r.toolErrors, 0);
		const limits = rs.filter(r => r.outcome === 'limit').length;
		lines.push(`| ${key} | ${rs.length} | ${avg(rs.map(r => r.iterations)).toFixed(1)} | ${(avg(rs.map(r => r.durationMs)) / 1000).toFixed(0)}s | ${errs}/${calls} | ${limits} |`);
	}
	const failed = new Map<string, number>();
	for (const r of runs) {
		for (const [t, n] of Object.entries(r.failedTools)) {
			failed.set(t, (failed.get(t) ?? 0) + n);
		}
	}
	const top = [...failed.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
	if (top.length) {
		lines.push('', '## Tool che falliscono di più', '');
		for (const [t, n] of top) {
			lines.push(`- \`${t}\`: ${n} errori`);
		}
	}
	lines.push('', '_Suggerimento: se un modello ha tante iterazioni medie o molti tool falliti, prova `structuredTools` o un modello più capace per le azioni._');
	return lines.join('\n');
}
