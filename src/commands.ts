import * as vscode from 'vscode';
import { BookmarkStatus } from './models';
import { BookmarkStore } from './store';
import { BookmarkTreeProvider } from './treeProvider';
import { DecorationManager } from './decorations';

/**
 * Registers all KeepR commands and returns disposables.
 */
export function registerCommands(
    context: vscode.ExtensionContext,
    store: BookmarkStore,
    treeProvider: BookmarkTreeProvider,
    decorations: DecorationManager,
): vscode.Disposable[] {
    const disposables: vscode.Disposable[] = [];

    function getStatusLabels(): string[] {
        const config = vscode.workspace.getConfiguration('keepr');
        return config.get<string[]>('statusLabels', [
            'To Fix', 'Bug', 'Performance', 'Bad Practice', 'To Implement', 'Review', 'Note',
        ]);
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
            const ticket = await vscode.window.showInputBox({
                prompt: 'Ticket / PBI number (optional)',
                placeHolder: 'e.g. "419046" or "FEAT-123"',
            });
            if (ticket === undefined) { return; }

            // Status
            const statuses = getStatusLabels();
            const statusPick = await vscode.window.showQuickPick(
                ['(none)', ...statuses],
                { placeHolder: 'Select status' },
            );
            if (statusPick === undefined) { return; }
            const status = statusPick === '(none)' ? undefined : statusPick as BookmarkStatus;

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
                    const ticket = await vscode.window.showInputBox({
                        prompt: 'Ticket / PBI number',
                        value: bookmark.ticket ?? '',
                    });
                    if (ticket === undefined) { return; }
                    await store.updateBookmark(bookmarkId, { ticket: ticket || undefined });
                    break;
                }
                case 'Status': {
                    const statuses = getStatusLabels();
                    const pick = await vscode.window.showQuickPick(
                        ['(none)', ...statuses],
                        { placeHolder: 'Select status' },
                    );
                    if (pick === undefined) { return; }
                    const status = pick === '(none)' ? undefined : pick as BookmarkStatus;
                    await store.updateBookmark(bookmarkId, { status });
                    break;
                }
            }
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
            const statuses = getStatusLabels();
            const pick = await vscode.window.showQuickPick(statuses, {
                placeHolder: 'Filter bookmarks by status',
            });
            if (pick) {
                treeProvider.setStatusFilter(pick as BookmarkStatus);
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

    return disposables;
}
