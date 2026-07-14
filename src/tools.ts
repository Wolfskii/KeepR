import * as vscode from 'vscode';
import { BookmarkStore } from './store';
import { Bookmark } from './models';
import { DecorationManager } from './decorations';
import { ProviderManager } from './providers';

// ── Input types ──────────────────────────────────────────

interface ListBookmarksInput {
    status?: string;
    ticket?: string;
    filePath?: string;
}

interface AddBookmarkInput {
    filePath: string;
    line: number;
    label?: string;
    ticket?: string;
    status?: string;
}

interface RemoveBookmarkInput {
    id?: string;
    filePath?: string;
    line?: number;
}

interface GetStatsInput { }

interface EditBookmarkInput {
    id?: string;
    filePath?: string;
    line?: number;
    label?: string;
    ticket?: string;
    status?: string;
}

interface GetConnectionsInput { }

interface GetTicketDetailsInput {
    ticketId?: string;
    all?: boolean;
}

interface SearchTicketsInput {
    query: string;
}

interface GetHierarchyInput {
    ticketId?: string;
    all?: boolean;
    depth?: number;
}

interface GetMyItemsInput {
    scope?: 'tickets' | 'pullRequests' | 'all';
    relation?: string;
    state?: string;
    provider?: string;
    sortBy?: 'updated' | 'created' | 'title' | 'provider';
    limit?: number;
}

// ── Shared helpers ───────────────────────────────────────

const ABS_PATH_RE = /^[a-zA-Z]:[/\\]/;

function resolveFileUri(filePath: string): vscode.Uri | undefined {
    if (ABS_PATH_RE.exec(filePath) || filePath.startsWith('/')) {
        return vscode.Uri.file(filePath);
    }
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
        return vscode.Uri.joinPath(folders[0].uri, filePath);
    }
    return undefined;
}

function textResult(text: string): vscode.LanguageModelToolResult {
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
}

// ── Tool implementations ─────────────────────────────────

export class ListBookmarksTool implements vscode.LanguageModelTool<ListBookmarksInput> {
    constructor(private readonly store: BookmarkStore) { }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ListBookmarksInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const { status, ticket, filePath } = options.input;
        let results = this.store.getAllBookmarks();

        if (status) {
            results = results.filter(({ bookmark }) =>
                bookmark.status?.toLowerCase() === status.toLowerCase());
        }
        if (ticket) {
            results = results.filter(({ bookmark }) =>
                bookmark.ticket?.includes(ticket));
        }
        if (filePath) {
            const lower = filePath.toLowerCase();
            results = results.filter(({ bookmark }) =>
                bookmark.location.filePath.toLowerCase().includes(lower));
        }

        if (results.length === 0) {
            return textResult('No bookmarks found matching the criteria.');
        }

        const lines = results.map(({ repo, bookmark }) => {
            const parts = [
                '- **' + bookmark.location.filePath + ':' + (bookmark.location.line + 1) + '**',
                '[' + this.store.getDisplayName(repo) + ']',
            ];
            if (bookmark.label) { parts.push('"' + bookmark.label + '"'); }
            if (bookmark.status) { parts.push('(' + bookmark.status + ')'); }
            if (bookmark.ticket) { parts.push('#' + bookmark.ticket); }
            parts.push('id=' + bookmark.id);
            return parts.join(' ');
        });

        return textResult('Found ' + results.length + ' bookmark(s):\n' + lines.join('\n'));
    }
}

export class AddBookmarkTool implements vscode.LanguageModelTool<AddBookmarkInput> {
    constructor(
        private readonly store: BookmarkStore,
        private readonly decorations: DecorationManager,
    ) { }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<AddBookmarkInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const { filePath, line, label, ticket, status } = options.input;

        // Resolve file URI
        const fileUri = resolveFileUri(filePath);
        if (!fileUri) {
            return textResult('Could not resolve file path: ' + filePath);
        }

