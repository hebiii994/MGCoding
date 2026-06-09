/*---------------------------------------------------------------------------------------------
 *  MGCoding - gestione modelli Ollama: elenco installati (con dimensione), cancellazione e
 *  download (pull) con avanzamento. Più una lista curata di modelli consigliati per il
 *  coding (inclusi i quant "dynamic" di unsloth, scaricabili da HuggingFace via Ollama).
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

function endpoint(): string {
	return vscode.workspace.getConfiguration('mgcoding').get<string>('ollama.endpoint', 'http://localhost:11434').replace(/\/$/, '');
}

export interface InstalledModel {
	name: string;
	/** Dimensione in byte. */
	size: number;
}

/** Formatta una dimensione in byte in GB/MB leggibili. */
export function humanSize(bytes: number): string {
	if (bytes >= 1024 ** 3) {
		return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
	}
	if (bytes >= 1024 ** 2) {
		return `${Math.round(bytes / 1024 ** 2)} MB`;
	}
	return `${bytes} B`;
}

/** Elenco dei modelli installati con la loro dimensione (GET /api/tags). */
export async function listInstalled(): Promise<InstalledModel[]> {
	const res = await fetch(`${endpoint()}/api/tags`);
	if (!res.ok) {
		throw new Error(`Ollama non raggiungibile (HTTP ${res.status}). È avviato?`);
	}
	const data = await res.json() as { models?: { name?: string; size?: number }[] };
	return (data.models ?? [])
		.map(m => ({ name: m.name ?? '', size: m.size ?? 0 }))
		.filter(m => m.name)
		.sort((a, b) => b.size - a.size);
}

/** Cancella un modello (DELETE /api/delete). */
export async function deleteModel(name: string): Promise<void> {
	const res = await fetch(`${endpoint()}/api/delete`, {
		method: 'DELETE',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ model: name, name })
	});
	if (!res.ok) {
		throw new Error(`Cancellazione non riuscita (HTTP ${res.status}).`);
	}
}

/** Scarica un modello (POST /api/pull, streaming NDJSON) invocando onProgress sullo stato. */
export async function pullModel(name: string, onProgress: (pct: number, status: string) => void, signal?: AbortSignal): Promise<void> {
	const res = await fetch(`${endpoint()}/api/pull`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ model: name, name, stream: true }),
		signal
	});
	if (!res.ok || !res.body) {
		throw new Error(`Download non riuscito (HTTP ${res.status}). Verifica il nome del modello.`);
	}
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	for (; ;) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		buffer += decoder.decode(value, { stream: true });
		let nl: number;
		while ((nl = buffer.indexOf('\n')) >= 0) {
			const line = buffer.slice(0, nl).trim();
			buffer = buffer.slice(nl + 1);
			if (!line) {
				continue;
			}
			try {
				const obj = JSON.parse(line) as { status?: string; completed?: number; total?: number; error?: string };
				if (obj.error) {
					throw new Error(obj.error);
				}
				const pct = obj.total && obj.completed ? Math.floor((obj.completed / obj.total) * 100) : 0;
				onProgress(pct, obj.status ?? '');
			} catch (e) {
				if (e instanceof Error && e.message && !/JSON/.test(e.message)) {
					throw e;
				}
			}
		}
	}
}

export interface SuggestedModel {
	/** Nome con cui fare il pull in Ollama. */
	name: string;
	label: string;
	note: string;
}

/**
 * Modelli consigliati per il coding. Includono sia i tag ufficiali Ollama sia i quant
 * "dynamic" (UD) di unsloth scaricabili da HuggingFace tramite `hf.co/<repo>` — di norma
 * più precisi a parità di dimensione. Aggiorna in base alle novità (es. subreddit unsloth).
 */
