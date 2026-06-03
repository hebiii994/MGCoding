/*---------------------------------------------------------------------------------------------
 *  MGCoding - punto di attivazione dell'estensione
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { runAgent } from './agent/agentLoop';
import { ChatViewProvider } from './chat/chatViewProvider';
import { registerDiffApproval } from './edit/diffApproval';
import { inlineEdit } from './edit/inlineEdit';
import { hasCheckpoint, revertCheckpoint, registerCheckpointDiff, openCheckpointDiffs } from './edit/checkpoint';
import { ChatMessage } from './llm/types';
import { createSampleHook, Hook, HookManager, HooksTreeProvider, toggleHook } from './hooks/hooks';
import { ProviderRegistry } from './llm/registry';
import { McpTreeProvider, openMcpConfig } from './mcp/mcp';
import { McpManager, setMcpManager } from './mcp/mcpClient';
import { importFromKiro } from './migrate/importKiro';
import { checkForUpdates } from './update/updater';
import { initAnalytics, track, toggleAnalytics } from './analytics/analytics';
import { registerAutocomplete } from './complete/autocomplete';
import { RunViewProvider } from './run/runView';
import { createSpec, runSpecTask, runSpecTasks, SpecsTreeProvider } from './specs/specs';
import { initSteering, SteeringTreeProvider } from './steering/steering';

export function activate(context: vscode.ExtensionContext): void {
	const registry = new ProviderRegistry(context);
	context.subscriptions.push(registry);

	// Anteprima diff per le modifiche ai file
	registerDiffApproval(context);
	registerCheckpointDiff(context);

	// Controllo aggiornamenti silenzioso all'avvio
	void checkForUpdates(context, false);

	// Analytics anonimi opt-in (chiede il consenso una sola volta)
	initAnalytics(context);
	track('app_started');

	// Primo avvio: proponi la configurazione guidata di un modello
	if (!context.globalState.get<boolean>('mgcoding.firstRunDone', false)) {
		void context.globalState.update('mgcoding.firstRunDone', true);
		void vscode.window.showInformationMessage(
			'Benvenuto in MGCoding! Vuoi configurare ora un modello (Gemini, ChatGPT, Claude, Ollama…)?',
			'Configurazione guidata'
		).then(choice => {
			if (choice === 'Configurazione guidata') {
				void registry.guidedSetup();
			}
		});
	}

	// Autocomplete inline (ghost text)
	registerAutocomplete(context);

	// Chat (barra laterale secondaria, a destra)
	const chat = new ChatViewProvider(context.extensionUri, registry, context.workspaceState);
	context.subscriptions.push(chat);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chat, {
			webviewOptions: { retainContextWhenHidden: true }
		})
	);
	// Rivela la chat all'avvio così è già pronta (non una vista vuota da cliccare).
	void vscode.commands.executeCommand('mgcoding.chat.focus');

	// Vista "Esecuzione" (stato task live + autopilot)
	const runView = new RunViewProvider(context.extensionUri);
	context.subscriptions.push(runView);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(RunViewProvider.viewType, runView, {
			webviewOptions: { retainContextWhenHidden: true }
		})
	);

	// Indicatore Autopilot nella status bar
	const autopilotItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
	autopilotItem.command = 'mgcoding.toggleAutopilot';
	const updateAutopilot = () => {
		const on = vscode.workspace.getConfiguration('mgcoding').get<boolean>('autoApprove', false);
		autopilotItem.text = on ? '$(rocket) Autopilot' : '$(shield) Supervised';
		autopilotItem.tooltip = on ? 'MGCoding: Autopilot attivo (esegue senza conferma). Clicca per disattivare.' : 'MGCoding: modalità supervisionata (chiede conferma). Clicca per Autopilot.';
	};
	updateAutopilot();
	autopilotItem.show();
	context.subscriptions.push(autopilotItem);
	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
		if (e.affectsConfiguration('mgcoding.autoApprove')) {
			updateAutopilot();
		}
	}));

	// MCP runtime (creato prima della tree per fornirle lo stato live)
	const mcpManager = new McpManager();
	setMcpManager(mcpManager);
	context.subscriptions.push(mcpManager);

	// Tree views (barra laterale sinistra)
	const specsTree = new SpecsTreeProvider();
	const hooksTree = new HooksTreeProvider();
	const steeringTree = new SteeringTreeProvider();
	const mcpTree = new McpTreeProvider(() => mcpManager.getStatuses());
	context.subscriptions.push(
		vscode.window.registerTreeDataProvider('mgcoding.specs', specsTree),
		vscode.window.registerTreeDataProvider('mgcoding.hooks', hooksTree),
		vscode.window.registerTreeDataProvider('mgcoding.steering', steeringTree),
		vscode.window.registerTreeDataProvider('mgcoding.mcp', mcpTree)
	);

	// Hooks runtime
	const hookManager = new HookManager(registry, () => hooksTree.refresh());
	context.subscriptions.push(hookManager);

	const restartMcp = async () => { await mcpManager.start(); mcpTree.refresh(); };
	void restartMcp();
	const mcpWatcher = vscode.workspace.createFileSystemWatcher('**/{.mg/mcp.json,.kiro/settings/mcp.json}');
	mcpWatcher.onDidChange(() => void restartMcp());
	mcpWatcher.onDidCreate(() => void restartMcp());
	mcpWatcher.onDidDelete(() => void restartMcp());
	context.subscriptions.push(mcpWatcher);

	// Comandi
	context.subscriptions.push(
		vscode.commands.registerCommand('mgcoding.switchProvider', () => registry.switchProvider()),
		vscode.commands.registerCommand('mgcoding.guidedSetup', () => registry.guidedSetup()),
		vscode.commands.registerCommand('mgcoding.toggleAnalytics', () => toggleAnalytics()),
		vscode.commands.registerCommand('mgcoding.setApiKey', () => registry.setApiKey()),
		vscode.commands.registerCommand('mgcoding.setOpenAIKey', () => registry.setOpenAIKey()),
		vscode.commands.registerCommand('mgcoding.openChat', () => vscode.commands.executeCommand('mgcoding.chat.focus')),
		vscode.commands.registerCommand('mgcoding.inlineEdit', () => inlineEdit(registry)),
		vscode.commands.registerCommand('mgcoding.checkUpdates', () => checkForUpdates(context, true)),
		vscode.commands.registerCommand('mgcoding.viewChanges', () => openCheckpointDiffs()),
		vscode.commands.registerCommand('mgcoding.revertChanges', async () => {
			if (!hasCheckpoint()) {
				vscode.window.showInformationMessage('Nessuna modifica dell\'agente da ripristinare.');
				return;
			}
			const ok = await vscode.window.showWarningMessage('Ripristinare i file all\'ultimo checkpoint (annulla le modifiche dell\'agente)?', { modal: true }, 'Ripristina');
			if (ok === 'Ripristina') {
				const n = await revertCheckpoint();
				vscode.window.showInformationMessage(`MGCoding: ripristinati ${n} file.`);
			}
		}),
		vscode.commands.registerCommand('mgcoding.runAgentTask', async () => {
			const task = await vscode.window.showInputBox({ prompt: 'Descrivi il task per l\'agente MGCoding', ignoreFocusOut: true });
			if (!task) {
				return;
			}
			runView.start('Task agente', [task]);
			runView.setStatus(0, 'running');
			const messages: ChatMessage[] = [{ role: 'user', content: task }];
			try {
				await vscode.window.withProgress(
					{ location: vscode.ProgressLocation.Notification, title: 'MGCoding: agente al lavoro…', cancellable: false },
					async () => runAgent(registry, messages, {
						onAssistantText: t => runView.log(`🤖 ${t.slice(0, 300)}`),
						onToolStart: c => runView.log(`🔧 ${c.tool} ${JSON.stringify(c.args).slice(0, 160)}`),
						onToolResult: r => runView.log(`↳ ${r.slice(0, 200)}`)
					})
				);
				runView.setStatus(0, 'done');
			} catch (err) {
				runView.setStatus(0, 'error');
				runView.log(`[errore] ${String(err)}`);
			}
			runView.finish('=== Fine ===');
		}),
		vscode.commands.registerCommand('mgcoding.toggleAutopilot', async () => {
			const cfg = vscode.workspace.getConfiguration('mgcoding');
			const next = !cfg.get<boolean>('autoApprove', false);
			await cfg.update('autoApprove', next, vscode.ConfigurationTarget.Global);
			vscode.window.showInformationMessage(`MGCoding Autopilot: ${next ? 'ON (esegue senza conferma)' : 'OFF (supervisionato)'}`);
		}),

		vscode.commands.registerCommand('mgcoding.newSpec', () => createSpec(registry, () => specsTree.refresh())),
		vscode.commands.registerCommand('mgcoding.refreshSpecs', () => specsTree.refresh()),
		vscode.commands.registerCommand('mgcoding.importFromKiro', () => importFromKiro()),
		vscode.commands.registerCommand('mgcoding.runSpecTasks', (node?: { uri: vscode.Uri }) => {
			if (node?.uri) {
				return runSpecTasks(registry, node.uri, () => specsTree.refresh(), runView);
			}
			return undefined;
		}),
		vscode.commands.registerCommand('mgcoding.runSpecTask', (node?: { specDir: vscode.Uri; lineIdx: number }) => {
			if (node?.specDir && typeof node.lineIdx === 'number') {
				return runSpecTask(registry, node.specDir, node.lineIdx, () => specsTree.refresh(), runView);
			}
			return undefined;
		}),

		vscode.commands.registerCommand('mgcoding.newHook', async () => { await createSampleHook(); hooksTree.refresh(); }),
		vscode.commands.registerCommand('mgcoding.refreshHooks', () => hooksTree.refresh()),
		vscode.commands.registerCommand('mgcoding.toggleHook', async (node?: { hook: Hook }) => {
			if (node?.hook) { await toggleHook(node.hook); await hookManager.reload(); hooksTree.refresh(); }
		}),
		vscode.commands.registerCommand('mgcoding.runHook', (node?: { hook: Hook }) => {
			if (node?.hook) { return hookManager.runManual(node.hook); }
			return undefined;
		}),

		vscode.commands.registerCommand('mgcoding.initSteering', async () => { await initSteering(); steeringTree.refresh(); }),
		vscode.commands.registerCommand('mgcoding.refreshSteering', () => steeringTree.refresh()),

		vscode.commands.registerCommand('mgcoding.openMcpConfig', () => openMcpConfig()),
		vscode.commands.registerCommand('mgcoding.refreshMcp', () => restartMcp())
	);
}

export function deactivate(): void {
	setMcpManager(undefined);
	// le altre risorse sono gestite via context.subscriptions
}
