/*---------------------------------------------------------------------------------------------
 *  MGCoding - indice semantico del codebase (RAG locale).
 *  Spezza i file in chunk, ne calcola gli embedding con Ollama (es. nomic-embed-text) e li
 *  salva localmente in .mg/index/index.json. Espone una ricerca per similarità (coseno) che
 *  l'agente usa via il tool search_code per trovare subito il codice rilevante.
 *  Tutto resta locale e offline.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { DOC_EXT, extractDocText } from './docText';

interface Chunk {
	path: string;
	start: number;
	end: number;
	text: string;
	vector: number[];
}

interface IndexData {
	model: string;
	files: Record<string, string>; // path relativo -> hash del contenuto
	chunks: Chunk[];
}

function cfg<T>(key: string, def: T): T {
	return vscode.workspace.getConfiguration('mgcoding').get<T>(key, def);
}

function endpoint(): string {
	return cfg<string>('ollama.endpoint', 'http://localhost:11434').replace(/\/$/, '');
}

function embedModel(): string {
	return cfg<string>('index.embedModel', 'nomic-embed-text');
}

/** Estensioni testuali da indicizzare. */
const TEXT_EXT = new Set([
	'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cc',
	'cs', 'php', 'swift', 'm', 'mm', 'scala', 'sh', 'bash', 'ps1', 'sql', 'html', 'css', 'scss', 'less', 'vue', 'svelte',
	'md', 'txt', 'yaml', 'yml', 'toml', 'ini', 'xml', 'gradle', 'dart', 'lua', 'r', 'ex', 'exs'
]);

const EXCLUDE_GLOB = '**/{node_modules,.git,out,out-build,out-vscode,.build,dist,.vscode-test,Library,Temp,Logs,obj,bin,.next,.cache,coverage,vendor,.mg/index}/**';

/** Calcola gli embedding di un batch di testi via Ollama (/api/embed). */
async function embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
	const res = await fetch(`${endpoint()}/api/embed`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ model: embedModel(), input: texts }),
		signal
	});
	if (!res.ok) {
		const t = await res.text().catch(() => '');
		throw new Error(`Embedding non riuscito (HTTP ${res.status}). ${/not found|no such model/i.test(t) ? `Modello "${embedModel()}" non installato: scaricalo con "ollama pull ${embedModel()}".` : t}`);
	}
	const data = await res.json() as { embeddings?: number[][] };
	if (!data.embeddings || !data.embeddings.length) {
		throw new Error('Nessun embedding restituito dal modello.');
	}
	return data.embeddings;
}

