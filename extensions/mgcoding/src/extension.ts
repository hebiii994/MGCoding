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
import { McpTreeProvider, openMcpConfig, addMcpServer, removeMcpServer, toggleMcpServer } from './mcp/mcp';
import { McpManager, setMcpManager } from './mcp/mcpClient';
import { importFromKiro } from './migrate/importKiro';
import { checkForUpdates } from './update/updater';
import { initAnalytics, track, toggleAnalytics } from './analytics/analytics';
import { registerAutocomplete } from './complete/autocomplete';
import { createSpec, runSpecTask, runSpecTasks, runSpecTasksParallel, SpecsTreeProvider, SpecTasksCodeLensProvider, toggleSpecTask } from './specs/specs';
import { initSteering, SteeringTreeProvider } from './steering/steering';

export function activate(context: vscode.ExtensionContext): void {
	const registry = new ProviderRegistry(context);
	context.subscriptions.push(registry);

	// Anteprima diff per le modifiche ai file
	registerDiffApproval(context);
	registerCheckpointDiff(context);

	// CodeLens "Start task / Run all / Sync / Segna fatto" nei tasks.md delle spec
	const specCodeLens = new SpecTasksCodeLensProvider();
	context.subscriptions.push(
		vscode.languages.registerCodeLensProvider({ pattern: '**/specs/**/tasks.md' }, specCodeLens)
	);

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
	// globalState (non workspaceState): la cronologia chat persiste tra i riavvii
	// e indipendentemente dalla cartella aperta.
	const chat = new ChatViewProvider(context.extensionUri, registry, context.globalState);
	context.subscriptions.push(chat);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chat, {
			webviewOptions: { retainContextWhenHidden: true }
		})
	);
	// Rivela la chat SOLO al primo avvio: dopo, si rispetta il layout salvato
	// dall'utente (larghezza/visibilità della barra laterale chat).
	if (!context.globalState.get<boolean>('mgcoding.chatRevealed', false)) {
		void context.globalState.update('mgcoding.chatRevealed', true);
		void vscode.commands.executeCommand('mgcoding.chat.focus');
	}

	// L'avanzamento dell'esecuzione dei task viene mostrato DENTRO la chat (a destra).
	const runView = chat.runReporter();

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
	const hookManager = new HookManager(registry, () => hooksTree.refresh(), () => chat.runReporter(), () => chat.beginRun());
	context.subscriptions.push(hookManager);

	const restartMcp = async () => { await mcpManager.start(); mcpTree.refresh(); };
	void restartMcp();
	const mcpWatcher = vscode.workspace.createFileSystemWatcher('**/{.mg/mcp.json,.kiro/settings/mcp.json}');
	mcpWatcher.onDidChange(() => void restartMcp());
	mcpWatcher.onDidCreate(() => void restartMcp());
	mcpWatcher.onDidDelete(() => void restartMcp());
	context.subscriptions.push(mcpWatcher);

	// Aggiorna le viste laterali quando i file di spec/steering/hooks cambiano
	// (anche quando li crea la chat), così il pannello si popola subito.
	const treeWatcher = vscode.workspace.createFileSystemWatcher('**/{.mg,.kiro}/{specs,steering,hooks}/**');
	const refreshTrees = () => { specsTree.refresh(); steeringTree.refresh(); hooksTree.refresh(); };
	treeWatcher.onDidChange(refreshTrees);
	treeWatcher.onDidCreate(refreshTrees);
	treeWatcher.onDidDelete(refreshTrees);
	context.subscriptions.push(treeWatcher);

	// Comandi
	context.subscriptions.push(
		vscode.commands.registerCommand('mgcoding.switchProvider', () => registry.switchProvider()),
		vscode.commands.registerCommand('mgcoding.guidedSetup', () => registry.guidedSetup()),
		vscode.commands.registerCommand('mgcoding.toggleAnalytics', () => toggleAnalytics()),
		vscode.commands.registerCommand('mgcoding.toggleNativeTools', async () => {
			const cfg = vscode.workspace.getConfiguration('mgcoding');
			const next = !cfg.get<boolean>('ollama.nativeTools', false);
			await cfg.update('ollama.nativeTools', next, vscode.ConfigurationTarget.Global);
			vscode.window.showInformationMessage(`Tool nativi Ollama: ${next ? 'ON' : 'OFF'}.`);
		}),
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
				return runSpecTasks(registry, node.uri, () => specsTree.refresh(), runView, true, chat.beginRun());
			}
			return undefined;
		}),
		vscode.commands.registerCommand('mgcoding.runSpecTask', (node?: { specDir: vscode.Uri; lineIdx: number }) => {
			if (node?.specDir && typeof node.lineIdx === 'number') {
				return runSpecTask(registry, node.specDir, node.lineIdx, () => specsTree.refresh(), runView, chat.beginRun());
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
		vscode.commands.registerCommand('mgcoding.refreshMcp', () => restartMcp()),
		vscode.commands.registerCommand('mgcoding.addMcpServer', async () => { if (await addMcpServer()) { restartMcp(); } }),
		vscode.commands.registerCommand('mgcoding.removeMcpServer', async (node?: { status?: { name?: string } }) => { if (await removeMcpServer(node?.status?.name)) { restartMcp(); } }),
		vscode.commands.registerCommand('mgcoding.toggleMcpServer', async (node?: { status?: { name?: string } }) => { if (await toggleMcpServer(node?.status?.name)) { restartMcp(); } }),
		vscode.commands.registerCommand('mgcoding.revealSpec', (node?: { uri?: vscode.Uri }) => revealNode(node?.uri)),
		vscode.commands.registerCommand('mgcoding.renameSpec', async (node?: { uri?: vscode.Uri }) => { if (await renameSpecDir(node?.uri)) { specsTree.refresh(); } }),
		vscode.commands.registerCommand('mgcoding.deleteSpec', async (node?: { uri?: vscode.Uri; label?: string }) => { if (await deleteUri(node?.uri, `Eliminare la spec "${node?.label ?? ''}"?`)) { specsTree.refresh(); } }),
		vscode.commands.registerCommand('mgcoding.revealHook', (node?: { hook?: Hook }) => revealNode(node?.hook?.uri)),
		vscode.commands.registerCommand('mgcoding.deleteHook', async (node?: { hook?: Hook }) => { if (await deleteUri(node?.hook?.uri, `Eliminare l'hook "${node?.hook?.name ?? ''}"?`)) { hooksTree.refresh(); } }),
		vscode.commands.registerCommand('mgcoding.revealSteering', (node?: { uri?: vscode.Uri }) => revealNode(node?.uri)),
		vscode.commands.registerCommand('mgcoding.deleteSteering', async (node?: { uri?: vscode.Uri; label?: string }) => { if (await deleteUri(node?.uri, `Eliminare lo steering "${node?.label ?? ''}"?`)) { steeringTree.refresh(); } }),

		// Barra spec (pulsanti nella title bar dell'editor per i file di una spec)
		vscode.commands.registerCommand('mgcoding.specOpenRequirements', (uri?: vscode.Uri) => openSpecSibling(uri, 'requirements.md')),
		vscode.commands.registerCommand('mgcoding.specOpenDesign', (uri?: vscode.Uri) => openSpecSibling(uri, 'design.md')),
		vscode.commands.registerCommand('mgcoding.specOpenTasks', (uri?: vscode.Uri) => openSpecSibling(uri, 'tasks.md')),
		vscode.commands.registerCommand('mgcoding.runSpecTasksHere', (uri?: vscode.Uri) => {
			const u = uri ?? vscode.window.activeTextEditor?.document.uri;
			if (!u) {
				return undefined;
			}
			// "Run all tasks": esegue i task richiesti, salta gli opzionali.
			return runSpecTasks(registry, vscode.Uri.joinPath(u, '..'), () => specsTree.refresh(), runView, false, chat.beginRun());
		}),
		vscode.commands.registerCommand('mgcoding.toggleSpecTask', async (node?: { specDir: vscode.Uri; lineIdx: number }) => {
			if (node?.specDir && typeof node.lineIdx === 'number') {
				await toggleSpecTask(node.specDir, node.lineIdx);
				specsTree.refresh();
				specCodeLens.refresh();
			}
		}),
		vscode.commands.registerCommand('mgcoding.specSync', () => {
			specsTree.refresh();
			specCodeLens.refresh();
			vscode.window.showInformationMessage('MGCoding: spec sincronizzata.');
		}),
		vscode.commands.registerCommand('mgcoding.runSpecTasksParallel', (uri?: vscode.Uri) => {
			const u = uri ?? vscode.window.activeTextEditor?.document.uri;
			if (!u) {
				return undefined;
			}
			const concurrency = vscode.workspace.getConfiguration('mgcoding').get<number>('tasks.parallel', 2);
			return runSpecTasksParallel(registry, vscode.Uri.joinPath(u, '..'), () => specsTree.refresh(), runView, true, chat.beginRun(), concurrency);
		}),
		vscode.commands.registerCommand('mgcoding.runSpecTasksHereOptional', (uri?: vscode.Uri) => {
			const u = uri ?? vscode.window.activeTextEditor?.document.uri;
			if (!u) {
				return undefined;
			}
			// "Run all + optional": include anche i task opzionali.
			return runSpecTasks(registry, vscode.Uri.joinPath(u, '..'), () => specsTree.refresh(), runView, true, chat.beginRun());
		})
	);
}

/** Mostra il file/cartella nel file manager del sistema operativo. */
async function revealNode(uri?: vscode.Uri): Promise<void> {
	if (uri) {
		await vscode.commands.executeCommand('revealFileInOS', uri);
	}
}

/** Elimina (Cestino) un file o cartella previa conferma. Ritorna true se eliminato. */
async function deleteUri(uri: vscode.Uri | undefined, prompt: string): Promise<boolean> {
	if (!uri) {
		return false;
	}
	const ok = await vscode.window.showWarningMessage(prompt, { modal: true, detail: 'L\'elemento verrà spostato nel Cestino.' }, 'Elimina');
	if (ok !== 'Elimina') {
		return false;
	}
	try {
		await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: true });
		return true;
	} catch (e) {
		vscode.window.showErrorMessage(`Eliminazione non riuscita: ${e instanceof Error ? e.message : String(e)}`);
		return false;
	}
}

