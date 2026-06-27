/*---------------------------------------------------------------------------------------------
 *  MGCoding - Spec_Validator (nucleo puro)
 *
 *  Nucleo puro per la validazione dei documenti Spec. Questo modulo non ha dipendenze
 *  da `vscode`, `fetch` o filesystem: opera esclusivamente su stringhe markdown e
 *  strutture dati, così da essere verificabile con property-based testing.
 *
 *  Questa parte copre:
 *   - task 7.1: il riconoscimento dei pattern EARS e il parsing dei criteri di
 *     accettazione numerati (Req. 6.1);
 *   - task 7.3: la Coverage_Map (`buildCoverageMap`), la validazione strutturale
 *     (`validateStructure`) e il report di validazione (`ValidationReport`,
 *     `buildValidationReport`) con il flag `canAdvance` (Req. 6.2, 6.3, 6.4, 6.5).
 *--------------------------------------------------------------------------------------------*/

import type { CoverageEntry, EarsPattern, SpecPhase } from '../llm/types';

/**
 * Un singolo criterio di accettazione EARS, identificato come "Req N.M":
 *  - `requirement` è il numero del requisito (N);
 *  - `index` è il numero progressivo del criterio dentro il requisito (M);
 *  - `text` è il testo del criterio.
 */
export interface AcceptanceCriterion {
	/** Numero del requisito (N) → "Req N.M". */
	requirement: number;
	/** Indice del criterio dentro il requisito (M) → "Req N.M". */
	index: number;
	/** Testo del criterio di accettazione. */
	text: string;
}

// --- Riconoscimento dei pattern EARS (Req. 6.1) ---

/**
 * Riconosce quale dei sei pattern EARS segue un criterio di accettazione (Req. 6.1).
 *
 * Le parole chiave EARS sono in inglese maiuscolo, anche quando la prosa del criterio
 * è in italiano (es. "WHEN ... THE Ollama_Provider SHALL ..."). Un criterio valido deve
 * contenere il verbo normativo `SHALL`; in assenza restituisce `undefined`.
 *
 * Classificazione (per numero di costrutti di precondizione presenti):
 *  - `complex`: due o più costrutti combinati (es. WHEN/WHILE + IF/THEN);
 *  - `unwanted`: un solo costrutto IF ... THEN;
 *  - `event`: un solo costrutto WHEN;
 *  - `state`: un solo costrutto WHILE;
 *  - `optional`: un solo costrutto WHERE;
 *  - `ubiquitous`: nessun costrutto di precondizione (THE ... SHALL ...).
 */
export function matchEarsPattern(text: string): EarsPattern | undefined {
	if (!text) {
		return undefined;
	}
	const upper = text.toUpperCase();

	// Un criterio EARS valido deve esprimere un obbligo con SHALL.
	if (!/\bSHALL\b/.test(upper)) {
		return undefined;
	}

	const hasWhen = /\bWHEN\b/.test(upper);
	const hasWhile = /\bWHILE\b/.test(upper);
	const hasWhere = /\bWHERE\b/.test(upper);
	// La condizione "unwanted behaviour" richiede sia IF sia THEN.
	const hasIfThen = /\bIF\b/.test(upper) && /\bTHEN\b/.test(upper);

	// Numero di costrutti di precondizione distinti presenti nel criterio.
	const constructs = [hasWhen, hasWhile, hasWhere, hasIfThen].filter(Boolean).length;

	// Combinazione di più costrutti → pattern complesso.
	if (constructs >= 2) {
		return 'complex';
	}
	if (hasIfThen) {
		return 'unwanted';
	}
	if (hasWhen) {
		return 'event';
	}
	if (hasWhile) {
		return 'state';
	}
	if (hasWhere) {
		return 'optional';
	}
	// Nessuna precondizione: criterio ubiquitario, purché esprima un soggetto normativo.
	if (/\bTHE\b/.test(upper)) {
		return 'ubiquitous';
	}
	return undefined;
}

// --- Parsing dei criteri di accettazione numerati (Req. 6.1) ---

/** Intestazione di un requisito: "### Requirement N: ...". */
const REQUIREMENT_HEADING = /^#{1,6}\s+Requirement\s+(\d+)\b/i;
/** Intestazione della sezione dei criteri: "#### Acceptance Criteria". */
const ACCEPTANCE_HEADING = /^#{1,6}\s+Acceptance\s+Criteria\b/i;
/** Una qualsiasi intestazione markdown. */
const ANY_HEADING = /^#{1,6}\s+/;
/** Voce di lista numerata: "M. testo" (con eventuale indentazione). */
const NUMBERED_ITEM = /^\s*(\d+)\.\s+(.*)$/;

