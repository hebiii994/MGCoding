/*---------------------------------------------------------------------------------------------
 *  MGCoding - punto di attivazione dell'estensione
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { runAgent } from './agent/agentLoop';
import { ChatViewProvider } from './chat/chatViewProvider';
import { ChatMessage } from './llm/types';
import { createSampleHook, Hook, HookManager, HooksTreeProvider, toggleHook } from './hooks/hooks';
import { ProviderRegistry } from './llm/registry';
import { McpTreeProvider, openMcpConfig } from './mcp/mcp';
import { McpManager, setMcpManager } from './mcp/mcpClient';
import { createSpec, runSpecTasks, SpecsTreeProvider } from './specs/specs';
import { initSteering, SteeringTreeProvider } from './steering/steering';

export function activate(context: vscode.ExtensionContext): void {
	const registry = new ProviderRegistry(context);
	context.subscriptions.push(registry);

	// Chat (barra laterale secondaria, a destra)
	const chat = new ChatViewProvider(context.extensionUri, registry);
	context.subscriptions.push(chat);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, chat, {
			webviewOptions: { retainContextWhenHidden: true }
		})
	);

	// Tree views (barra laterale sinistra)
	const specsTree = new SpecsTreeProvider();
	const hooksTree = new HooksTreeProvider();
	const steeringTree = new SteeringTreeProvider();
	const mcpTree = new McpTreeProvider();
	context.subscriptions.push(
		vscode.window.registerTreeDataProvider('mgcoding.specs', specsTree),
		vscode.window.registerTreeDataProvider('mgcoding.hooks', hooksTree),
		vscode.window.registerTreeDataProvider('mgcoding.steering', steeringTree),
		vscode.window.registerTreeDataProvider('mgcoding.mcp', mcpTree)
	);

	// Hooks runtime
	const hookManager = new HookManager(registry, () => hooksTree.refresh());
	context.subscriptions.push(hookManager);

	// MCP runtime
	const mcpManager = new McpManager();
	setMcpManager(mcpManager);
	context.subscriptions.push(mcpManager);
	const restartMcp = async () => { await mcpManager.start(); mcpTree.refresh(); };
	void restartMcp();
	const mcpWatcher = vscode.workspace.createFileSystemWatcher('**/.mg/mcp.json');
	mcpWatcher.onDidChange(() => void restartMcp());
	mcpWatcher.onDidCreate(() => void restartMcp());
	mcpWatcher.onDidDelete(() => void restartMcp());
	context.subscriptions.push(mcpWatcher);

	// Comandi
	context.subscriptions.push(
		vscode.commands.registerCommand('mgcoding.switchProvider', () => registry.switchProvider()),
		vscode.commands.registerCommand('mgcoding.setApiKey', () => registry.setApiKey()),
		vscode.commands.registerCommand('mgcoding.openChat', () => vscode.commands.executeCommand('mgcoding.chat.focus')),
		vscode.commands.registerCommand('mgcoding.runAgentTask', async () => {
			const task = await vscode.window.showInputBox({ prompt: 'Descrivi il task per l\'agente MGCoding', ignoreFocusOut: true });
			if (!task) {
				return;
			}
			const out = vscode.window.createOutputChannel('MGCoding Agent');
			out.show(true);
			out.appendLine(`\n=== Task: ${task} ===`);
			const messages: ChatMessage[] = [{ role: 'user', content: task }];
			await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: 'MGCoding: agente al lavoro…', cancellable: false },
				async () => runAgent(registry, messages, {
					onAssistantText: t => out.appendLine(`\n🤖 ${t}`),
					onToolStart: c => out.appendLine(`\n🔧 ${c.tool} ${JSON.stringify(c.args)}`),
					onToolResult: r => out.appendLine(`↳ ${r.slice(0, 500)}`)
				})
			);
			out.appendLine('\n=== Fine ===');
		}),

		vscode.commands.registerCommand('mgcoding.newSpec', () => createSpec(registry, () => specsTree.refresh())),
		vscode.commands.registerCommand('mgcoding.refreshSpecs', () => specsTree.refresh()),
		vscode.commands.registerCommand('mgcoding.runSpecTasks', (node?: { uri: vscode.Uri }) => {
			if (node?.uri) {
				return runSpecTasks(registry, node.uri, () => specsTree.refresh());
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
