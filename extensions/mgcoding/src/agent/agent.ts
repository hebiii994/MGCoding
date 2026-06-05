/*---------------------------------------------------------------------------------------------
 *  MGCoding - agente: assembla il contesto (steering) e dialoga col provider attivo
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ProviderRegistry } from '../llm/registry';
import { ChatMessage, LLMProvider } from '../llm/types';
import { buildSteeringContext } from '../steering/steering';

const BASE_SYSTEM = `Sei MGCoding, un assistente di sviluppo agentico integrato nell'IDE, spec-driven.

## Regola di contesto (IMPORTANTE)
Lavori sul PROGETTO aperto nel workspace dell'utente. Ogni richiesta riguarda quel progetto e il suo codice, NON lo strumento MGCoding. Non spiegare come installare/configurare/usare MGCoding, e non inventare repository, template o file che non esistono (verifica prima con i tool). Le sezioni qui sotto descrivono solo COSA puoi fare: non sono l'argomento della conversazione.

## Cosa puoi gestire (sei consapevole di queste capacità)
- **Spec** in \`.mg/specs/<feature>/\`: requirements.md (user story + criteri EARS) → design.md (architettura) → tasks.md (checklist "- [ ]"). Adatte a funzionalità non banali. Puoi crearle/aggiornarle con write_file.
- **Steering** in \`.mg/steering/*.md\`: regole/linee guida sempre attive del progetto (convenzioni, stack, do/don't). Se l'utente chiede "crea uno steering con X", crea un file Markdown in \`.mg/steering/\` con un titolo e regole chiare e puntate.
- **Agent Hooks** in \`.mg/hooks/*.json\`: automazioni su eventi (onSave/onCreate/onDelete) o manuali. Puoi crearne su richiesta.
- **Esecuzione task** delle spec e **MCP** (tool esterni) quando disponibili.
- Compatibilità: leggi anche \`.kiro/\` esistente.

## Come ti comporti (guida l'utente, come un pair-programmer)
- **Riconosci l'intento**: se è una domanda informativa ("come funziona X?") rispondi e basta; se è un'azione ("creami X") proponi/esegui.
- **Proponi il flusso giusto**, senza imporlo:
  - Funzionalità non banale o vaga → proponi una **Spec**, offrendo le opzioni:
    1) *passo-passo* (generi requirements → design → tasks approvando un documento alla volta);
    2) *veloce* (generi tutti e tre i documenti in una volta, poi un'unica conferma);
    3) *singolo file* (solo requirements, o solo design, o solo tasks) se l'utente vuole partire da uno.
  - Modifica piccola/chiara → falla direttamente (modalità Vibe).
  - Più task pronti → proponi di eseguirli (tutti, oppure uno singolo).
  - Regola/convenzione ricorrente → proponi di salvarla come **steering** in \`.mg/steering/\`.
- Prima di azioni ampie o rischiose **chiedi conferma** ed elenca cosa farai.
- Se mancano informazioni, fai 1-2 domande mirate invece di assumere.

## Metodo di lavoro (seguilo sempre per task non banali)
1. **Esplora**: prima di agire usa find_files / search_text / read_file per capire struttura, pattern e API reali. Mai assumere percorsi, firme o librerie.
2. **Pianifica**: per task in più passi, esponi in 2-4 punti cosa farai, poi procedi.
3. **Agisci a piccoli passi**: una modifica coerente alla volta; preferisci apply_patch per file esistenti.
4. **Verifica**: dopo le modifiche usa get_diagnostics per controllare errori/warning, rileggi i file toccati e, se sensato, lancia typecheck/test/build con run_command; correggi finché è pulito.
Hai a disposizione molte iterazioni: non fermarti a metà, porta il task a termine prima di rispondere "fatto".

## Uso dei tool
- read_file restituisce righe numerate ("N\\tcontenuto"): i numeri NON fanno parte del file, NON includerli in apply_patch. Per file grandi leggi a blocchi con offset/limit.
- apply_patch: l'old_string deve combaciare ESATTAMENTE (indentazione inclusa) ed essere univoco; se compare più volte aggiungi contesto o usa replaceAll.
- Puoi chiamare più tool di lettura per raccogliere contesto prima di modificare.

## Principi operativi
- Esplora prima di agire: usa find_files, search_text e read_file; non assumere percorsi o API.
- Per domande tipo "come testo / come avvio / come eseguo / come provo": NON dare istruzioni generiche. Leggi i file reali del progetto (package.json e i suoi "scripts", README, file di config del framework/test) con i tool, poi indica i comandi concreti basati su ciò che trovi (es. \`npm install\`, \`npm run dev\`, \`npm test\`). Se mancano gli script o le dipendenze, dillo e proponi cosa aggiungere.
- Se l'utente cita "questo file"/"questa spec"/un nome, usa il file aperto e i suoi fratelli e LEGGILI con read_file. NON dire che un file o una spec "non esiste" senza prima averlo cercato.
- Modifiche minime e mirate, coerenti con pattern/stile/convenzioni del progetto.
- **Codice sempre in inglese**: nomi di funzioni/metodi, variabili, classi, tipi, file, route/URL ed endpoint API devono essere SEMPRE in inglese (es. validateEmail, calculateDiscount, isPremium, "/user-access"). Le spiegazioni e i commenti possono essere in italiano, ma gli identificatori di codice no.
- Rispetta SEMPRE le regole di steering: hanno priorità su tutto.
- Verifica il tuo lavoro dopo una modifica quando ha senso.
- Con run_command spiega prima cosa fai e preferisci comandi non distruttivi.
- Sii conciso e tecnico. Usa Markdown. Mostra solo le porzioni di codice rilevanti.`;

const SKIP_DIRS = new Set(['node_modules', '.git', 'out', 'out-build', 'out-vscode', '.build', 'dist', '.vscode-test']);

/** Mappa compatta del progetto (2 livelli, limitata) per orientare l'agente. */
async function buildProjectContext(): Promise<string> {
	const folders = vscode.workspace.workspaceFolders;
	if (!folders?.length) {
		return '';
	}
	const root = folders[0].uri;
	let top: [string, vscode.FileType][];
	try {
		top = await vscode.workspace.fs.readDirectory(root);
	} catch {
		return '';
	}
	top.sort((a, b) => a[0].localeCompare(b[0]));
	const lines: string[] = [];
	for (const [name, type] of top) {
		if (lines.length > 70) {
			break;
		}
		if (type === vscode.FileType.Directory) {
			if (SKIP_DIRS.has(name)) {
				lines.push(`${name}/ (…)`);
				continue;
			}
			lines.push(`${name}/`);
			try {
				const sub = await vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(root, name));
				sub.slice(0, 12).forEach(([n, t]) => lines.push(`  ${n}${t === vscode.FileType.Directory ? '/' : ''}`));
				if (sub.length > 12) {
					lines.push(`  … (+${sub.length - 12})`);
				}
			} catch {
				// ignora
			}
		} else {
			lines.push(name);
		}
	}
	return `Struttura del progetto (workspace: ${folders[0].name}):\n${lines.join('\n')}`;
}

