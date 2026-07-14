import * as vscode from 'vscode';
import { TicketProvider, TicketInfo, TicketDetails, UserRelatedPullRequestInfo, UserRelatedTicketInfo } from './types';

export interface JiraConfig {
    baseUrl: string;
    email: string;
    hosting: 'cloud' | 'server';
}

export class JiraProvider implements TicketProvider {
    readonly id = 'jira' as const;
    readonly displayName = 'Jira';

    private _config: JiraConfig | undefined;
    private _tokenGetter: (() => Promise<string | undefined>) | undefined;
    private _tokenSetter: ((token: string) => Promise<void>) | undefined;
    private _secrets: vscode.SecretStorage | undefined;
    private detailsCache = new Map<string, TicketDetails>();
    private static CACHE_TTL = 2 * 60 * 1000;
    private authWarningShown = false;

    constructor(config?: JiraConfig, tokenGetter?: () => Promise<string | undefined>, tokenSetter?: (token: string) => Promise<void>) {
        this._config = config;
        this._tokenGetter = tokenGetter;
        this._tokenSetter = tokenSetter;
    }

    private get hosting(): 'cloud' | 'server' {
        if (this._config) { return this._config.hosting; }
        const val = vscode.workspace.getConfiguration('keepr.jira').get<string>('hosting');
        return val === 'server' ? 'server' : 'cloud';
    }

    private get isServer(): boolean {
        return this.hosting === 'server';
    }

    private get baseUrl(): string | undefined {
        if (this._config) { return this._config.baseUrl; }
        return vscode.workspace.getConfiguration('keepr.jira').get<string>('baseUrl');
    }

    private get email(): string | undefined {
        if (this._config) { return this._config.email; }
        return vscode.workspace.getConfiguration('keepr.jira').get<string>('email');
    }

    private async getToken(): Promise<string | undefined> {
        if (this._tokenGetter) { return this._tokenGetter(); }
        const stored = await this._secrets?.get('keepr.jira.apiToken');
        if (stored) { return stored; }
        return vscode.workspace.getConfiguration('keepr.jira').get<string>('apiToken');
    }

    /** REST API base: v3 for Cloud, v2 for Server/DC */
    private get apiVersion(): string {
        return this.isServer ? '2' : '3';
    }

    initSecrets(secrets: vscode.SecretStorage): void {
        this._secrets = secrets;
    }

    isConfigured(): boolean {
        // Cloud requires email; Server can use PAT-only (no email/username needed)
        if (this.isServer) {
            return !!this.baseUrl;
        }
        return !!(this.baseUrl && this.email);
    }

    async storeToken(token: string): Promise<void> {
        if (this._tokenSetter) { await this._tokenSetter(token); return; }
        await this._secrets?.store('keepr.jira.apiToken', token);
    }

