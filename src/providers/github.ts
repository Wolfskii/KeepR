import * as vscode from 'vscode';
import { TicketProvider, TicketInfo, TicketDetails, UserRelatedPullRequestInfo, UserRelatedTicketInfo } from './types';

export interface GitHubConfig {
    owner: string;
    repo: string;
}

export class GitHubProvider implements TicketProvider {
    readonly id = 'github' as const;
    readonly displayName = 'GitHub';

    private _config: GitHubConfig | undefined;
    private _tokenGetter: (() => Promise<string | undefined>) | undefined;
    private _tokenSetter: ((token: string) => Promise<void>) | undefined;
    private _secrets: vscode.SecretStorage | undefined;
    private detailsCache = new Map<string, TicketDetails>();
    private static CACHE_TTL = 2 * 60 * 1000;
    private authWarningShown = false;

    constructor(config?: GitHubConfig, tokenGetter?: () => Promise<string | undefined>, tokenSetter?: (token: string) => Promise<void>) {
        this._config = config;
        this._tokenGetter = tokenGetter;
        this._tokenSetter = tokenSetter;
    }

    private get owner(): string | undefined {
        if (this._config) { return this._config.owner; }
        return vscode.workspace.getConfiguration('keepr.github').get<string>('owner');
    }

    private get repo(): string | undefined {
        if (this._config) { return this._config.repo; }
        return vscode.workspace.getConfiguration('keepr.github').get<string>('repo');
    }

    private async getToken(): Promise<string | undefined> {
        if (this._tokenGetter) { return this._tokenGetter(); }
        const stored = await this._secrets?.get('keepr.github.token');
        if (stored) { return stored; }
        return vscode.workspace.getConfiguration('keepr.github').get<string>('token');
    }

    initSecrets(secrets: vscode.SecretStorage): void {
        this._secrets = secrets;
    }

    isConfigured(): boolean {
        return !!(this.owner && this.repo);
    }

    async storeToken(token: string): Promise<void> {
        if (this._tokenSetter) { await this._tokenSetter(token); return; }
        await this._secrets?.store('keepr.github.token', token);
    }

    getTicketUrl(ticketId: string): string | undefined {
        const owner = this.owner;
        const repo = this.repo;
        if (!owner || !repo || !ticketId) { return undefined; }
        const id = ticketId.replace(/^#/, '');
        return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${encodeURIComponent(id)}`;
    }

    async searchTickets(query: string): Promise<TicketInfo[]> {
        const owner = this.owner;
        const repo = this.repo;
        const token = await this.getToken();
        if (!owner || !repo) { return []; }

        try {
            const headers: Record<string, string> = {
                'Accept': 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
            };
            if (token) {
                headers['Authorization'] = `Bearer ${token}`;
            }

            const isNumeric = /^\d+$/.test(query.trim());
            let results: TicketInfo[] = [];

            if (isNumeric) {
                // Fetch issue by number directly
                const resp = await fetch(
                    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${query.trim()}`,
                    { headers },
                );
                if (resp.ok) {
                    const issue = await resp.json() as GitHubIssue;
                    results = [this.mapIssue(issue)];
                }
            } else {
                // Search issues and PRs
                const q = encodeURIComponent(`repo:${owner}/${repo} ${query} in:title`);
                const resp = await fetch(
                    `https://api.github.com/search/issues?q=${q}&per_page=15`,
                    { headers },
                );
                if (!resp.ok) {
                    if (resp.status === 401 || resp.status === 403) {
                        this.warnAuthScopeIssue();
                    }
                    return [];
                }
                const data = await resp.json() as { items?: GitHubIssue[] };
                results = (data.items ?? []).map((i) => this.mapIssue(i));
            }

