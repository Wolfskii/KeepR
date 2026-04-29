import * as vscode from 'vscode';
import { TicketProvider, TicketInfo, TicketDetails } from './types';

export class AzureDevOpsProvider implements TicketProvider {
    readonly id = 'azureDevOps' as const;
    readonly displayName = 'Azure DevOps';

    private _secrets: vscode.SecretStorage | undefined;
    private detailsCache = new Map<number, TicketDetails>();
    private static CACHE_TTL = 2 * 60 * 1000;

    private get orgUrl(): string | undefined {
        return vscode.workspace.getConfiguration('keepr.azureDevOps').get<string>('orgUrl');
    }

    private get project(): string | undefined {
        return vscode.workspace.getConfiguration('keepr.azureDevOps').get<string>('project');
    }

    private async getToken(): Promise<string | undefined> {
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
                if (wiqlResponse.status === 401) {
                    vscode.window.showWarningMessage('KeepR: Azure DevOps PAT is invalid or expired.');
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

            if (!batchResponse.ok) { return []; }

            const batchData = await batchResponse.json() as {
                value?: { id: number; fields: Record<string, any> }[];
            };

            return (batchData.value ?? []).map((wi) => ({
                id: String(wi.id),
                title: wi.fields['System.Title'] ?? '',
                type: wi.fields['System.WorkItemType'] ?? '',
                state: wi.fields['System.State'] ?? '',
                assignedTo: wi.fields['System.AssignedTo']?.displayName,
            }));
        } catch (err) {
            console.error('KeepR: Azure DevOps search failed', err);
            return [];
        }
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
            if (!wiResp.ok) { return undefined; }
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
                boardColumn: fields['System.BoardColumn'],
                branches: [],
                pullRequests: [],
                _fetchedAt: Date.now(),
            };

            const relations = wiData.relations ?? [];
            for (const rel of relations) {
                if (rel.rel === 'ArtifactLink') {
                    const artifactUrl = rel.url ?? '';
                    const name = rel.attributes?.['name'] ?? '';

                    if (artifactUrl.includes('/GIT/Ref/') || name === 'Branch') {
                        const branchName = this.extractBranchName(artifactUrl);
                        if (branchName) { details.branches.push(branchName); }
                    } else if (artifactUrl.includes('/GIT/PullRequestId/') || name === 'Pull Request') {
                        const pr = await this.fetchPrFromArtifact(artifactUrl, headers, base);
                        if (pr) { details.pullRequests.push(pr); }
                    }
                }
            }

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
    ): Promise<{ title: string; url: string; status: string } | undefined> {
        try {
            const parts = artifactUrl.split('/');
            const prId = parts[parts.length - 1];
            if (!prId || isNaN(parseInt(prId, 10))) { return undefined; }

            const project = this.project!;
            const prUrl = `${baseUrl}/${encodeURIComponent(project)}/_apis/git/pullrequests/${prId}?api-version=7.0`;
            const resp = await fetch(prUrl, { headers });
            if (!resp.ok) { return undefined; }

            const pr = await resp.json() as {
                title?: string;
                status?: string;
                repository?: { name?: string };
                pullRequestId?: number;
            };

            const orgUrl = this.orgUrl!;
            const repoName = pr.repository?.name ?? '';
            const webUrl = `${this.normalizeUrl(orgUrl)}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repoName)}/pullrequest/${pr.pullRequestId}`;

            return {
                title: pr.title ?? `PR #${prId}`,
                url: webUrl,
                status: pr.status ?? 'unknown',
            };
        } catch {
            return undefined;
        }
    }
}
