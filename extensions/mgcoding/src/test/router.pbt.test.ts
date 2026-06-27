/*---------------------------------------------------------------------------------------------
 *  MGCoding - Property-based test del Router_LLM (logica pura `chooseProvider`).
 *  Harness self-contained (assert + ok/FAIL + exit(1)), eseguibile con:
 *      node out/test/router.pbt.test.js
 *
 *  Property 4: Selezione provider LLM dall'insieme dei disponibili con local-first
 *  Per ogni insieme di provider con disponibilità e località arbitrarie, `chooseProvider`
 *  restituisce un provider appartenente all'insieme dei disponibili (o `undefined` se vuoto);
 *  e quando `localFirst` è attivo ed esiste almeno un provider locale disponibile, la scelta
 *  è locale.
 *
 *  Per isolare questa proprietà manteniamo `hasImages = false`: nella precedenza di
 *  `chooseProvider` il filtro vision (passo 3) è più a valle del local-first (passo 2) e
 *  introdurrebbe un restringimento ortogonale a quello qui verificato.
 *
 *  **Validates: Requirements 2.1, 2.5, 20.1**
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

/** Descrittore di provider con flag di disponibilità/località/vision arbitrari. */
const arbDescriptor: fc.Arbitrary<ProviderDescriptor> = fc.record({
	id: fc.string({ minLength: 1, maxLength: 8 }),
	available: fc.boolean(),
	local: fc.boolean(),
	vision: fc.boolean(),
});

/** Insieme di descrittori (anche vuoto): l'ordine e gli id arbitrari sono ammessi. */
const arbDescriptors: fc.Arbitrary<ProviderDescriptor[]> = fc.array(arbDescriptor, { maxLength: 6 });

/**
 * Contesto di instradamento con `hasImages` fissato a false per isolare il local-first.
 * `localFirst`, `complexity` e `hint` restano arbitrari.
 */
const arbContext: fc.Arbitrary<RouteContext> = fc.record({
	hint: fc.option(fc.string(), { nil: undefined }),
	hasImages: fc.constant(false),
	complexity: fc.constantFrom<'light' | 'heavy'>('light', 'heavy'),
	localFirst: fc.boolean(),
});

/** Configurazione di auto-route opzionale (può anche essere assente). */
const arbRoute: fc.Arbitrary<RouteConfig | undefined> = fc.option(
	fc.record({
		heavyId: fc.string({ minLength: 1, maxLength: 8 }),
		lightId: fc.string({ minLength: 1, maxLength: 8 }),
		autoRoute: fc.boolean(),
	}),
	{ nil: undefined }
);

// --- Clausola A: il risultato appartiene sempre all'insieme dei disponibili (o undefined) ---
test('Property 4: il provider scelto è disponibile, oppure undefined se nessuno lo è', () => {
	fc.assert(
		fc.property(arbDescriptors, arbContext, arbRoute, (descriptors, ctx, route) => {
			// `chooseProvider` restituisce un RouteResult: il provider è in `.provider`.
			const result = chooseProvider(descriptors, ctx, route);
			const chosen = result.provider;
			const available = descriptors.filter(d => d.available);
			if (available.length === 0) {
				assert.strictEqual(chosen, undefined, 'senza provider disponibili deve restituire undefined');
				// Con la nuova firma l'assenza di provider è sempre motivata (RouteResult.fallbackReason).
				assert.ok(
					typeof result.fallbackReason === 'string' && result.fallbackReason.length > 0,
					'l\'assenza di provider deve essere motivata nel RouteResult'
				);
				return;
			}
			assert.ok(chosen !== undefined, 'con almeno un disponibile deve restituire un provider');
			assert.ok(chosen.available, 'il provider scelto deve essere disponibile');
			// Deve essere esattamente uno degli oggetti dell'insieme dei disponibili (per riferimento).
			assert.ok(available.indexOf(chosen) >= 0, 'il provider scelto deve appartenere ai disponibili');
		}),
		{ numRuns: RUNS }
	);
});

// --- Clausola B: local-first con almeno un locale disponibile => scelta locale ---------------
test('Property 4: con localFirst e un locale disponibile la scelta è locale', () => {
	fc.assert(
		fc.property(arbDescriptors, arbRoute, (descriptors, route) => {
			const ctx: RouteContext = { hasImages: false, complexity: 'light', localFirst: true };
			const chosen = chooseProvider(descriptors, ctx, route).provider;
			const availableLocals = descriptors.filter(d => d.available && d.local);
			if (availableLocals.length > 0) {
				assert.ok(chosen !== undefined, 'con un locale disponibile deve restituire un provider');
				assert.ok(chosen.local, 'con localFirst e un locale disponibile la scelta deve essere locale');
				assert.ok(chosen.available, 'la scelta locale deve comunque essere disponibile');
			}
		}),
		{ numRuns: RUNS }
	);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
}
