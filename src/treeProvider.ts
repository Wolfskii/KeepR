import * as vscode from 'vscode';
import * as path from 'path';
import { Bookmark, BookmarkStatus, RepoBookmarks, statusIcon } from './models';
import { BookmarkStore } from './store';
import { ProviderManager, TicketDetails } from './providers';
import { AggregatedMyPullRequest, AggregatedMyTicket } from './providers/providerManager';

type GroupBy = 'repo' | 'file' | 'status' | 'ticket';
type MyItemsSort = 'updated' | 'created' | 'title' | 'provider' | 'type' | 'status';
export type TreeMode = 'bookmarks' | 'tickets' | 'prs';

/** Union of all node types in the tree */
type TreeNode = RepoNode | FileNode | GroupNode | BookmarkNode | MyTicketsSectionNode | MyPrsSectionNode | MyTicketNode | MyPrNode | MyItemDetailNode | MyItemDetailExpandableNode;

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

class MyItemDetailNode {
  readonly type = 'myItemDetail' as const;
  constructor(
    public readonly label: string,
    public readonly description?: string,
    public readonly icon?: vscode.ThemeIcon,
    public readonly command?: vscode.Command,
    public readonly contextValue: string = 'myItemDetail',
  ) { }
}

class MyItemDetailExpandableNode {
  readonly type = 'myItemDetailExpandable' as const;
  constructor(
    public readonly id: string,
    public readonly label: string,
    public readonly fullText: string,
    public readonly isExpanded: boolean,
    public readonly icon?: vscode.ThemeIcon,
  ) { }
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
  private refreshingMyItems = false;
  private myItemsFetchedAt = 0;
  private expandedMyTickets = new Set<string>();
  private expandedMyPrs = new Set<string>();
  private expandedDescriptions = new Set<string>();

  private myTicketDetailsCache = new Map<string, { data: TicketDetails; fetchedAt: number }>();
  private myPrDetailsCache = new Map<string, { data: any; fetchedAt: number }>();
  private myTicketDetailsFetching = new Set<string>();
  private myPrDetailsFetching = new Set<string>();

  private static DETAIL_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
  private static MY_ITEMS_CACHE_TTL = 2 * 60 * 1000; // 2 minutes