/**
 * Estrae i criteri di accettazione numerati da un documento `requirements.md`.
 *
 * Vengono considerate solo le voci di lista numerate che si trovano dentro una sezione
 * "Acceptance Criteria" appartenente a un requisito "Requirement N". L'indice della voce
 * (M) è il numero della lista, così da ricostruire l'identificatore "Req N.M". Le righe di
 * continuazione (testo non numerato) vengono accodate al criterio corrente, supportando i
 * criteri scritti su più righe.
 */
export function parseAcceptanceCriteria(md: string): AcceptanceCriterion[] {
	const criteria: AcceptanceCriterion[] = [];
	if (!md) {
		return criteria;
	}

	const lines = md.split(/\r?\n/);
	let currentRequirement: number | undefined;
	let inCriteria = false;
	let last: AcceptanceCriterion | undefined;

	for (const line of lines) {
		// Nuovo requisito: aggiorna il contesto e chiude la sezione criteri precedente.
		const reqMatch = REQUIREMENT_HEADING.exec(line);
		if (reqMatch) {
			currentRequirement = Number(reqMatch[1]);
			inCriteria = false;
			last = undefined;
			continue;
		}

		// Inizio della sezione dei criteri di accettazione.
		if (ACCEPTANCE_HEADING.test(line)) {
			inCriteria = true;
			last = undefined;
			continue;
		}

		// Qualsiasi altra intestazione termina la sezione dei criteri.
		if (ANY_HEADING.test(line)) {
			inCriteria = false;
			last = undefined;
			continue;
		}

		if (!inCriteria || currentRequirement === undefined) {
			continue;
		}

		// Voce numerata → nuovo criterio.
		const itemMatch = NUMBERED_ITEM.exec(line);
		if (itemMatch) {
			last = {
				requirement: currentRequirement,
				index: Number(itemMatch[1]),
				text: itemMatch[2].trim(),
			};
			criteria.push(last);
			continue;
		}

		// Riga di continuazione di un criterio multi-linea.
		if (last && line.trim().length > 0) {
			last.text = `${last.text} ${line.trim()}`.trim();
		}
	}

	return criteria;
}

// --- Coverage_Map: copertura dei criteri da parte dei task (Req. 6.2, 6.3) ---

/**
 * Estrae da una riga di `tasks.md` gli identificatori di criterio "N.M" referenziati.
 *
 * Sono riconosciuti due formati di riferimento:
 *  - liste esplicite "Requirements: N.M, N.M, ..." (anche con marcatori markdown,
 *    es. "- _Requirements: 11.4, 1.3_"), come usate da questo spec;
 *  - riferimenti inline "(Req N.M)" o "Req. N.M", come usati nella prosa di design.
 *
 * Restituisce l'insieme delle coppie "N.M" trovate (senza il prefisso "Req").
 */
function extractTaskReferences(line: string): Set<string> {
	const refs = new Set<string>();
	if (!line) {
		return refs;
	}

	// Liste esplicite "Requirements: N.M, N.M, ...": si isola il testo dopo i due punti
	// e si estraggono tutte le coppie N.M presenti.
	const listMatch = /Requirements?\s*:\s*([0-9.,\s]+)/i.exec(line);
	if (listMatch) {
		const nums = listMatch[1].match(/\d+\.\d+/g);
		if (nums) {
			for (const n of nums) {
				refs.add(n);
			}
		}
	}

	// Riferimenti inline "Req N.M" / "(Req. N.M)".
	const inline = /\bReq\.?\s*(\d+\.\d+)/gi;
	let m: RegExpExecArray | null;
	while ((m = inline.exec(line)) !== null) {
		refs.add(m[1]);
	}

	return refs;
}

/**
 * Costruisce la Coverage_Map dai criteri di accettazione ai task (Req. 6.2).
 *
 * Ogni criterio compare nella mappa una sola volta (deduplicato per "N.M") ed è marcato
 * `covered` se almeno un task del documento `tasksMd` lo cita (Req. 6.3). Il campo
 * `taskLines` contiene gli indici di riga (0-based) di `tasksMd` in cui il criterio è
 * referenziato, così da poter indicare all'utente dove avviene la copertura.
 */
export function buildCoverageMap(
	criteria: AcceptanceCriterion[],
	tasksMd: string
): CoverageEntry[] {
	const lines = tasksMd ? tasksMd.split(/\r?\n/) : [];
	// Pre-calcolo dei riferimenti per ogni riga, una sola volta.
	const lineRefs = lines.map(extractTaskReferences);

	const seen = new Set<string>();
	const result: CoverageEntry[] = [];

	for (const c of criteria) {
		const key = `${c.requirement}.${c.index}`;
		// Ogni criterio compare una sola volta nella Coverage_Map.
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);

		const taskLines: number[] = [];
		lineRefs.forEach((refs, idx) => {
			if (refs.has(key)) {
				taskLines.push(idx);
			}
		});

		result.push({
			criterion: `Req ${key}`,
			taskLines,
			covered: taskLines.length > 0,
		});
	}

	return result;
}

