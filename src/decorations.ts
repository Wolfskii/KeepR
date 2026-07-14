import * as vscode from 'vscode';
import { Bookmark, BookmarkStatus, statusColor } from './models';
import { BookmarkStore } from './store';

/** One decoration type per status color so each category gets its own highlight */
interface StatusDecoration {
  type: vscode.TextEditorDecorationType;
  color: string;
}

/**
 * Manages per-status colored line highlights and an after-content bookmark badge
 * that users can hover to reveal the bookmark in the KeepR panel.
 */
export class DecorationManager {
  /** status key → decoration type (lazily created) */
  private readonly statusDecorations = new Map<string, StatusDecoration>();
  /** Keys of decorations applied in the last pass (to clear stale ones) */
  private lastAppliedKeys = new Set<string>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly store: BookmarkStore) {
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
          this.disposeDecorations();
          this.updateDecorations();
        }
      }),
    );
  }

  private getOrCreateDecoration(status: string | undefined): StatusDecoration {
    const key = status ?? '__default__';
    let dec = this.statusDecorations.get(key);
    if (dec) { return dec; }

    const color = statusColor(status as BookmarkStatus);

    // Build a subtle background from the status color (low alpha)
    const bgColor = color + '18'; // ~9% opacity
    const borderColor = color + '66'; // ~40% opacity
    const badgeColor = color;

    const type = vscode.window.createTextEditorDecorationType({
      backgroundColor: bgColor,
      isWholeLine: true,
      borderWidth: '0 0 0 3px',
      borderStyle: 'solid',
      borderColor: borderColor,
      overviewRulerColor: color,
      overviewRulerLane: vscode.OverviewRulerLane.Center,
      // After-content bookmark badge — appears at end of line
      after: {
        contentText: ' 🔖',
        color: badgeColor,
        fontStyle: 'normal',
        fontWeight: 'normal',
        margin: '0 0 0 1.5em',
        textDecoration: 'none; position: relative; top: -0.15em; font-size: 0.85em; cursor: pointer;',
      },
    });

    dec = { type, color };
    this.statusDecorations.set(key, dec);
    return dec;
  }

  updateDecorations(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { return; }

    const config = vscode.workspace.getConfiguration('keepr');
    const lineHighlight = config.get<boolean>('lineHighlightEnabled', true);

    const bookmarks = this.store.getBookmarksInFile(editor.document.uri);

    // Clear all previously applied decorations
    for (const key of this.lastAppliedKeys) {
      const dec = this.statusDecorations.get(key);
      if (dec) { editor.setDecorations(dec.type, []); }
    }
    this.lastAppliedKeys.clear();

    if (!lineHighlight || bookmarks.length === 0) {
      return;
    }

    // Group bookmarks by status
    const grouped = new Map<string, Bookmark[]>();
    for (const bm of bookmarks) {
      const key = bm.status ?? '__default__';
      if (!grouped.has(key)) { grouped.set(key, []); }
      grouped.get(key)!.push(bm);
    }

    // Apply a separate decoration type per status group
    for (const [key, bms] of grouped) {
      const dec = this.getOrCreateDecoration(key === '__default__' ? undefined : key);
      this.lastAppliedKeys.add(key);

      const ranges: vscode.DecorationOptions[] = bms.map((bm) => {
        const line = bm.location.line;
        return {
          range: new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER),
          hoverMessage: this.buildHover(bm),
        };
      });

      editor.setDecorations(dec.type, ranges);
    }
  }

  private buildHover(bm: Bookmark): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.supportHtml = true;

    const parts: string[] = ['**🔖 KeepR**'];
    if (bm.label) { parts.push(bm.label); }
    if (bm.ticket) {
      const ticketUrl = this.getTicketUrl(bm.ticket);
      if (ticketUrl) {
        parts.push(`🎫 [#${bm.ticket}](${ticketUrl})`);
      } else {
        parts.push(`🎫 ${bm.ticket}`);
      }
    }
    if (bm.status) { parts.push(`📌 ${bm.status}`); }
    md.appendMarkdown(parts.join(' · '));

    // Command link to reveal in panel
    const cmdUri = vscode.Uri.parse(
      `command:keepr.revealBookmark?${encodeURIComponent(JSON.stringify([bm.id]))}`,
    );
    const resolveUri = vscode.Uri.parse(
      `command:keepr.resolveBookmarkById?${encodeURIComponent(JSON.stringify([bm.id]))}`,
    );
    const removeUri = vscode.Uri.parse(
      `command:keepr.removeBookmarkById?${encodeURIComponent(JSON.stringify([bm.id]))}`,
    );
    md.appendMarkdown(`\n\n[Show in KeepR panel](${cmdUri}) · [Resolve](${resolveUri}) · [Remove](${removeUri})`);

    return md;
  }

  private getTicketUrl(ticket: string): string | undefined {
    const config = vscode.workspace.getConfiguration('keepr.azureDevOps');
    const orgUrl = config.get<string>('orgUrl');
    const project = config.get<string>('project');
    if (!orgUrl || !project || !ticket) { return undefined; }
    const id = ticket.replace(/^#/, '');
    return `${orgUrl.replace(/\/+$/, '')}/${encodeURIComponent(project)}/_workitems/edit/${encodeURIComponent(id)}`;
  }

  private disposeDecorations(): void {
    for (const dec of this.statusDecorations.values()) {
      dec.type.dispose();
    }
    this.statusDecorations.clear();
    this.lastAppliedKeys.clear();
  }

  dispose(): void {
    this.disposeDecorations();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
