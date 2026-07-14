import * as vscode from 'vscode';
import { TicketProvider, TicketInfo, TicketDetails, PullRequestInfo, TicketHierarchyRef, UserRelatedPullRequestInfo, UserRelatedTicketInfo } from './types';

export interface AzureDevOpsConfig {
    orgUrl: string;
    project: string;
}

interface AzureIdentity {
    id?: string;
    descriptor?: string;
    uniqueName?: string;
    displayName?: string;
}

interface AzureActor {
    id?: string;
    descriptor?: string;
    uniqueName?: string;
    displayName?: string;
    mailAddress?: string;
}

export class AzureDevOpsProvider implements TicketProvider {
    readonly id = 'azureDevOps' as const;
    readonly displayName = 'Azure DevOps';

    private _config: AzureDevOpsConfig | undefined;
    private _tokenGetter: (() => Promise<string | undefined>) | undefined;
    private _tokenSetter: ((token: string) => Promise<void>) | undefined;
    private _secrets: vscode.SecretStorage | undefined;
    private detailsCache = new Map<number, TicketDetails>();
    private static CACHE_TTL = 2 * 60 * 1000;
    private workItemWarningShown = false;
    private pullRequestWarningShown = false;

    constructor(config?: AzureDevOpsConfig, tokenGetter?: () => Promise<string | undefined>, tokenSetter?: (token: string) => Promise<void>) {
        this._config = config;
        this._tokenGetter = tokenGetter;
        this._tokenSetter = tokenSetter;
    }

    private get orgUrl(): string | undefined {
        if (this._config) { return this._config.orgUrl; }
        return vscode.workspace.getConfiguration('keepr.azureDevOps').get<string>('orgUrl');
    }

    private get project(): string | undefined {
        if (this._config) { return this._config.project; }
        return vscode.workspace.getConfiguration('keepr.azureDevOps').get<string>('project');
    }

    private async getToken(): Promise<string | undefined> {
        if (this._tokenGetter) { return this._tokenGetter(); }
        const stored = await this._secrets?.get('keepr.azureDevOps.pat');
        if (stored) { return stored; }
        return vscode.workspace.getConfiguration('keepr.azureDevOps').get<string>('pat');
    }

    initSecrets(secrets: vscode.SecretStorage): void {
        this._secrets = secrets;
    }

    isConfigured(): boolean {
        return !!(this.orgUrl && this.project);
    }

    async storeToken(token: string): Promise<void> {
        if (this._tokenSetter) { await this._tokenSetter(token); return; }
        await this._secrets?.store('keepr.azureDevOps.pat', token);
    }

