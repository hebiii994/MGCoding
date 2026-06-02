/*---------------------------------------------------------------------------------------------
 *  MGCoding - test unitari delle funzioni pure (eseguibili con: node out/test/parsing.test.js)
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { kiroHookToInternal, parseToolCall, scopedGlob, splitThink } from '../util/parsing';

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

test('parseToolCall: blocco mg-tool {tool,args}', () => {
	const c = parseToolCall('testo\n```mg-tool\n{"tool":"read_file","args":{"path":"a.ts"}}\n```');
	assert.deepStrictEqual(c, { tool: 'read_file', args: { path: 'a.ts' } });
});

test('parseToolCall: blocco json {name,arguments}', () => {
	const c = parseToolCall('```json\n{"name":"write_file","arguments":{"path":"b","content":"x"}}\n```');
	assert.deepStrictEqual(c, { tool: 'write_file', args: { path: 'b', content: 'x' } });
});

test('parseToolCall: nessun tool', () => {
	assert.strictEqual(parseToolCall('solo una risposta in testo'), undefined);
});

test('scopedGlob: con e senza base', () => {
	assert.strictEqual(scopedGlob('**/*.ts', 'src'), 'src/**/*.ts');
	assert.strictEqual(scopedGlob('*.cs', 'Assets/Combat'), 'Assets/Combat/**/*.cs');
	assert.strictEqual(scopedGlob('**/*.ts'), '**/*.ts');
});

test('kiroHookToInternal: conversione when/then', () => {
	const h = kiroHookToInternal({ name: 'G', when: { type: 'fileEdited', patterns: ['**/*.cs'] }, then: { type: 'askAgent', prompt: 'p' } });
	assert.deepStrictEqual(
		{ event: h!.event, action: h!.action, filePattern: h!.filePattern, prompt: h!.prompt, enabled: h!.enabled },
		{ event: 'onSave', action: 'ask', filePattern: '**/*.cs', prompt: 'p', enabled: true }
	);
});

test('splitThink: separa ragionamento e risposta', () => {
	const r = splitThink('<think>ragiono qui</think>Risposta finale');
	assert.deepStrictEqual(r, { think: 'ragiono qui', answer: 'Risposta finale', thinking: false });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	process.exit(1);
}