/** Rinomina la cartella di una spec (chiede il nuovo nome, crea uno slug). */
async function renameSpecDir(uri?: vscode.Uri): Promise<boolean> {
	if (!uri) {
		return false;
	}
	const current = uri.path.split('/').pop() ?? '';
	const name = await vscode.window.showInputBox({
		title: 'Rinomina spec',
		prompt: 'Nuovo nome della spec',
		value: current.replace(/-/g, ' '),
		validateInput: v => v.trim() ? undefined : 'Inserisci un nome'
	});
	if (!name) {
		return false;
	}
	const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || current;
	if (slug === current) {
		return false;
	}
	const dest = vscode.Uri.joinPath(uri, '..', slug);
	try {
		await vscode.workspace.fs.rename(uri, dest, { overwrite: false });
		return true;
	} catch (e) {
		vscode.window.showErrorMessage(`Rinomina non riuscita: ${e instanceof Error ? e.message : String(e)}`);
		return false;
	}
}

/** Apre un documento fratello (requirements/design/tasks) nella stessa cartella spec. */
async function openSpecSibling(uri: vscode.Uri | undefined, name: string): Promise<void> {
	const u = uri ?? vscode.window.activeTextEditor?.document.uri;
	if (!u) {
		return;
	}
	const sibling = vscode.Uri.joinPath(u, '..', name);
	try {
		await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(sibling), { preview: false });
	} catch {
		vscode.window.showWarningMessage(`${name} non presente in questa spec.`);
	}
}

export function deactivate(): void {
	setMcpManager(undefined);
	// le altre risorse sono gestite via context.subscriptions
}