export const SUGGESTED_MODELS: SuggestedModel[] = [
	{ name: 'nomic-embed-text', label: 'nomic-embed-text (embedding)', note: 'NON è un modello di chat: serve all\'indice semantico del codice (RAG). ~270 MB.' },
	{ name: 'qwen2.5-coder:7b', label: 'Qwen2.5-Coder 7B', note: 'Ottimo per coding, leggero (~4.7 GB). Supporta i tool.' },
	{ name: 'qwen2.5-coder:14b', label: 'Qwen2.5-Coder 14B', note: 'Più capace, ~9 GB. Supporta i tool.' },
	{ name: 'qwen3:8b', label: 'Qwen3 8B', note: 'Generalista recente con reasoning, ~5 GB. Tool ok.' },
	{ name: 'llama3.1:8b', label: 'Llama 3.1 8B', note: 'Generalista solido, ~4.9 GB. Supporta i tool.' },
	{ name: 'gemma3:12b', label: 'Gemma 3 12B', note: 'Google, multimodale (vision), ~8 GB.' },
	{ name: 'hf.co/unsloth/Qwen2.5-Coder-7B-Instruct-GGUF:Q4_K_M', label: 'unsloth · Qwen2.5-Coder 7B (Q4_K_M)', note: 'Quant unsloth da HuggingFace: buona precisione/peso.' },
	{ name: 'hf.co/unsloth/Qwen3-14B-GGUF:UD-Q4_K_XL', label: 'unsloth · Qwen3 14B (UD dynamic)', note: 'Quant "dynamic" unsloth: qualità migliore a pari dimensione.' }
];

// ---- Consulente modelli: catalogo con metadati + wizard di raccomandazione ----

type ModelUse = 'coding' | 'general' | 'vision' | 'reasoning';

interface CatalogModel {
	name: string;
	label: string;
	/** VRAM consigliata (GB) per girare fluido a un quant tipico (~Q4). 0 = molto leggero. */
	vramGB: number;
	uses: ModelUse[];
	tools: boolean;
	vision: boolean;
	/** Qualità relativa percepita (1-5) per ordinare a parità di vincoli. */
	quality: number;
	note: string;
}

/**
 * Catalogo di modelli consigliati con requisiti indicativi. I valori di VRAM sono stime per
 * un quant ~Q4; con meno VRAM si può comunque girare su CPU/RAM ma più lentamente.
 * Include varianti unsloth (HuggingFace) per qualità a pari dimensione.
 */
