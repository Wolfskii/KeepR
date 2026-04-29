import * as vscode from 'vscode';
import { BookmarkStore } from './store';
import { BookmarkTreeProvider } from './treeProvider';
import { DecorationManager } from './decorations';
import { registerCommands } from './commands';

let store: BookmarkStore;
let treeProvider: BookmarkTreeProvider;
let decorations: DecorationManager;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    // Initialize store and load persisted bookmarks
    store = new BookmarkStore(context);
    await store.load();

    // Tree view
    treeProvider = new BookmarkTreeProvider(store);
    const treeView = vscode.window.createTreeView('keepr.bookmarksView', {
        treeDataProvider: treeProvider,
        showCollapseAll: true,
    });

    // Editor decorations
    decorations = new DecorationManager(store);

    // Register all commands
    const commandDisposables = registerCommands(context, store, treeProvider, decorations);

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

    // Push disposables
    context.subscriptions.push(treeView, store, treeProvider, decorations, ...commandDisposables);
}

export function deactivate(): void {
    // cleanup handled by disposables
}
