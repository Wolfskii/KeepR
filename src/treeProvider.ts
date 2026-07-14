import * as vscode from 'vscode';
import * as path from 'path';
import { Bookmark, BookmarkStatus, RepoBookmarks, statusIcon } from './models';
import { BookmarkStore } from './store';
import { ProviderManager, TicketDetails } from './providers';
import { AggregatedMyPullRequest, AggregatedMyTicket } from './providers/providerManager';

type GroupBy = 'repo' | 'file' | 'status' | 'ticket';
type MyItemsSort = 'updated' | 'created' | 'title' | 'provider';

/** Union of all node types in the tree */
type TreeNode = RepoNode | FileNode | GroupNode | BookmarkNode | MyTicketsSectionNode | MyPrsSectionNode | MyTicketNode | MyPrNode;

class RepoNode {
  readonly type = 'repo' as const;
  constructor(
    public readonly repo: RepoBookmarks,
    public collapsed: boolean,
  ) { }
}

class FileNode {
  readonly type = 'file' as const;
  constructor(
    public readonly repo: RepoBookmarks,
    public readonly filePath: string,
    public readonly bookmarks: Bookmark[],
  ) { }
}

class GroupNode {
  readonly type = 'group' as const;
  constructor(
    public readonly label: string,
    public readonly repo: RepoBookmarks,
    public readonly bookmarks: Bookmark[],
    public readonly icon?: vscode.ThemeIcon,
  ) { }
}

class BookmarkNode {
  readonly type = 'bookmark' as const;
  constructor(
    public readonly repo: RepoBookmarks,
    public readonly bookmark: Bookmark,
  ) { }
}

class MyTicketsSectionNode {
  readonly type = 'myTicketsSection' as const;
}

class MyPrsSectionNode {
  readonly type = 'myPrsSection' as const;
}

class MyTicketNode {
  readonly type = 'myTicket' as const;
  constructor(public readonly item: AggregatedMyTicket) { }
}

class MyPrNode {
  readonly type = 'myPr' as const;
  constructor(public readonly item: AggregatedMyPullRequest) { }
}