    getTicketUrl(ticketId: string): string | undefined {
        const orgUrl = this.orgUrl;
        const project = this.project;
        if (!orgUrl || !project || !ticketId) { return undefined; }
        const id = ticketId.replace(/^#/, '');
        return `${this.normalizeUrl(orgUrl)}/${encodeURIComponent(project)}/_workitems/edit/${encodeURIComponent(id)}`;
    }

    async searchTickets(query: string): Promise<TicketInfo[]> {
        const orgUrl = this.orgUrl;
        const project = this.project;
        const pat = await this.getToken();
        if (!orgUrl || !project || !pat) { return []; }

        try {
            const isNumeric = /^\d+$/.test(query.trim());
            const wiql = isNumeric
                ? `SELECT [System.Id] FROM WorkItems WHERE [System.Id] = ${query.trim()} AND [System.TeamProject] = '${project}'`
                : `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${project}' AND [System.Title] CONTAINS '${this.escapeWiql(query)}' ORDER BY [System.ChangedDate] DESC`;

            const wiqlUrl = `${this.normalizeUrl(orgUrl)}/${encodeURIComponent(project)}/_apis/wit/wiql?api-version=7.0&$top=15`;

            const wiqlResponse = await fetch(wiqlUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Basic ${Buffer.from(':' + pat).toString('base64')}`,
                },
                body: JSON.stringify({ query: wiql }),
            });

            if (!wiqlResponse.ok) {
                if (wiqlResponse.status === 401 || wiqlResponse.status === 403) {
                    this.warnWorkItemAccessIssue();
                }
                return [];
            }

            const wiqlData = await wiqlResponse.json() as { workItems?: { id: number }[] };
            const ids = wiqlData.workItems?.map((wi) => wi.id) ?? [];
            if (ids.length === 0) { return []; }

            const batchUrl = `${this.normalizeUrl(orgUrl)}/_apis/wit/workitems?ids=${ids.join(',')}&fields=System.Id,System.Title,System.WorkItemType,System.State,System.AssignedTo&api-version=7.0`;

            const batchResponse = await fetch(batchUrl, {
                headers: {
                    'Authorization': `Basic ${Buffer.from(':' + pat).toString('base64')}`,
                },
            });

            if (!batchResponse.ok) {
                if (batchResponse.status === 401 || batchResponse.status === 403) {
                    this.warnWorkItemAccessIssue();
                }
                return [];
            }

            const batchData = await batchResponse.json() as {
                value?: { id: number; fields: Record<string, any> }[];
            };

            return (batchData.value ?? []).map((wi) => ({
                id: String(wi.id),
                title: wi.fields['System.Title'] ?? '',
                type: wi.fields['System.WorkItemType'] ?? '',
                state: wi.fields['System.State'] ?? '',
                assignedTo: wi.fields['System.AssignedTo']?.displayName,
                url: this.getTicketUrl(String(wi.id)),
            }));
        } catch (err) {
            console.error('KeepR: Azure DevOps search failed', err);
            return [];
        }
    }

    async getMyTickets(): Promise<UserRelatedTicketInfo[]> {
        const orgUrl = this.orgUrl;
        const project = this.project;
        const pat = await this.getToken();
        if (!orgUrl || !project || !pat) { return []; }

        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Basic ${Buffer.from(':' + pat).toString('base64')}`,
        };

        const assignedQuery = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${project}' AND [System.AssignedTo] = @Me ORDER BY [System.ChangedDate] DESC`;
        const createdQuery = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${project}' AND [System.CreatedBy] = @Me ORDER BY [System.ChangedDate] DESC`;

        const assigned = await this.queryMyWorkItemsByWiql(assignedQuery, 'assigned', headers);
        const created = await this.queryMyWorkItemsByWiql(createdQuery, 'created', headers);

        const map = new Map<string, UserRelatedTicketInfo>();
        for (const item of [...assigned, ...created]) {
            const prev = map.get(item.id);
            if (!prev) {
                map.set(item.id, item);
                continue;
            }
            if (prev.relation && item.relation && prev.relation !== item.relation) {
                prev.relation = 'assigned+created';
            }
        }

        return [...map.values()];
    }

    async getMyPullRequests(): Promise<UserRelatedPullRequestInfo[]> {
        const orgUrl = this.orgUrl;
        const project = this.project;
        const pat = await this.getToken();
        if (!orgUrl || !project || !pat) { return []; }

        const headers = {
            'Authorization': `Basic ${Buffer.from(':' + pat).toString('base64')}`,
        };

        const identity = await this.getCurrentIdentity(headers);
        const fallbackDisplayNames = await this.getFallbackDisplayNames(headers);
        if (!identity.id && !identity.descriptor && !identity.uniqueName && !identity.displayName && fallbackDisplayNames.length === 0) {
            return [];
        }

        const collected: UserRelatedPullRequestInfo[] = [];

        if (identity.id) {
            const reviewed = await this.queryMyPullRequests(project, identity.id, 'reviewer', headers);
            const authored = await this.queryMyPullRequests(project, identity.id, 'authored', headers);
            collected.push(...reviewed, ...authored);
        }

        // Fallback path for cases where reviewer/creator identity filters miss PRs.
        const fallback = await this.queryPullRequestsAcrossRepos(project, identity, fallbackDisplayNames, headers);
        collected.push(...fallback);

        const map = new Map<string, UserRelatedPullRequestInfo>();
        for (const item of collected) {
            const key = item.id ?? item.url;
            const prev = map.get(key);
            if (!prev) {
                map.set(key, item);
                continue;
            }
            if (prev.relation && item.relation && prev.relation !== item.relation) {
                const merged = new Set<string>(`${prev.relation}+${item.relation}`.split('+').filter(Boolean));
                if (merged.has('reviewer') && merged.has('authored')) {
                    prev.relation = 'reviewer+authored';
                } else if (merged.has('approved') && merged.has('authored')) {
                    prev.relation = 'reviewer+authored';
                } else if (merged.has('approved')) {
                    prev.relation = 'approved';
                }
            }
            if (!prev.relation && item.relation) {
                prev.relation = item.relation;
            }
        }

        return [...map.values()];
    }

    async getTicketDetails(ticketId: string): Promise<TicketDetails | undefined> {
        const id = parseInt(ticketId.replace(/^#/, ''), 10);
        if (isNaN(id)) { return undefined; }

        const cached = this.detailsCache.get(id);
        if (cached && (Date.now() - cached._fetchedAt) < AzureDevOpsProvider.CACHE_TTL) {
            return cached;
        }

        const orgUrl = this.orgUrl;
        const project = this.project;
        const pat = await this.getToken();
        if (!orgUrl || !project || !pat) { return undefined; }

        try {
            const headers = {
                'Authorization': `Basic ${Buffer.from(':' + pat).toString('base64')}`,
            };
            const base = this.normalizeUrl(orgUrl);

            const wiUrl = `${base}/_apis/wit/workitems/${id}?$expand=relations&api-version=7.0`;
            const wiResp = await fetch(wiUrl, { headers });
            if (!wiResp.ok) {
                if (wiResp.status === 401 || wiResp.status === 403) {
                    this.warnWorkItemAccessIssue();
                }
                return undefined;
            }
            const wiData = await wiResp.json() as {
                id: number;
                fields: Record<string, any>;
                relations?: { rel: string; url: string; attributes: Record<string, any> }[];
            };

            const fields = wiData.fields;
            const details: TicketDetails = {
                id: String(wiData.id),
                title: fields['System.Title'] ?? '',
                type: fields['System.WorkItemType'] ?? '',
                state: fields['System.State'] ?? '',
                assignedTo: fields['System.AssignedTo']?.displayName,
                url: this.getTicketUrl(String(wiData.id)),
                boardColumn: fields['System.BoardColumn'],
                description: this.toPlainText(fields['System.Description']),
                acceptanceCriteria: this.toPlainText(fields['Microsoft.VSTS.Common.AcceptanceCriteria']),
                children: [],
                branches: [],
                pullRequests: [],
                _fetchedAt: Date.now(),
            };

            const relations = wiData.relations ?? [];
            const parentIds = new Set<number>();
            const childIds = new Set<number>();
            for (const rel of relations) {
                if (rel.rel === 'System.LinkTypes.Hierarchy-Reverse') {
                    const parentId = this.extractWorkItemIdFromRelationUrl(rel.url);
                    if (parentId) { parentIds.add(parentId); }
                } else if (rel.rel === 'System.LinkTypes.Hierarchy-Forward') {
                    const childId = this.extractWorkItemIdFromRelationUrl(rel.url);
                    if (childId) { childIds.add(childId); }
                }

                if (rel.rel === 'ArtifactLink') {
                    const artifactUrl = rel.url ?? '';
                    const name = rel.attributes?.['name'] ?? '';

                    if (artifactUrl.includes('/GIT/Ref/') || name === 'Branch') {
                        const branchName = this.extractBranchName(artifactUrl);
                        if (branchName) { details.branches.push(branchName); }
                    } else if (artifactUrl.includes('/GIT/PullRequestId/') || name === 'Pull Request') {
                        const pr = await this.fetchPrFromArtifact(artifactUrl, headers, base, project);
                        if (pr) { details.pullRequests.push(pr); }
                    }
                }
            }

            const hierarchy = await this.fetchHierarchyRefs([...parentIds, ...childIds], headers, base);
            if (parentIds.size > 0) {
                const firstParentId = [...parentIds][0];
                if (firstParentId) {
                    details.parent = hierarchy.get(firstParentId);
                }
            }
            details.children = [...childIds]
                .map((cid) => hierarchy.get(cid))
                .filter((child): child is TicketHierarchyRef => !!child);

            this.detailsCache.set(id, details);
            return details;
        } catch (err) {
            console.error('KeepR: Failed to fetch work item details', err);
            return undefined;
        }
    }

    invalidateCache(ticketId: string): void {
        const id = parseInt(ticketId.replace(/^#/, ''), 10);
        if (!isNaN(id)) { this.detailsCache.delete(id); }
    }

    clearCache(): void {
        this.detailsCache.clear();
    }

    private normalizeUrl(url: string): string {
        return url.replace(/\/+$/, '');
    }

    private escapeWiql(text: string): string {
        return text.replace(/'/g, "''");
    }

    private extractBranchName(artifactUrl: string): string | undefined {
        try {
            const parts = artifactUrl.split('/');
            const gbPart = parts.find(p => p.startsWith('GB'));
            if (gbPart) {
                return decodeURIComponent(gbPart.slice(2));
            }
        } catch { /* ignore */ }
        return undefined;
    }

    private async fetchPrFromArtifact(
        artifactUrl: string,
        headers: Record<string, string>,
        baseUrl: string,
        project: string,
    ): Promise<PullRequestInfo | undefined> {
        try {
            const parts = artifactUrl.split('/');
            const prId = parts[parts.length - 1];
            if (!prId || isNaN(parseInt(prId, 10))) { return undefined; }

            const prUrl = `${baseUrl}/${encodeURIComponent(project)}/_apis/git/pullrequests/${prId}?api-version=7.0`;
            const resp = await fetch(prUrl, { headers });
            if (!resp.ok) { return undefined; }

            const pr = await resp.json() as {
                title?: string;
                status?: string;
                repository?: { id?: string; name?: string };
                pullRequestId?: number;
                sourceRefName?: string;
                targetRefName?: string;
            };

            const orgUrl = this.orgUrl!;
            const repoName = pr.repository?.name ?? '';
            const webUrl = `${this.normalizeUrl(orgUrl)}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repoName)}/pullrequest/${pr.pullRequestId}`;

            const sourceBranch = this.normalizeRefName(pr.sourceRefName);
            const targetBranch = this.normalizeRefName(pr.targetRefName);

            const prInfo: PullRequestInfo = {
                id: pr.pullRequestId ? String(pr.pullRequestId) : prId,
                title: pr.title ?? `PR #${prId}`,
                url: webUrl,
                status: pr.status ?? 'unknown',
                sourceBranch,
                targetBranch,
            };

            const repositoryId = pr.repository?.id;
            if (repositoryId && pr.pullRequestId) {
                prInfo.changes = await this.fetchPrChanges(baseUrl, project, repositoryId, pr.pullRequestId, headers);
            }

            return prInfo;
        } catch {
            return undefined;
        }
    }

    private async fetchPrChanges(
        baseUrl: string,
        project: string,
        repositoryId: string,
        pullRequestId: number,
        headers: Record<string, string>,
    ): Promise<{ fileCount?: number; changedFiles: string[] } | undefined> {
        try {
            const iterationsUrl = `${baseUrl}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repositoryId)}/pullRequests/${pullRequestId}/iterations?api-version=7.0`;
            const iterationsResp = await fetch(iterationsUrl, { headers });
            if (!iterationsResp.ok) {
                if (iterationsResp.status === 401 || iterationsResp.status === 403) {
                    this.warnPullRequestAccessIssue();
                }
                return undefined;
            }

            const iterationsData = await iterationsResp.json() as { value?: { id?: number }[] };
            const maxIteration = Math.max(...(iterationsData.value ?? []).map((i) => i.id ?? 0));
            if (!maxIteration) { return undefined; }

            const changesUrl = `${baseUrl}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repositoryId)}/pullRequests/${pullRequestId}/iterations/${maxIteration}/changes?api-version=7.0&$top=1000`;
            const changesResp = await fetch(changesUrl, { headers });
            if (!changesResp.ok) {
                if (changesResp.status === 401 || changesResp.status === 403) {
                    this.warnPullRequestAccessIssue();
                }
                return undefined;
            }

            const changesData = await changesResp.json() as {
                changeEntries?: { item?: { path?: string } }[];
                changeCounts?: Record<string, number>;
            };

            const changedFiles = (changesData.changeEntries ?? [])
                .map((c) => c.item?.path)
                .filter((p): p is string => !!p)
                .slice(0, 50);

            const fileCount = Object.values(changesData.changeCounts ?? {}).reduce((sum, n) => sum + n, 0);

            return {
                fileCount: fileCount || changedFiles.length,
                changedFiles,
            };
        } catch {
            return undefined;
        }
    }

    private normalizeRefName(ref?: string): string | undefined {
        if (!ref) { return undefined; }
        return ref.replace(/^refs\/heads\//, '');
    }

    private extractWorkItemIdFromRelationUrl(url: string | undefined): number | undefined {
        if (!url) { return undefined; }
        const match = url.match(/\/workItems\/(\d+)$/i);
        if (!match) { return undefined; }
        const id = parseInt(match[1], 10);
        return isNaN(id) ? undefined : id;
    }

    private async fetchHierarchyRefs(
        ids: number[],
        headers: Record<string, string>,
        baseUrl: string,
    ): Promise<Map<number, TicketHierarchyRef>> {
        const result = new Map<number, TicketHierarchyRef>();
        if (ids.length === 0) { return result; }

        try {
            const uniqueIds = [...new Set(ids)].filter((id) => Number.isFinite(id));
            const url = `${baseUrl}/_apis/wit/workitems?ids=${uniqueIds.join(',')}&fields=System.Id,System.Title,System.WorkItemType,System.State,System.AssignedTo&api-version=7.0`;
            const resp = await fetch(url, { headers });
            if (!resp.ok) { return result; }

            const data = await resp.json() as { value?: { id: number; fields: Record<string, any> }[] };
            for (const wi of data.value ?? []) {
                result.set(wi.id, {
                    id: String(wi.id),
                    title: wi.fields['System.Title'] ?? '',
                    type: wi.fields['System.WorkItemType'] ?? '',
                    state: wi.fields['System.State'] ?? '',
                    assignedTo: wi.fields['System.AssignedTo']?.displayName,
                    url: this.getTicketUrl(String(wi.id)),
                });
            }
        } catch {
            // Ignore hierarchy fetch failures; base details are still useful.
        }

        return result;
    }

    private toPlainText(value: unknown): string | undefined {
        if (typeof value !== 'string') { return undefined; }
        const withoutTags = value
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/p>/gi, '\n\n')
            .replace(/<li>/gi, '- ')
            .replace(/<\/li>/gi, '\n')
            .replace(/<[^>]+>/g, '');
        const normalized = withoutTags
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/\r\n/g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
        return normalized || undefined;
    }

    private warnWorkItemAccessIssue(): void {
        if (this.workItemWarningShown) { return; }
        this.workItemWarningShown = true;
        vscode.window.showWarningMessage(
            'KeepR: Unable to read Azure DevOps work items/tickets. Required PAT scope: Work Items (Read). Also ensure your account has access to this project.',
        );
    }

    private warnPullRequestAccessIssue(): void {
        if (this.pullRequestWarningShown) { return; }
        this.pullRequestWarningShown = true;
        vscode.window.showWarningMessage(
            'KeepR: Unable to read Azure DevOps pull requests/code data. Required PAT scopes: Code (Read) and Code (Status). Also ensure your account has access to target repositories.',
        );
    }

    private async queryMyWorkItemsByWiql(
        wiql: string,
        relation: string,
        headers: Record<string, string>,
    ): Promise<UserRelatedTicketInfo[]> {
        const orgUrl = this.orgUrl;
        const project = this.project;
        if (!orgUrl || !project) { return []; }

        try {
            const wiqlUrl = `${this.normalizeUrl(orgUrl)}/${encodeURIComponent(project)}/_apis/wit/wiql?api-version=7.0&$top=50`;
            const wiqlResp = await fetch(wiqlUrl, {
                method: 'POST',
                headers,
                body: JSON.stringify({ query: wiql }),
            });
            if (!wiqlResp.ok) {
                if (wiqlResp.status === 401 || wiqlResp.status === 403) {
                    this.warnWorkItemAccessIssue();
                }
                return [];
            }

            const wiqlData = await wiqlResp.json() as { workItems?: { id: number }[] };
            const ids = wiqlData.workItems?.map((w) => w.id) ?? [];
            if (ids.length === 0) { return []; }

            const batchUrl = `${this.normalizeUrl(orgUrl)}/_apis/wit/workitems?ids=${ids.join(',')}&fields=System.Id,System.Title,System.WorkItemType,System.State,System.AssignedTo,System.ChangedDate,System.CreatedDate&api-version=7.0`;
            const batchResp = await fetch(batchUrl, { headers: { Authorization: headers.Authorization } });
            if (!batchResp.ok) {
                if (batchResp.status === 401 || batchResp.status === 403) {
                    this.warnWorkItemAccessIssue();
                }
                return [];
            }

            const batchData = await batchResp.json() as { value?: { id: number; fields: Record<string, any> }[] };
            return (batchData.value ?? []).map((wi) => ({
                id: String(wi.id),
                title: wi.fields['System.Title'] ?? '',
                type: wi.fields['System.WorkItemType'] ?? '',
                state: wi.fields['System.State'] ?? '',
                assignedTo: wi.fields['System.AssignedTo']?.displayName,
                url: this.getTicketUrl(String(wi.id)),
                relation,
                updatedAt: wi.fields['System.ChangedDate'],
                createdAt: wi.fields['System.CreatedDate'],
            }));
        } catch {
            return [];
        }
    }

    private async getCurrentIdentity(headers: Record<string, string>): Promise<AzureIdentity> {
        const orgUrl = this.orgUrl;
        if (!orgUrl) { return {}; }

        try {
            const url = `${this.normalizeUrl(orgUrl)}/_apis/connectionData?connectOptions=IncludeServices&lastChangeId=-1&lastChangeId64=-1&api-version=7.0`;
            const resp = await fetch(url, { headers });
            if (resp.status === 401 || resp.status === 403) {
                this.warnPullRequestAccessIssue();
            }
            if (!resp.ok) { return {}; }
            const data = await resp.json() as {
                authenticatedUser?: { id?: string; descriptor?: string; uniqueName?: string; providerDisplayName?: string; customDisplayName?: string };
                authorizedUser?: { id?: string; descriptor?: string; uniqueName?: string; providerDisplayName?: string; customDisplayName?: string };
            };
            const user = data.authenticatedUser ?? data.authorizedUser;
            if (!user) { return {}; }
            return {
                id: user.id,
                descriptor: user.descriptor,
                uniqueName: user.uniqueName,
                displayName: user.providerDisplayName ?? user.customDisplayName,
            };
        } catch {
            return {};
        }
    }

    private async queryPullRequestsAcrossRepos(
        project: string,
        identity: AzureIdentity,
        fallbackDisplayNames: string[],
        headers: Record<string, string>,
    ): Promise<UserRelatedPullRequestInfo[]> {
        const orgUrl = this.orgUrl;
        if (!orgUrl) { return []; }

        try {
            const base = this.normalizeUrl(orgUrl);
            const reposUrl = `${base}/${encodeURIComponent(project)}/_apis/git/repositories?api-version=7.0`;
            const reposResp = await fetch(reposUrl, { headers });
            if (reposResp.status === 401 || reposResp.status === 403) {
                this.warnPullRequestAccessIssue();
            }
            if (!reposResp.ok) { return []; }

            const reposData = await reposResp.json() as {
                value?: Array<{ id?: string; name?: string }>;
            };

            const results: UserRelatedPullRequestInfo[] = [];

            const statuses = ['active', 'completed', 'abandoned'];

            for (const repo of reposData.value ?? []) {
                const repoId = repo.id;
                if (!repoId) { continue; }

                for (const status of statuses) {
                    const prsUrl = `${base}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repoId)}/pullrequests?searchCriteria.status=${encodeURIComponent(status)}&$top=200&api-version=7.0`;
                    const prsResp = await fetch(prsUrl, { headers });
                    if (prsResp.status === 401 || prsResp.status === 403) {
                        this.warnPullRequestAccessIssue();
                    }
                    if (!prsResp.ok) { continue; }

                    const prsData = await prsResp.json() as {
                        value?: Array<{
                            pullRequestId?: number;
                            title?: string;
                            status?: string;
                            repository?: { name?: string };
                            sourceRefName?: string;
                            targetRefName?: string;
                            creationDate?: string;
                            closedDate?: string;
                            createdBy?: AzureActor;
                            reviewers?: Array<AzureActor & { vote?: number }>;
                        }>;
                    };

                    for (const pr of prsData.value ?? []) {
                        const isAuthor = this.matchesIdentity(pr.createdBy, identity, fallbackDisplayNames);
                        const myReview = pr.reviewers?.find((r) => this.matchesIdentity(r, identity, fallbackDisplayNames));
                        const isReviewer = !!myReview;
                        if (!isAuthor && !isReviewer) { continue; }

                        const prId = pr.pullRequestId ? String(pr.pullRequestId) : '';
                        const repoName = pr.repository?.name ?? repo.name ?? '';
                        const webUrl = `${base}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repoName)}/pullrequest/${encodeURIComponent(prId)}`;

                        let relation = isAuthor && isReviewer ? 'reviewer+authored' : (isAuthor ? 'authored' : 'reviewer');
                        if (!isAuthor && (myReview?.vote ?? 0) >= 10) {
                            relation = 'approved';
                        }

                        results.push({
                            id: prId,
                            title: pr.title ?? `PR #${prId}`,
                            url: webUrl,
                            status: pr.status ?? status,
                            state: pr.status ?? status,
                            sourceBranch: this.normalizeRefName(pr.sourceRefName),
                            targetBranch: this.normalizeRefName(pr.targetRefName),
                            relation,
                            createdAt: pr.creationDate,
                            updatedAt: pr.closedDate ?? pr.creationDate,
                            author: pr.createdBy?.displayName,
                        });
                    }
                }
            }

            return results;
        } catch {
            return [];
        }
    }

    private matchesIdentity(
        actor: AzureActor | undefined,
        identity: AzureIdentity,
        fallbackDisplayNames: string[] = [],
    ): boolean {
        if (!actor) { return false; }
        const actorId = (actor.id ?? '').toLowerCase();
        const actorDescriptor = (actor.descriptor ?? '').toLowerCase();
        const actorUnique = (actor.uniqueName ?? '').toLowerCase();
        const actorDisplay = (actor.displayName ?? '').toLowerCase();
        const actorMail = (actor.mailAddress ?? '').toLowerCase();

        const identityIds = [identity.id, identity.descriptor].filter(Boolean).map((v) => String(v).toLowerCase());
        const identityUnique = (identity.uniqueName ?? '').toLowerCase();
        const identityDisplay = (identity.displayName ?? '').toLowerCase();
        const fallbackDisplays = fallbackDisplayNames.map((name) => name.toLowerCase());

        if (actorId && identityIds.includes(actorId)) { return true; }
        if (actorDescriptor && identityIds.includes(actorDescriptor)) { return true; }
        if (actorUnique && identityIds.includes(actorUnique)) { return true; }
        if (actorMail && identityIds.includes(actorMail)) { return true; }
        if (identityUnique && (actorUnique === identityUnique || actorId === identityUnique)) { return true; }
        if (identityDisplay && actorDisplay && actorDisplay === identityDisplay) { return true; }
        if (fallbackDisplays.length > 0 && actorDisplay && fallbackDisplays.includes(actorDisplay)) { return true; }

        return false;
    }

    private async getFallbackDisplayNames(headers: Record<string, string>): Promise<string[]> {
        const names = new Set<string>();
        if (this._config) {
            for (const name of await this.getMyDisplayNamesFromTickets(headers)) {
                if (name) { names.add(name); }
            }
        }
        return [...names];
    }

    private async getMyDisplayNamesFromTickets(headers: Record<string, string>): Promise<string[]> {
        const orgUrl = this.orgUrl;
        const project = this.project;
        if (!orgUrl || !project) { return []; }

        try {
            const wiql = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${project}' AND [System.AssignedTo] = @Me ORDER BY [System.ChangedDate] DESC`;
            const wiqlUrl = `${this.normalizeUrl(orgUrl)}/${encodeURIComponent(project)}/_apis/wit/wiql?api-version=7.0&$top=10`;
            const wiqlResp = await fetch(wiqlUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: headers.Authorization,
                },
                body: JSON.stringify({ query: wiql }),
            });
            if (!wiqlResp.ok) { return []; }

            const wiqlData = await wiqlResp.json() as { workItems?: { id: number }[] };
            const ids = wiqlData.workItems?.map((w) => w.id) ?? [];
            if (ids.length === 0) { return []; }

            const batchUrl = `${this.normalizeUrl(orgUrl)}/_apis/wit/workitems?ids=${ids.join(',')}&fields=System.AssignedTo&api-version=7.0`;
            const batchResp = await fetch(batchUrl, { headers: { Authorization: headers.Authorization } });
            if (!batchResp.ok) { return []; }

            const batchData = await batchResp.json() as { value?: { fields: Record<string, any> }[] };
            const names = new Set<string>();
            for (const wi of batchData.value ?? []) {
                const displayName = wi.fields?.['System.AssignedTo']?.displayName;
                if (typeof displayName === 'string' && displayName.trim()) {
                    names.add(displayName.trim());
                }
            }
            return [...names];
        } catch {
            return [];
        }
    }

    private async queryMyPullRequests(
        project: string,
        identityId: string,
        relation: 'reviewer' | 'authored',
        headers: Record<string, string>,
    ): Promise<UserRelatedPullRequestInfo[]> {
        const orgUrl = this.orgUrl;
        if (!orgUrl) { return []; }

        try {
            const criteria = relation === 'reviewer'
                ? `searchCriteria.reviewerId=${encodeURIComponent(identityId)}`
                : `searchCriteria.creatorId=${encodeURIComponent(identityId)}`;
            const url = `${this.normalizeUrl(orgUrl)}/${encodeURIComponent(project)}/_apis/git/pullrequests?${criteria}&searchCriteria.status=all&$top=200&api-version=7.0`;
            const resp = await fetch(url, { headers });
            if (resp.status === 401 || resp.status === 403) {
                this.warnPullRequestAccessIssue();
            }
            if (!resp.ok) { return []; }

            const data = await resp.json() as {
                value?: Array<{
                    pullRequestId?: number;
                    title?: string;
                    status?: string;
                    repository?: { name?: string };
                    sourceRefName?: string;
                    targetRefName?: string;
                    creationDate?: string;
                    closedDate?: string;
                    createdBy?: { displayName?: string };
                    reviewers?: Array<{ id?: string; vote?: number }>;
                }>;
            };

            return (data.value ?? []).map((pr) => {
                const prId = pr.pullRequestId ? String(pr.pullRequestId) : '';
                const repoName = pr.repository?.name ?? '';
                const webUrl = `${this.normalizeUrl(orgUrl)}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repoName)}/pullrequest/${encodeURIComponent(prId)}`;

                let actualRelation: string = relation;
                if (relation === 'reviewer') {
                    const myReview = pr.reviewers?.find((r) => r.id === identityId);
                    if ((myReview?.vote ?? 0) >= 10) {
                        actualRelation = 'approved';
                    }
                }

                return {
                    id: prId,
                    title: pr.title ?? `PR #${prId}`,
                    url: webUrl,
                    status: pr.status ?? 'unknown',
                    state: pr.status,
                    sourceBranch: this.normalizeRefName(pr.sourceRefName),
                    targetBranch: this.normalizeRefName(pr.targetRefName),
                    relation: actualRelation,
                    createdAt: pr.creationDate,
                    updatedAt: pr.closedDate ?? pr.creationDate,
                    author: pr.createdBy?.displayName,
                } as UserRelatedPullRequestInfo;
            });
        } catch {
            return [];
        }
    }
}
