import * as vscode from 'vscode';
import { BookmarkStore } from './store';

/**
 * Shows inline actions on bookmarked lines: resolve or remove.
 */
export class BookmarkCodeLensProvider implements vscode.CodeLensProvider {
    private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
    readonly onDidChangeCodeLenses = this.onDidChangeEmitter.event;
    private readonly disposables: vscode.Disposable[] = [];

    constructor(private readonly store: BookmarkStore) {
        this.disposables.push(
            store.onDidChange(() => this.refresh()),
            vscode.workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration('keepr.inlineActionsEnabled')) {
                    this.refresh();
                }
            }),
        );
    }

    provideCodeLenses(document: vscode.TextDocument, _token: vscode.CancellationToken): vscode.CodeLens[] {
        const enabled = vscode.workspace.getConfiguration('keepr').get<boolean>('inlineActionsEnabled', true);
        if (!enabled) { return []; }

        const lenses: vscode.CodeLens[] = [];
        const bookmarks = this.store.getBookmarksInFile(document.uri);

        for (const bm of bookmarks) {
            const line = bm.location.line;
            const range = new vscode.Range(line, 0, line, 0);

            lenses.push(
                new vscode.CodeLens(range, {
                    title: '$(check) Resolve',
                    tooltip: 'Mark bookmark as resolved',
                    command: 'keepr.resolveBookmarkById',
                    arguments: [bm.id],
                }),
                new vscode.CodeLens(range, {
                    title: '$(trash) Remove',
                    tooltip: 'Remove bookmark',
                    command: 'keepr.removeBookmarkById',
                    arguments: [bm.id],
                }),
            );
        }

        return lenses;
    }

    refresh(): void {
        this.onDidChangeEmitter.fire();
    }

    dispose(): void {
        this.onDidChangeEmitter.dispose();
        for (const d of this.disposables) {
            d.dispose();
        }
    }
}