const CATALOG: CatalogModel[] = [
	{ name: 'qwen2.5-coder:1.5b', label: 'Qwen2.5-Coder 1.5B', vramGB: 2, uses: ['coding'], tools: false, vision: false, quality: 2, note: 'Per macchine molto leggere; coding di base.' },
	{ name: 'qwen2.5-coder:3b', label: 'Qwen2.5-Coder 3B', vramGB: 3, uses: ['coding'], tools: true, vision: false, quality: 3, note: 'Leggero ma decente per il codice.' },
	{ name: 'qwen2.5-coder:7b', label: 'Qwen2.5-Coder 7B', vramGB: 6, uses: ['coding'], tools: true, vision: false, quality: 4, note: 'Miglior rapporto qualità/peso per il coding.' },
	{ name: 'qwen2.5-coder:14b', label: 'Qwen2.5-Coder 14B', vramGB: 10, uses: ['coding'], tools: true, vision: false, quality: 5, note: 'Coding molto capace.' },
	{ name: 'qwen2.5-coder:32b', label: 'Qwen2.5-Coder 32B', vramGB: 20, uses: ['coding', 'reasoning'], tools: true, vision: false, quality: 5, note: 'Top per il codice, richiede molta VRAM.' },
	{ name: 'llama3.2:3b', label: 'Llama 3.2 3B', vramGB: 3, uses: ['general'], tools: true, vision: false, quality: 3, note: 'Generalista leggero.' },
	{ name: 'llama3.1:8b', label: 'Llama 3.1 8B', vramGB: 6, uses: ['general'], tools: true, vision: false, quality: 4, note: 'Generalista solido con tool.' },
	{ name: 'qwen3:4b', label: 'Qwen3 4B', vramGB: 4, uses: ['general', 'reasoning'], tools: true, vision: false, quality: 3, note: 'Recente, con ragionamento, leggero.' },
	{ name: 'qwen3:8b', label: 'Qwen3 8B', vramGB: 6, uses: ['general', 'reasoning'], tools: true, vision: false, quality: 4, note: 'Buon generalista con reasoning.' },
	{ name: 'qwen3:14b', label: 'Qwen3 14B', vramGB: 10, uses: ['general', 'reasoning', 'coding'], tools: true, vision: false, quality: 5, note: 'Forte e versatile.' },
	{ name: 'gemma3:4b', label: 'Gemma 3 4B', vramGB: 4, uses: ['general', 'vision'], tools: false, vision: true, quality: 3, note: 'Multimodale leggero (legge immagini).' },
	{ name: 'gemma3:12b', label: 'Gemma 3 12B', vramGB: 9, uses: ['general', 'vision'], tools: false, vision: true, quality: 4, note: 'Multimodale capace (vision).' },
	{ name: 'gemma3:27b', label: 'Gemma 3 27B', vramGB: 18, uses: ['general', 'vision', 'reasoning'], tools: false, vision: true, quality: 5, note: 'Multimodale top, molta VRAM.' },
	{ name: 'phi4:14b', label: 'Phi-4 14B', vramGB: 10, uses: ['reasoning', 'general'], tools: true, vision: false, quality: 4, note: 'Forte nel ragionamento per la sua taglia.' },
	{ name: 'deepseek-r1:8b', label: 'DeepSeek-R1 8B', vramGB: 6, uses: ['reasoning'], tools: false, vision: false, quality: 4, note: 'Specializzato nel ragionamento (distillato).' },
	{ name: 'deepseek-r1:14b', label: 'DeepSeek-R1 14B', vramGB: 10, uses: ['reasoning', 'coding'], tools: false, vision: false, quality: 5, note: 'Ragionamento approfondito.' },
	{ name: 'mistral-nemo:12b', label: 'Mistral Nemo 12B', vramGB: 8, uses: ['general'], tools: true, vision: false, quality: 4, note: 'Generalista con contesto ampio.' },
	{ name: 'hf.co/unsloth/Qwen2.5-Coder-7B-Instruct-GGUF:Q4_K_M', label: 'unsloth · Qwen2.5-Coder 7B', vramGB: 6, uses: ['coding'], tools: true, vision: false, quality: 4, note: 'Quant unsloth: ottima precisione/peso.' },
	{ name: 'hf.co/unsloth/Qwen3-14B-GGUF:UD-Q4_K_XL', label: 'unsloth · Qwen3 14B (UD)', vramGB: 10, uses: ['general', 'reasoning', 'coding'], tools: true, vision: false, quality: 5, note: 'Quant "dynamic" unsloth: qualità superiore a pari taglia.' }
];

