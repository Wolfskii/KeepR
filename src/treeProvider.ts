import * as vscode from 'vscode';
import * as path from 'path';
import { Bookmark, BookmarkStatus, RepoBookmarks, statusIcon } from './models';
import { BookmarkStore } from './store';

type GroupBy = 'repo' | 'file' | 'status' | 'ticket';

/** Union of all node types in the tree */
type TreeNode = RepoNode | FileNode | GroupNode | BookmarkNode;

class RepoNode {
  readonly type = 'repo' as const;
  constructor(
    public readonly repo: RepoBookmarks,
    public collapsed: boolean,
  ) {}
}

class FileNode {
  readonly type = 'file' as const;
  constructor(
    public readonly repo: RepoBookmarks,
    public readonly filePath: string,
    public readonly bookmarks: Bookmark[],
  ) {}
}

class GroupNode {
  readonly type = 'group' as const;
  constructor(
    public readonly label: string,
    public readonly repo: RepoBookmarks,
    public readonly bookmarks: Bookmark[],
    public readonly icon?: vscode.ThemeIcon,
  ) {}
}

class BookmarkNode {
  readonly type = 'bookmark' as const;
  constructor(
    public readonly repo: RepoBookmarks,
    public readonly bookmark: Bookmark,
  ) {}
}

