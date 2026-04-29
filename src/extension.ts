import * as vscode from 'vscode';
import { BookmarkStore } from './store';
import { BookmarkTreeProvider } from './treeProvider';
import { DecorationManager } from './decorations';
import { registerCommands } from './commands';
import { ProviderManager, ConnectionStore, ProviderTreeProvider } from './providers';
import { showOnboardingIfNeeded } from './onboarding';

let store: BookmarkStore;
let treeProvider: BookmarkTreeProvider;
let decorations: DecorationManager;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    // Initialize store and load persisted bookmarks
    store = new BookmarkStore(context);
    await store.load();

    // Connection store (multi-connection support)
    const connectionStore = new ConnectionStore(context.globalState, context.secrets);

    // Ticket provider manager (Azure DevOps, GitHub, Jira)
    const providers = new ProviderManager();
    providers.initSecrets(context.secrets);
    providers.initConnectionStore(connectionStore);
    providers.watchConfigChanges(context);

    // Provider tree view (sidebar panel for managing connections)
    const providerTree = new ProviderTreeProvider(connectionStore);
    const providerTreeView = vscode.window.createTreeView('keepr.providersView', {
        treeDataProvider: providerTree,
    });
    connectionStore.onDidChange(() => providerTree.refresh());

    // Bookmarks tree view
    treeProvider = new BookmarkTreeProvider(store, providers);
    const treeView = vscode.window.createTreeView('keepr.bookmarksView', {
        treeDataProvider: treeProvider,
        showCollapseAll: true,
    });

    // Refresh tree when provider changes
    providers.onDidChangeProvider(() => {
        treeProvider.refreshWorkItems();
    });

    // Editor decorations
    decorations = new DecorationManager(store);

    // Register all commands
    const commandDisposables = registerCommands(context, store, treeProvider, decorations, treeView, providers);

    // Refresh tree when store changes
    store.onDidChange(() => treeProvider.refresh());

    // Track line changes for bookmark drift correction
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(async (e) => {
            if (e.contentChanges.length > 0) {
                await store.adjustLines(e.document.uri, e.contentChanges);
            }
        }),
    );

    // Update decorations when switching editors
    if (vscode.window.activeTextEditor) {
        decorations.updateDecorations();
    }

    // Reload bookmarks when workspace folders change
    context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(async () => {
            await store.load();
            treeProvider.refresh();
            decorations.updateDecorations();
        }),
    );

    // Show onboarding if first install and no provider configured
    showOnboardingIfNeeded(context, providers);

    // Push disposables
    context.subscriptions.push(treeView, providerTreeView, store, treeProvider, decorations, providers, connectionStore, providerTree, ...commandDisposables);
}

export function deactivate(): void {
    // cleanup handled by disposables
}