/** Wizard: chiede VRAM, uso e priorità, poi filtra e ordina i modelli adatti. */
export async function recommendModel(): Promise<void> {
	const vramPick = await vscode.window.showQuickPick(
		[
			{ label: 'Solo CPU / non lo so', v: 0 },
			{ label: 'Fino a 4 GB VRAM', v: 4 },
			{ label: '6 GB VRAM', v: 6 },
			{ label: '8 GB VRAM', v: 8 },
			{ label: '12 GB VRAM', v: 12 },
			{ label: '16 GB VRAM', v: 16 },
			{ label: '24 GB+ VRAM', v: 24 }
		],
		{ title: 'Consulente modelli (1/3)', placeHolder: 'Quanta VRAM ha la tua GPU?' }
	) as (vscode.QuickPickItem & { v: number }) | undefined;
	if (!vramPick) {
		return;
	}
	const usePick = await vscode.window.showQuickPick(
		[
			{ label: '$(code) Coding', u: 'coding' as ModelUse },
			{ label: '$(comment-discussion) Generale / chat', u: 'general' as ModelUse },
			{ label: '$(eye) Vision (leggere immagini)', u: 'vision' as ModelUse },
			{ label: '$(lightbulb) Ragionamento', u: 'reasoning' as ModelUse }
		],
		{ title: 'Consulente modelli (2/3)', placeHolder: 'Uso principale?' }
	) as (vscode.QuickPickItem & { u: ModelUse }) | undefined;
	if (!usePick) {
		return;
	}
	const prio = await vscode.window.showQuickPick(
		[
			{ label: '$(rocket) Velocità (più leggero)', p: 'speed' },
			{ label: '$(star) Qualità (più capace)', p: 'quality' },
			{ label: 'Servono i tool dell\'agente', p: 'tools' }
		],
		{ title: 'Consulente modelli (3/3)', placeHolder: 'Cosa conta di più?' }
	) as (vscode.QuickPickItem & { p: string }) | undefined;
	if (!prio) {
		return;
	}

	const vram = vramPick.v;
	let cap = vram;
	let cpuMode = false;
	if (vram === 0) {
		// Niente GPU: su CPU conta la RAM. Chiedi quanta RAM c'è e dimensiona di conseguenza
		// (lasciando margine per sistema/contesto: ~60% della RAM come budget per il modello).
		cpuMode = true;
		const ramPick = await vscode.window.showQuickPick(
			[
				{ label: '8 GB RAM', v: 8 },
				{ label: '16 GB RAM', v: 16 },
				{ label: '32 GB RAM', v: 32 },
				{ label: '64 GB+ RAM', v: 64 },
				{ label: 'Non lo so', v: 0 }
			],
			{ title: 'Consulente modelli — solo CPU', placeHolder: 'Quanta RAM ha il PC? (su CPU conta la RAM)' }
		) as (vscode.QuickPickItem & { v: number }) | undefined;
		if (!ramPick) {
			return;
		}
		cap = ramPick.v === 0 ? 6 : Math.max(3, Math.floor(ramPick.v * 0.6));
	}
	let matches = CATALOG.filter(m => m.uses.includes(usePick.u) && m.vramGB <= cap);
	if (usePick.u === 'vision') {
		matches = matches.filter(m => m.vision);
	}
	if (prio.p === 'tools') {
		matches = matches.filter(m => m.tools);
	}
	if (matches.length === 0) {
		// Fallback: ignora il filtro d'uso e mostra i più adatti per VRAM.
		matches = CATALOG.filter(m => m.vramGB <= cap);
	}
	matches.sort((a, b) => prio.p === 'speed' ? (a.vramGB - b.vramGB) || (b.quality - a.quality) : (b.quality - a.quality) || (a.vramGB - b.vramGB));
	const top = matches.slice(0, 6);

	const cpuNote = cpuMode ? ' · (su CPU sarà più lento)' : '';
	const items = top.map(m => ({
		label: m.label,
		description: `~${m.vramGB} GB${m.tools ? ' · 🔧 tool' : ''}${m.vision ? ' · 👁 vision' : ''}`,
		detail: `${m.note}${cpuNote}`,
		name: m.name
	}));
	const pick = await vscode.window.showQuickPick(items, {
		title: 'Modelli consigliati per te',
		placeHolder: top.length ? 'Invio per scaricare il modello scelto' : 'Nessun modello adatto trovato'
	}) as (vscode.QuickPickItem & { name: string }) | undefined;
	if (pick) {
		await pullFlow(pick.name);
	}
}

/** Imposta un modello come attivo (provider Ollama). */
async function useModel(name: string): Promise<void> {
	const c = vscode.workspace.getConfiguration('mgcoding');
	await c.update('ollama.model', name, vscode.ConfigurationTarget.Global);
	await c.update('provider', 'ollama', vscode.ConfigurationTarget.Global);
}

