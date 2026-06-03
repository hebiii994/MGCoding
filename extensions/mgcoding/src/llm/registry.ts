/*---------------------------------------------------------------------------------------------
 *  MGCoding - registry/selezione provider LLM + gestione API key + status bar
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ClaudeProvider } from './claudeProvider';
import { OllamaProvider } from './ollamaProvider';
import { OpenAIProvider } from './openaiProvider';
import { LLMProvider } from './types';

const SECRET_CLAUDE_KEY = 'mgcoding.claude.apiKey';
const SECRET_OPENAI_KEY = 'mgcoding.openai.apiKey';

export class ProviderRegistry implements vscode.Disposable {

	private readonly claude: ClaudeProvider;
	private readonly ollama: OllamaProvider;
	private readonly openai: OpenAIProvider;
	private readonly statusBar: vscode.StatusBarItem;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly context: vscode.ExtensionContext) {
		this.claude = new ClaudeProvider(
			() => Promise.resolve(this.context.secrets.get(SECRET_CLAUDE_KEY)),
			() => {
				const c = vscode.workspace.getConfiguration('mgcoding');
				return {
					model: c.get<string>('claude.model', 'claude-opus-4-8'),
					maxTokens: c.get<number>('claude.maxTokens', 8192),
					thinking: c.get<boolean>('claude.thinking', false),
					thinkingBudget: c.get<number>('claude.thinkingBudget', 2048)
				};
			}
		);
		this.ollama = new OllamaProvider(() => {
			const c = vscode.workspace.getConfiguration('mgcoding');
			return {
				endpoint: c.get<string>('ollama.endpoint', 'http://localhost:11434'),
				model: c.get<string>('ollama.model', 'qwen2.5-coder:14b'),
				think: c.get<boolean>('ollama.think', false)
			};
		});
		this.openai = new OpenAIProvider(
			() => Promise.resolve(this.context.secrets.get(SECRET_OPENAI_KEY)),
			() => {
				const c = vscode.workspace.getConfiguration('mgcoding');
				return {
					endpoint: c.get<string>('openai.endpoint', 'http://localhost:1234/v1'),
					model: c.get<string>('openai.model', 'local-model')
				};
			}
		);

		this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
		this.statusBar.command = 'mgcoding.switchProvider';
		this.disposables.push(this.statusBar);
		this.updateStatusBar();
		this.statusBar.show();

		this.disposables.push(vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('mgcoding')) {
				this.updateStatusBar();
			}
		}));
	}

	private byId(id: string): LLMProvider {
		return id === 'claude' ? this.claude : id === 'openai' ? this.openai : this.ollama;
	}

	current(): LLMProvider {
		return this.byId(vscode.workspace.getConfiguration('mgcoding').get<string>('provider', 'ollama'));
	}

	/** Sceglie il provider per una richiesta: se autoRoute è attivo, instrada per complessità. */
	pickProvider(hint?: string): LLMProvider {
		const c = vscode.workspace.getConfiguration('mgcoding');
		if (!c.get<boolean>('autoRoute', false)) {
			return this.current();
		}
		const heavy = /refactor|architett|design|implementa|\bspec\b|multipl|test|debug|ottimizz|migrazion|intero|tutti i file|codebase|refactoring/i;
		const isHeavy = !!hint && (hint.length > 600 || heavy.test(hint));
		return this.byId(isHeavy ? c.get<string>('route.heavy', 'claude') : c.get<string>('route.light', 'ollama'));
	}

	listOllamaModels(): Promise<string[]> {
		return this.ollama.listModels();
	}

	listOpenAIModels(): Promise<string[]> {
		return this.openai.listModels();
	}

	async setOpenAIKey(): Promise<void> {
		const key = await vscode.window.showInputBox({
			prompt: 'API key per l\'endpoint OpenAI-compatibile (lascia vuoto per locale senza chiave)',
			password: true,
			ignoreFocusOut: true
		});
		if (key !== undefined) {
			await this.context.secrets.store(SECRET_OPENAI_KEY, key.trim());
			vscode.window.showInformationMessage('API key OpenAI-compat salvata.');
			this.updateStatusBar();
		}
	}

	private updateStatusBar(): void {
		const p = this.current();
		this.statusBar.text = `$(sparkle) MGCoding: ${p.label} (${p.modelName()})`;
		this.statusBar.tooltip = 'Clicca per cambiare provider/modello MGCoding';
	}

	async switchProvider(): Promise<void> {
		const picked = await vscode.window.showQuickPick(
			[
				{ label: 'Ollama (locale)', id: 'ollama' },
				{ label: 'Claude (Anthropic)', id: 'claude' },
				{ label: 'OpenAI-compatibile (LM Studio, OpenRouter…)', id: 'openai' }
			],
			{ placeHolder: 'Seleziona il provider LLM' }
		);
		if (!picked) {
			return;
		}
		await vscode.workspace.getConfiguration('mgcoding').update('provider', picked.id, vscode.ConfigurationTarget.Global);
		if (picked.id === 'claude' && !(await this.claude.isConfigured())) {
			const set = await vscode.window.showInformationMessage(
				'Nessuna API key Claude impostata. Vuoi impostarla ora?',
				'Imposta'
			);
			if (set) {
				await this.setApiKey();
			}
		}
		this.updateStatusBar();
	}

	async setApiKey(): Promise<void> {
		const key = await vscode.window.showInputBox({
			prompt: 'Incolla la tua API key Anthropic (sk-ant-...)',
			password: true,
			ignoreFocusOut: true
		});
		if (key) {
			await this.context.secrets.store(SECRET_CLAUDE_KEY, key.trim());
			vscode.window.showInformationMessage('API key Claude salvata in modo sicuro.');
			this.updateStatusBar();
		}
	}

	dispose(): void {
		this.disposables.forEach(d => d.dispose());
	}
}