        const repo = this.store.getRepoForFile(fileUri);
        if (!repo) {
            return textResult('File is not in any workspace folder: ' + filePath);
        }

        // line is 1-based from input, store uses 0-based
        const zeroLine = line - 1;

        // Try to get line text for drift detection
        let lineText: string | undefined;
        try {
            const doc = await vscode.workspace.openTextDocument(fileUri);
            if (zeroLine >= 0 && zeroLine < doc.lineCount) {
                lineText = doc.lineAt(zeroLine).text;
            }
        } catch { /* file might not be openable */ }

        const bookmark = await this.store.addBookmark(fileUri, zeroLine, {
            label: label || undefined,
            ticket: ticket || undefined,
            status: status || undefined,
            lineText,
        });

        if (!bookmark) {
            return textResult('Failed to add bookmark.');
        }

        this.decorations.updateDecorations();

        const msg = 'Bookmark added at ' + filePath + ':' + line + ' (id=' + bookmark.id + ')' +
            (label ? ' label="' + label + '"' : '') +
            (status ? ' status=' + status : '') +
            (ticket ? ' ticket=#' + ticket : '');
        return textResult(msg);
    }
}

export class RemoveBookmarkTool implements vscode.LanguageModelTool<RemoveBookmarkInput> {
    constructor(
        private readonly store: BookmarkStore,
        private readonly decorations: DecorationManager,
    ) { }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<RemoveBookmarkInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const { id, filePath, line } = options.input;

        if (id) {
            const success = await this.store.removeBookmark(id);
            if (success) {
                this.decorations.updateDecorations();
                return textResult('Bookmark ' + id + ' removed.');
            }
            return textResult('Bookmark with id=' + id + ' not found.');
        }

        if (filePath && line !== undefined) {
            const fileUri = resolveFileUri(filePath);
            if (!fileUri) {
                return textResult('Could not resolve file path: ' + filePath);
            }
            const found = this.store.findBookmarkAtLine(fileUri, line - 1);
            if (found) {
                await this.store.removeBookmark(found.bookmark.id);
                this.decorations.updateDecorations();
                return textResult('Bookmark removed from ' + filePath + ':' + line + '.');
            }
            return textResult('No bookmark found at ' + filePath + ':' + line + '.');
        }

        return textResult('Provide either an id, or filePath + line to remove a bookmark.');
    }
}

export class GetStatsTool implements vscode.LanguageModelTool<GetStatsInput> {
    constructor(private readonly store: BookmarkStore) { }

    async invoke(
        _options: vscode.LanguageModelToolInvocationOptions<GetStatsInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const all = this.store.getAllBookmarks();
        const total = all.length;

        if (total === 0) {
            return textResult('No bookmarks in the workspace.');
        }

        // By status
        const byStatus = new Map<string, number>();
        // By ticket
        const byTicket = new Map<string, number>();
        // By repo
        const byRepo = new Map<string, number>();

        for (const { repo, bookmark } of all) {
            const status = bookmark.status || '(none)';
            byStatus.set(status, (byStatus.get(status) ?? 0) + 1);

            if (bookmark.ticket) {
                byTicket.set(bookmark.ticket, (byTicket.get(bookmark.ticket) ?? 0) + 1);
            }

            const repoName = this.store.getDisplayName(repo);
            byRepo.set(repoName, (byRepo.get(repoName) ?? 0) + 1);
        }

        const lines: string[] = [
            `**Total bookmarks:** ${total}`,
            '',
            '**By status:**',
            ...[...byStatus.entries()]
                .sort((a, b) => b[1] - a[1])
                .map(([s, n]) => `  - ${s}: ${n}`),
            '',
            '**By project:**',
            ...[...byRepo.entries()]
                .sort((a, b) => b[1] - a[1])
                .map(([r, n]) => `  - ${r}: ${n}`),
        ];

        if (byTicket.size > 0) {
            lines.push(
                '',
                '**By ticket:**',
                ...[...byTicket.entries()]
                    .sort((a, b) => b[1] - a[1])
                    .map(([t, n]) => `  - #${t}: ${n}`),
            );
        }

        return textResult(lines.join('\n'));
    }
}