export class BookmarkTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private groupBy: GroupBy;
  private statusFilter: BookmarkStatus | undefined;
  private ticketFilter: string | undefined;
  /** Per-repo collapse state (repoName → collapsed) */
  private collapsedRepos = new Map<string, boolean>();

  constructor(private readonly store: BookmarkStore) {
    const config = vscode.workspace.getConfiguration('keepr');
    this.groupBy = config.get<GroupBy>('defaultGroupBy', 'repo');
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  setGroupBy(groupBy: GroupBy): void {
    this.groupBy = groupBy;
    this.refresh();
  }

  setStatusFilter(status: BookmarkStatus | undefined): void {
    this.statusFilter = status;
    this.ticketFilter = undefined;
    this.refresh();
  }

  setTicketFilter(ticket: string | undefined): void {
    this.ticketFilter = ticket;
    this.statusFilter = undefined;
    this.refresh();
  }

  clearFilter(): void {
    this.statusFilter = undefined;
    this.ticketFilter = undefined;
    this.refresh();
  }

  toggleRepoCollapse(repoName: string): void {
    const current = this.collapsedRepos.get(repoName) ?? false;
    this.collapsedRepos.set(repoName, !current);
    this.refresh();
  }

  collapseAll(): void {
    for (const repo of this.store.getState().repos) {
      this.collapsedRepos.set(repo.repoName, true);
    }
    this.refresh();
  }

  expandAll(): void {
    this.collapsedRepos.clear();
    this.refresh();
  }

  // ── TreeDataProvider implementation ──────────────────

  getTreeItem(element: TreeNode): vscode.TreeItem {
    switch (element.type) {
      case 'repo':
        return this.repoTreeItem(element);
      case 'file':
        return this.fileTreeItem(element);
      case 'group':
        return this.groupTreeItem(element);
      case 'bookmark':
        return this.bookmarkTreeItem(element);
    }
  }

  getChildren(element?: TreeNode): TreeNode[] {
    if (!element) {
      return this.getRoots();
    }

    switch (element.type) {
      case 'repo':
        return this.getRepoChildren(element);
      case 'file':
        return element.bookmarks.map((b) => new BookmarkNode(element.repo, b));
      case 'group':
        return element.bookmarks.map((b) => new BookmarkNode(element.repo, b));
      case 'bookmark':
        return [];
    }
  }

  // ── Root nodes ───────────────────────────────────────

  private getRoots(): TreeNode[] {
    const state = this.store.getState();
    if (state.repos.length === 1 && this.groupBy === 'repo') {
      // Single repo: skip the repo level
      return this.getRepoChildren(new RepoNode(state.repos[0], false));
    }
    return state.repos.map(
      (r) => new RepoNode(r, this.collapsedRepos.get(r.repoName) ?? false),
    );
  }

  private getRepoChildren(node: RepoNode): TreeNode[] {
    const bookmarks = this.applyFilters(node.repo.bookmarks);

    switch (this.groupBy) {
      case 'repo':
      case 'file':
        return this.groupByFile(node.repo, bookmarks);
      case 'status':
        return this.groupByStatus(node.repo, bookmarks);
      case 'ticket':
        return this.groupByTicket(node.repo, bookmarks);
    }
  }

  // ── Grouping helpers ─────────────────────────────────

  private groupByFile(repo: RepoBookmarks, bookmarks: Bookmark[]): TreeNode[] {
    const map = new Map<string, Bookmark[]>();
    for (const bm of bookmarks) {
      const key = bm.location.filePath;
      if (!map.has(key)) { map.set(key, []); }
      map.get(key)!.push(bm);
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([fp, bms]) => new FileNode(repo, fp, bms));
  }

  private groupByStatus(repo: RepoBookmarks, bookmarks: Bookmark[]): TreeNode[] {
    const map = new Map<string, Bookmark[]>();
    for (const bm of bookmarks) {
      const key = bm.status ?? '(no status)';
      if (!map.has(key)) { map.set(key, []); }
      map.get(key)!.push(bm);
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([s, bms]) => new GroupNode(s, repo, bms, statusIcon(s)));
  }

  private groupByTicket(repo: RepoBookmarks, bookmarks: Bookmark[]): TreeNode[] {
    const map = new Map<string, Bookmark[]>();
    for (const bm of bookmarks) {
      const key = bm.ticket || '(no ticket)';
      if (!map.has(key)) { map.set(key, []); }
      map.get(key)!.push(bm);
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([t, bms]) => new GroupNode(t, repo, bms, new vscode.ThemeIcon('issues')));
  }

  // ── Filter ───────────────────────────────────────────

  private applyFilters(bookmarks: Bookmark[]): Bookmark[] {
    let result = bookmarks;
    if (this.statusFilter) {
      result = result.filter((b) => b.status === this.statusFilter);
    }
    if (this.ticketFilter) {
      const q = this.ticketFilter.toLowerCase();
      result = result.filter((b) => b.ticket?.toLowerCase().includes(q));
    }
    return result;
  }

  // ── TreeItem builders ────────────────────────────────

  private repoTreeItem(node: RepoNode): vscode.TreeItem {
    const count = this.applyFilters(node.repo.bookmarks).length;
    const item = new vscode.TreeItem(
      `${node.repo.repoName} (${count})`,
      node.collapsed
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.Expanded,
    );
    item.iconPath = new vscode.ThemeIcon('repo');
    item.contextValue = 'repo';
    return item;
  }

  private fileTreeItem(node: FileNode): vscode.TreeItem {
    const fileName = path.basename(node.filePath);
    const dir = path.dirname(node.filePath);
    const item = new vscode.TreeItem(
      `${fileName} (${node.bookmarks.length})`,
      vscode.TreeItemCollapsibleState.Expanded,
    );
    item.description = dir !== '.' ? dir : undefined;
    item.iconPath = vscode.ThemeIcon.File;
    item.contextValue = 'file';
    item.resourceUri = this.store.resolveUri(node.repo, node.bookmarks[0]);
    return item;
  }

  private groupTreeItem(node: GroupNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      `${node.label} (${node.bookmarks.length})`,
      vscode.TreeItemCollapsibleState.Expanded,
    );
    item.iconPath = node.icon;
    item.contextValue = 'group';
    return item;
  }

  private bookmarkTreeItem(node: BookmarkNode): vscode.TreeItem {
    const bm = node.bookmark;
    const lineNum = bm.location.line + 1;
    const label = bm.label || bm.location.lineText?.trim() || `Line ${lineNum}`;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);

    // Description: line number + ticket + status
    const parts: string[] = [`L${lineNum}`];
    if (bm.ticket) { parts.push(`#${bm.ticket}`); }
    if (bm.status) { parts.push(bm.status); }
    item.description = parts.join(' · ');

    item.iconPath = statusIcon(bm.status);
    item.contextValue = 'bookmark';
    item.tooltip = this.buildTooltip(bm);

    // Click → navigate to bookmark
    const fileUri = this.store.resolveUri(node.repo, bm);
    item.command = {
      command: 'vscode.open',
      title: 'Go to Bookmark',
      arguments: [
        fileUri,
        {
          selection: new vscode.Range(
            bm.location.line,
            bm.location.startColumn ?? 0,
            bm.location.line,
            bm.location.endColumn ?? 0,
          ),
        } as vscode.TextDocumentShowOptions,
      ],
    };

    return item;
  }

  private buildTooltip(bm: Bookmark): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    if (bm.label) { md.appendMarkdown(`**${bm.label}**\n\n`); }
    if (bm.ticket) { md.appendMarkdown(`🎫 Ticket: \`${bm.ticket}\`\n\n`); }
    if (bm.status) { md.appendMarkdown(`📌 Status: ${bm.status}\n\n`); }
    md.appendMarkdown(`📄 ${bm.location.filePath}:${bm.location.line + 1}\n\n`);
    if (bm.location.lineText) {
      md.appendCodeblock(bm.location.lineText.trim(), '');
    }
    return md;
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}
