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
	/** Pagina dove ottenere la API key (mostrata nella configurazione guidata). */
	keyUrl?: string;
	/** Nota mostrata nella configurazione guidata. */
	note?: string;
}

const OPENAI_PRESETS: OpenAIPreset[] = [
	{ id: 'chatgpt', label: 'ChatGPT (OpenAI)', endpoint: 'https://api.openai.com/v1', model: 'gpt-4o', keyUrl: 'https://platform.openai.com/api-keys', note: 'Serve una API key di OpenAI Platform (a consumo): l\'abbonamento ChatGPT web non è sufficiente.' },
	{ id: 'gemini', label: 'Google Gemini', endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-pro', keyUrl: 'https://aistudio.google.com/apikey', note: 'Serve una API key gratuita di Google AI Studio: l\'abbonamento Gemini Advanced non è sufficiente.' },
	{ id: 'openrouter', label: 'OpenRouter (tutti i modelli)', endpoint: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-3.7-sonnet', keyUrl: 'https://openrouter.ai/keys' },
	{ id: 'azure', label: 'Azure OpenAI (aziendale)', endpoint: '', model: '', azure: true, prompt: true, note: 'Inserisci l\'URL del deployment Azure e la relativa key.' },
	{ id: 'lmstudio', label: 'LM Studio (locale)', endpoint: 'http://localhost:1234/v1', model: 'local-model', note: 'Assicurati che LM Studio sia in esecuzione con il server locale attivo.' },
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

	/** True se il modello Ollama dichiara di supportare il tool-use nativo. */
	ollamaModelSupportsTools(model: string): Promise<boolean> {
		return this.ollama.supportsTools(model);
	}

	listOpenAIModels(): Promise<string[]> {
		return this.openai.listModels();
	}

	/** True se esiste una API key salvata per l'endpoint OpenAI-compatibile attuale. */
	async hasOpenAIKey(): Promise<boolean> {
		const endpoint = vscode.workspace.getConfiguration('mgcoding').get<string>('openai.endpoint', 'http://localhost:1234/v1');
		const key = await this.context.secrets.get(openAiSecretKeyFor(endpoint));
		return !!(key && key.trim());
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
	private async applyOpenAiPreset(preset: OpenAIPreset, forceKey = false): Promise<boolean> {
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

		// Chiedi la API key se richiesto esplicitamente o se non già memorizzata per questo endpoint.
		const existing = await this.context.secrets.get(openAiSecretKeyFor(endpoint));
		if (forceKey || !existing) {
			await this.setOpenAIKey();
		}
		this.updateStatusBar();
		return true;
	}

	/** Testa la raggiungibilità del provider e mostra l'esito. */
	private async testAndReport(provider: LLMProvider, label: string): Promise<void> {
		const ok = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: `Verifica connessione a ${label}…`, cancellable: false },
			() => provider.isConfigured()
		);
		this.updateStatusBar();
		if (ok) {
			vscode.window.showInformationMessage(`✓ ${label} configurato e raggiungibile.`);
		} else {
			vscode.window.showWarningMessage(`⚠ ${label} configurato, ma il test di connessione non è riuscito. Verifica la chiave o l'endpoint.`);
		}
	}

	/** Procedura guidata: scegli un servizio, ottieni la chiave, testala, scegli il modello. */
	async guidedSetup(): Promise<void> {
		type Item = vscode.QuickPickItem & { target: 'preset' | 'claude' | 'ollama'; presetId?: string };
		const items: Item[] = [
			{ label: '$(sparkle) Google Gemini', detail: 'API key gratuita da Google AI Studio', target: 'preset', presetId: 'gemini' },
			{ label: 'ChatGPT (OpenAI)', detail: 'API key da OpenAI Platform', target: 'preset', presetId: 'chatgpt' },
			{ label: 'Claude (Anthropic)', detail: 'API key da console.anthropic.com', target: 'claude' },
			{ label: 'OpenRouter', detail: 'Tutti i modelli con una sola key', target: 'preset', presetId: 'openrouter' },
			{ label: 'Azure OpenAI', detail: 'Endpoint aziendale', target: 'preset', presetId: 'azure' },
			{ label: 'Ollama (locale)', detail: 'Modelli in locale, nessuna chiave', target: 'ollama' },
			{ label: 'LM Studio (locale)', detail: 'Server locale OpenAI-compatibile', target: 'preset', presetId: 'lmstudio' }
		];
		const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Configurazione guidata: quale modello/servizio vuoi usare?', ignoreFocusOut: true });
		if (!pick) {
			return;
		}

		if (pick.target === 'claude') {
			const go = await vscode.window.showInformationMessage(
				'Claude richiede una API key Anthropic (sk-ant-…).',
				'Apri pagina chiave',
				'Ho già la chiave'
			);
			if (go === 'Apri pagina chiave') {
				await vscode.env.openExternal(vscode.Uri.parse('https://console.anthropic.com/settings/keys'));
			}
			if (!go) {
				return;
			}
			await vscode.workspace.getConfiguration('mgcoding').update('provider', 'claude', vscode.ConfigurationTarget.Global);
			await this.setApiKey();
			await this.testAndReport(this.claude, 'Claude');
			return;
		}

		if (pick.target === 'ollama') {
			const c = vscode.workspace.getConfiguration('mgcoding');
			await c.update('provider', 'ollama', vscode.ConfigurationTarget.Global);
			const endpoint = c.get<string>('ollama.endpoint', 'http://localhost:11434');
			const models = await this.ollama.listModels();
			if (!models.length) {
				vscode.window.showWarningMessage(`Ollama non raggiungibile su ${endpoint}. Avvia Ollama (e scarica un modello con "ollama pull") poi riprova.`);
				return;
			}
			const model = await vscode.window.showQuickPick(models, { placeHolder: 'Scegli il modello Ollama da usare' });
			if (model) {
				await c.update('ollama.model', model, vscode.ConfigurationTarget.Global);
			}
			await this.testAndReport(this.ollama, 'Ollama');
			return;
		}

		// Servizi OpenAI-compatibili (preset)
		const preset = OPENAI_PRESETS.find(p => p.id === pick.presetId);
		if (!preset) {
			return;
		}
		if (preset.keyUrl) {
			const go = await vscode.window.showInformationMessage(
				`${preset.label}. ${preset.note ?? ''}`.trim(),
				'Apri pagina chiave',
				'Ho già la chiave'
			);
			if (!go) {
				return;
			}
			if (go === 'Apri pagina chiave') {
				await vscode.env.openExternal(vscode.Uri.parse(preset.keyUrl));
			}
		} else if (preset.note) {
			vscode.window.showInformationMessage(preset.note);
		}
		const ok = await this.applyOpenAiPreset(preset, true);
		if (!ok) {
			return;
		}
		// Offri la scelta del modello tra quelli esposti dall'endpoint, se disponibili.
		try {
			const models = await this.openai.listModels();
			if (models.length) {
				const current = vscode.workspace.getConfiguration('mgcoding').get<string>('openai.model', '');
				const sorted = [current, ...models.filter(m => m !== current)].filter(Boolean);
				const model = await vscode.window.showQuickPick(sorted, { placeHolder: `Scegli il modello (${preset.label})` });
				if (model) {
					await vscode.workspace.getConfiguration('mgcoding').update('openai.model', model, vscode.ConfigurationTarget.Global);
				}
			}
		} catch {
			// elenco modelli non disponibile: si tiene il default del preset
		}
		await this.testAndReport(this.openai, preset.label);
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
