/*---------------------------------------------------------------------------------------------
 *  MGCoding - test property-based delle funzioni pure di `media/workflowConverter.ts`
 *  (eseguibile con: node out/test/workflowConverter.pbt.test.js)
 *
 *  Property 26: Conversione UI→API che preserva nodi e topologia (round-trip)
 *  *Per ogni* workflow in formato API valido, costruendo una rappresentazione UI equivalente
 *  e riconvertendola con `convertUiToApi`, il risultato è un workflow API equivalente: stesso
 *  insieme di `class_type` e stessa topologia dei collegamenti tra nodi.
 *  **Validates: Requirements 15.2**
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fc from 'fast-check';
import { ApiWorkflow, isLink } from '../media/workflowGraph';
import { convertUiToApi, isUiFormat, ObjectInfo, UiWorkflow } from '../media/workflowConverter';

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

// ---------------------------------------------------------------------------------------------
// Generatore intelligente di scenari di round-trip.
//
// Per rendere il round-trip BEN DEFINITO, generiamo congiuntamente: (a) un workflow API valido,
// (b) la sua rappresentazione UI equivalente (`nodes[]` + `links[]`), e (c) un `ObjectInfo`
// coerente che ordina i `widgets_values` posizionali esattamente come sono stati prodotti.
//
// La generazione è basata su "template di classe": ogni template definisce una `class_type`
// (univoca) e un elenco ORDINATO di campi, ciascuno o di connessione (slot alimentato da un
// link) oppure widget (valore inline di tipo INT/FLOAT/STRING/BOOLEAN). Più nodi possono
// condividere lo stesso template (e quindi la stessa `class_type`), così l'ObjectInfo per quella
// classe resta consistente anche con `class_type` duplicate.
// ---------------------------------------------------------------------------------------------

type WidgetType = 'INT' | 'FLOAT' | 'STRING' | 'BOOLEAN';
interface FieldSpec { kind: 'link' | 'widget'; widgetType: WidgetType; }
interface FieldData { srcIdx: number; slot: number; sval: string; ival: number; fval: number; bval: boolean; }
interface NodeSpec { templateIndex: number; fieldData: FieldData[]; }
interface Scenario { templates: FieldSpec[][]; nodes: NodeSpec[]; }
interface Built { api: ApiWorkflow; ui: UiWorkflow; objectInfo: ObjectInfo; }

const fieldArb: fc.Arbitrary<FieldSpec> = fc.record({
	kind: fc.constantFrom<'link' | 'widget'>('link', 'widget'),
	widgetType: fc.constantFrom<WidgetType>('INT', 'FLOAT', 'STRING', 'BOOLEAN'),
});

// Ogni template: 0..4 campi ordinati. Almeno un template.
const templatesArb: fc.Arbitrary<FieldSpec[][]> = fc.array(
	fc.array(fieldArb, { maxLength: 4 }),
	{ minLength: 1, maxLength: 4 }
);

// Per ogni nodo generiamo dati per max 4 campi (consumati posizionalmente dal template).
const nodeArb: fc.Arbitrary<NodeSpec> = fc.record({
	templateIndex: fc.nat({ max: 1000 }),
	fieldData: fc.array(
		fc.record({
			srcIdx: fc.nat({ max: 1000 }),
			slot: fc.integer({ min: 0, max: 3 }),
			sval: fc.string({ maxLength: 8 }),
			ival: fc.integer({ min: -1000, max: 1000 }),
			fval: fc.double({ noNaN: true, noDefaultInfinity: true }),
			bval: fc.boolean(),
		}),
		{ minLength: 4, maxLength: 4 }
	),
});

const nodesArb: fc.Arbitrary<NodeSpec[]> = fc.array(nodeArb, { minLength: 1, maxLength: 6 });

function widgetValue(field: FieldSpec, data: FieldData): string | number | boolean {
	switch (field.widgetType) {
		case 'INT': return data.ival;
		case 'FLOAT': return data.fval;
		case 'BOOLEAN': return data.bval;
		default: return data.sval;
	}
}

// Assembla congiuntamente API + UI + ObjectInfo a partire dallo scenario generato.
function build(s: Scenario): Built {
	const templates = s.templates;
	const numT = templates.length;
	const nodes = s.nodes;
	const numN = nodes.length;
	const nodeIds = nodes.map((_n, i) => i); // id numerici dei nodi (l'API usa String(id))

	const api: ApiWorkflow = {};
	const uiNodes: UiWorkflow['nodes'] = [];
	const links: UiWorkflow['links'] = [];
	const objectInfo: ObjectInfo = {};
	let linkCounter = 1;

	// ObjectInfo coerente per ogni template: i campi di connessione hanno un tipo non-widget
	// ("MODEL"), i campi widget il loro tipo primitivo. L'ordine delle chiavi è significativo.
	for (let t = 0; t < numT; t++) {
		const required: Record<string, [unknown, ...unknown[]]> = {};
		templates[t].forEach((f, j) => {
			required[`f${j}`] = f.kind === 'link' ? ['MODEL'] : [f.widgetType];
		});
		objectInfo[`Class${t}`] = { input: { required } };
	}

	nodes.forEach((node, idx) => {
		const tIdx = node.templateIndex % numT;
		const tmpl = templates[tIdx];
		const className = `Class${tIdx}`;
		const nodeNumericId = nodeIds[idx];
		const apiInputs: ApiWorkflow[string]['inputs'] = {};
		const uiInputs: { name: string; link: number }[] = [];
		const widgetsValues: unknown[] = [];

		tmpl.forEach((f, j) => {
			const name = `f${j}`;
			const data = node.fieldData[j];
			if (f.kind === 'link') {
				const srcNumericId = nodeIds[data.srcIdx % numN];
				const slot = data.slot;
				// API: input di connessione come riferimento [originNodeId(stringa), originSlot].
				apiInputs[name] = [String(srcNumericId), slot];
				// UI: slot di input con un linkId + voce nella tabella links.
				const linkId = linkCounter++;
				uiInputs.push({ name, link: linkId });
				links.push([linkId, srcNumericId, slot, nodeNumericId, uiInputs.length - 1, 'MODEL']);
			} else {
				// API: valore widget inline. UI: valore posizionale in widgets_values (in ordine).
				const val = widgetValue(f, data);
				apiInputs[name] = val;
				widgetsValues.push(val);
			}
		});

		api[String(nodeNumericId)] = { class_type: className, inputs: apiInputs };
		uiNodes.push({ id: nodeNumericId, type: className, widgets_values: widgetsValues, inputs: uiInputs });
	});

	return { api, ui: { nodes: uiNodes, links }, objectInfo };
}

const scenarioArb: fc.Arbitrary<Built> = fc
	.record({ templates: templatesArb, nodes: nodesArb })
	.map(build);

// Multiset ordinato delle class_type di un workflow.
function classTypes(api: ApiWorkflow): string[] {
	return Object.values(api).map(n => n.class_type).sort();
}

// Insieme degli archi della topologia: "origine#slot->destinazione#campo" per ogni input-link.
function edges(api: ApiWorkflow): string[] {
	const set: string[] = [];
	for (const [nid, node] of Object.entries(api)) {
		for (const [field, val] of Object.entries(node.inputs)) {
			if (isLink(val)) {
				set.push(`${val[0]}#${val[1]}->${nid}#${field}`);
			}
		}
	}
	return set.sort();
}

test('Property 26: il round-trip UI→API preserva class_type e topologia dei link', () => {
	fc.assert(
		fc.property(scenarioArb, ({ api, ui, objectInfo }: Built) => {
			// La rappresentazione costruita deve essere genuinamente in formato UI.
			assert.ok(isUiFormat(ui), 'la rappresentazione costruita non è in formato UI');

			const result = convertUiToApi(ui, objectInfo);
			assert.ok(result.ok, `conversione fallita: ${result.ok ? '' : result.reason}`);
			if (!result.ok) {
				return;
			}
			const converted = result.api;

			// (a) Stesso insieme di id di nodo.
			assert.deepStrictEqual(Object.keys(converted).sort(), Object.keys(api).sort());
			// (b) Stesso multiset di class_type.
			assert.deepStrictEqual(classTypes(converted), classTypes(api));
			// (c) Stessa topologia dei collegamenti tra nodi.
			assert.deepStrictEqual(edges(converted), edges(api));
		}),
		{ numRuns: 200 }
	);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
}
