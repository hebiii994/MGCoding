/*---------------------------------------------------------------------------------------------
 *  MGCoding - Property-based test del Router_LLM (logica pura `chooseProvider`).
 *  Harness self-contained (assert + ok/FAIL + exit(1)), eseguibile con:
 *      node out/test/routerAutoroute.pbt.test.js
 *
 *  Property 5: Auto-route instrada per complessità
 *  Per ogni richiesta marcata come complessa l'auto-route seleziona il provider designato
 *  "heavy", e per ogni richiesta marcata come semplice seleziona quello "light".
 *
 *  Per isolare questa proprietà neutralizziamo i filtri che precedono l'auto-route nella
 *  precedenza di `chooseProvider`:
 *   - `localFirst = false`  → il passo 2 (local-first) non restringe i candidati;
 *   - `hasImages = false`   → il passo 3 (vision) non restringe i candidati;
 *   - i provider designati heavy/light sono SEMPRE disponibili e hanno id univoci, così che
 *     il passo 4 (auto-route) trovi esattamente il designato.
 *
 *  **Validates: Requirements 2.2**
 *--------------------------------------------------------------------------------------------*/

// Lo stub di `vscode` DEVE essere importato prima del modulo sotto test (vedi vscodeStub.ts).
import './vscodeStub';
import * as assert from 'assert';
import * as fc from 'fast-check';
import { chooseProvider, ProviderDescriptor, RouteConfig, RouteContext } from '../llm/registry';

const RUNS = 200;

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void): void {
	try {
		fn();
		passed++;
		console.log(`ok   - ${name}`);
	} catch (e) {
		failed++;
		console.error(`FAIL - ${name}: ${e instanceof Error ? e.message : String(e)}`);
	}
}

/** Scenario di auto-route: id univoci, designati heavy/light disponibili, complessità arbitraria. */
interface AutoRouteScenario {
	descriptors: ProviderDescriptor[];
	heavyId: string;
	lightId: string;
	complexity: 'light' | 'heavy';
}

/**
 * Genera un insieme di descrittori con id UNIVOCI (almeno due). Il primo id è designato come
 * provider "heavy", il secondo come "light"; entrambi sono forzati disponibili. Gli altri
 * descrittori hanno flag arbitrari. `local`/`vision` restano arbitrari ma irrilevanti perché
 * `localFirst` e `hasImages` sono falsi nel contesto.
 */
const arbScenario: fc.Arbitrary<AutoRouteScenario> = fc
	.uniqueArray(fc.string({ minLength: 1, maxLength: 8 }), { minLength: 2, maxLength: 6 })
	.chain(ids =>
		fc
			.record({
				descriptors: fc.tuple(
					...ids.map(id =>
						fc.record({
							id: fc.constant(id),
							available: fc.boolean(),
							local: fc.boolean(),
							vision: fc.boolean(),
						})
					)
				),
				complexity: fc.constantFrom<'light' | 'heavy'>('light', 'heavy'),
			})
			.map(({ descriptors, complexity }) => {
				const descs: ProviderDescriptor[] = descriptors.map(d => ({ ...d }));
				// Forza disponibili i due provider designati (heavy = ids[0], light = ids[1]).
				descs[0].available = true;
				descs[1].available = true;
				return { descriptors: descs, heavyId: ids[0], lightId: ids[1], complexity };
			})
	);

test('Property 5: con autoRoute la scelta è il designato heavy/light secondo la complessità', () => {
	fc.assert(
		fc.property(arbScenario, ({ descriptors, heavyId, lightId, complexity }) => {
			const ctx: RouteContext = { hasImages: false, complexity, localFirst: false };
			const route: RouteConfig = { heavyId, lightId, autoRoute: true };
			// La nuova firma restituisce un RouteResult: si legge `.provider`.
			const chosen = chooseProvider(descriptors, ctx, route).provider;
			const wantedId = complexity === 'heavy' ? heavyId : lightId;
			assert.ok(chosen !== undefined, 'il designato è disponibile: deve restituire un provider');
			assert.strictEqual(
				chosen.id,
				wantedId,
				`con complessità '${complexity}' l'auto-route deve scegliere il designato '${wantedId}'`
			);
		}),
		{ numRuns: RUNS }
	);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
}