            return results;
        } catch (err) {
            console.error('KeepR: GitHub search failed', err);
            return [];
        }
    }

    async getMyTickets(): Promise<UserRelatedTicketInfo[]> {
        const qualifiers: Array<{ q: string; relation: string }> = [
            { q: 'assignee:@me is:issue', relation: 'assigned' },
            { q: 'author:@me is:issue', relation: 'created' },
            { q: 'mentions:@me is:issue', relation: 'mentioned' },
            { q: 'commenter:@me is:issue', relation: 'commented' },
        ];

        const all = new Map<string, UserRelatedTicketInfo>();
        for (const query of qualifiers) {
            const items = await this.searchRelatedIssues(query.q, query.relation);
            for (const item of items) {
                const prev = all.get(item.id);
                if (!prev) {
                    all.set(item.id, item);
                } else if (prev.relation && item.relation && prev.relation !== item.relation) {
                    prev.relation = 'involved';
                }
            }
        }

        return [...all.values()];
    }

    async getMyPullRequests(): Promise<UserRelatedPullRequestInfo[]> {
        const qualifiers: Array<{ q: string; relation: string }> = [
            { q: 'author:@me is:pr', relation: 'authored' },
            { q: 'review-requested:@me is:pr', relation: 'reviewer' },
            { q: 'reviewed-by:@me is:pr', relation: 'approved' },
            { q: 'mentions:@me is:pr', relation: 'mentioned' },
            { q: 'commenter:@me is:pr', relation: 'commented' },
            { q: 'involves:@me is:pr', relation: 'involved' },
        ];

        const all = new Map<string, UserRelatedPullRequestInfo>();
        for (const query of qualifiers) {
            const items = await this.searchRelatedPullRequests(query.q, query.relation);
            for (const item of items) {
                const key = item.id ?? item.url;
                const prev = all.get(key);
                if (!prev) {
                    all.set(key, item);
                } else if (prev.relation && item.relation && prev.relation !== item.relation) {
                    prev.relation = 'involved';
                }
            }
        }

        return [...all.values()];
    }

    async getTicketDetails(ticketId: string): Promise<TicketDetails | undefined> {
        const id = ticketId.replace(/^#/, '');
        const cached = this.detailsCache.get(id);
        if (cached && (Date.now() - cached._fetchedAt) < GitHubProvider.CACHE_TTL) {
            return cached;
        }

        const owner = this.owner;
        const repo = this.repo;
        const token = await this.getToken();
        if (!owner || !repo) { return undefined; }

        try {
            const headers: Record<string, string> = {
                'Accept': 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
            };
            if (token) {
                headers['Authorization'] = `Bearer ${token}`;
            }

            // Fetch issue
            const issueResp = await fetch(
                `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${encodeURIComponent(id)}`,
                { headers },
            );
            if (!issueResp.ok) {
                if (issueResp.status === 401 || issueResp.status === 403) {
                    this.warnAuthScopeIssue();
                }
                return undefined;
            }
            const issue = await issueResp.json() as GitHubIssue;

            const details: TicketDetails = {
                ...this.mapIssue(issue),
                boardColumn: undefined,
                description: issue.body,
                children: [],
                branches: [],
                pullRequests: [],
                _fetchedAt: Date.now(),
            };

            // Fetch timeline events to find linked branches and PRs
            if (token) {
                try {
                    const eventsResp = await fetch(
                        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${encodeURIComponent(id)}/timeline?per_page=100`,
                        { headers },
                    );
                    if (eventsResp.status === 401 || eventsResp.status === 403) {
                        this.warnAuthScopeIssue();
                    }
                    if (eventsResp.ok) {
                        const events = await eventsResp.json() as GitHubTimelineEvent[];
                        const seenBranches = new Set<string>();
                        const seenPRs = new Set<number>();

                        for (const event of events) {
                            if (event.event === 'cross-referenced' && event.source?.issue?.pull_request) {
                                const pr = event.source.issue;
                                if (!seenPRs.has(pr.number)) {
                                    seenPRs.add(pr.number);
                                    details.pullRequests.push({
                                        title: pr.title ?? `PR #${pr.number}`,
                                        url: pr.html_url ?? this.getTicketUrl(String(pr.number)) ?? '',
                                        status: pr.state ?? 'unknown',
                                    });

                                    // Try to get branch from PR
                                    if (pr.pull_request?.url) {
                                        try {
                                            const prResp = await fetch(pr.pull_request.url, { headers });
                                            if (prResp.ok) {
                                                const prData = await prResp.json() as { head?: { ref?: string } };
                                                if (prData.head?.ref && !seenBranches.has(prData.head.ref)) {
                                                    seenBranches.add(prData.head.ref);
                                                    details.branches.push(prData.head.ref);
                                                }
                                            }
                                        } catch { /* skip branch fetch failure */ }
                                    }
                                }
                            }
                            if (event.event === 'referenced' && event.commit_id) {
                                // Could extract branch from commit, but limited without more context
                            }
                        }
                    }
                } catch { /* skip timeline failure */ }
            }

            this.detailsCache.set(id, details);
            return details;
        } catch (err) {
            console.error('KeepR: Failed to fetch GitHub issue details', err);
            return undefined;
        }
    }

    invalidateCache(ticketId: string): void {
        this.detailsCache.delete(ticketId.replace(/^#/, ''));
    }

    clearCache(): void {
        this.detailsCache.clear();
    }

    private mapIssue(issue: GitHubIssue): TicketInfo {
        return {
            id: String(issue.number),
            title: issue.title ?? '',
            type: issue.pull_request ? 'Pull Request' : 'Issue',
            state: issue.state ?? 'unknown',
            assignedTo: issue.assignee?.login,
            url: issue.html_url,
        };
    }

    private warnAuthScopeIssue(): void {
        if (this.authWarningShown) { return; }
        this.authWarningShown = true;
        vscode.window.showWarningMessage(
            'KeepR: GitHub token missing permissions for full details. For fine-grained PATs, grant Issues (Read) and Pull requests (Read).',
        );
    }

    private async searchRelatedIssues(queryPart: string, relation: string): Promise<UserRelatedTicketInfo[]> {
        const owner = this.owner;
        const repo = this.repo;
        const token = await this.getToken();
        if (!owner || !repo) { return []; }

        try {
            const headers: Record<string, string> = {
                'Accept': 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
            };
            if (token) { headers['Authorization'] = `Bearer ${token}`; }

            const q = encodeURIComponent(`repo:${owner}/${repo} ${queryPart}`);
            const resp = await fetch(`https://api.github.com/search/issues?q=${q}&per_page=30`, { headers });
            if (!resp.ok) { return []; }

            const data = await resp.json() as { items?: GitHubIssue[] };
            return (data.items ?? []).map((issue) => ({
                ...this.mapIssue(issue),
                relation,
                createdAt: issue.created_at,
                updatedAt: issue.updated_at,
            }));
        } catch {
            return [];
        }
    }

    private async searchRelatedPullRequests(queryPart: string, relation: string): Promise<UserRelatedPullRequestInfo[]> {
        const owner = this.owner;
        const repo = this.repo;
        const token = await this.getToken();
        if (!owner || !repo) { return []; }

        try {
            const headers: Record<string, string> = {
                'Accept': 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
            };
            if (token) { headers['Authorization'] = `Bearer ${token}`; }

            const q = encodeURIComponent(`repo:${owner}/${repo} ${queryPart}`);
            const resp = await fetch(`https://api.github.com/search/issues?q=${q}&per_page=30`, { headers });
            if (!resp.ok) { return []; }

            const data = await resp.json() as { items?: GitHubIssue[] };
            return (data.items ?? []).map((issue) => ({
                id: String(issue.number),
                title: issue.title ?? `PR #${issue.number}`,
                url: issue.html_url ?? '',
                status: issue.state ?? 'unknown',
                state: issue.state,
                relation,
                createdAt: issue.created_at,
                updatedAt: issue.updated_at,
                author: issue.user?.login,
            }));
        } catch {
            return [];
        }
    }
}

interface GitHubIssue {
    number: number;
    title?: string;
    state?: string;
    html_url?: string;
    body?: string;
    assignee?: { login?: string };
    pull_request?: { url?: string };
    labels?: { name?: string }[];
    created_at?: string;
    updated_at?: string;
    user?: { login?: string };
}

interface GitHubTimelineEvent {
    event?: string;
    commit_id?: string;
    source?: {
        issue?: GitHubIssue & {
            pull_request?: { url?: string };
        };
    };
}