/** Flusso di scaricamento di un modello, con barra di avanzamento e offerta di usarlo. */
async function pullFlow(name: string): Promise<void> {
	try {
		await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: `Scarico ${name}`, cancellable: true },
			async (progress, token) => {
				const ctrl = new AbortController();
				token.onCancellationRequested(() => ctrl.abort());
				let last = 0;
				await pullModel(name, (pct, status) => {
					const inc = Math.max(0, pct - last);
					last = pct;
					progress.report({ increment: inc, message: `${status}${pct ? ` ${pct}%` : ''}` });
				}, ctrl.signal);
			}
		);
	} catch (err) {
		void vscode.window.showErrorMessage(`Download non riuscito: ${err instanceof Error ? err.message : String(err)}`);
		return;
	}
	const go = await vscode.window.showInformationMessage(`Modello "${name}" scaricato.`, 'Usa ora');
	if (go === 'Usa ora') {
		await useModel(name);
	}
}

/** Comando interattivo: gestisci i modelli Ollama (cancella installati, scarica nuovi). */
export async function manageModels(): Promise<void> {
	let installed: InstalledModel[];
	try {
		installed = await listInstalled();
	} catch (err) {
		void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
		return;
	}
	type Item = vscode.QuickPickItem & { action: 'delete' | 'pull' | 'use'; name?: string };
	const items: Item[] = [
		{ label: '$(cloud-download) Scarica un nuovo modello…', action: 'pull' },
		...(installed.length ? [{ label: 'Installati', kind: vscode.QuickPickItemKind.Separator } as Item] : []),
		...installed.map((m): Item => ({ label: `$(database) ${m.name}`, description: humanSize(m.size), detail: 'Invio = usa · cancella dal menu successivo', action: 'use', name: m.name }))
	];
	const pick = await vscode.window.showQuickPick(items, {
		title: 'Gestione modelli Ollama',
		placeHolder: installed.length ? `${installed.length} modelli installati` : 'Nessun modello installato: scaricane uno'
	});
	if (!pick) {
		return;
	}
	if (pick.action === 'pull') {
		type SItem = vscode.QuickPickItem & { name: string; advisor?: boolean };
		const sItems: SItem[] = [
			{ label: '$(sparkle) Consigliami un modello…', description: 'in base a VRAM e uso', detail: 'Rispondi a 3 domande e ti propongo i modelli adatti', name: '', advisor: true },
			{ label: 'Consigliati', kind: vscode.QuickPickItemKind.Separator, name: '' } as SItem,
			...SUGGESTED_MODELS.map((s): SItem => ({ label: s.label, description: s.name, detail: s.note, name: s.name })),
			{ label: '$(edit) Altro nome (manuale)…', description: '', detail: 'Es. qwen2.5-coder:7b oppure hf.co/<repo>:<tag>', name: '' }
		];
		const sp = await vscode.window.showQuickPick(sItems, { title: 'Scarica modello', placeHolder: 'Scegli un modello, fatti consigliare, o inseriscine uno' });
		if (!sp) {
			return;
		}
		if (sp.advisor) {
			await recommendModel();
			return;
		}
		let name = sp.name;
		if (!name) {
			name = (await vscode.window.showInputBox({ title: 'Nome modello da scaricare', prompt: 'Es. qwen2.5-coder:7b · llama3.1:8b · hf.co/unsloth/<repo>:<tag>' }))?.trim() ?? '';
		}
		if (name) {
			await pullFlow(name);
		}
		return;
	}
	if (pick.action === 'use' && pick.name) {
		const sub = await vscode.window.showQuickPick(
			[{ label: '$(check) Usa questo modello' }, { label: '$(trash) Cancella questo modello' }],
			{ title: pick.name, placeHolder: 'Cosa vuoi fare con questo modello?' }
		);
		if (!sub) {
			return;
		}
		if (sub.label.includes('Cancella')) {
			const ok = await vscode.window.showWarningMessage(`Cancellare definitivamente "${pick.name}"?`, { modal: true }, 'Cancella');
			if (ok === 'Cancella') {
				try {
					await deleteModel(pick.name);
					void vscode.window.showInformationMessage(`Modello "${pick.name}" cancellato.`);
				} catch (err) {
					void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
				}
			}
		} else {
			await useModel(pick.name);
			void vscode.window.showInformationMessage(`Modello attivo: ${pick.name}.`);
		}
	}
}