export class EditBookmarkTool implements vscode.LanguageModelTool<EditBookmarkInput> {
    constructor(
        private readonly store: BookmarkStore,
        private readonly decorations: DecorationManager,
    ) { }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<EditBookmarkInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const { id, filePath, line, label, ticket, status } = options.input;

        // Find the bookmark
        let bookmarkId: string | undefined = id;

        if (!bookmarkId && filePath && line !== undefined) {
            const fileUri = resolveFileUri(filePath);
            if (fileUri) {
                const found = this.store.findBookmarkAtLine(fileUri, line - 1);
                if (found) { bookmarkId = found.bookmark.id; }
            }
        }

        if (!bookmarkId) {
            return textResult('Could not find bookmark. Provide an id, or filePath + line.');
        }

        const found = this.store.findBookmarkById(bookmarkId);
        if (!found) {
            return textResult('Bookmark with id=' + bookmarkId + ' not found.');
        }

        // Build updates — only include fields that were explicitly provided
        const updates: Partial<Pick<Bookmark, 'label' | 'ticket' | 'status'>> = {};
        if (label !== undefined) { updates.label = label || undefined; }
        if (ticket !== undefined) { updates.ticket = ticket || undefined; }
        if (status !== undefined) { updates.status = status || undefined; }

        if (Object.keys(updates).length === 0) {
            return textResult('No changes specified. Provide at least one of: label, ticket, status.');
        }

        const success = await this.store.updateBookmark(bookmarkId, updates);
        if (!success) {
            return textResult('Failed to update bookmark.');
        }

        this.decorations.updateDecorations();

        const changedFields = Object.entries(updates)
            .map(([k, v]) => k + '=' + (v ? '"' + v + '"' : '(cleared)'))
            .join(', ');

        return textResult('Bookmark ' + bookmarkId + ' updated: ' + changedFields);
    }
}

export class GetConnectionsTool implements vscode.LanguageModelTool<GetConnectionsInput> {
    constructor(private readonly providers: ProviderManager) { }

    async invoke(
        _options: vscode.LanguageModelToolInvocationOptions<GetConnectionsInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const connStore = this.providers.connectionStore;

        // Check multi-connection store first
        if (connStore) {
            const connections = connStore.getAll();
            if (connections.length === 0) {
                return textResult(
                    'No ticket provider connections configured.\n\n' +
                    'To set one up, run the command **"KeepR: Add Provider Connection"** from the command palette ' +
                    '(or **"KeepR: Set Up Ticket Provider"**). ' +
                    'Supported providers: Azure DevOps, GitHub, Jira.',
                );
            }

            const activeId = connStore.getActiveId();
            const lines = connections.map((c) => {
                const isActive = c.id === activeId ? ' ✅ **ACTIVE**' : '';
                const configDetails = Object.entries(c.config)
                    .filter(([key]) => !key.toLowerCase().includes('token') && !key.toLowerCase().includes('pat') && !key.toLowerCase().includes('secret'))
                    .map(([key, val]) => `${key}: ${val}`)
                    .join(', ');
                return `- **${c.name}** (${c.type})${isActive}\n  ${configDetails}`;
            });

            return textResult(
                connections.length + ' provider connection(s) configured:\n\n' + lines.join('\n\n'),
            );
        }

        // Legacy: check VS Code settings
        const activeId = this.providers.activeProviderId;
        if (!activeId) {
            return textResult(
                'No ticket provider configured.\n\n' +
                'Run **"KeepR: Set Up Ticket Provider"** to connect Azure DevOps, GitHub, or Jira.',
            );
        }

        const isConfigured = this.providers.isConfigured();
        return textResult(
            'Active provider: **' + activeId + '** (via VS Code settings)\n' +
            'Configured: ' + (isConfigured ? 'Yes' : 'No — credentials may be missing. Run "KeepR: Set Up Ticket Provider" to fix.'),
        );
    }
}

