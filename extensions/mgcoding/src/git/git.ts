/*---------------------------------------------------------------------------------------------
 *  MGCoding - integrazione Git: genera messaggi di commit dal diff, spiega un diff e prepara
 *  la descrizione di una Pull Request, usando il modello LLM configurato.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { ProviderRegistry } from '../llm/registry';
import { streamPure } from '../agent/agent';

const exec = promisify(execFile);
const MAX_DIFF = 14000;

interface GitRepo {
	rootUri: vscode.Uri;
	inputBox: { value: string };
}

/** Ottiene il primo repository Git tramite l'API dell'estensione integrata vscode.git. */
async function getRepo(): Promise<GitRepo | undefined> {
	const ext = vscode.extensions.getExtension<{ getAPI(v: number): { repositories: GitRepo[] } }>('vscode.git');
	if (!ext) {
		return undefined;
	}
	const git = ext.isActive ? ext.exports : await ext.activate();
	return git.getAPI(1).repositories[0];
}

/** Radice del repo (da git API o dalla cartella di lavoro). */
async function repoRoot(): Promise<string | undefined> {
	const repo = await getRepo();
	return repo?.rootUri.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

async function runGit(root: string, args: string[]): Promise<string> {
	const { stdout } = await exec('git', args, { cwd: root, maxBuffer: 20 * 1024 * 1024 });
	return stdout;
}

/** Genera un messaggio di commit dal diff staged (o, se vuoto, dalle modifiche di lavoro). */
export async function generateCommitMessage(registry: ProviderRegistry): Promise<void> {
	const root = await repoRoot();
	if (!root) {
		void vscode.window.showErrorMessage('Nessun repository Git aperto.');
		return;
	}
	let diff = '';
	try {
		diff = await runGit(root, ['diff', '--staged']);
		if (!diff.trim()) {
			diff = await runGit(root, ['diff']);
		}
	} catch (err) {
		void vscode.window.showErrorMessage(`git diff non riuscito: ${err instanceof Error ? err.message : String(err)}`);
		return;
	}
	if (!diff.trim()) {
		void vscode.window.showInformationMessage('Nessuna modifica da committare.');
		return;
	}
	const sys = 'Sei un assistente Git. Dato un diff, scrivi UN solo messaggio di commit in stile Conventional Commits (es. "feat: …", "fix: …", "refactor: …", "docs: …"). Prima riga imperativa e concisa (<72 caratteri); se utile aggiungi una riga vuota e un breve corpo con i punti salienti. Scrivi in italiano. Rispondi SOLO con il messaggio, senza virgolette né spiegazioni.';
	const msg = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.SourceControl, title: 'Genero il messaggio di commit…' },
		() => streamPure(registry, [{ role: 'user', content: diff.slice(0, MAX_DIFF) }], sys, () => { /* no stream */ })
	);
	const clean = msg.trim().replace(/^["'`]|["'`]$/g, '');
	if (!clean) {
		void vscode.window.showWarningMessage('Il modello non ha prodotto un messaggio.');
		return;
	}
	const repo = await getRepo();
	if (repo) {
		repo.inputBox.value = clean;
		void vscode.window.showInformationMessage('Messaggio di commit inserito nel pannello Source Control.');
	} else {
		await vscode.env.clipboard.writeText(clean);
		void vscode.window.showInformationMessage('Messaggio di commit copiato negli appunti.');
	}
}

/** Apre un documento markdown con il testo dato in anteprima. */
async function openMarkdown(title: string, body: string): Promise<void> {
	const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: `# ${title}\n\n${body}\n` });
	await vscode.window.showTextDocument(doc, { preview: true });
}

/** Spiega in linguaggio naturale il diff corrente (staged o, se vuoto, working tree). */
export async function explainDiff(registry: ProviderRegistry): Promise<void> {
	const root = await repoRoot();
	if (!root) {
		void vscode.window.showErrorMessage('Nessun repository Git aperto.');
		return;
	}
	let diff = '';
	try {
		diff = await runGit(root, ['diff', '--staged']);
		if (!diff.trim()) {
			diff = await runGit(root, ['diff']);
		}
	} catch { /* */ }
	if (!diff.trim()) {
		void vscode.window.showInformationMessage('Nessuna modifica da spiegare.');
		return;
	}
	const sys = 'Spiega in italiano, in modo chiaro e conciso, cosa fa questo diff: riassunto in cima, poi un elenco puntato delle modifiche principali raggruppate per file/area e l\'eventuale impatto. Usa markdown.';
	const out = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: 'Analizzo il diff…' },
		() => streamPure(registry, [{ role: 'user', content: diff.slice(0, MAX_DIFF) }], sys, () => { /* */ })
	);
	if (out.trim()) {
		await openMarkdown('Spiegazione delle modifiche', out.trim());
	}
}

/** Determina il branch base (main/master/develop) presente nel repo. */
async function baseBranch(root: string): Promise<string> {
	for (const b of ['main', 'master', 'develop']) {
		try {
			await runGit(root, ['rev-parse', '--verify', b]);
			return b;
		} catch { /* non esiste */ }
	}
	return 'main';
}

/** Genera titolo e descrizione di una Pull Request dal confronto col branch base. */
export async function prDescription(registry: ProviderRegistry): Promise<void> {
	const root = await repoRoot();
	if (!root) {
		void vscode.window.showErrorMessage('Nessun repository Git aperto.');
		return;
	}
	let diff = '';
	let log = '';
	try {
		const base = await baseBranch(root);
		const head = (await runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
		if (head === base) {
			void vscode.window.showInformationMessage(`Sei sul branch base "${base}": crea un branch di feature per la PR.`);
			return;
		}
		diff = await runGit(root, ['diff', `${base}...HEAD`]);
		log = await runGit(root, ['log', '--no-merges', '--pretty=- %s', `${base}..HEAD`]);
	} catch (err) {
		void vscode.window.showErrorMessage(`git non riuscito: ${err instanceof Error ? err.message : String(err)}`);
		return;
	}
	if (!diff.trim()) {
		void vscode.window.showInformationMessage('Nessuna differenza rispetto al branch base.');
		return;
	}
	const sys = 'Scrivi la descrizione di una Pull Request in italiano (markdown). Struttura: un titolo conciso sulla prima riga (come "# Titolo"), poi sezioni "## Cosa cambia", "## Perché", "## Come testare". Basati sui commit e sul diff forniti. Sii concreto e sintetico.';
	const input = `Commit:\n${log.slice(0, 3000)}\n\nDiff:\n${diff.slice(0, MAX_DIFF)}`;
	const out = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: 'Preparo la descrizione della PR…' },
		() => streamPure(registry, [{ role: 'user', content: input }], sys, () => { /* */ })
	);
	if (out.trim()) {
		const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: out.trim() + '\n' });
		await vscode.window.showTextDocument(doc, { preview: true });
	}
}