function cosine(a: number[], b: number[]): number {
	let dot = 0, na = 0, nb = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

function sha1(s: string): string {
	return crypto.createHash('sha1').update(s).digest('hex');
}

/** Spezza il testo in chunk di ~`size` righe con `overlap` righe di sovrapposizione. */
function chunkLines(text: string, size = 60, overlap = 12): { start: number; end: number; text: string }[] {
	const lines = text.split('\n');
	const out: { start: number; end: number; text: string }[] = [];
	for (let i = 0; i < lines.length; i += (size - overlap)) {
		const slice = lines.slice(i, i + size);
		const body = slice.join('\n').trim();
		if (body) {
			out.push({ start: i + 1, end: Math.min(i + size, lines.length), text: body });
		}
		if (i + size >= lines.length) {
			break;
		}
	}
	return out;
}

/** Indice semantico del workspace corrente. Singleton (vedi `codeIndex`). */
class CodeIndex {
	private chunks: Chunk[] = [];
	private files: Record<string, string> = {};
	private loaded = false;
	private building = false;

	private root(): vscode.WorkspaceFolder | undefined {
		return vscode.workspace.workspaceFolders?.[0];
	}

	private indexUri(): vscode.Uri | undefined {
		const r = this.root();
		return r ? vscode.Uri.joinPath(r.uri, '.mg', 'index', 'index.json') : undefined;
	}

	isReady(): boolean {
		return this.chunks.length > 0;
	}

	count(): number {
		return this.chunks.length;
	}

	/** Carica l'indice persistito (se presente e con lo stesso modello di embedding). */
	async load(): Promise<void> {
		if (this.loaded) {
			return;
		}
		this.loaded = true;
		const uri = this.indexUri();
		if (!uri) {
			return;
		}
		try {
			const buf = await vscode.workspace.fs.readFile(uri);
			const data = JSON.parse(Buffer.from(buf).toString('utf8')) as IndexData;
			if (data.model === embedModel() && Array.isArray(data.chunks)) {
				this.chunks = data.chunks;
				this.files = data.files ?? {};
			}
		} catch {
			// nessun indice salvato: ok
		}
	}

	private async save(): Promise<void> {
		const uri = this.indexUri();
		if (!uri) {
			return;
		}
		const data: IndexData = { model: embedModel(), files: this.files, chunks: this.chunks };
		await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(data), 'utf8'));
	}

	/**
	 * (Ri)costruisce l'indice: indicizza i file di testo cambiati dall'ultima volta.
	 * onProgress(done, total) per la barra di avanzamento.
	 */
	async build(onProgress?: (done: number, total: number, label: string) => void, signal?: AbortSignal): Promise<number> {
		if (this.building) {
			return this.chunks.length;
		}
		this.building = true;
		try {
			await this.load();
			const maxKB = cfg<number>('index.maxFileKB', 200);
			const found = await vscode.workspace.findFiles('**/*', EXCLUDE_GLOB, 8000);
			const extOf = (u: vscode.Uri): string => u.path.split('.').pop()?.toLowerCase() ?? '';
			const targets = found.filter(u => TEXT_EXT.has(extOf(u)) || DOC_EXT.has(extOf(u)));
			const seen = new Set<string>();
			const newFiles: Record<string, string> = {};
			// Riusa i chunk dei file invariati.
			const kept: Chunk[] = [];
			const toEmbed: { path: string; start: number; end: number; text: string }[] = [];

			let processed = 0;
			for (const uri of targets) {
				if (signal?.aborted) {
					break;
				}
				const rel = vscode.workspace.asRelativePath(uri, false);
				seen.add(rel);
				processed++;
				onProgress?.(processed, targets.length, 'scansione');
				let content: string;
				const ext = extOf(uri);
				try {
					const buf = Buffer.from(await vscode.workspace.fs.readFile(uri));
					if (DOC_EXT.has(ext)) {
						// Documenti binari (pdf/docx/...): estrai il testo. Cap più ampio (~10 MB).
						if (buf.byteLength > 10 * 1024 * 1024) {
							continue;
						}
						content = (await extractDocText(ext, buf)).trim();
						if (!content) {
							continue; // non estraibile (es. PDF senza pdftotext, o scansione)
						}
					} else {
						if (buf.byteLength > maxKB * 1024 || buf.includes(0)) {
							continue; // troppo grande o binario
						}
						content = buf.toString('utf8');
					}
				} catch {
					continue;
				}
				const hash = sha1(content);
				newFiles[rel] = hash;
				if (this.files[rel] === hash) {
					// invariato: tieni i chunk già presenti
					for (const c of this.chunks) {
						if (c.path === rel) {
							kept.push(c);
						}
					}
				} else {
					for (const ch of chunkLines(content)) {
						toEmbed.push({ path: rel, ...ch });
					}
				}
			}

			// Calcola gli embedding dei chunk nuovi/modificati a batch.
			const embedded: Chunk[] = [];
			const BATCH = 16;
			for (let i = 0; i < toEmbed.length; i += BATCH) {
				if (signal?.aborted) {
					break;
				}
				const batch = toEmbed.slice(i, i + BATCH);
				const vectors = await embed(batch.map(b => `${b.path}\n${b.text}`.slice(0, 2000)), signal);
				batch.forEach((b, j) => {
					if (vectors[j]) {
						embedded.push({ path: b.path, start: b.start, end: b.end, text: b.text.slice(0, 1500), vector: vectors[j] });
					}
				});
				onProgress?.(Math.min(i + BATCH, toEmbed.length), toEmbed.length, 'embedding');
			}

			this.chunks = [...kept, ...embedded];
			this.files = newFiles;
			await this.save();
			return this.chunks.length;
		} finally {
			this.building = false;
		}
	}

	/** Ricerca i `k` chunk più simili alla query. Costruisce l'indice se assente. */
	async search(query: string, k = 6): Promise<{ path: string; start: number; end: number; text: string; score: number }[]> {
		await this.load();
		if (!this.isReady()) {
			await this.build();
		}
		if (!this.isReady()) {
			return [];
		}
		const [qv] = await embed([query]);
		return this.chunks
			.map(c => ({ path: c.path, start: c.start, end: c.end, text: c.text, score: cosine(qv, c.vector) }))
			.sort((a, b) => b.score - a.score)
			.slice(0, k);
	}
}

export const codeIndex = new CodeIndex();