export class GetTicketDetailsTool implements vscode.LanguageModelTool<GetTicketDetailsInput> {
    constructor(
        private readonly store: BookmarkStore,
        private readonly providers: ProviderManager,
    ) { }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<GetTicketDetailsInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        if (!this.providers.isConfigured()) {
            return textResult(
                'No ticket provider is configured or the active connection is missing credentials.\n\n' +
                'Run **"KeepR: Add Provider Connection"** to set one up.',
            );
        }

        const ticketIds = this.collectTicketIds(options.input);
        if (ticketIds.size === 0) {
            return textResult(
                'No ticket ID provided and no bookmarks have linked tickets. ' +
                'Provide a ticketId or set all=true to fetch details for all linked tickets.',
            );
        }

        const results: string[] = [];
        for (const tid of ticketIds) {
            results.push(await this.formatTicketDetails(tid));
        }

        return textResult(results.join('\n\n'));
    }

    private collectTicketIds(input: GetTicketDetailsInput): Set<string> {
        const ids = new Set<string>();
        if (input.ticketId) { ids.add(input.ticketId); }
        if (input.all) {
            for (const { bookmark } of this.store.getAllBookmarks()) {
                if (bookmark.ticket) { ids.add(bookmark.ticket); }
            }
        }
        return ids;
    }

    private async formatTicketDetails(tid: string): Promise<string> {
        try {
            const details = await this.providers.getTicketDetails(tid);
            if (!details) {
                return '### #' + tid + '\nNot found or not accessible.';
            }

            const lines: string[] = [
                '### #' + details.id + ' — ' + details.title,
                '- **Type:** ' + details.type,
                '- **State:** ' + details.state,
            ];
            if (details.boardColumn) { lines.push('- **Board Column:** ' + details.boardColumn); }
            if (details.assignedTo) { lines.push('- **Assigned To:** ' + details.assignedTo); }

            const url = details.url ?? this.providers.getTicketUrl(tid);
            if (url) { lines.push('- **URL:** ' + url); }

            if (details.parent) {
                const parent = details.parent;
                const parentParts = [
                    '#' + parent.id + ' — ' + parent.title,
                    '(' + parent.type + ' · ' + parent.state + ')',
                ];
                if (parent.url) {
                    parentParts.push(parent.url);
                }
                lines.push('- **Parent:** ' + parentParts.join(' '));
            }

            if (details.children.length > 0) {
                lines.push('- **Children:**');
                for (const child of details.children) {
                    const childParts = [
                        '#' + child.id + ' — ' + child.title,
                        '(' + child.type + ' · ' + child.state + ')',
                    ];
                    if (child.url) {
                        childParts.push(child.url);
                    }
                    lines.push('  - ' + childParts.join(' '));
                }
            }

            if (details.description) {
                lines.push('', '**Description:**', details.description);
            }
            if (details.acceptanceCriteria) {
                lines.push('', '**Acceptance Criteria:**', details.acceptanceCriteria);
            }

            if (details.branches.length > 0) {
                lines.push('- **Branches:** ' + details.branches.join(', '));
            }
            if (details.pullRequests.length > 0) {
                lines.push('- **Pull Requests:**');
                for (const pr of details.pullRequests) {
                    const prParts = [pr.title + ' (' + pr.status + ') — ' + pr.url];
                    if (pr.sourceBranch || pr.targetBranch) {
                        prParts.push('[' + (pr.sourceBranch ?? '?') + ' -> ' + (pr.targetBranch ?? '?') + ']');
                    }
                    lines.push('  - ' + prParts.join(' '));

                    if (pr.changes) {
                        if (pr.changes.fileCount !== undefined) {
                            lines.push('    - files changed: ' + pr.changes.fileCount);
                        }
                        if (pr.changes.changedFiles.length > 0) {
                            lines.push('    - changed paths (sample): ' + pr.changes.changedFiles.slice(0, 10).join(', '));
                        }
                    }
                }
            }

            return lines.join('\n');
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return '### #' + tid + '\nError fetching details: ' + msg;
        }
    }
}