  constructor(
    private readonly store: BookmarkStore,
    private readonly providers?: ProviderManager,
    private readonly mode: TreeMode = 'bookmarks',
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
      case 'myItemDetail':
        return this.myItemDetailTreeItem(element);
      case 'myItemDetailExpandable':
        return this.myItemDetailExpandableTreeItem(element);
    }
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    if (!element) {
      if (this.mode === 'tickets') {
        await this.ensureMyItemsLoaded();
        return this.getFilteredSortedMyTickets().map((item) => new MyTicketNode(item));
      }
      if (this.mode === 'prs') {
        await this.ensureMyItemsLoaded();
        return this.getFilteredSortedMyPrs().map((item) => new MyPrNode(item));
      }
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
        return this.expandedMyTickets.has(this.myTicketKey(element.item))
          ? this.buildMyTicketChildren(element.item)
          : [];
      case 'myPr':
        return this.expandedMyPrs.has(this.myPrKey(element.item))
          ? this.buildMyPrChildren(element.item)
          : [];
      case 'myItemDetail':
      case 'myItemDetailExpandable':
        return [];
    }
  }

  getParent(element: TreeNode): TreeNode | undefined {
    switch (element.type) {
      case 'repo':
        return undefined;
      case 'file':
        if (this.mode !== 'bookmarks') { return undefined; }
        return this.isSingleRepoRootMode()
          ? undefined
          : new RepoNode(element.repo, this.collapsedRepos.get(element.repo.repoName) ?? false);
      case 'group':
        if (this.mode !== 'bookmarks') { return undefined; }
        return this.isSingleRepoRootMode()
          ? undefined
          : new RepoNode(element.repo, this.collapsedRepos.get(element.repo.repoName) ?? false);
      case 'bookmark': {
        if (this.mode !== 'bookmarks') { return undefined; }
        const repo = element.repo;
        const bm = element.bookmark;
        const visible = this.applyFilters(repo.bookmarks);

        switch (this.groupBy) {
          case 'repo':
          case 'file': {
            const fileBookmarks = visible.filter((item) => item.location.filePath === bm.location.filePath);
            return new FileNode(repo, bm.location.filePath, fileBookmarks);
          }
          case 'status': {
            const label = bm.status ?? '(no status)';
            const grouped = visible.filter((item) => (item.status ?? '(no status)') === label);
            return new GroupNode(label, repo, grouped, statusIcon(label));
          }
          case 'ticket': {
            const label = bm.ticket || '(no ticket)';
            const grouped = visible.filter((item) => (item.ticket || '(no ticket)') === label);
            return new GroupNode(label, repo, grouped, new vscode.ThemeIcon('issues'));
          }
        }
      }
      case 'myTicketsSection':
      case 'myPrsSection':
      case 'myTicket':
      case 'myPr':
        return undefined;
      case 'myItemDetail':
        return undefined;
    }
  }

  public getBookmarkNodeById(bookmarkId: string): object | undefined {
    const found = this.store.findBookmarkById(bookmarkId);
    if (!found) { return undefined; }

    const visible = this.applyFilters(found.repo.bookmarks);
    const inView = visible.some((bookmark) => bookmark.id === found.bookmark.id);
    if (!inView) { return undefined; }

    return new BookmarkNode(found.repo, found.bookmark);
  }

  private isSingleRepoRootMode(): boolean {
    return this.store.getState().repos.length === 1 && this.groupBy === 'repo';
  }

  // ── Root nodes ───────────────────────────────────────

  private getRoots(): TreeNode[] {
    if (this.mode !== 'bookmarks') {
      return [];
    }

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
      this.loadingMyItems
        ? 'My Tickets/PBIs/Features (loading...)'
        : this.refreshingMyItems
          ? `My Tickets/PBIs/Features (${count}, updating...)`
          : `My Tickets/PBIs/Features (${count})`,
      vscode.TreeItemCollapsibleState.Collapsed,
    );
    item.iconPath = new vscode.ThemeIcon('issues');
    item.contextValue = 'myTicketsSection';
    return item;
  }

  private myPrsSectionTreeItem(): vscode.TreeItem {
    const count = this.getFilteredSortedMyPrs().length;
    const item = new vscode.TreeItem(
      this.loadingMyItems
        ? 'My Pull Requests (loading...)'
        : this.refreshingMyItems
          ? `My Pull Requests (${count}, updating...)`
          : `My Pull Requests (${count})`,
      vscode.TreeItemCollapsibleState.Collapsed,
    );
    item.iconPath = new vscode.ThemeIcon('git-pull-request');
    item.contextValue = 'myPrsSection';
    return item;
  }

  private myTicketTreeItem(node: MyTicketNode): vscode.TreeItem {
    const it = node.item;
    const glyph = this.myTicketTypeGlyph(it.item.type);
    const key = this.myTicketKey(it);
    const isExpanded = this.expandedMyTickets.has(key);
    const stateBadge = `${this.ticketStateEmoji(it.item.state)} ${it.item.state}`;
    const item = new vscode.TreeItem(
      `${glyph} #${it.item.id} — ${it.item.title}`,
      isExpanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
    );
    const descParts = [it.providerLabel, it.item.type, stateBadge];
    if (it.item.relation) { descParts.push(it.item.relation); }
    item.description = descParts.filter(Boolean).join(' · ');
    item.iconPath = this.myTicketTypeIcon(it.item.type);
    item.contextValue = 'myTicket';

    item.command = {
      command: 'keepr.toggleMyItemExpand',
      title: 'Toggle Ticket Details',
      arguments: [{ kind: 'ticket', key }],
    };

    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**#${it.item.id} — ${it.item.title}**\n\n`);
    md.appendMarkdown(`Provider: ${it.providerLabel}\n\n`);
    md.appendMarkdown(`Type/State: ${it.item.type} · ${it.item.state}\n\n`);
    if (it.item.relation) { md.appendMarkdown(`Relation: ${it.item.relation}\n\n`); }
    if (it.item.updatedAt) { md.appendMarkdown(`Updated: ${it.item.updatedAt}\n\n`); }
    item.tooltip = md;
    return item;
  }

  private myTicketTypeGlyph(type: string | undefined): string {
    const value = (type ?? '').toLowerCase();
    if (value.includes('bug')) { return '🐞'; }
    if (value.includes('task')) { return '✅'; }
    if (value.includes('feature') || value.includes('epic') || value.includes('story') || value.includes('pbi') || value.includes('product backlog')) {
      return '⭐';
    }
    return '📌';
  }

  private myTicketTypeIcon(type: string | undefined): vscode.ThemeIcon {
    const value = (type ?? '').toLowerCase();
    if (value.includes('bug')) { return new vscode.ThemeIcon('bug'); }
    if (value.includes('task')) { return new vscode.ThemeIcon('checklist'); }
    if (value.includes('feature') || value.includes('epic') || value.includes('story') || value.includes('pbi') || value.includes('product backlog')) {
      return new vscode.ThemeIcon('rocket');
    }
    return new vscode.ThemeIcon('issues');
  }

  private myPrTreeItem(node: MyPrNode): vscode.TreeItem {
    const pr = node.item;
    const idLabel = pr.item.id ? `#${pr.item.id}` : 'PR';
    const key = this.myPrKey(pr);
    const isExpanded = this.expandedMyPrs.has(key);
    const statusBadge = `${this.prStatusEmoji(pr.item.status)} ${pr.item.status}`;
    const item = new vscode.TreeItem(
      `${idLabel} — ${pr.item.title}`,
      isExpanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
    );
    const descParts = [pr.providerLabel, statusBadge];
    if (pr.item.relation) { descParts.push(pr.item.relation); }
    item.description = descParts.filter(Boolean).join(' · ');
    item.iconPath = new vscode.ThemeIcon('git-pull-request');
    item.contextValue = 'myPullRequest';
    item.command = {
      command: 'keepr.toggleMyItemExpand',
      title: 'Toggle PR Details',
      arguments: [{ kind: 'pr', key }],
    };

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

  private myItemDetailTreeItem(node: MyItemDetailNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
    item.description = node.description;
    item.iconPath = node.icon;
    item.contextValue = node.contextValue;
    if (node.command) {
      item.command = node.command;
    }
    return item;
  }

  private myItemDetailExpandableTreeItem(node: MyItemDetailExpandableNode): vscode.TreeItem {
    const lines = node.fullText.split('\n').filter(line => line.trim());
    const firstLine = lines[0] || node.fullText;
    const hasMore = lines.length > 1;
    const label = node.isExpanded
      ? `$(chevron-down) ${node.label}`
      : `$(chevron-right) ${node.label}`;

    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.description = node.isExpanded
      ? undefined
      : `${firstLine}${hasMore ? ' …' : ''}`;
    item.iconPath = node.icon;
    item.contextValue = 'myItemDetailExpandable';
    item.command = {
      command: 'keepr.toggleDescriptionExpand',
      title: 'Toggle Description',
      arguments: [node.id],
    };
    return item;
  }

  private buildMyTicketChildren(item: AggregatedMyTicket): TreeNode[] {
    const rows: TreeNode[] = [
      new MyItemDetailNode('State', `${this.ticketStateEmoji(item.item.state)} ${item.item.state}`, new vscode.ThemeIcon('debug-pause')),
      new MyItemDetailNode('Type', item.item.type || '(unknown)', new vscode.ThemeIcon('symbol-struct')),
      new MyItemDetailNode('Provider', item.providerLabel, new vscode.ThemeIcon('plug')),
    ];

    if (item.item.assignedTo) {
      rows.push(new MyItemDetailNode('Assigned', item.item.assignedTo, new vscode.ThemeIcon('person')));
    }
    if (item.item.relation) {
      rows.push(new MyItemDetailNode('Relation', item.item.relation, new vscode.ThemeIcon('git-pull-request')));
    }
    if (item.item.updatedAt) {
      const updatedDisplay = this.formatDateTime(item.item.updatedAt);
      if (updatedDisplay) {
        rows.push(new MyItemDetailNode('Updated', updatedDisplay, new vscode.ThemeIcon('history')));
      }
    }

    const details = this.getMyTicketDetailsCached(item.item.id);
    const isFetching = this.myTicketDetailsFetching.has(item.item.id);

    if (isFetching && !details) {
      rows.push(new MyItemDetailNode('$(loading~spin) Fetching details...', undefined, new vscode.ThemeIcon('loading'), undefined, 'myItemLoading'));
    } else if (isFetching && details) {
      rows.push(new MyItemDetailNode('$(loading~spin) Updating...', undefined, new vscode.ThemeIcon('loading'), undefined, 'myItemLoading'));
    }

    this.fetchMyTicketDetailsAsync(item.item.id);
    if (details?.boardColumn && details.boardColumn !== details.state) {
      rows.push(new MyItemDetailNode('Board Column', details.boardColumn, new vscode.ThemeIcon('project')));
    }
    if (details?.description) {
      const descId = `desc:${item.item.id}`;
      const isExpanded = this.expandedDescriptions.has(descId);
      rows.push(new MyItemDetailExpandableNode(descId, 'Description', details.description, isExpanded, new vscode.ThemeIcon('note')));
      if (isExpanded) {
        const descLines = details.description.split('\n');
        for (let i = 0; i < descLines.length; i++) {
          const line = descLines[i].trim();
          if (line) {
            rows.push(new MyItemDetailNode(`  ${line}`, undefined, new vscode.ThemeIcon('blank')));
          }
        }
      }
    }
    if (details?.acceptanceCriteria) {
      rows.push(new MyItemDetailNode('Acceptance', this.truncate(details.acceptanceCriteria), new vscode.ThemeIcon('check-all')));
    }

    if (item.item.url) {
      rows.push(new MyItemDetailNode(
        'Open in Browser',
        undefined,
        new vscode.ThemeIcon('globe'),
        { command: 'keepr.openMyItemInBrowser', title: 'Open in Browser', arguments: [item.item.url] },
        'myItemAction',
      ));
      rows.push(new MyItemDetailNode(
        'Copy Link',
        undefined,
        new vscode.ThemeIcon('copy'),
        { command: 'keepr.copyMyItemUrl', title: 'Copy Link', arguments: [item.item.url] },
        'myItemAction',
      ));
    }

    return rows;
  }

  private buildMyPrChildren(item: AggregatedMyPullRequest): TreeNode[] {
    const rows: TreeNode[] = [
      new MyItemDetailNode('Status', `${this.prStatusEmoji(item.item.status)} ${item.item.status}`, new vscode.ThemeIcon('git-pull-request')),
      new MyItemDetailNode('Provider', item.providerLabel, new vscode.ThemeIcon('plug')),
    ];

    if (item.item.relation) {
      rows.push(new MyItemDetailNode('Relation', item.item.relation, new vscode.ThemeIcon('person')));
    }
    if (item.item.author) {
      rows.push(new MyItemDetailNode('Author', item.item.author, new vscode.ThemeIcon('account')));
    }
    if (item.item.sourceBranch || item.item.targetBranch) {
      rows.push(new MyItemDetailNode('Branches', `${item.item.sourceBranch ?? '?'} -> ${item.item.targetBranch ?? '?'}`, new vscode.ThemeIcon('git-branch')));
    }
    if (item.item.updatedAt) {
      const updatedDisplay = this.formatDateTime(item.item.updatedAt);
      if (updatedDisplay) {
        rows.push(new MyItemDetailNode('Updated', updatedDisplay, new vscode.ThemeIcon('history')));
      }
    }

    this.fetchMyPrDetailsAsync(item);

    if (item.item.url) {
      rows.push(new MyItemDetailNode(
        'Open in Browser',
        undefined,
        new vscode.ThemeIcon('globe'),
        { command: 'keepr.openMyItemInBrowser', title: 'Open in Browser', arguments: [item.item.url] },
        'myItemAction',
      ));
      rows.push(new MyItemDetailNode(
        'Copy Link',
        undefined,
        new vscode.ThemeIcon('copy'),
        { command: 'keepr.copyMyItemUrl', title: 'Copy Link', arguments: [item.item.url] },
        'myItemAction',
      ));
    }

    return rows;
  }

  private myTicketKey(item: AggregatedMyTicket): string {
    return `${item.providerId}:ticket:${item.item.id}`;
  }

  private myPrKey(item: AggregatedMyPullRequest): string {
    return `${item.providerId}:pr:${item.item.id ?? item.item.url}`;
  }

  public toggleDescriptionExpand(descId: string): void {
    if (this.expandedDescriptions.has(descId)) {
      this.expandedDescriptions.delete(descId);
    } else {
      this.expandedDescriptions.add(descId);
    }
    this.refresh();
  }

  public toggleMyItemExpand(kind: 'ticket' | 'pr', key: string): boolean {
    if (kind === 'ticket' && this.mode !== 'tickets') { return false; }
    if (kind === 'pr' && this.mode !== 'prs') { return false; }

    const set = kind === 'ticket' ? this.expandedMyTickets : this.expandedMyPrs;
    if (set.has(key)) {
      set.delete(key);
    } else {
      set.add(key);
    }
    this.refresh();
    return true;
  }

  private ticketStateEmoji(state: string | undefined): string {
    const value = (state ?? '').toLowerCase();
    if (value.includes('active') || value.includes('progress') || value.includes('committed')) { return '🟢'; }
    if (value.includes('todo') || value.includes('new') || value.includes('backlog')) { return '🟡'; }
    if (value.includes('test') || value.includes('review') || value.includes('qa')) { return '🟣'; }
    if (value.includes('done') || value.includes('closed') || value.includes('removed') || value.includes('abandoned')) { return '⚪'; }
    return '🔵';
  }

  private prStatusEmoji(status: string | undefined): string {
    const value = (status ?? '').toLowerCase();
    if (value.includes('active') || value.includes('open')) { return '🟢'; }
    if (value.includes('completed') || value.includes('merged')) { return '✅'; }
    if (value.includes('abandoned') || value.includes('declined') || value.includes('closed')) { return '⚪'; }
    return '🔵';
  }

  private truncate(text: string, max = 120): string {
    if (text.length <= max) { return text; }
    return `${text.slice(0, max - 1)}…`;
  }

  private formatDateTime(isoString: string | undefined): string | undefined {
    if (!isoString) { return undefined; }
    try {
      const date = new Date(isoString);
      if (isNaN(date.getTime())) { return undefined; }
      return date.toLocaleString(undefined, {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    } catch {
      return undefined;
    }
  }

  private getMyTicketDetailsCached(ticketId: string): TicketDetails | undefined {
    const cached = this.myTicketDetailsCache.get(ticketId);
    if (!cached) { return undefined; }

    const age = Date.now() - cached.fetchedAt;
    if (age > BookmarkTreeProvider.DETAIL_CACHE_TTL) {
      this.myTicketDetailsCache.delete(ticketId);
      return undefined;
    }

    return cached.data;
  }

  private fetchMyTicketDetailsAsync(ticketId: string): void {
    if (!this.providers?.isConfigured()) { return; }
    if (this.myTicketDetailsFetching.has(ticketId)) { return; }
    const cached = this.myTicketDetailsCache.get(ticketId);
    if (cached && (Date.now() - cached.fetchedAt) < BookmarkTreeProvider.DETAIL_CACHE_TTL) {
      return;
    }

    this.myTicketDetailsFetching.add(ticketId);
    this.providers.getTicketDetails(ticketId)
      .then((details) => {
        this.myTicketDetailsFetching.delete(ticketId);
        if (details) {
          this.myTicketDetailsCache.set(ticketId, { data: details, fetchedAt: Date.now() });
          this._onDidChangeTreeData.fire(undefined);
        }
      })
      .catch(() => {
        this.myTicketDetailsFetching.delete(ticketId);
      });
  }

  private fetchMyPrDetailsAsync(_item: AggregatedMyPullRequest): void {
    // PR details are typically lightweight; no separate fetch needed for now
    // Can be extended in the future if PR-specific details become available
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
    this.myItemsFetchedAt = 0;
    this.refreshingMyItems = false;
    this.refresh();
  }

  async getAvailableMyTicketStates(): Promise<string[]> {
    await this.ensureMyItemsLoaded();
    return [...new Set((this.myTicketsCache ?? []).map((item) => item.item.state).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  }

  async getAvailableMyPrStates(): Promise<string[]> {
    await this.ensureMyItemsLoaded();
    const knownStates = ['active', 'completed', 'abandoned', 'closed', 'merged', 'declined', 'draft'];
    const discoveredStates = (this.myPrsCache ?? [])
      .map((item) => item.item.status || item.item.state)
      .filter(Boolean) as string[];

    const allStates = [...new Set([...knownStates, ...discoveredStates])];
    return allStates.sort((a, b) => a.localeCompare(b));
  }

  private isMyItemsEnabled(): boolean {
    return vscode.workspace.getConfiguration('keepr').get<boolean>('myItems.enabled', true);
  }

  private async ensureMyItemsLoaded(): Promise<void> {
    if (this.loadingMyItems) { return; }
    if (this.myTicketsCache && this.myPrsCache) {
      if (this.isMyItemsCacheStale()) {
        this.refreshMyItemsInBackground();
      }
      return;
    }
    if (!this.providers) {
      this.myTicketsCache = [];
      this.myPrsCache = [];
      this.myItemsFetchedAt = Date.now();
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
      this.myItemsFetchedAt = Date.now();
    } finally {
      this.loadingMyItems = false;
      this._onDidChangeTreeData.fire(undefined);
    }
  }

  private isMyItemsCacheStale(): boolean {
    if (!this.myItemsFetchedAt) { return true; }
    return (Date.now() - this.myItemsFetchedAt) > BookmarkTreeProvider.MY_ITEMS_CACHE_TTL;
  }

  private refreshMyItemsInBackground(): void {
    if (this.loadingMyItems || this.refreshingMyItems || !this.providers) { return; }

    this.refreshingMyItems = true;
    this._onDidChangeTreeData.fire(undefined);

    Promise.all([
      this.providers.getMyTicketsAcrossProviders(),
      this.providers.getMyPullRequestsAcrossProviders(),
    ]).then(([tickets, prs]) => {
      this.myTicketsCache = tickets;
      this.myPrsCache = prs;
      this.myItemsFetchedAt = Date.now();
    }).catch(() => {
      // Keep stale cache data if refresh fails.
    }).finally(() => {
      this.refreshingMyItems = false;
      this._onDidChangeTreeData.fire(undefined);
    });
  }

  private getFilteredSortedMyTickets(): AggregatedMyTicket[] {
    const all = [...(this.myTicketsCache ?? [])];
    const config = vscode.workspace.getConfiguration('keepr');
    const filter = config.get<string>('myItems.ticketFilter', 'all');
    const visibleStates = config.get<string[]>('myItems.ticketVisibleStates', []);
    const sortBy = config.get<MyItemsSort>('myItems.sortBy', 'updated');

    const relationFiltered = filter === 'all' ? all : all.filter((t) => (t.item.relation ?? '').toLowerCase().includes(filter.toLowerCase()));
    const stateFiltered = this.filterByVisibleStates(relationFiltered, visibleStates, (item) => item.item.state, 'ticket');
    return stateFiltered.sort((a, b) => {
      const stateOrder = this.compareTicketStatePriority(a.item.state, b.item.state);
      if (stateOrder !== 0) { return stateOrder; }

      return this.compareMyItems(
        a.item.title,
        b.item.title,
        a.providerLabel,
        b.providerLabel,
        a.item.updatedAt,
        b.item.updatedAt,
        a.item.createdAt,
        b.item.createdAt,
        a.item.type,
        b.item.type,
        a.item.state,
        b.item.state,
        sortBy,
      );
    });
  }

  private getFilteredSortedMyPrs(): AggregatedMyPullRequest[] {
    const all = [...(this.myPrsCache ?? [])];
    const config = vscode.workspace.getConfiguration('keepr');
    const filter = config.get<string>('myItems.prFilter', 'all');
    const visibleStates = config.get<string[]>('myItems.prVisibleStates', []);
    const sortBy = config.get<MyItemsSort>('myItems.sortBy', 'updated');

    const relationFiltered = filter === 'all' ? all : all.filter((p) => (p.item.relation ?? '').toLowerCase().includes(filter.toLowerCase()));
    const stateFiltered = this.filterByVisibleStates(relationFiltered, visibleStates, (item) => item.item.status || item.item.state, 'pr');
    return stateFiltered.sort((a, b) => this.compareMyItems(
      a.item.title,
      b.item.title,
      a.providerLabel,
      b.providerLabel,
      a.item.updatedAt,
      b.item.updatedAt,
      a.item.createdAt,
      b.item.createdAt,
      undefined,
      undefined,
      a.item.status || a.item.state,
      b.item.status || b.item.state,
      sortBy,
    ));
  }

  private filterByVisibleStates<T>(
    items: T[],
    visibleStates: string[],
    getState: (item: T) => string | undefined,
    scope: 'ticket' | 'pr',
  ): T[] {
    if (visibleStates.length > 0) {
      const allowed = new Set(visibleStates.map((state) => state.toLowerCase()));
      return items.filter((item) => {
        const state = getState(item);
        return !state || allowed.has(state.toLowerCase());
      });
    }

    return items.filter((item) => !this.isCompletedState(getState(item), scope));
  }

  private isCompletedState(state: string | undefined, scope: 'ticket' | 'pr'): boolean {
    const normalized = (state ?? '').trim().toLowerCase();
    if (!normalized) { return false; }

    if (scope === 'pr') {
      return ['completed', 'abandoned', 'closed', 'merged', 'declined'].includes(normalized);
    }

    return ['done', 'closed', 'resolved', 'removed', 'completed', 'abandoned', 'cancelled', 'canceled'].includes(normalized);
  }

  private compareTicketStatePriority(stateA: string | undefined, stateB: string | undefined): number {
    return this.ticketStatePriority(stateA) - this.ticketStatePriority(stateB);
  }

  private ticketStatePriority(state: string | undefined): number {
    const normalized = (state ?? '').trim().toLowerCase();
    if (!normalized) { return 50; }

    if (this.matchesAny(normalized, ['active', 'in progress', 'committed', 'doing', 'open', 'current', 'started'])) {
      return 10;
    }

    if (this.matchesAny(normalized, ['todo', 'to do', 'new', 'approved', 'ready', 'planned', 'backlog'])) {
      return 20;
    }

    if (this.matchesAny(normalized, ['pr', 'pull request', 'review', 'testing', 'test', 'qa', 'verify', 'validation'])) {
      return 30;
    }

    if (this.matchesAny(normalized, ['blocked', 'waiting', 'hold'])) {
      return 40;
    }

    if (this.matchesAny(normalized, ['done', 'closed', 'resolved', 'removed', 'completed', 'abandoned', 'cancelled', 'canceled'])) {
      return 90;
    }

    return 50;
  }

  private matchesAny(value: string, patterns: string[]): boolean {
    return patterns.some((pattern) => value.includes(pattern));
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
    typeA: string | undefined,
    typeB: string | undefined,
    statusA: string | undefined,
    statusB: string | undefined,
    sortBy: MyItemsSort,
  ): number {
    switch (sortBy) {
      case 'title':
        return titleA.localeCompare(titleB);
      case 'provider':
        return providerA.localeCompare(providerB);
      case 'type':
        return (typeA ?? '').localeCompare(typeB ?? '') || titleA.localeCompare(titleB);
      case 'status':
        return (statusA ?? '').localeCompare(statusB ?? '') || titleA.localeCompare(titleB);
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
