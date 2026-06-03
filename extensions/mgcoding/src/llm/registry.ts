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

/** Preset di servizi OpenAI-compatibili pronti all'uso. */
interface OpenAIPreset {
	id: string;
	label: string;
	endpoint: string;
	model: string;
	azure?: boolean;
	/** true => chiede all'utente endpoint/deployment (Azure o custom). */
	prompt?: boolean;
}

const OPENAI_PRESETS: OpenAIPreset[] = [
	{ id: 'chatgpt', label: 'ChatGPT (OpenAI)', endpoint: 'https://api.openai.com/v1', model: 'gpt-4o' },
	{ id: 'gemini', label: 'Google Gemini', endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-pro' },
	{ id: 'openrouter', label: 'OpenRouter (tutti i modelli)', endpoint: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-3.7-sonnet' },
	{ id: 'azure', label: 'Azure OpenAI (aziendale)', endpoint: '', model: '', azure: true, prompt: true },
	{ id: 'lmstudio', label: 'LM Studio (locale)', endpoint: 'http://localhost:1234/v1', model: 'local-model' },
	{ id: 'custom', label: 'Endpoint personalizzato…', endpoint: '', model: '', prompt: true }
];

/** Nome del secret per la API key di uno specifico endpoint (chiavi multiple coesistono). */
function openAiSecretKeyFor(endpoint: string): string {
	return endpoint ? `${SECRET_OPENAI_KEY}:${endpoint}` : SECRET_OPENAI_KEY;
}

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
			() => {
				const endpoint = vscode.workspace.getConfiguration('mgcoding').get<string>('openai.endpoint', 'http://localhost:1234/v1');
				return Promise.resolve(this.context.secrets.get(openAiSecretKeyFor(endpoint)));
			},
			() => {
				const c = vscode.workspace.getConfiguration('mgcoding');
				return {
					endpoint: c.get<string>('openai.endpoint', 'http://localhost:1234/v1'),
					model: c.get<string>('openai.model', 'local-model'),
					azure: c.get<boolean>('openai.azure', false),
					apiVersion: c.get<string>('openai.apiVersion', '2024-08-01-preview')
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
		const endpoint = vscode.workspace.getConfiguration('mgcoding').get<string>('openai.endpoint', 'http://localhost:1234/v1');
		const key = await vscode.window.showInputBox({
			prompt: `API key per ${endpoint || 'l\'endpoint OpenAI-compatibile'} (lascia vuoto per locale senza chiave)`,
			password: true,
			ignoreFocusOut: true
		});
		if (key !== undefined) {
			await this.context.secrets.store(openAiSecretKeyFor(endpoint), key.trim());
			vscode.window.showInformationMessage('API key OpenAI-compat salvata.');
			this.updateStatusBar();
		}
	}

	/** Applica un preset OpenAI-compatibile: aggiorna config, chiede endpoint/modello/key se serve. */
	private async applyOpenAiPreset(preset: OpenAIPreset): Promise<boolean> {
		const c = vscode.workspace.getConfiguration('mgcoding');
		let endpoint = preset.endpoint;
		let model = preset.model;

		if (preset.prompt) {
			const ph = preset.azure
				? 'https://<risorsa>.openai.azure.com/openai/deployments/<deployment>'
				: 'https://… (base URL OpenAI-compatibile, es. .../v1)';
			const ep = await vscode.window.showInputBox({ prompt: 'Endpoint (base URL)', placeHolder: ph, value: endpoint, ignoreFocusOut: true });
			if (!ep) {
				return false;
			}
			endpoint = ep.trim();
			const md = await vscode.window.showInputBox({ prompt: 'Nome modello / deployment', value: model, ignoreFocusOut: true });
			if (md === undefined) {
				return false;
			}
			model = md.trim();
		}

		await c.update('provider', 'openai', vscode.ConfigurationTarget.Global);
		await c.update('openai.endpoint', endpoint, vscode.ConfigurationTarget.Global);
		await c.update('openai.model', model, vscode.ConfigurationTarget.Global);
		await c.update('openai.azure', !!preset.azure, vscode.ConfigurationTarget.Global);

		// Chiedi la API key solo se non già memorizzata per questo endpoint.
		const existing = await this.context.secrets.get(openAiSecretKeyFor(endpoint));
		if (!existing) {
			await this.setOpenAIKey();
		}
		this.updateStatusBar();
		return true;
	}

	private updateStatusBar(): void {
		const p = this.current();
		this.statusBar.text = `$(sparkle) MGCoding: ${p.label} (${p.modelName()})`;
		this.statusBar.tooltip = 'Clicca per cambiare provider/modello MGCoding';
	}

	async switchProvider(): Promise<void> {
		type Item = vscode.QuickPickItem & { id: string; preset?: OpenAIPreset };
		const items: Item[] = [
			{ label: 'Ollama (locale)', id: 'ollama' },
			{ label: 'Claude (Anthropic)', id: 'claude' },
			{ label: 'Servizi OpenAI-compatibili', kind: vscode.QuickPickItemKind.Separator, id: '' },
			...OPENAI_PRESETS.map(p => ({
				label: p.label,
				description: p.endpoint || (p.azure ? 'Azure' : 'personalizzato'),
				id: 'openai',
				preset: p
			}))
		];
		const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Seleziona il provider/servizio LLM' });
		if (!picked) {
			return;
		}
		if (picked.id === 'openai' && picked.preset) {
			await this.applyOpenAiPreset(picked.preset);
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