export class SearchTicketsTool implements vscode.LanguageModelTool<SearchTicketsInput> {
    constructor(private readonly providers: ProviderManager) { }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<SearchTicketsInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const query = options.input.query?.trim();
        if (!query) {
            return textResult('Provide a query to search tickets, for example "419046" or "unit conversion".');
        }

        if (!this.providers.isConfigured()) {
            return textResult(
                'No ticket provider is configured or the active connection is missing credentials.\n\n' +
                'Run **"KeepR: Add Provider Connection"** to set one up.',
            );
        }

        try {
            const results = await this.providers.searchTickets(query);
            if (results.length === 0) {
                return textResult('No tickets found for "' + query + '".');
            }

            const lines = results.map((ticket) => {
                const parts = [
                    '- #' + ticket.id + ' — ' + ticket.title,
                    '(' + ticket.type + ' · ' + ticket.state + ')',
                ];
                if (ticket.assignedTo) {
                    parts.push('assigned: ' + ticket.assignedTo);
                }
                const url = ticket.url ?? this.providers.getTicketUrl(ticket.id);
                if (url) {
                    parts.push(url);
                }
                return parts.join(' ');
            });

            return textResult('Found ' + results.length + ' ticket(s):\n' + lines.join('\n'));
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return textResult('Ticket search failed: ' + msg);
        }
    }
}

export class GetHierarchyTool implements vscode.LanguageModelTool<GetHierarchyInput> {
    constructor(
        private readonly store: BookmarkStore,
        private readonly providers: ProviderManager,
    ) { }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<GetHierarchyInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        if (!this.providers.isConfigured()) {
            return textResult(
                'No ticket provider is configured or the active connection is missing credentials.\n\n' +
                'Run **"KeepR: Add Provider Connection"** to set one up.',
            );
        }

        const input = options.input;
        const maxDepth = Math.max(1, Math.min(input.depth ?? 2, 5));
        const ticketIds = this.collectTicketIds(input);
        if (ticketIds.length === 0) {
            return textResult(
                'No ticket ID provided and no bookmarks have linked tickets. ' +
                'Provide ticketId or set all=true.',
            );
        }

        const sections: string[] = [];
        for (const tid of ticketIds) {
            const section = await this.buildHierarchySection(tid, maxDepth);
            sections.push(section);
        }

