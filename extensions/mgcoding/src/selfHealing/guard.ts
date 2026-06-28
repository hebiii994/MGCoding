/*---------------------------------------------------------------------------------------------
 *  MGCoding - Self_Healing: Reward_Hacking_Guard (nucleo puro).
 *  Impedisce a una Fix_Proposal di "barare": modificare file di test/configurazione protetti
 *  o ridurre il numero complessivo di test per superare la verifica (Req. 7).
 *--------------------------------------------------------------------------------------------*/

import { FixProposal, GuardConfig, GuardVerdict, VerificationSnapshot } from './types';

/** Normalizza i separatori di percorso a `/` per un confronto uniforme cross-platform. */
function normalize(p: string): string {
	return p.replace(/\\/g, '/');
}

/**
 * Converte un glob (`*`, `**`, `?`) in una RegExp ancorata. `**` attraversa i separatori di
 * cartella (e l'eventuale `/` immediatamente successivo), `*` resta entro un segmento, `?`
 * corrisponde a un singolo carattere non separatore.
 */
function globToRegExp(glob: string): RegExp {
	const g = normalize(glob);
	let re = '';
	for (let i = 0; i < g.length; i++) {
		const c = g[i];
		if (c === '*') {
			if (g[i + 1] === '*') {
				re += '.*';
				i++;
				if (g[i + 1] === '/') {
					i++;
				}
			} else {
				re += '[^/]*';
			}
		} else if (c === '?') {
			re += '[^/]';
		} else if ('.+^${}()|[]\\'.includes(c)) {
			re += `\\${c}`;
		} else {
			re += c;
		}
	}
	return new RegExp(`^${re}$`);
}

/** True se il percorso corrisponde ad almeno un glob protetto (Req. 7.1). */
export function isProtectedPath(path: string, config: GuardConfig): boolean {
	const p = normalize(path);
	return config.protectedGlobs.some(glob => globToRegExp(glob).test(p));
}

/**
 * Guard PRE-applicazione (Req. 7.2): rifiuta la proposta se uno qualunque dei `touchedPaths`
 * è un Protected_Path, indicando il percorso incriminato.
 */
export function checkPathsGuard(proposal: FixProposal, config: GuardConfig): GuardVerdict {
	const offending = proposal.touchedPaths.find(p => isProtectedPath(p, config));
	if (offending !== undefined) {
		return { ok: false, reason: `La proposta modifica un percorso protetto (test/configurazione): ${offending}` };
	}
	return { ok: true };
}

/**
 * Guard POST-verifica (Req. 7.3): rifiuta se il numero totale di test è DIMINUITO rispetto
 * alla Baseline (possibile indebolimento della suite per "far passare" la verifica).
 */
export function checkTestCountGuard(
	baseline: VerificationSnapshot,
	after: VerificationSnapshot
): GuardVerdict {
	if (after.totalTests < baseline.totalTests) {
		return { ok: false, reason: `Il numero di test è diminuito (${baseline.totalTests} → ${after.totalTests}): possibile indebolimento della suite.` };
	}
	return { ok: true };
}