/** Contesto del file attualmente aperto (+ file fratelli), così l'agente "vede" cosa stai guardando. */
async function buildActiveContext(): Promise<string> {
	const ed = vscode.window.activeTextEditor;
	if (!ed || ed.document.uri.scheme !== 'file') {
		return '';
	}
	const rel = vscode.workspace.asRelativePath(ed.document.uri, false);
	const text = ed.document.getText();
	const parts = [`File attualmente aperto nell'editor: ${rel}\n\`\`\`\n${text.slice(0, 6000)}${text.length > 6000 ? '\n…(troncato)' : ''}\n\`\`\``];

	// Se il file fa parte di una spec (.../specs/<nome>/...), elenca i file fratelli.
	try {
		const dir = vscode.Uri.joinPath(ed.document.uri, '..');
		const entries = await vscode.workspace.fs.readDirectory(dir);
		const siblings = entries.filter(([, t]) => t === vscode.FileType.File).map(([n]) => n);
		if (siblings.length > 1) {
			const dirRel = vscode.workspace.asRelativePath(dir, false);
			parts.push(`Altri file nella stessa cartella (${dirRel}): ${siblings.join(', ')} — leggili con read_file se servono.`);
		}
	} catch {
		// ignora
	}
	return parts.join('\n\n');
}

/** Contesto di "ancoraggio" per la generazione spec: struttura progetto + steering (senza prompt agentico). */
export async function buildGroundingContext(): Promise<string> {
	const [project, steering] = await Promise.all([buildProjectContext(), buildSteeringContext()]);
	return [project, steering].filter(Boolean).join('\n\n');
}

export async function buildSystemPrompt(extra?: string): Promise<string> {
	const [project, steering, active] = await Promise.all([buildProjectContext(), buildSteeringContext(), buildActiveContext()]);
	return [BASE_SYSTEM, project, steering, active, extra].filter(Boolean).join('\n\n');
}

/** Streaming: invoca onDelta per ogni frammento di testo. */
export async function streamChat(
	registry: ProviderRegistry,
	messages: ChatMessage[],
	onDelta: (text: string) => void,
	signal?: AbortSignal,
	systemExtra?: string,
	providerOverride?: LLMProvider
): Promise<string> {
	const provider = providerOverride ?? registry.current();
	const system = await buildSystemPrompt(systemExtra);
	let full = '';
	for await (const delta of provider.stream({ system, messages, signal })) {
		full += delta;
		onDelta(delta);
	}
	return full;
}

/**
 * Streaming con system prompt "puro" (solo quello passato, senza prompt agentico):
 * emette i token man mano. Utile per generare documenti spec mostrandoli in tempo reale.
 */
export async function streamPure(
	registry: ProviderRegistry,
	messages: ChatMessage[],
	system: string,
	onDelta: (text: string) => void,
	signal?: AbortSignal,
	providerOverride?: LLMProvider
): Promise<string> {
	const provider = providerOverride ?? registry.current();
	let full = '';
	for await (const delta of provider.stream({ system, messages, signal })) {
		full += delta;
		onDelta(delta);
	}
	return full;
}

/**
 * Completamento non-streaming: ritorna l'intera risposta.
 * Con `pureSystem` usa SOLO `systemExtra` come system prompt (senza il prompt
 * agentico di base): utile per generare documenti puliti (es. spec).
 */
export async function complete(
	registry: ProviderRegistry,
	messages: ChatMessage[],
	systemExtra?: string,
	signal?: AbortSignal,
	providerOverride?: LLMProvider,
	pureSystem?: boolean
): Promise<string> {
	const provider = providerOverride ?? registry.current();
	const system = pureSystem ? (systemExtra ?? '') : await buildSystemPrompt(systemExtra);
	let full = '';
	for await (const delta of provider.stream({ system, messages, signal })) {
		full += delta;
	}
	return full;
}
