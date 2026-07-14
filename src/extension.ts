import * as vscode from 'vscode';
import { BookmarkStore } from './store';
import { BookmarkTreeProvider } from './treeProvider';
import { DecorationManager } from './decorations';
import { registerCommands } from './commands';
import { registerTools } from './tools';
import { ProviderManager, ConnectionStore, ProviderTreeProvider } from './providers';
import { showOnboardingIfNeeded } from './onboarding';
import { BookmarkCodeLensProvider } from './codeLensProvider';

let store: BookmarkStore;
let treeProvider: BookmarkTreeProvider;
let myTicketsTreeProvider: BookmarkTreeProvider;
let myPrsTreeProvider: BookmarkTreeProvider;
let decorations: DecorationManager;
let codeLensProvider: BookmarkCodeLensProvider;

const driftPromptCooldownMs = 30_000;
const recentlyPrompted = new Map<string, number>();

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
    treeProvider = new BookmarkTreeProvider(store, providers, 'bookmarks');
    const treeView = vscode.window.createTreeView('keepr.bookmarksView', {
        treeDataProvider: treeProvider,
        showCollapseAll: true,
    });

    myTicketsTreeProvider = new BookmarkTreeProvider(store, providers, 'tickets');
    const myTicketsTreeView = vscode.window.createTreeView('keepr.myTicketsView', {
        treeDataProvider: myTicketsTreeProvider,
    });

    myPrsTreeProvider = new BookmarkTreeProvider(store, providers, 'prs');
    const myPrsTreeView = vscode.window.createTreeView('keepr.myPullRequestsView', {
        treeDataProvider: myPrsTreeProvider,
    });

    // Warm My Items cache in background so filters/views are responsive when opened.
    if (vscode.workspace.getConfiguration('keepr').get<boolean>('myItems.enabled', true)) {
        void providers.getMyTicketsAcrossProviders().catch(() => undefined);
        void providers.getMyPullRequestsAcrossProviders().catch(() => undefined);
    }

    // Refresh tree when provider changes
    providers.onDidChangeProvider(() => {
        treeProvider.refreshWorkItems();
        myTicketsTreeProvider.refreshWorkItems();
        myPrsTreeProvider.refreshWorkItems();
    });

    // Editor decorations
    decorations = new DecorationManager(store);

    // Inline resolve/remove actions on bookmarked rows.
    codeLensProvider = new BookmarkCodeLensProvider(store);
    const codeLensRegistration = vscode.languages.registerCodeLensProvider({ scheme: 'file' }, codeLensProvider);

    // Register all commands
    const commandDisposables = registerCommands(
        context,
        store,
        treeProvider,
        decorations,
        treeView,
        providers,
        [myTicketsTreeProvider, myPrsTreeProvider],
    );

    // Register Language Model Tools (Copilot Chat / MCP integration)
    registerTools(context, store, decorations, providers);

    // Refresh tree when store changes
    store.onDidChange(() => {
        treeProvider.refresh();
        myTicketsTreeProvider.refresh();
        myPrsTreeProvider.refresh();
    });

    // Track line changes for bookmark drift correction
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(async (e) => {
            if (e.contentChanges.length > 0) {
                const impacts = store.detectLineImpacts(e.document.uri, e.contentChanges);
                await store.adjustLines(e.document.uri, e.contentChanges);
                await promptDeletedBookmarks(e.document, impacts);
            }
        }),
    );

    // Prompt for bookmarks on lines that changed since last snapshot.
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(async (document) => {
            await promptEditedBookmarks(document);
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
    context.subscriptions.push(
        treeView,
        myTicketsTreeView,
        myPrsTreeView,
        providerTreeView,
        store,
        treeProvider,
        myTicketsTreeProvider,
        myPrsTreeProvider,
        decorations,
        codeLensProvider,
        codeLensRegistration,
        providers,
        connectionStore,
        providerTree,
        ...commandDisposables,
    );
}

export function deactivate(): void {
    // cleanup handled by disposables
}

async function promptDeletedBookmarks(
    document: vscode.TextDocument,
    impacts: { bookmarkId: string; filePath: string; line: number }[],
): Promise<void> {
    for (const impact of impacts) {
        const promptKey = `${impact.bookmarkId}:deleted`;
        if (isPromptCooldownActive(promptKey)) { continue; }

        const found = store.findBookmarkById(impact.bookmarkId);
        if (!found) { continue; }
        const currentLine = found.bookmark.location.line + 1;

        const choice = await vscode.window.showWarningMessage(
            `KeepR bookmark line was removed in ${impact.filePath}.`,
            'Mark Resolved',
            'Remove',
            'Keep',
        );

        await handleDriftChoice(found.bookmark.id, choice, document, currentLine);
        markPrompted(promptKey);
    }
}

async function promptEditedBookmarks(document: vscode.TextDocument): Promise<void> {
    const bookmarks = store.getBookmarksInFile(document.uri);
    for (const bm of bookmarks) {
        if (bm.location.line < 0 || bm.location.line >= document.lineCount) { continue; }

        const currentLineText = document.lineAt(bm.location.line).text;
        const previousLineText = bm.location.lineText;
        if (!previousLineText) { continue; }
        if (previousLineText.trim() === currentLineText.trim()) { continue; }

        const promptKey = `${bm.id}:edited`;
        if (isPromptCooldownActive(promptKey)) { continue; }

        const choice = await vscode.window.showInformationMessage(
            `KeepR bookmark line changed at ${bm.location.filePath}:${bm.location.line + 1}.`,
            'Mark Resolved',
            'Remove',
            'Keep',
        );

        await handleDriftChoice(bm.id, choice, document, bm.location.line + 1);
        markPrompted(promptKey);
    }
}

async function handleDriftChoice(
    bookmarkId: string,
    choice: string | undefined,
    document: vscode.TextDocument,
    oneBasedLine: number,
): Promise<void> {
    if (choice === 'Remove') {
        await store.removeBookmark(bookmarkId);
        decorations.updateDecorations();
        return;
    }

    const zeroLine = oneBasedLine - 1;
    const lineText = zeroLine >= 0 && zeroLine < document.lineCount
        ? document.lineAt(zeroLine).text
        : undefined;

    if (choice === 'Mark Resolved') {
        await store.updateBookmark(bookmarkId, { status: 'Resolved' });
        await store.setBookmarkLineText(bookmarkId, lineText);
        decorations.updateDecorations();
        return;
    }

    if (choice === 'Keep') {
        await store.setBookmarkLineText(bookmarkId, lineText);
    }
}

function isPromptCooldownActive(key: string): boolean {
    const last = recentlyPrompted.get(key);
    return typeof last === 'number' && (Date.now() - last) < driftPromptCooldownMs;
}

function markPrompted(key: string): void {
    recentlyPrompted.set(key, Date.now());
}