// --- Validazione strutturale dei documenti Spec (Req. 6.4, 6.5) ---

/** Esito della verifica di presenza di una sezione strutturale attesa. */
export interface StructuralIssue {
	/** Nome della sezione strutturale attesa. */
	section: string;
	/** True se la sezione è presente nel documento. */
	present: boolean;
}

/**
 * Sezioni strutturali attese per ciascuna fase dello workflow Spec.
 *
 * I nomi corrispondono alle intestazioni markdown canoniche dei documenti Spec; la
 * verifica è case-insensitive e per sottostringa, così da tollerare titoli estesi
 * (es. "## Components and Interfaces" oppure "## Requirements").
 */
const EXPECTED_SECTIONS: Record<SpecPhase, readonly string[]> = {
	requirements: ['Introduction', 'Requirements'],
	design: ['Overview', 'Architecture', 'Components and Interfaces', 'Data Models'],
	tasks: ['Tasks'],
};

/** Verifica se il documento contiene un'intestazione che cita la sezione indicata. */
function hasHeadingFor(md: string, section: string): boolean {
	if (!md) {
		return false;
	}
	const needle = section.toLowerCase();
	const lines = md.split(/\r?\n/);
	for (const line of lines) {
		const heading = /^#{1,6}\s+(.*)$/.exec(line);
		if (heading && heading[1].toLowerCase().includes(needle)) {
			return true;
		}
	}
	return false;
}

/**
 * Valida la presenza delle sezioni strutturali attese per la fase corrente (Req. 6.4).
 *
 * Restituisce un esito per ciascuna sezione attesa con il flag `present`. Le sezioni con
 * `present === false` sono quelle mancanti, che bloccano l'avanzamento alla fase
 * successiva pur lasciando completabile la fase corrente (Req. 6.5).
 */
export function validateStructure(phase: SpecPhase, md: string): StructuralIssue[] {
	const expected = EXPECTED_SECTIONS[phase] ?? [];
	return expected.map((section) => ({
		section,
		present: hasHeadingFor(md, section),
	}));
}

// --- Report di validazione e gating dell'avanzamento (Req. 6.3, 6.5) ---

/**
 * Report complessivo di validazione di una fase Spec.
 *
 * `canAdvance` è `true` solo quando non manca alcuna sezione strutturale e nessun
 * criterio risulta scoperto: in tal caso si può procedere alla fase successiva. La fase
 * corrente resta comunque completabile anche con `canAdvance === false` (Req. 6.5).
 */
export interface ValidationReport {
	/** Esito della validazione strutturale (Req. 6.4, 6.5). */
	structural: StructuralIssue[];
	/** Coverage_Map dei criteri di accettazione (Req. 6.2, 6.3). */
	coverage: CoverageEntry[];
	/** Criteri che non seguono alcun pattern EARS valido (Req. 6.1). */
	earsViolations: AcceptanceCriterion[];
	/** True se è possibile avanzare alla fase successiva (Req. 6.3, 6.5). */
	canAdvance: boolean;
}

/** Parametri per la costruzione del report di validazione di una fase. */
export interface ValidationInput {
	/** Fase dello workflow Spec da validare. */
	phase: SpecPhase;
	/** Documento della fase corrente, usato per la validazione strutturale. */
	phaseDocument: string;
	/** Documento `requirements.md`, usato per EARS e Coverage_Map (se disponibile). */
	requirementsMd?: string;
	/** Documento `tasks.md`, usato per la Coverage_Map (se disponibile). */
	tasksMd?: string;
}

/**
 * Costruisce il `ValidationReport` di una fase combinando struttura, copertura ed EARS.
 *
 * La Coverage_Map viene calcolata solo nella fase `tasks` (quando i task esistono); nelle
 * fasi precedenti resta vuota. `canAdvance` è azzerato da qualunque sezione mancante o
 * criterio scoperto (Req. 6.3, 6.5), mentre le violazioni EARS sono riportate a scopo
 * informativo senza incidere su `canAdvance`.
 */
export function buildValidationReport(input: ValidationInput): ValidationReport {
	const { phase, phaseDocument, requirementsMd, tasksMd } = input;

	const structural = validateStructure(phase, phaseDocument);

	const criteria = parseAcceptanceCriteria(requirementsMd ?? '');
	const earsViolations = criteria.filter((c) => matchEarsPattern(c.text) === undefined);

	const coverage = phase === 'tasks' ? buildCoverageMap(criteria, tasksMd ?? '') : [];

	const hasMissingSection = structural.some((s) => !s.present);
	const hasUncovered = coverage.some((c) => !c.covered);
	const canAdvance = !hasMissingSection && !hasUncovered;

	return { structural, coverage, earsViolations, canAdvance };
}
