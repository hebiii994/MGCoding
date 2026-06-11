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
- **Bug**: per un bug NON proporre la spec completa (sproporzionata). Se il bug merita tracciamento, crea una spec leggera con il solo \`bugfix.md\` (sezioni: Comportamento attuale, Comportamento atteso, Cosa NON toccare) e poi correggi; per bug semplici correggi e basta.
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
1. **Esplora**: prima di agire localizza il codice rilevante. Per "dove sta X / come funziona Y" usa PRIMA **search_code** (ricerca semantica nell'indice del codebase), poi affina con search_text/find_files e leggi con read_file. Mai assumere percorsi, firme o librerie.
2. **Pianifica**: per task in più passi usa il tool update_plan per elencare gli step (3-6) e tieni aggiornato lo stato (in_progress/done) man mano che procedi, così l'utente vede l'avanzamento. Per task complessi con parti INDIPENDENTI, puoi fare da orchestratore e delegare i singoli pezzi a subagent focalizzati con il tool **delegate** (istruzioni autosufficienti: il subagent non vede questa conversazione).
3. **Agisci a piccoli passi**: una modifica coerente alla volta; preferisci apply_patch per file esistenti.
4. **Verifica**: dopo le modifiche usa get_diagnostics per controllare errori/warning, rileggi i file toccati e, se sensato, lancia typecheck/test/build con run_command; correggi finché è pulito. NB: una verifica automatica controlla gli errori sui file che modifichi e te li ripropone: correggili prima di concludere.
Hai a disposizione molte iterazioni: non fermarti a metà, porta il task a termine prima di rispondere "fatto".

**Efficienza (importante)**: vai dritto al punto. NON scrivere preamboli, ringraziamenti o frasi di cortesia tra un tool e l'altro ("Grazie", "Vediamo se…", "Procedo a…"): emetti subito il tool successivo. Per DIAGNOSTICARE un problema, raccogli prima le PROVE con i tool (leggi i file rilevanti, controlla la configurazione, lancia il comando) in sequenza e SENZA commentare ogni passo, POI concludi con la causa e la correzione. Non chiedere all'utente informazioni che puoi ottenere da solo con i tool (es. "incollami l'output", "che file hai"): leggi/eseguì tu. Esempio: se un dev server dà 404, NON spiegare le possibili cause — leggi index.html, elenca src/, leggi vite.config, individua l'entry corretto e correggi.

**Chiusura asciutta (importante)**: la risposta finale dice COSA hai fatto/trovato e si ferma lì. VIETATE le sezioni-template di cortesia: niente "Verifica dell'App", "Risoluzione dei Problemi", "Spero che questo ti aiuti", "Fammi sapere se…". NON chiedere all'utente di aprire il browser per verificare: verifica TU con fetch_url e riporta il risultato reale.

## Dev server e verifica web
- Un dev server avviato con run_command RESTA ATTIVO e ha l'**hot reload** (Vite/webpack/next): dopo una modifica ai file NON riavviarlo e NON rilanciare lo stesso comando — le modifiche si applicano da sole. Per controllare come sta usa get_command_output.
- Dopo l'avvio VERIFICA tu che risponda: fetch_url sull'URL mostrato nell'output (es. http://localhost:5173/).
- **Pagina bianca**? Procedura: 1) fetch_url sull'URL → l'HTML servito contiene il div di mount (es. \`<div id="root">\`) e lo \`<script>\` che punta all'entry GIUSTO? 2) l'entry (es. src/main.tsx) esiste e fa davvero il render (createRoot/render) sul div giusto? 3) get_command_output per errori del server; get_diagnostics sui file coinvolti. La causa è quasi sempre una di queste — trovala con le prove, non riavviare il server.

**Chiedi quando serve**: se una decisione è ambigua e cambierebbe ciò che fai (linguaggio/framework, nome, struttura cartelle, quale file modificare, scelte di design), usa il tool **ask_user** con 2-4 opzioni chiare invece di assumere in silenzio. Non abusarne: chiedi solo quando l'ambiguità è reale e impatta il risultato.

**Ricorda l'utente**: quando emerge una preferenza DURATURA (lingua, framework/stile preferiti, come si chiama, come vuole le risposte, sistema operativo), salvala col tool **remember** così la ricorderai nelle prossime sessioni. Se è già presente nel "Profilo utente" qui sotto, non ripeterla.

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

/**
 * System prompt CONDENSATO per i modelli locali piccoli (≤8B): le istruzioni lunghe li
 * "diluiscono" (instruction dilution) — meglio poche regole essenziali e nette.
 */
const BASE_SYSTEM_COMPACT = `Sei MGCoding, agente di sviluppo nell'IDE. Lavori sul progetto aperto nel workspace dell'utente.
REGOLE ESSENZIALI:
- AGISCI con i tool: per leggere/scrivere/eseguire DEVI emettere la chiamata tool, MAI descriverla o scrivere comandi come testo. NON inventare mai l'output di un tool: te lo fornisce il sistema.
- Metodo: esplora (search_code, read_file) → agisci a piccoli passi (apply_patch per i file esistenti) → verifica (get_diagnostics e output reale).
- Un dev server avviato resta attivo e ha l'hot reload: NON riavviarlo dopo una modifica; rileggi l'output con get_command_output e verifica con fetch_url.
- Niente preamboli né frasi di cortesia: vai dritto al punto; alla fine un breve riepilogo di cosa hai fatto e stop.
- Codice (nomi di funzioni/variabili/classi/file/endpoint) SEMPRE in inglese; spiegazioni in italiano.
- Le regole di steering più sotto hanno priorità su tutto.`;

/** True se il modello locale configurato è piccolo (≤8B): meglio il prompt condensato. */
function isSmallLocalModel(): boolean {
	const cfg = vscode.workspace.getConfiguration('mgcoding');
	if (cfg.get<string>('provider', 'ollama') !== 'ollama' || !cfg.get<boolean>('ollama.compactPrompt', true)) {
		return false;
	}
	const model = cfg.get<string>('ollama.model', '').toLowerCase();
	const m = /(\d+(?:\.\d+)?)\s*b\b/.exec(model);
	if (m) {
		return parseFloat(m[1]) <= 8;
	}
	return /mini|tiny|small/.test(model);
}

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

/** Info sull'ambiente: indica al modello SO e shell così usa la sintassi giusta. */
function environmentInfo(): string {
	const isWin = process.platform === 'win32';
	const shell = isWin ? 'cmd.exe (Prompt dei comandi di Windows)' : '/bin/sh';
	const folders = vscode.workspace.workspaceFolders;
	const cwd = folders?.length ? folders[0].uri.fsPath : '(nessuna cartella aperta)';
	const winRules = isWin
		? '\n- Sintassi WINDOWS: NON usare comandi bash/unix (niente `mkdir -p`, `ls`, `rm -rf`, `touch`, né espansione graffe `{a,b}`). Per più comandi separa con `&&`.\n- Per creare cartelle usa il tool create_directory (NON `mkdir` da shell). Per creare/scrivere file usa write_file (crea da solo le cartelle mancanti).'
		: '';
	return `## Ambiente\n- Sistema operativo: ${process.platform}\n- Shell di run_command: ${shell}\n- Cartella di lavoro: ${cwd}\n- I comandi devono essere NON interattivi (usa flag tipo --yes/--y; non lanciare wizard che restano in attesa di input).${winRules}`;
}