    getTicketUrl(ticketId: string): string | undefined {
        const baseUrl = this.baseUrl;
        if (!baseUrl || !ticketId) { return undefined; }
        const key = ticketId.replace(/^#/, '');
        return `${this.normalizeUrl(baseUrl)}/browse/${encodeURIComponent(key)}`;
    }

    async searchTickets(query: string): Promise<TicketInfo[]> {
        const baseUrl = this.baseUrl;
        const email = this.email;
        const token = await this.getToken();
        if (!baseUrl || !token) { return []; }
        if (!this.isServer && !email) { return []; }

        try {
            const headers = this.authHeaders(email, token);

            // If query looks like a Jira key (ABC-123), search by key; otherwise text search
            const isKey = /^[A-Z]+-\d+$/i.test(query.trim());
            const jql = isKey
                ? `key = "${this.escapeJql(query.trim())}"`
                : `summary ~ "${this.escapeJql(query)}" ORDER BY updated DESC`;

            const url = `${this.normalizeUrl(baseUrl)}/rest/api/${this.apiVersion}/search?jql=${encodeURIComponent(jql)}&maxResults=15&fields=summary,issuetype,status,assignee`;

            const resp = await fetch(url, { headers });

            if (!resp.ok) {
                if (resp.status === 401 || resp.status === 403) {
                    this.warnAuthScopeIssue();
                }
                return [];
            }

            const data = await resp.json() as {
                issues?: JiraIssue[];
            };

            return (data.issues ?? []).map((issue) => this.mapIssue(issue));
        } catch (err) {
            console.error('KeepR: Jira search failed', err);
            return [];
        }
    }

    async getMyTickets(): Promise<UserRelatedTicketInfo[]> {
        const baseUrl = this.baseUrl;
        const email = this.email;
        const token = await this.getToken();
        if (!baseUrl || !token) { return []; }
        if (!this.isServer && !email) { return []; }

        try {
            const headers = this.authHeaders(email, token);
            const jql = '(assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser()) ORDER BY updated DESC';
            const url = `${this.normalizeUrl(baseUrl)}/rest/api/${this.apiVersion}/search?jql=${encodeURIComponent(jql)}&maxResults=50&fields=summary,issuetype,status,assignee,updated,created`;
            const resp = await fetch(url, { headers });
            if (!resp.ok) { return []; }

            const data = await resp.json() as { issues?: JiraIssue[] };
            return (data.issues ?? []).map((issue) => ({
                ...this.mapIssue(issue),
                relation: 'involved',
                updatedAt: issue.fields?.updated,
                createdAt: issue.fields?.created,
            }));
        } catch {
            return [];
        }
    }

    async getMyPullRequests(): Promise<UserRelatedPullRequestInfo[]> {
        // Jira does not expose first-class PR entities tied directly to user context in a portable way.
        return [];
    }

    async getTicketDetails(ticketId: string): Promise<TicketDetails | undefined> {
        const key = ticketId.replace(/^#/, '');

        const cached = this.detailsCache.get(key);
        if (cached && (Date.now() - cached._fetchedAt) < JiraProvider.CACHE_TTL) {
            return cached;
        }

        const baseUrl = this.baseUrl;
        const email = this.email;
        const token = await this.getToken();
        if (!baseUrl || !token) { return undefined; }
        if (!this.isServer && !email) { return undefined; }

        try {
            const headers = this.authHeaders(email, token);
            const base = this.normalizeUrl(baseUrl);

            // Fetch issue with status and development info
            const issueUrl = `${base}/rest/api/${this.apiVersion}/issue/${encodeURIComponent(key)}?fields=summary,description,issuetype,status,assignee,parent,subtasks`;
            const issueResp = await fetch(issueUrl, { headers });
            if (!issueResp.ok) {
                if (issueResp.status === 401 || issueResp.status === 403) {
                    this.warnAuthScopeIssue();
                }
                return undefined;
            }
            const issue = await issueResp.json() as JiraIssue;

            const details: TicketDetails = {
                ...this.mapIssue(issue),
                boardColumn: issue.fields?.status?.statusCategory?.name,
                description: this.jiraDescriptionToText(issue.fields?.description),
                children: (issue.fields?.subtasks ?? []).map((sub) => ({
                    id: sub.key ?? String(sub.id),
                    title: sub.fields?.summary ?? '',
                    type: sub.fields?.issuetype?.name ?? '',
                    state: sub.fields?.status?.name ?? '',
                    assignedTo: sub.fields?.assignee?.displayName,
                    url: this.getTicketUrl(sub.key ?? String(sub.id)),
                })),
                branches: [],
                pullRequests: [],
                _fetchedAt: Date.now(),
            };

            if (issue.fields?.parent) {
                const parent = issue.fields.parent;
                details.parent = {
                    id: parent.key ?? String(parent.id),
                    title: parent.fields?.summary ?? '',
                    type: parent.fields?.issuetype?.name ?? '',
                    state: parent.fields?.status?.name ?? '',
                    assignedTo: parent.fields?.assignee?.displayName,
                    url: this.getTicketUrl(parent.key ?? String(parent.id)),
                };
            }

            // Try to get dev info (branches/PRs) from the development field
            // This requires the Jira Development Tool integration to be enabled
            try {
                const devUrl = `${base}/rest/dev-status/latest/issue/detail?issueId=${issue.id}&applicationType=stash&dataType=pullrequest`;
                const devResp = await fetch(devUrl, { headers });
                if (devResp.ok) {
                    const devData = await devResp.json() as JiraDevInfo;
                    for (const detail of devData.detail ?? []) {
                        for (const pr of detail.pullRequests ?? []) {
                            details.pullRequests.push({
                                title: pr.name ?? `PR #${pr.id}`,
                                url: pr.url ?? '',
                                status: pr.status ?? 'unknown',
                            });
                            // Extract source branch
                            if (pr.source?.name && !details.branches.includes(pr.source.name)) {
                                details.branches.push(pr.source.name);
                            }
                        }
                    }
                }
            } catch { /* dev status API may not be available */ }

            // Also try the branch info endpoint
            try {
                const branchUrl = `${base}/rest/dev-status/latest/issue/detail?issueId=${issue.id}&applicationType=stash&dataType=branch`;
                const branchResp = await fetch(branchUrl, { headers });
                if (branchResp.ok) {
                    const branchData = await branchResp.json() as JiraDevInfo;
                    for (const detail of branchData.detail ?? []) {
                        for (const branch of detail.branches ?? []) {
                            if (branch.name && !details.branches.includes(branch.name)) {
                                details.branches.push(branch.name);
                            }
                        }
                    }
                }
            } catch { /* ignore */ }

            this.detailsCache.set(key, details);
            return details;
        } catch (err) {
            console.error('KeepR: Failed to fetch Jira issue details', err);
            return undefined;
        }
    }

    invalidateCache(ticketId: string): void {
        this.detailsCache.delete(ticketId.replace(/^#/, ''));
    }

    clearCache(): void {
        this.detailsCache.clear();
    }

    private normalizeUrl(url: string): string {
        return url.replace(/\/+$/, '');
    }

    private escapeJql(text: string): string {
        return text.replace(/["\\]/g, '\\$&');
    }

    private authHeaders(email: string | undefined, token: string): Record<string, string> {
        // Server/DC without email/username: use Bearer PAT auth
        if (this.isServer && !email) {
            return {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/json',
            };
        }
        // Cloud (email:apiToken) or Server with username (username:password)
        return {
            'Authorization': `Basic ${Buffer.from((email ?? '') + ':' + token).toString('base64')}`,
            'Accept': 'application/json',
        };
    }

    private mapIssue(issue: JiraIssue): TicketInfo {
        return {
            id: issue.key ?? String(issue.id),
            title: issue.fields?.summary ?? '',
            type: issue.fields?.issuetype?.name ?? '',
            state: issue.fields?.status?.name ?? '',
            assignedTo: issue.fields?.assignee?.displayName,
            url: this.getTicketUrl(issue.key ?? String(issue.id)),
        };
    }

    private warnAuthScopeIssue(): void {
        if (this.authWarningShown) { return; }
        this.authWarningShown = true;
        vscode.window.showWarningMessage(
            'KeepR: Jira credentials may be missing permissions. Ensure Browse Project access and linked Development Tools access for branch/PR details.',
        );
    }

    private jiraDescriptionToText(description: unknown): string | undefined {
        if (!description) { return undefined; }
        if (typeof description === 'string') {
            return description.trim() || undefined;
        }

        const lines: string[] = [];

        const walk = (node: any): void => {
            if (!node) { return; }
            if (typeof node === 'string') {
                lines.push(node);
                return;
            }
            if (node.type === 'text' && typeof node.text === 'string') {
                lines.push(node.text);
            }
            if (Array.isArray(node.content)) {
                for (const child of node.content) {
                    walk(child);
                }
                if (node.type === 'paragraph' || node.type === 'listItem') {
                    lines.push('\n');
                }
            }
        };

        walk(description);

        const normalized = lines.join('')
            .replace(/\r\n/g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
        return normalized || undefined;
    }
}

interface JiraIssue {
    id: string;
    key?: string;
    fields?: {
        summary?: string;
        description?: unknown;
        issuetype?: { name?: string };
        status?: {
            name?: string;
            statusCategory?: { name?: string };
        };
        assignee?: { displayName?: string };
        updated?: string;
        created?: string;
        parent?: JiraIssue;
        subtasks?: JiraIssue[];
    };
}

interface JiraDevInfo {
    detail?: {
        pullRequests?: {
            id?: string;
            name?: string;
            url?: string;
            status?: string;
            source?: { name?: string };
        }[];
        branches?: {
            name?: string;
            url?: string;
        }[];
    }[];
}
