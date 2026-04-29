import * as vscode from 'vscode';
import { TicketProvider, TicketInfo, TicketDetails } from './types';

export class GitHubProvider implements TicketProvider {
    readonly id = 'github' as const;
    readonly displayName = 'GitHub';

    private _secrets: vscode.SecretStorage | undefined;
    private detailsCache = new Map<string, TicketDetails>();
    private static CACHE_TTL = 2 * 60 * 1000;

    private get owner(): string | undefined {
        return vscode.workspace.getConfiguration('keepr.github').get<string>('owner');
    }

    private get repo(): string | undefined {
        return vscode.workspace.getConfiguration('keepr.github').get<string>('repo');
    }

    private async getToken(): Promise<string | undefined> {
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
                    if (resp.status === 401) {
                        vscode.window.showWarningMessage('KeepR: GitHub token is invalid or expired.');
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
            if (!issueResp.ok) { return undefined; }
            const issue = await issueResp.json() as GitHubIssue;

            const details: TicketDetails = {
                ...this.mapIssue(issue),
                boardColumn: undefined,
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
        };
    }
}

interface GitHubIssue {
    number: number;
    title?: string;
    state?: string;
    html_url?: string;
    assignee?: { login?: string };
    pull_request?: { url?: string };
    labels?: { name?: string }[];
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
