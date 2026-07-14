import * as vscode from 'vscode';
import { BookmarkStatus } from './models';
import { BookmarkStore } from './store';
import { BookmarkTreeProvider } from './treeProvider';
import { DecorationManager } from './decorations';
import { ProviderManager, ConnectionStore, runSetupWizard } from './providers';
import { pickTicket } from './ticketPicker';

/**
 * Registers all KeepR commands and returns disposables.
 */
export function registerCommands(
    context: vscode.ExtensionContext,
    store: BookmarkStore,
    treeProvider: BookmarkTreeProvider,
    decorations: DecorationManager,
    treeView: vscode.TreeView<any>,
    providers: ProviderManager,
    myItemsTreeProviders: BookmarkTreeProvider[] = [],
): vscode.Disposable[] {
    const disposables: vscode.Disposable[] = [];

    const refreshMyItemsViews = (): void => {
        treeProvider.refreshMyItems();
        for (const provider of myItemsTreeProviders) {
            provider.refreshMyItems();
        }
    };

    const allTreeProviders = [treeProvider, ...myItemsTreeProviders];

    function getStatusLabels(): string[] {
        const config = vscode.workspace.getConfiguration('keepr');
        return config.get<string[]>('statusLabels', [
            'To Fix', 'Bug', 'Performance', 'Bad Practice', 'To Implement', 'Review', 'Note', 'Resolved',
        ]);
    }

    /** Emoji prefix per status for QuickPick items */
    function statusEmoji(status: string): string {
        switch (status) {
            case 'Bug': return '$(bug)';
            case 'To Fix': return '$(wrench)';
            case 'Performance': return '$(dashboard)';
            case 'Bad Practice': return '$(warning)';
            case 'To Implement': return '$(lightbulb)';
            case 'Review': return '$(eye)';
            case 'Note': return '$(note)';
            case 'Resolved': return '$(check)';
            default: return '$(bookmark)';
        }
    }

    function statusQuickPickItems(includeNone: boolean): vscode.QuickPickItem[] {
        const statuses = getStatusLabels();
        const items: vscode.QuickPickItem[] = statuses.map((s) => ({
            label: `${statusEmoji(s)} ${s}`,
            description: '',
            detail: undefined,
            _status: s,
        } as vscode.QuickPickItem & { _status: string }));
        if (includeNone) {
            items.unshift({ label: '$(circle-slash) (none)', description: '' });
        }
        return items;
    }

    function extractStatus(pick: vscode.QuickPickItem | undefined): BookmarkStatus | undefined | null {
        if (!pick) { return null; } // cancelled
        if (pick.label.includes('(none)')) { return undefined; }
        // Strip the icon prefix: "$(icon) Status" → "Status"
        return pick.label.replace(/^\$\([^)]+\)\s*/, '') as BookmarkStatus;
    }

    // ── Toggle Bookmark (quick, no dialog) ───────────────

    disposables.push(
        vscode.commands.registerCommand('keepr.toggleBookmark', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) { return; }

            const line = editor.selection.active.line;
            const existing = store.findBookmarkAtLine(editor.document.uri, line);

            if (existing) {
                await store.removeBookmark(existing.bookmark.id);
            } else {
                const lineText = editor.document.lineAt(line).text;
                await store.addBookmark(editor.document.uri, line, { lineText });
            }
            decorations.updateDecorations();
        }),
    );

    // ── Add Bookmark with Details ────────────────────────

    disposables.push(
        vscode.commands.registerCommand('keepr.addBookmark', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) { return; }

            const line = editor.selection.active.line;
            const lineText = editor.document.lineAt(line).text;
            const selection = editor.selection;

            // Label
            const label = await vscode.window.showInputBox({
                prompt: 'Bookmark label (optional)',
                placeHolder: 'e.g. "Check null handling here"',
            });
            if (label === undefined) { return; } // cancelled

            // Ticket / PBI
            const ticket = await pickTicket(providers);
            if (ticket === undefined) { return; }

            // Status
            const statusPick = await vscode.window.showQuickPick(
                statusQuickPickItems(true),
                { placeHolder: 'Select status' },
            );
            const status = extractStatus(statusPick);
            if (status === null) { return; } // cancelled

            await store.addBookmark(editor.document.uri, line, {
                label: label || undefined,
                ticket: ticket || undefined,
                status,
                lineText,
                startColumn: selection.isEmpty ? undefined : selection.start.character,
                endColumn: selection.isEmpty ? undefined : selection.end.character,
            });
            decorations.updateDecorations();
        }),
    );

    // ── Remove Bookmark ──────────────────────────────────

    disposables.push(
        vscode.commands.registerCommand('keepr.removeBookmark', async (arg?: string | { bookmark?: { id: string } }) => {
            let bookmarkId: string | undefined;

            if (typeof arg === 'string') {
                bookmarkId = arg;
            } else if (arg?.bookmark?.id) {
                bookmarkId = arg.bookmark.id;
            } else {
                // From editor context
                const editor = vscode.window.activeTextEditor;
                if (!editor) { return; }
                const existing = store.findBookmarkAtLine(editor.document.uri, editor.selection.active.line);
                if (existing) {
                    bookmarkId = existing.bookmark.id;
                }
            }

            if (!bookmarkId) { return; }
            await store.removeBookmark(bookmarkId);
            decorations.updateDecorations();
        }),
    );

    // ── Resolve Bookmark ───────────────────────────────

    disposables.push(
        vscode.commands.registerCommand('keepr.resolveBookmark', async (arg?: string | { bookmark?: { id: string } }) => {
            let bookmarkId: string | undefined;

            if (typeof arg === 'string') {
                bookmarkId = arg;
            } else if (arg?.bookmark?.id) {
                bookmarkId = arg.bookmark.id;
            } else {
                const editor = vscode.window.activeTextEditor;
                if (!editor) { return; }
                const existing = store.findBookmarkAtLine(editor.document.uri, editor.selection.active.line);
                if (existing) {
                    bookmarkId = existing.bookmark.id;
                }
            }

            if (!bookmarkId) {
                vscode.window.showInformationMessage('No bookmark found at cursor.');
                return;
            }

            await store.updateBookmark(bookmarkId, { status: 'Resolved' });

            const found = store.findBookmarkById(bookmarkId);
            if (found) {
                const uri = store.resolveUri(found.repo, found.bookmark);
                const doc = await vscode.workspace.openTextDocument(uri);
                const line = found.bookmark.location.line;
                const lineText = line >= 0 && line < doc.lineCount ? doc.lineAt(line).text : undefined;
                await store.setBookmarkLineText(bookmarkId, lineText);
            }

            decorations.updateDecorations();
        }),
    );

    // Convenience aliases for inline editor controls
    disposables.push(
        vscode.commands.registerCommand('keepr.removeBookmarkById', async (bookmarkId: string) => {
            if (!bookmarkId) { return; }
            await vscode.commands.executeCommand('keepr.removeBookmark', bookmarkId);
        }),
        vscode.commands.registerCommand('keepr.resolveBookmarkById', async (bookmarkId: string) => {
            if (!bookmarkId) { return; }
            await vscode.commands.executeCommand('keepr.resolveBookmark', bookmarkId);
        }),
        vscode.commands.registerCommand('keepr.editBookmarkById', async (bookmarkId: string) => {
            if (!bookmarkId) { return; }
            await vscode.commands.executeCommand('keepr.editBookmark', { bookmark: { id: bookmarkId } });
        }),
    );

    // ── Edit Bookmark ────────────────────────────────────

    disposables.push(
        vscode.commands.registerCommand('keepr.editBookmark', async (node?: { bookmark?: { id: string } }) => {
            let bookmarkId: string | undefined;

            if (node?.bookmark) {
                bookmarkId = node.bookmark.id;
            } else {
                const editor = vscode.window.activeTextEditor;
                if (!editor) { return; }
                const existing = store.findBookmarkAtLine(editor.document.uri, editor.selection.active.line);
                if (existing) { bookmarkId = existing.bookmark.id; }
            }

            if (!bookmarkId) {
                vscode.window.showInformationMessage('No bookmark found at cursor.');
                return;
            }

            const found = store.findBookmarkById(bookmarkId);
            if (!found) { return; }
            const { bookmark } = found;

            const field = await vscode.window.showQuickPick(
                ['Label', 'Ticket', 'Status'],
                { placeHolder: 'What to edit?' },
            );
            if (!field) { return; }

            switch (field) {
                case 'Label': {
                    const label = await vscode.window.showInputBox({
                        prompt: 'New label',
                        value: bookmark.label ?? '',
                    });
                    if (label === undefined) { return; }
                    await store.updateBookmark(bookmarkId, { label: label || undefined });
                    break;
                }
                case 'Ticket': {
                    const ticket = await pickTicket(providers, bookmark.ticket);
                    if (ticket === undefined) { return; }
                    await store.updateBookmark(bookmarkId, { ticket: ticket || undefined });
                    break;
                }
                case 'Status': {
                    const pick = await vscode.window.showQuickPick(
                        statusQuickPickItems(true),
                        { placeHolder: 'Select status' },
                    );
                    const newStatus = extractStatus(pick);
                    if (newStatus === null) { return; }
                    await store.updateBookmark(bookmarkId, { status: newStatus });
                    break;
                }
            }
        }),
    );

    // ── Rename Repo ──────────────────────────────────────

    disposables.push(
        vscode.commands.registerCommand('keepr.renameRepo', async (node?: { repo?: { repoName: string; displayName?: string } }) => {
            if (!node?.repo) { return; }
            const current = store.getDisplayName(
                store.getState().repos.find((r) => r.repoName === node.repo!.repoName)!,
            );
            const newName = await vscode.window.showInputBox({
                prompt: 'Rename project',
                value: current,
                placeHolder: 'e.g. "Nemo.Core"',
            });
            if (newName === undefined) { return; }
            await store.renameRepo(node.repo.repoName, newName || undefined);
        }),
    );

    // ── Navigation ───────────────────────────────────────

    disposables.push(
        vscode.commands.registerCommand('keepr.nextBookmark', async () => {
            await navigateBookmark('next');
        }),
    );

    disposables.push(
        vscode.commands.registerCommand('keepr.previousBookmark', async () => {
            await navigateBookmark('previous');
        }),
    );

    async function navigateBookmark(direction: 'next' | 'previous'): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { return; }

        const bookmarks = store.getBookmarksInFile(editor.document.uri);
        if (bookmarks.length === 0) { return; }

        const currentLine = editor.selection.active.line;
        const sorted = [...bookmarks].sort((a, b) => a.location.line - b.location.line);

        let target: typeof bookmarks[0] | undefined;

        if (direction === 'next') {
            target = sorted.find((b) => b.location.line > currentLine) ?? sorted[0];
        } else {
            target = [...sorted].reverse().find((b) => b.location.line < currentLine) ?? sorted[sorted.length - 1];
        }

        if (target) {
            const pos = new vscode.Position(target.location.line, target.location.startColumn ?? 0);
            editor.selection = new vscode.Selection(pos, pos);
            editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
        }
    }

    // ── Clear All ────────────────────────────────────────

    disposables.push(
        vscode.commands.registerCommand('keepr.clearAllBookmarks', async () => {
            const confirm = await vscode.window.showWarningMessage(
                'Remove all bookmarks in this workspace?',
                { modal: true },
                'Yes',
            );
            if (confirm === 'Yes') {
                await store.clearAll();
                decorations.updateDecorations();
            }
        }),
    );

    // ── Section collapse/expand ──────────────────────────

    disposables.push(
        vscode.commands.registerCommand('keepr.toggleSectionCollapse', (node?: { repo?: { repoName: string } }) => {
            if (node?.repo) {
                treeProvider.toggleRepoCollapse(node.repo.repoName);
            }
        }),
    );

    disposables.push(
        vscode.commands.registerCommand('keepr.collapseAll', () => {
            treeProvider.collapseAll();
        }),
    );

    disposables.push(
        vscode.commands.registerCommand('keepr.expandAll', () => {
            treeProvider.expandAll();
        }),
    );

    // ── Filters ──────────────────────────────────────────

    disposables.push(
        vscode.commands.registerCommand('keepr.filterByStatus', async () => {
            const pick = await vscode.window.showQuickPick(
                statusQuickPickItems(false),
                { placeHolder: 'Filter bookmarks by status' },
            );
            const chosen = extractStatus(pick);
            if (chosen) {
                treeProvider.setStatusFilter(chosen);
            }
        }),
    );

    disposables.push(
        vscode.commands.registerCommand('keepr.filterByTicket', async () => {
            const ticket = await vscode.window.showInputBox({
                prompt: 'Filter by ticket number',
                placeHolder: 'e.g. "419046"',
            });
            if (ticket) {
                treeProvider.setTicketFilter(ticket);
            }
        }),
    );

    disposables.push(
        vscode.commands.registerCommand('keepr.clearFilter', () => {
            treeProvider.clearFilter();
        }),
    );

    // ── My Items filters/sort ──────────────────────────

    disposables.push(
        vscode.commands.registerCommand('keepr.refreshMyItems', () => {
            refreshMyItemsViews();
            vscode.window.showInformationMessage('KeepR: My Tickets/PRs refreshed.');
        }),
    );

    disposables.push(
        vscode.commands.registerCommand('keepr.toggleMyItemExpand', async (arg?: { kind?: 'ticket' | 'pr'; key?: string }) => {
            const kind = arg?.kind;
            const key = arg?.key;
            if (!kind || !key) { return; }

            for (const provider of allTreeProviders) {
                provider.toggleMyItemExpand(kind, key);
            }
        }),
    );

    disposables.push(
        vscode.commands.registerCommand('keepr.toggleDescriptionExpand', async (descId?: string) => {
            if (!descId) { return; }
            for (const provider of allTreeProviders) {
                provider.toggleDescriptionExpand(descId);
            }
        }),
    );

    disposables.push(
        vscode.commands.registerCommand('keepr.openMyItemInBrowser', async (arg?: string | { item?: { item?: { url?: string } } }) => {
            const url = typeof arg === 'string' ? arg : arg?.item?.item?.url;
            if (!url) { return; }
            await vscode.env.openExternal(vscode.Uri.parse(url));
        }),
    );

    disposables.push(
        vscode.commands.registerCommand('keepr.copyMyItemUrl', async (arg?: string | { item?: { item?: { url?: string } } }) => {
            const url = typeof arg === 'string' ? arg : arg?.item?.item?.url;
            if (!url) { return; }
            await vscode.env.clipboard.writeText(url);
            vscode.window.showInformationMessage('KeepR: Link copied to clipboard.');
        }),
    );

    disposables.push(
        vscode.commands.registerCommand('keepr.setMyItemsTicketFilter', async () => {
            const options = [
                { label: 'All', value: 'all' },
                { label: 'Assigned', value: 'assigned' },
                { label: 'Created', value: 'created' },
                { label: 'Mentioned', value: 'mentioned' },
                { label: 'Commented', value: 'commented' },
                { label: 'Involved', value: 'involved' },
            ];
            const pick = await vscode.window.showQuickPick(options, { placeHolder: 'My Tickets filter' });
            if (!pick) { return; }
            await vscode.workspace.getConfiguration('keepr').update('myItems.ticketFilter', pick.value, vscode.ConfigurationTarget.Global);
            refreshMyItemsViews();
        }),
    );

    disposables.push(
        vscode.commands.registerCommand('keepr.setMyItemsPrFilter', async () => {
            const options = [
                { label: 'All', value: 'all' },
                { label: 'Authored', value: 'authored' },
                { label: 'Reviewer', value: 'reviewer' },
                { label: 'Approved', value: 'approved' },
                { label: 'Mentioned', value: 'mentioned' },
                { label: 'Commented', value: 'commented' },
                { label: 'Involved', value: 'involved' },
            ];
            const pick = await vscode.window.showQuickPick(options, { placeHolder: 'My Pull Requests filter' });
            if (!pick) { return; }
            await vscode.workspace.getConfiguration('keepr').update('myItems.prFilter', pick.value, vscode.ConfigurationTarget.Global);
            refreshMyItemsViews();
        }),
    );

    disposables.push(
        vscode.commands.registerCommand('keepr.setMyItemsTicketStates', async () => {
            const states = await treeProvider.getAvailableMyTicketStates();
            if (states.length === 0) {
                vscode.window.showInformationMessage('KeepR: No ticket states available yet. Refresh My Items first.');
                return;
            }

            const config = vscode.workspace.getConfiguration('keepr');
            const current = new Set(config.get<string[]>('myItems.ticketVisibleStates', []));
            const picks = await vscode.window.showQuickPick(
                states.map((state) => ({ label: state, picked: current.size === 0 ? !isCompletedState(state, 'ticket') : current.has(state) })),
                { placeHolder: 'Visible ticket states', canPickMany: true },
            );
            if (!picks) { return; }

            await config.update('myItems.ticketVisibleStates', picks.map((pick) => pick.label), vscode.ConfigurationTarget.Global);
            refreshMyItemsViews();
        }),
    );

    disposables.push(
        vscode.commands.registerCommand('keepr.setMyItemsPrStates', async () => {
            const states = await treeProvider.getAvailableMyPrStates();
            if (states.length === 0) {
                vscode.window.showInformationMessage('KeepR: No pull request states available yet. Refresh My Items first.');
                return;
            }

            const config = vscode.workspace.getConfiguration('keepr');
            const current = new Set(config.get<string[]>('myItems.prVisibleStates', []));
            const picks = await vscode.window.showQuickPick(
                states.map((state) => ({ label: state, picked: current.size === 0 ? !isCompletedState(state, 'pr') : current.has(state) })),
                { placeHolder: 'Visible pull request states', canPickMany: true },
            );
            if (!picks) { return; }

            await config.update('myItems.prVisibleStates', picks.map((pick) => pick.label), vscode.ConfigurationTarget.Global);
            refreshMyItemsViews();
        }),
    );

    disposables.push(
        vscode.commands.registerCommand('keepr.setMyItemsSort', async () => {
            const options = [
                { label: 'Updated (Newest first)', value: 'updated' },
                { label: 'Created (Newest first)', value: 'created' },
                { label: 'Title (A-Z)', value: 'title' },
                { label: 'Provider (A-Z)', value: 'provider' },
                { label: 'Type (A-Z)', value: 'type' },
                { label: 'Status (A-Z)', value: 'status' },
            ];
            const pick = await vscode.window.showQuickPick(options, { placeHolder: 'My Items sort order' });
            if (!pick) { return; }
            await vscode.workspace.getConfiguration('keepr').update('myItems.sortBy', pick.value, vscode.ConfigurationTarget.Global);
            refreshMyItemsViews();
        }),
    );

    // ── Go to bookmark (from quick pick) ────────────────

    disposables.push(
        vscode.commands.registerCommand('keepr.goToBookmark', async () => {
            const all = store.getAllBookmarks();
            if (all.length === 0) {
                vscode.window.showInformationMessage('No bookmarks yet.');
                return;
            }

            const items = all.map(({ repo, bookmark }) => ({
                label: bookmark.label || bookmark.location.lineText?.trim() || `Line ${bookmark.location.line + 1}`,
                description: `${repo.repoName} · ${bookmark.location.filePath}:${bookmark.location.line + 1}`,
                detail: [bookmark.ticket ? `#${bookmark.ticket}` : '', bookmark.status ?? ''].filter(Boolean).join(' · '),
                bookmark,
                repo,
            }));

            const pick = await vscode.window.showQuickPick(items, {
                placeHolder: 'Go to bookmark…',
                matchOnDescription: true,
                matchOnDetail: true,
            });

            if (pick) {
                const uri = store.resolveUri(pick.repo, pick.bookmark);
                const line = pick.bookmark.location.line;
                const col = pick.bookmark.location.startColumn ?? 0;
                const doc = await vscode.workspace.openTextDocument(uri);
                const editor = await vscode.window.showTextDocument(doc);
                const pos = new vscode.Position(line, col);
                editor.selection = new vscode.Selection(pos, pos);
                editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
            }
        }),
    );

    // ── Reveal bookmark in panel (from hover link or badge) ──

    disposables.push(
        vscode.commands.registerCommand('keepr.revealBookmark', async (bookmarkId?: string) => {
            if (!bookmarkId) {
                // Fallback: try current line
                const editor = vscode.window.activeTextEditor;
                if (!editor) { return; }
                const found = store.findBookmarkAtLine(editor.document.uri, editor.selection.active.line);
                if (found) { bookmarkId = found.bookmark.id; }
            }
            if (!bookmarkId) { return; }

            // Focus the KeepR panel
            await vscode.commands.executeCommand('keepr.bookmarksView.focus');

            const node = treeProvider.getBookmarkNodeById(bookmarkId);
            if (!node) { return; }
            try {
                await treeView.reveal(node, { focus: true, select: true, expand: 3 });
            } catch {
                // Ignore reveal failures (for example when filtered out); panel is already focused.
            }
        }),
    );

    // ── Set Provider Token (secure storage) ───────────────

    disposables.push(
        vscode.commands.registerCommand('keepr.setAzureDevOpsPat', async () => {
            const connStore = providers.connectionStore;
            if (connStore) {
                // Multi-connection mode — run full wizard for Azure DevOps
                await runSetupWizard(connStore);
                return;
            }
            const pat = await vscode.window.showInputBox({
                prompt: 'Enter your Azure DevOps Personal Access Token',
                placeHolder: 'Paste PAT here…',
                password: true,
            });
            if (pat === undefined) { return; }
            const azdo = providers.getProvider('azureDevOps');
            if (azdo) {
                await azdo.storeToken(pat);
                vscode.window.showInformationMessage('KeepR: Azure DevOps PAT saved securely.');
            }
        }),
    );

    disposables.push(
        vscode.commands.registerCommand('keepr.setGitHubToken', async () => {
            const connStore = providers.connectionStore;
            if (connStore) {
                await runSetupWizard(connStore);
                return;
            }
            const token = await vscode.window.showInputBox({
                prompt: 'Enter your GitHub Personal Access Token',
                placeHolder: 'Paste token here…',
                password: true,
            });
            if (token === undefined) { return; }
            const gh = providers.getProvider('github');
            if (gh) {
                await gh.storeToken(token);
                vscode.window.showInformationMessage('KeepR: GitHub token saved securely.');
            }
        }),
    );

    disposables.push(
        vscode.commands.registerCommand('keepr.setJiraToken', async () => {
            const connStore = providers.connectionStore;
            if (connStore) {
                await runSetupWizard(connStore);
                return;
            }
            const token = await vscode.window.showInputBox({
                prompt: 'Enter your Jira API Token',
                placeHolder: 'Paste token here…',
                password: true,
            });
            if (token === undefined) { return; }
            const jira = providers.getProvider('jira');
            if (jira) {
                await jira.storeToken(token);
                vscode.window.showInformationMessage('KeepR: Jira API token saved securely.');
            }
        }),
    );

    // ── Setup Provider (interactive wizard) ──────────────────

    disposables.push(
        vscode.commands.registerCommand('keepr.setupProvider', async () => {
            const connStore = providers.connectionStore;
            if (connStore) {
                await runSetupWizard(connStore);
                return;
            }
            // Legacy fallback: open settings
            const items: (vscode.QuickPickItem & { _id: string })[] = [
                { label: '$(azure-devops) Azure DevOps', description: 'Connect to Azure DevOps work items', _id: 'azureDevOps' },
                { label: '$(github) GitHub', description: 'Connect to GitHub Issues & PRs', _id: 'github' },
                { label: '$(globe) Jira', description: 'Connect to Jira issues', _id: 'jira' },
            ];
            const pick = await vscode.window.showQuickPick(items, {
                placeHolder: 'Choose a ticket provider to set up',
            });
            if (!pick) { return; }
            await vscode.workspace.getConfiguration('keepr').update('ticketProvider', pick._id, vscode.ConfigurationTarget.Global);
            await vscode.commands.executeCommand('workbench.action.openSettings', `keepr.${pick._id}`);
        }),
    );

    // ── Add Connection (same wizard as setupProvider) ──────────────────

    disposables.push(
        vscode.commands.registerCommand('keepr.addConnection', async () => {
            const connStore = providers.connectionStore;
            if (!connStore) { return; }
            await runSetupWizard(connStore);
        }),
    );

    // ── Edit Connection ──────────────────

    disposables.push(
        vscode.commands.registerCommand('keepr.editConnection', async (arg?: string | { connection?: { id: string } }) => {
            const connStore = providers.connectionStore;
            if (!connStore) { return; }

            let connectionId: string | undefined;
            if (typeof arg === 'string') { connectionId = arg; }
            else if (arg?.connection?.id) { connectionId = arg.connection.id; }

            if (!connectionId) {
                // Pick from list
                const connections = connStore.getAll();
                if (connections.length === 0) {
                    vscode.window.showInformationMessage('No connections configured. Use "Add Connection" first.');
                    return;
                }
                const pick = await vscode.window.showQuickPick(
                    connections.map(c => ({ label: c.name, description: c.type, _id: c.id })),
                    { placeHolder: 'Select a connection to edit' },
                );
                if (!pick) { return; }
                connectionId = pick._id;
            }

            const conn = connStore.get(connectionId);
            if (!conn) { return; }
            await runSetupWizard(connStore, conn);
        }),
    );

    // ── Remove Connection ──────────────────

    disposables.push(
        vscode.commands.registerCommand('keepr.removeConnection', async (arg?: string | { connection?: { id: string } }) => {
            const connStore = providers.connectionStore;
            if (!connStore) { return; }

            let connectionId: string | undefined;
            if (typeof arg === 'string') { connectionId = arg; }
            else if (arg?.connection?.id) { connectionId = arg.connection.id; }

            if (!connectionId) {
                const connections = connStore.getAll();
                if (connections.length === 0) { return; }
                const pick = await vscode.window.showQuickPick(
                    connections.map(c => ({ label: c.name, description: c.type, _id: c.id })),
                    { placeHolder: 'Select a connection to remove' },
                );
                if (!pick) { return; }
                connectionId = pick._id;
            }

            const conn = connStore.get(connectionId);
            if (!conn) { return; }

            const confirm = await vscode.window.showWarningMessage(
                `Remove connection "${conn.name}"?`,
                { modal: true },
                'Remove',
            );
            if (confirm !== 'Remove') { return; }

            await connStore.remove(connectionId);
            vscode.window.showInformationMessage(`KeepR: Connection "${conn.name}" removed.`);
        }),
    );

    // ── Activate Connection ──────────────────

    disposables.push(
        vscode.commands.registerCommand('keepr.activateConnection', async (arg?: string | { connection?: { id: string } }) => {
            const connStore = providers.connectionStore;
            if (!connStore) { return; }

            let connectionId: string | undefined;
            if (typeof arg === 'string') { connectionId = arg; }
            else if (arg?.connection?.id) { connectionId = arg.connection.id; }

            if (!connectionId) {
                const connections = connStore.getAll();
                if (connections.length === 0) { return; }
                const activeId = connStore.getActiveId();
                const pick = await vscode.window.showQuickPick(
                    connections.map(c => ({
                        label: c.id === activeId ? `● ${c.name}` : c.name,
                        description: c.type,
                        _id: c.id,
                    })),
                    { placeHolder: 'Select the active connection' },
                );
                if (!pick) { return; }
                connectionId = pick._id;
            }

            await connStore.setActiveId(connectionId);
            const conn = connStore.get(connectionId);
            if (conn) {
                vscode.window.showInformationMessage(`KeepR: Active connection set to "${conn.name}".`);
            }
        }),
    );

    // ── Open Ticket in Browser ────────────────────────────

    disposables.push(
        vscode.commands.registerCommand('keepr.openTicket', async (node?: { bookmark?: { id: string } }) => {
            let ticket: string | undefined;

            if (node?.bookmark) {
                const found = store.findBookmarkById(node.bookmark.id);
                ticket = found?.bookmark.ticket;
            } else {
                const editor = vscode.window.activeTextEditor;
                if (editor) {
                    const found = store.findBookmarkAtLine(editor.document.uri, editor.selection.active.line);
                    ticket = found?.bookmark.ticket;
                }
            }

            if (!ticket) {
                vscode.window.showInformationMessage('No ticket linked to this bookmark.');
                return;
            }

            const url = providers.getTicketUrl(ticket);
            if (!url) {
                vscode.window.showWarningMessage('Configure a ticket provider in settings to open tickets.');
                return;
            }

            await vscode.env.openExternal(vscode.Uri.parse(url));
        }),

        // ── Refresh work item data ─────────────────────
        vscode.commands.registerCommand('keepr.refreshWorkItems', () => {
            treeProvider.refreshWorkItems();
            vscode.window.showInformationMessage('KeepR: Work item data refreshed.');
        }),
    );

    return disposables;

    function isCompletedState(state: string, scope: 'ticket' | 'pr'): boolean {
        const normalized = state.trim().toLowerCase();
        if (scope === 'pr') {
            return ['completed', 'abandoned', 'closed', 'merged', 'declined'].includes(normalized);
        }

        return ['done', 'closed', 'resolved', 'removed', 'completed', 'abandoned', 'cancelled', 'canceled'].includes(normalized);
    }
}
