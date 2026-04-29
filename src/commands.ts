import * as vscode from 'vscode';
import { BookmarkStatus } from './models';
import { BookmarkStore } from './store';
import { BookmarkTreeProvider } from './treeProvider';
import { DecorationManager } from './decorations';
import { AzureDevOpsService } from './azureDevOps';
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
    azdo: AzureDevOpsService,
): vscode.Disposable[] {
    const disposables: vscode.Disposable[] = [];

    function getStatusLabels(): string[] {
        const config = vscode.workspace.getConfiguration('keepr');
        return config.get<string[]>('statusLabels', [
            'To Fix', 'Bug', 'Performance', 'Bad Practice', 'To Implement', 'Review', 'Note',
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
            const ticket = await pickTicket(azdo);
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
        vscode.commands.registerCommand('keepr.removeBookmark', async (node?: { bookmark?: { id: string } }) => {
            if (node?.bookmark) {
                await store.removeBookmark(node.bookmark.id);
            } else {
                // From editor context
                const editor = vscode.window.activeTextEditor;
                if (!editor) { return; }
                const existing = store.findBookmarkAtLine(editor.document.uri, editor.selection.active.line);
                if (existing) {
                    await store.removeBookmark(existing.bookmark.id);
                }
            }
            decorations.updateDecorations();
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
                    const ticket = await pickTicket(azdo, bookmark.ticket);
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
        }),
    );

    // ── Set Azure DevOps PAT (secure storage) ────────────

    disposables.push(
        vscode.commands.registerCommand('keepr.setAzureDevOpsPat', async () => {
            const pat = await vscode.window.showInputBox({
                prompt: 'Enter your Azure DevOps Personal Access Token',
                placeHolder: 'Paste PAT here…',
                password: true,
            });
            if (pat === undefined) { return; }
            if (pat) {
                await azdo.storePat(pat);
                vscode.window.showInformationMessage('KeepR: Azure DevOps PAT saved securely.');
            } else {
                await azdo.storePat('');
                vscode.window.showInformationMessage('KeepR: Azure DevOps PAT cleared.');
            }
        }),
    );

    return disposables;
}
