import * as vscode from 'vscode';
import { BookmarkStore } from './store';
import { statusIcon } from './models';

/**
 * Manages gutter icons and line highlight decorations for bookmarked lines.
 */
export class DecorationManager {
  private readonly decorationTypes = new Map<string, vscode.TextEditorDecorationType>();
  private readonly defaultDecoration: vscode.TextEditorDecorationType;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly store: BookmarkStore) {
    this.defaultDecoration = vscode.window.createTextEditorDecorationType({
      gutterIconPath: undefined, // will use overview ruler instead
      gutterIconSize: 'contain',
      overviewRulerColor: new vscode.ThemeColor('keepr.bookmarkBorder'),
      overviewRulerLane: vscode.OverviewRulerLane.Center,
      backgroundColor: new vscode.ThemeColor('keepr.bookmarkBackground'),
      isWholeLine: true,
      borderWidth: '0 0 0 3px',
      borderStyle: 'solid',
      borderColor: new vscode.ThemeColor('keepr.bookmarkBorder'),
    });

    // Refresh decorations when the active editor changes
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.updateDecorations()),
    );

    // Refresh when store changes
    this.disposables.push(
      store.onDidChange(() => this.updateDecorations()),
    );

    // Refresh on configuration change
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('keepr')) {
          this.updateDecorations();
        }
      }),
    );
  }

  updateDecorations(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { return; }

    const config = vscode.workspace.getConfiguration('keepr');
    const lineHighlight = config.get<boolean>('lineHighlightEnabled', true);

    const bookmarks = this.store.getBookmarksInFile(editor.document.uri);

    if (!lineHighlight || bookmarks.length === 0) {
      editor.setDecorations(this.defaultDecoration, []);
      return;
    }

    const ranges: vscode.DecorationOptions[] = bookmarks.map((bm) => {
      const line = bm.location.line;
      return {
        range: new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER),
        hoverMessage: this.buildHover(bm),
      };
    });

    editor.setDecorations(this.defaultDecoration, ranges);
  }

  private buildHover(bm: { label?: string; ticket?: string; status?: string }): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    const parts: string[] = ['**KeepR**'];
    if (bm.label) { parts.push(bm.label); }
    if (bm.ticket) { parts.push(`🎫 ${bm.ticket}`); }
    if (bm.status) { parts.push(`📌 ${bm.status}`); }
    md.appendMarkdown(parts.join(' · '));
    return md;
  }

  dispose(): void {
    this.defaultDecoration.dispose();
    for (const dt of this.decorationTypes.values()) {
      dt.dispose();
    }
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
