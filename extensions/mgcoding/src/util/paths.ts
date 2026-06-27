/*---------------------------------------------------------------------------------------------
 *  MGCoding - Utility PURE di percorso e comando di avvio di ComfyUI.
 *  Logica PURA: nessuna dipendenza da `vscode`/`fetch`. È consentito solo `path` di Node per le
 *  costanti dei separatori; la piattaforma è SEMPRE un parametro iniettabile (non legata a
 *  `process.platform`) così da poter essere verificata sia per 'win32' sia per 'posix'.
 *  Vedi design "Properties 38 & 39" e Requirement 24.
 *  _Requirements: 24.2, 24.3_
 *--------------------------------------------------------------------------------------------*/

/** Piattaforme supportate per la costruzione di percorsi e comandi (iniettabili nei test). */
export type OsPlatform = 'win32' | 'posix';

/** Separatore di percorso per ciascuna piattaforma. */
export const PATH_SEPARATOR: Readonly<Record<OsPlatform, '\\' | '/'>> = {
	win32: '\\',
	posix: '/',
};

/** I due separatori possibili, usati per normalizzare input misti. */
const ALL_SEPARATORS = ['\\', '/'] as const;

/**
 * Restituisce il separatore di percorso atteso per la piattaforma indicata.
 * _Requirements: 24.3_
 */
export function separatorFor(platform: OsPlatform): '\\' | '/' {
	return PATH_SEPARATOR[platform];
}

/**
 * Predicato puro: vero se `ch` è il separatore di percorso della piattaforma indicata.
 * _Requirements: 24.3_
 */
export function isSeparator(ch: string, platform: OsPlatform): boolean {
	return ch === PATH_SEPARATOR[platform];
}

/**
 * Vero se `p` usa esclusivamente il separatore della piattaforma indicata (nessuna mescolanza
 * di `\\` e `/`). Un percorso senza alcun separatore è considerato coerente.
 * _Requirements: 24.3_
 */
export function usesConsistentSeparators(p: string, platform: OsPlatform): boolean {
	const sep = PATH_SEPARATOR[platform];
	const foreign = ALL_SEPARATORS.find(s => s !== sep)!;
	return !p.includes(foreign);
}

/**
 * Unisce segmenti di percorso usando il separatore della piattaforma indicata, in modo
 * coerente (senza mai mischiare `\\` e `/`).
 *
 * - I separatori già presenti nei segmenti (di qualsiasi tipo) sono normalizzati su quello
 *   della piattaforma.
 * - I segmenti vuoti sono ignorati.
 * - I separatori ridondanti tra segmenti sono compattati (eccetto un eventuale prefisso UNC/
 *   radice iniziale, che è preservato).
 *
 * _Requirements: 24.3_
 */
export function joinPath(platform: OsPlatform, ...segments: string[]): string {
	const sep = PATH_SEPARATOR[platform];
	// Normalizza ogni separatore nei segmenti verso quello della piattaforma.
	const normalize = (s: string): string => {
		let out = s;
		for (const other of ALL_SEPARATORS) {
			if (other !== sep) {
				out = out.split(other).join(sep);
			}
		}
		return out;
	};

	const parts: string[] = [];
	for (const raw of segments) {
		if (!raw) {
			continue;
		}
		const norm = normalize(raw);
		// Scompone in token non vuoti, preservando un eventuale separatore/prefisso iniziale.
		const tokens = norm.split(sep).filter(t => t.length > 0);
		if (tokens.length === 0) {
			// Il segmento era composto solo da separatori: contribuisce a una radice.
			if (parts.length === 0) {
				parts.push('');
			}
			continue;
		}
		// Conserva il prefisso di radice del primo segmento (es. "C:" o leading sep).
		if (parts.length === 0 && (norm.startsWith(sep))) {
			parts.push('');
		}
		parts.push(...tokens);
	}

	if (parts.length === 0) {
		return '';
	}
	// Gestisce il caso di radice iniziale (parts[0] === '') unendo col separatore.
	const joined = parts.join(sep);
	return joined.length === 0 ? sep : joined;
}

/** Comando di avvio risolto: eseguibile + argomenti, separati per essere testabili e sicuri. */
export interface LaunchCommand {
	/** Eseguibile/interprete da invocare (percorso assoluto o relativo alla cartella ComfyUI). */
	command: string;
	/** Argomenti passati all'eseguibile, in ordine. */
	args: string[];
}

/**
 * Nome della cartella dell'interprete Python embedded della distribuzione portable di ComfyUI
 * su Windows.
 */
export const PYTHON_EMBEDED_DIR = 'python_embeded';

/** Nome dell'eseguibile dell'interprete Python embedded. */
export const PYTHON_EMBEDED_EXE = 'python.exe';

/** Cartella e script di avvio di ComfyUI all'interno della distribuzione portable. */
export const COMFYUI_DIR = 'ComfyUI';
export const COMFYUI_MAIN = 'main.py';

/**
 * Costruisce il comando di avvio di ComfyUI su Windows usando l'interprete Python embedded
 * della distribuzione portable.
 *
 * Data la cartella di installazione (quella che contiene `python_embeded\` e `ComfyUI\`),
 * produce un'invocazione equivalente a:
 *
 *   python_embeded\python.exe -s ComfyUI\main.py
 *
 * Eventuali argomenti aggiuntivi (es. `--listen`, `--port 8188`) sono accodati nell'ordine
 * indicato. La funzione è PURA: non avvia alcun processo, ritorna solo la struttura del comando.
 *
 * @param installRoot Cartella radice della distribuzione portable di ComfyUI.
 * @param extraArgs   Argomenti aggiuntivi da passare a `main.py`.
 * _Requirements: 24.2_
 */
export function buildWindowsLaunch(installRoot: string, extraArgs: string[] = []): LaunchCommand {
	const platform: OsPlatform = 'win32';
	const command = joinPath(platform, installRoot, PYTHON_EMBEDED_DIR, PYTHON_EMBEDED_EXE);
	const mainScript = joinPath(platform, COMFYUI_DIR, COMFYUI_MAIN);
	// `-s` isola l'interprete dai site-packages utente (comportamento atteso del launcher portable).
	const args = ['-s', mainScript, ...extraArgs];
	return { command, args };
}