        return textResult(sections.join('\n\n'));
    }

    private collectTicketIds(input: GetHierarchyInput): string[] {
        const ids = new Set<string>();
        if (input.ticketId) { ids.add(input.ticketId); }
        if (input.all) {
            for (const { bookmark } of this.store.getAllBookmarks()) {
                if (bookmark.ticket) {
                    ids.add(bookmark.ticket);
                }
            }
        }
        return [...ids];
    }

    private async buildHierarchySection(ticketId: string, maxDepth: number): Promise<string> {
        const visited = new Set<string>();
        const details = await this.providers.getTicketDetails(ticketId);
        if (!details) {
            return `### #${ticketId}\nNot found or not accessible.`;
        }

        const lines: string[] = [
            `### Hierarchy for #${details.id} — ${details.title}`,
            `- Root Ticket: #${details.id} (${details.type} · ${details.state})`,
        ];

        if (details.parent) {
            const parentChain = await this.getParentChain(details.parent.id, maxDepth, visited);
            if (parentChain.length > 0) {
                lines.push('- Parent Chain:');
                for (const parent of parentChain) {
                    lines.push(`  - #${parent.id} — ${parent.title} (${parent.type} · ${parent.state})`);
                }
            }
        }

        const childLines = await this.getChildLines(details.id, maxDepth, 0, visited);
        if (childLines.length > 0) {
            lines.push('- Children:');
            lines.push(...childLines);
        } else {
            lines.push('- Children: none found');
        }

        return lines.join('\n');
    }

    private async getParentChain(
        startId: string,
        maxDepth: number,
        visited: Set<string>,
    ): Promise<Array<{ id: string; title: string; type: string; state: string }>> {
        const chain: Array<{ id: string; title: string; type: string; state: string }> = [];
        let currentId: string | undefined = startId;
        let steps = 0;

        while (currentId && steps < maxDepth && !visited.has(`parent:${currentId}`)) {
            visited.add(`parent:${currentId}`);
            const details = await this.providers.getTicketDetails(currentId);
            if (!details) { break; }
            chain.push({
                id: details.id,
                title: details.title,
                type: details.type,
                state: details.state,
            });
            currentId = details.parent?.id;
            steps += 1;
        }

        return chain.reverse();
    }

    private async getChildLines(
        ticketId: string,
        maxDepth: number,
        depth: number,
        visited: Set<string>,
    ): Promise<string[]> {
        if (depth >= maxDepth) { return []; }
        if (visited.has(`child:${ticketId}:${depth}`)) { return []; }
        visited.add(`child:${ticketId}:${depth}`);

        const details = await this.providers.getTicketDetails(ticketId);
        if (!details || details.children.length === 0) { return []; }

        const lines: string[] = [];
        for (const child of details.children) {
            const indent = '  '.repeat(depth + 1);
            lines.push(`${indent}- #${child.id} — ${child.title} (${child.type} · ${child.state})`);
            const nested = await this.getChildLines(child.id, maxDepth, depth + 1, visited);
            lines.push(...nested);
        }
        return lines;
    }
}

