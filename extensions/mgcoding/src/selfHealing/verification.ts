/*---------------------------------------------------------------------------------------------
 *  MGCoding - Self_Healing: confronto degli snapshot di verifica (Verification_Gate, nucleo puro).
 *--------------------------------------------------------------------------------------------*/

import { RegressionVerdict, VerificationSnapshot } from './types';

/**
 * Confronta lo snapshot DOPO l'applicazione con la Baseline (Req. 6.2, 6.3):
 *  - `regression` se gli errori O i test rossi sono AUMENTATI;
 *  - `ok` se gli errori sono DIMINUITI e i test rossi non sono aumentati (Issue risolta senza danni);
 *  - `no-change` in ogni altro caso.
 * Funzione totale: definita per qualunque coppia di snapshot.
 */
export function compareVerification(
	baseline: VerificationSnapshot,
	after: VerificationSnapshot
): RegressionVerdict {
	if (after.errorCount > baseline.errorCount || after.failingTests > baseline.failingTests) {
		return 'regression';
	}
	if (after.errorCount < baseline.errorCount && after.failingTests <= baseline.failingTests) {
		return 'ok';
	}
	return 'no-change';
}