export class BookmarkTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private groupBy: GroupBy;
  private statusFilter: BookmarkStatus | undefined;
  private ticketFilter: string | undefined;
  /** Per-repo collapse state (repoName → collapsed) */
  private collapsedRepos = new Map<string, boolean>();
  /** Cached ticket details for enriching tree items */
  private workItemCache = new Map<string, TicketDetails | null>();
  private pendingFetches = new Set<string>();
  private myTicketsCache: AggregatedMyTicket[] | undefined;
  private myPrsCache: AggregatedMyPullRequest[] | undefined;
  private loadingMyItems = false;

  constructor(
    private readonly store: BookmarkStore,
    private readonly providers?: ProviderManager,
  ) {
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
      case 'myTicketsSection':
        return this.myTicketsSectionTreeItem();
      case 'myPrsSection':
        return this.myPrsSectionTreeItem();
      case 'myTicket':
        return this.myTicketTreeItem(element);
      case 'myPr':
        return this.myPrTreeItem(element);
    }
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
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
      case 'myTicketsSection':
        await this.ensureMyItemsLoaded();
        return this.getFilteredSortedMyTickets().map((item) => new MyTicketNode(item));
      case 'myPrsSection':
        await this.ensureMyItemsLoaded();
        return this.getFilteredSortedMyPrs().map((item) => new MyPrNode(item));
      case 'myTicket':
      case 'myPr':
        return [];
    }
  }

  // ── Root nodes ───────────────────────────────────────

  private getRoots(): TreeNode[] {
    const state = this.store.getState();
    const roots: TreeNode[] = [];

    if (state.repos.length === 1 && this.groupBy === 'repo') {
      // Single repo: skip the repo level
      roots.push(...this.getRepoChildren(new RepoNode(state.repos[0], false)));
    } else {
      roots.push(...state.repos.map(
        (r) => new RepoNode(r, this.collapsedRepos.get(r.repoName) ?? false),
      ));
    }

    if (this.isMyItemsEnabled()) {
      roots.push(new MyTicketsSectionNode(), new MyPrsSectionNode());
    }

    return roots;
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
    const displayName = this.store.getDisplayName(node.repo);
    const item = new vscode.TreeItem(
      `${displayName} (${count})`,
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

  private myTicketsSectionTreeItem(): vscode.TreeItem {
    const count = this.getFilteredSortedMyTickets().length;
    const item = new vscode.TreeItem(
      this.loadingMyItems ? 'My Tickets/PBIs/Features (loading...)' : `My Tickets/PBIs/Features (${count})`,
      vscode.TreeItemCollapsibleState.Collapsed,
    );
    item.iconPath = new vscode.ThemeIcon('issues');
    item.contextValue = 'myTicketsSection';
    return item;
  }

  private myPrsSectionTreeItem(): vscode.TreeItem {
    const count = this.getFilteredSortedMyPrs().length;
    const item = new vscode.TreeItem(
      this.loadingMyItems ? 'My Pull Requests (loading...)' : `My Pull Requests (${count})`,
      vscode.TreeItemCollapsibleState.Collapsed,
    );
    item.iconPath = new vscode.ThemeIcon('git-pull-request');
    item.contextValue = 'myPrsSection';
    return item;
  }

  private myTicketTreeItem(node: MyTicketNode): vscode.TreeItem {
    const it = node.item;
    const item = new vscode.TreeItem(`#${it.item.id} — ${it.item.title}`, vscode.TreeItemCollapsibleState.None);
    const descParts = [it.providerLabel, it.item.type, it.item.state];
    if (it.item.relation) { descParts.push(it.item.relation); }
    item.description = descParts.filter(Boolean).join(' · ');
    item.iconPath = new vscode.ThemeIcon('issue-opened');
    item.contextValue = 'myTicket';

    if (it.item.url) {
      item.command = {
        command: 'vscode.open',
        title: 'Open Ticket',
        arguments: [vscode.Uri.parse(it.item.url)],
      };
    }

    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**#${it.item.id} — ${it.item.title}**\n\n`);
    md.appendMarkdown(`Provider: ${it.providerLabel}\n\n`);
    md.appendMarkdown(`Type/State: ${it.item.type} · ${it.item.state}\n\n`);
    if (it.item.relation) { md.appendMarkdown(`Relation: ${it.item.relation}\n\n`); }
    if (it.item.updatedAt) { md.appendMarkdown(`Updated: ${it.item.updatedAt}\n\n`); }
    item.tooltip = md;
    return item;
  }

  private myPrTreeItem(node: MyPrNode): vscode.TreeItem {
    const pr = node.item;
    const idLabel = pr.item.id ? `#${pr.item.id}` : 'PR';
    const item = new vscode.TreeItem(`${idLabel} — ${pr.item.title}`, vscode.TreeItemCollapsibleState.None);
    const descParts = [pr.providerLabel, pr.item.status];
    if (pr.item.relation) { descParts.push(pr.item.relation); }
    item.description = descParts.filter(Boolean).join(' · ');
    item.iconPath = new vscode.ThemeIcon('git-pull-request');
    item.contextValue = 'myPullRequest';
    if (pr.item.url) {
      item.command = {
        command: 'vscode.open',
        title: 'Open Pull Request',
        arguments: [vscode.Uri.parse(pr.item.url)],
      };
    }

    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${idLabel} — ${pr.item.title}**\n\n`);
    md.appendMarkdown(`Provider: ${pr.providerLabel}\n\n`);
    md.appendMarkdown(`Status: ${pr.item.status}\n\n`);
    if (pr.item.relation) { md.appendMarkdown(`Relation: ${pr.item.relation}\n\n`); }
    if (pr.item.sourceBranch || pr.item.targetBranch) {
      md.appendMarkdown(`Branches: ${pr.item.sourceBranch ?? '?'} -> ${pr.item.targetBranch ?? '?'}\n\n`);
    }
    item.tooltip = md;
    return item;
  }

  private bookmarkTreeItem(node: BookmarkNode): vscode.TreeItem {
    const bm = node.bookmark;
    const lineNum = bm.location.line + 1;
    const label = bm.label || bm.location.lineText?.trim() || `Line ${lineNum}`;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);

    // Description: line number + ticket + work item state + status
    const parts: string[] = [`L${lineNum}`];
    if (bm.ticket) {
      const wi = this.getCachedWorkItem(bm.ticket);
      if (wi) {
        parts.push(`#${bm.ticket} [${wi.state}]`);
      } else {
        parts.push(`#${bm.ticket}`);
      }
    }
    if (bm.status) { parts.push(bm.status); }
    item.description = parts.join(' · ');

    item.iconPath = statusIcon(bm.status);
    item.contextValue = bm.ticket ? 'bookmarkWithTicket' : 'bookmark';
    item.tooltip = this.buildTooltip(bm);

    // Trigger async fetch for work item details (updates on next refresh)
    if (bm.ticket) { this.fetchWorkItemAsync(bm.ticket); }

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
    if (bm.ticket) {
      const ticketUrl = this.getTicketUrl(bm.ticket);
      const wi = this.getCachedWorkItem(bm.ticket);
      if (ticketUrl) {
        md.appendMarkdown(`🎫 Ticket: [#${bm.ticket}](${ticketUrl})`);
      } else {
        md.appendMarkdown(`🎫 Ticket: \`${bm.ticket}\``);
      }
      if (wi) {
        md.appendMarkdown(` — **${wi.state}**`);
        if (wi.boardColumn && wi.boardColumn !== wi.state) {
          md.appendMarkdown(` (${wi.boardColumn})`);
        }
        if (wi.type) { md.appendMarkdown(` · ${wi.type}`); }
        if (wi.assignedTo) { md.appendMarkdown(` · ${wi.assignedTo}`); }
      }
      md.appendMarkdown('\n\n');

      // Show linked branches
      if (wi && wi.branches.length > 0) {
        md.appendMarkdown(`🌿 **Branches:**\n\n`);
        for (const branch of wi.branches) {
          md.appendMarkdown(`- \`${branch}\`\n`);
        }
        md.appendMarkdown('\n');
      }

      // Show linked PRs
      if (wi && wi.pullRequests.length > 0) {
        md.appendMarkdown(`🔀 **Pull Requests:**\n\n`);
        for (const pr of wi.pullRequests) {
          const statusBadge = pr.status === 'completed' ? '✅' : pr.status === 'active' ? '🟢' : '⚪';
          md.appendMarkdown(`- ${statusBadge} [${pr.title}](${pr.url}) (${pr.status})\n`);
        }
        md.appendMarkdown('\n');
      }
    }
    if (bm.status) { md.appendMarkdown(`📌 Status: ${bm.status}\n\n`); }
    md.appendMarkdown(`📄 ${bm.location.filePath}:${bm.location.line + 1}\n\n`);
    if (bm.location.lineText) {
      md.appendCodeblock(bm.location.lineText.trim(), '');
    }
    return md;
  }

  private getTicketUrl(ticket: string): string | undefined {
    return this.providers?.getTicketUrl(ticket);
  }

  // ── Async work item fetching ─────────────────────────

  private getCachedWorkItem(ticket: string): TicketDetails | undefined {
    const cached = this.workItemCache.get(ticket);
    return cached ?? undefined;
  }

  private fetchWorkItemAsync(ticket: string): void {
    if (!this.providers?.isConfigured()) { return; }
    if (this.workItemCache.has(ticket) || this.pendingFetches.has(ticket)) { return; }

    this.pendingFetches.add(ticket);
    this.providers.getTicketDetails(ticket).then((details) => {
      this.pendingFetches.delete(ticket);
      this.workItemCache.set(ticket, details ?? null);
      if (details) {
        // Refresh tree to show the newly fetched data
        this._onDidChangeTreeData.fire(undefined);
      }
    }).catch(() => {
      this.pendingFetches.delete(ticket);
    });
  }

  /** Force re-fetch all work item data */
  refreshWorkItems(): void {
    this.workItemCache.clear();
    this.providers?.clearCache();
    this.myTicketsCache = undefined;
    this.myPrsCache = undefined;
    this.refresh();
  }

  refreshMyItems(): void {
    this.myTicketsCache = undefined;
    this.myPrsCache = undefined;
    this.refresh();
  }

  private isMyItemsEnabled(): boolean {
    return vscode.workspace.getConfiguration('keepr').get<boolean>('myItems.enabled', true);
  }

  private async ensureMyItemsLoaded(): Promise<void> {
    if (this.loadingMyItems) { return; }
    if (this.myTicketsCache && this.myPrsCache) { return; }
    if (!this.providers) {
      this.myTicketsCache = [];
      this.myPrsCache = [];
      return;
    }

    this.loadingMyItems = true;
    try {
      const [tickets, prs] = await Promise.all([
        this.providers.getMyTicketsAcrossProviders(),
        this.providers.getMyPullRequestsAcrossProviders(),
      ]);
      this.myTicketsCache = tickets;
      this.myPrsCache = prs;
    } finally {
      this.loadingMyItems = false;
      this._onDidChangeTreeData.fire(undefined);
    }
  }

  private getFilteredSortedMyTickets(): AggregatedMyTicket[] {
    const all = [...(this.myTicketsCache ?? [])];
    const config = vscode.workspace.getConfiguration('keepr');
    const filter = config.get<string>('myItems.ticketFilter', 'all');
    const sortBy = config.get<MyItemsSort>('myItems.sortBy', 'updated');

    const filtered = filter === 'all' ? all : all.filter((t) => (t.item.relation ?? '').toLowerCase().includes(filter.toLowerCase()));
    return filtered.sort((a, b) => this.compareMyItems(a.item.title, b.item.title, a.providerLabel, b.providerLabel, a.item.updatedAt, b.item.updatedAt, a.item.createdAt, b.item.createdAt, sortBy));
  }

  private getFilteredSortedMyPrs(): AggregatedMyPullRequest[] {
    const all = [...(this.myPrsCache ?? [])];
    const config = vscode.workspace.getConfiguration('keepr');
    const filter = config.get<string>('myItems.prFilter', 'all');
    const sortBy = config.get<MyItemsSort>('myItems.sortBy', 'updated');

    const filtered = filter === 'all' ? all : all.filter((p) => (p.item.relation ?? '').toLowerCase().includes(filter.toLowerCase()));
    return filtered.sort((a, b) => this.compareMyItems(a.item.title, b.item.title, a.providerLabel, b.providerLabel, a.item.updatedAt, b.item.updatedAt, a.item.createdAt, b.item.createdAt, sortBy));
  }

  private compareMyItems(
    titleA: string,
    titleB: string,
    providerA: string,
    providerB: string,
    updatedA: string | undefined,
    updatedB: string | undefined,
    createdA: string | undefined,
    createdB: string | undefined,
    sortBy: MyItemsSort,
  ): number {
    switch (sortBy) {
      case 'title':
        return titleA.localeCompare(titleB);
      case 'provider':
        return providerA.localeCompare(providerB);
      case 'created':
        return (Date.parse(createdB ?? '') || 0) - (Date.parse(createdA ?? '') || 0);
      case 'updated':
      default:
        return (Date.parse(updatedB ?? '') || 0) - (Date.parse(updatedA ?? '') || 0);
    }
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}