export class GetMyItemsTool implements vscode.LanguageModelTool<GetMyItemsInput> {
    constructor(private readonly providers: ProviderManager) { }

    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<GetMyItemsInput>,
        _token: vscode.CancellationToken,
    ): Promise<vscode.LanguageModelToolResult> {
        const input = options.input;
        const scope = input.scope ?? 'all';
        const sortBy = input.sortBy ?? 'updated';
        const limit = Math.max(1, Math.min(input.limit ?? 50, 200));
        const relationFilter = (input.relation ?? 'all').toLowerCase();
        const stateFilter = (input.state ?? '').toLowerCase();
        const providerFilter = (input.provider ?? 'all').toLowerCase();

        const sections: string[] = [];

        if (scope === 'all' || scope === 'tickets') {
            let tickets = await this.providers.getMyTicketsAcrossProviders();
            tickets = tickets.filter((t) => this.matchesCommonFilters(t.providerLabel, t.item.relation, t.item.state, providerFilter, relationFilter, stateFilter));
            tickets = this.sortItems(tickets, sortBy, (x) => x.item.title, (x) => x.providerLabel, (x) => x.item.updatedAt, (x) => x.item.createdAt);
            tickets = tickets.slice(0, limit);

            const lines = tickets.map((t) => {
                const parts = [`- [${t.providerLabel}] #${t.item.id} — ${t.item.title}`, `(${t.item.type} · ${t.item.state})`];
                if (t.item.relation) { parts.push(`relation=${t.item.relation}`); }
                if (t.item.assignedTo) { parts.push(`assigned=${t.item.assignedTo}`); }
                if (t.item.url) { parts.push(t.item.url); }
                return parts.join(' ');
            });
            sections.push(`### My Tickets/PBIs/Features (${tickets.length})\n${lines.length > 0 ? lines.join('\n') : '- none'}`);
        }

        if (scope === 'all' || scope === 'pullRequests') {
            let prs = await this.providers.getMyPullRequestsAcrossProviders();
            prs = prs.filter((p) => this.matchesCommonFilters(p.providerLabel, p.item.relation, p.item.status ?? p.item.state, providerFilter, relationFilter, stateFilter));
            prs = this.sortItems(prs, sortBy, (x) => x.item.title, (x) => x.providerLabel, (x) => x.item.updatedAt, (x) => x.item.createdAt);
            prs = prs.slice(0, limit);

            const lines = prs.map((p) => {
                const idLabel = p.item.id ? `#${p.item.id}` : 'PR';
                const parts = [`- [${p.providerLabel}] ${idLabel} — ${p.item.title}`, `(${p.item.status})`];
                if (p.item.relation) { parts.push(`relation=${p.item.relation}`); }
                if (p.item.sourceBranch || p.item.targetBranch) {
                    parts.push(`[${p.item.sourceBranch ?? '?'} -> ${p.item.targetBranch ?? '?'}]`);
                }
                if (p.item.url) { parts.push(p.item.url); }
                return parts.join(' ');
            });
            sections.push(`### My Pull Requests (${prs.length})\n${lines.length > 0 ? lines.join('\n') : '- none'}`);
        }

        if (sections.length === 0) {
            return textResult('No scope selected. Use scope=tickets, scope=pullRequests, or scope=all.');
        }

        return textResult(sections.join('\n\n'));
    }

    private matchesCommonFilters(
        providerLabel: string,
        relation: string | undefined,
        state: string | undefined,
        providerFilter: string,
        relationFilter: string,
        stateFilter: string,
    ): boolean {
        const providerOk = providerFilter === 'all' || providerLabel.toLowerCase().includes(providerFilter);
        const relationOk = relationFilter === 'all' || (relation ?? '').toLowerCase().includes(relationFilter);
        const stateOk = !stateFilter || (state ?? '').toLowerCase().includes(stateFilter);
        return providerOk && relationOk && stateOk;
    }

    private sortItems<T>(
        items: T[],
        sortBy: 'updated' | 'created' | 'title' | 'provider',
        getTitle: (item: T) => string,
        getProvider: (item: T) => string,
        getUpdated: (item: T) => string | undefined,
        getCreated: (item: T) => string | undefined,
    ): T[] {
        const sorted = [...items];
        sorted.sort((a, b) => {
            switch (sortBy) {
                case 'title':
                    return getTitle(a).localeCompare(getTitle(b));
                case 'provider':
                    return getProvider(a).localeCompare(getProvider(b));
                case 'created':
                    return (Date.parse(getCreated(b) ?? '') || 0) - (Date.parse(getCreated(a) ?? '') || 0);
                case 'updated':
                default:
                    return (Date.parse(getUpdated(b) ?? '') || 0) - (Date.parse(getUpdated(a) ?? '') || 0);
            }
        });
        return sorted;
    }
}

/**
 * Register all KeepR Language Model Tools for Copilot Chat integration.
 */
export function registerTools(
    context: vscode.ExtensionContext,
    store: BookmarkStore,
    decorations: DecorationManager,
    providers: ProviderManager,
): void {
    context.subscriptions.push(
        vscode.lm.registerTool('keepr_listBookmarks', new ListBookmarksTool(store)),
        vscode.lm.registerTool('keepr_addBookmark', new AddBookmarkTool(store, decorations)),
        vscode.lm.registerTool('keepr_removeBookmark', new RemoveBookmarkTool(store, decorations)),
        vscode.lm.registerTool('keepr_editBookmark', new EditBookmarkTool(store, decorations)),
        vscode.lm.registerTool('keepr_getStats', new GetStatsTool(store)),
        vscode.lm.registerTool('keepr_getConnections', new GetConnectionsTool(providers)),
        vscode.lm.registerTool('keepr_getTicketDetails', new GetTicketDetailsTool(store, providers)),
        vscode.lm.registerTool('keepr_searchTickets', new SearchTicketsTool(providers)),
        vscode.lm.registerTool('keepr_getHierarchy', new GetHierarchyTool(store, providers)),
        vscode.lm.registerTool('keepr_getMyItems', new GetMyItemsTool(providers)),
    );
}