/** Cache del rilevamento tipo-progetto (evita stat ad ogni prompt). */
let cachedFlavor: { value: string; at: number } | undefined;

/** Rileva il tipo di progetto (es. Unity) e inietta regole specifiche nel prompt. */
async function projectFlavorInfo(): Promise<string> {
	if (cachedFlavor && Date.now() - cachedFlavor.at < 60000) {
		return cachedFlavor.value;
	}
	const folders = vscode.workspace.workspaceFolders;
	let value = '';
	if (folders?.length) {
		try {
			await vscode.workspace.fs.stat(vscode.Uri.joinPath(folders[0].uri, 'ProjectSettings', 'ProjectVersion.txt'));
			value = `## Progetto Unity (rilevato automaticamente)
- Codice C# in Assets/: convenzioni Unity (PascalCase per classi e metodi pubblici, un MonoBehaviour per file con lo stesso nome del file).
- NON toccare MAI: i file .meta (li gestisce Unity), Library/, Temp/, obj/, Logs/, ProjectSettings/ (salvo richiesta esplicita).
- Dopo aver modificato script C#, Unity ricompila da solo (domain reload): se sono disponibili i tool MCP di Unity, LEGGI LA CONSOLE (errori di compilazione/runtime) e correggi gli errori PRIMA di concludere. Le operazioni MCP durante il reload possono richiedere tempo: riprova invece di arrenderti.
- Per operazioni sull'Editor (scene, GameObject, componenti, asset, material) usa i tool MCP di Unity, NON comandi shell o modifiche manuali ai file di scena (.unity sono YAML fragili).
- Se un tool restituisce uno screenshot, osservalo davvero per verificare il risultato visivo.`;
		} catch {
			// non è un progetto Unity
		}
	}
	cachedFlavor = { value, at: Date.now() };
	return value;
}

export async function buildSystemPrompt(extra?: string, requestHint?: string): Promise<string> {
	const [project, steering, active, flavor] = await Promise.all([buildProjectContext(), buildSteeringContext(requestHint), buildActiveContext(), projectFlavorInfo()]);
	const base = isSmallLocalModel() ? BASE_SYSTEM_COMPACT : BASE_SYSTEM;
	return [base, environmentInfo(), flavor, project, steering, active, extra].filter(Boolean).join('\n\n');
}

/** Ultimo messaggio utente: usato come "richiesta corrente" per lo steering auto. */
function lastUserText(messages: ChatMessage[]): string | undefined {
	return [...messages].reverse().find(m => m.role === 'user')?.content;
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
	const system = await buildSystemPrompt(systemExtra, lastUserText(messages));
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
	const system = pureSystem ? (systemExtra ?? '') : await buildSystemPrompt(systemExtra, lastUserText(messages));
	let full = '';
	for await (const delta of provider.stream({ system, messages, signal })) {
		full += delta;
	}
	return full;
}
