import * as vscode from 'vscode';

export interface WorkItem {
    id: number;
    title: string;
    type: string;
    state: string;
    assignedTo?: string;
}

/**
 * Lightweight Azure DevOps REST client for searching work items.
 * Uses the WIQL query endpoint — no SDK dependency needed.
 */
export class AzureDevOpsService {
    private get orgUrl(): string | undefined {
        return vscode.workspace.getConfiguration('keepr.azureDevOps').get<string>('orgUrl');
    }

    private get project(): string | undefined {
        return vscode.workspace.getConfiguration('keepr.azureDevOps').get<string>('project');
    }

    private async getPat(): Promise<string | undefined> {
        // Try secret storage first, fall back to setting
        const stored = await AzureDevOpsService._secretStorage?.get('keepr.azureDevOps.pat');
        if (stored) { return stored; }
        return vscode.workspace.getConfiguration('keepr.azureDevOps').get<string>('pat');
    }

    private static _secretStorage: vscode.SecretStorage | undefined;

    static initSecretStorage(storage: vscode.SecretStorage): void {
        AzureDevOpsService._secretStorage = storage;
    }

    isConfigured(): boolean {
        return !!(this.orgUrl && this.project);
    }

    /** Store PAT securely in VS Code's secret storage */
    async storePat(pat: string): Promise<void> {
        await AzureDevOpsService._secretStorage?.store('keepr.azureDevOps.pat', pat);
    }

    /** Search work items by text query */
    async searchWorkItems(query: string): Promise<WorkItem[]> {
        const orgUrl = this.orgUrl;
        const project = this.project;
        const pat = await this.getPat();
        if (!orgUrl || !project || !pat) { return []; }

        try {
            // WIQL search — finds by ID if numeric, otherwise by title text
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

            // Fetch work item details in batch
            const batchUrl = `${this.normalizeUrl(orgUrl)}/_apis/wit/workitems?ids=${ids.join(',')}&fields=System.Id,System.Title,System.WorkItemType,System.State,System.AssignedTo&api-version=7.0`;

            const batchResponse = await fetch(batchUrl, {
                headers: {
                    'Authorization': `Basic ${Buffer.from(':' + pat).toString('base64')}`,
                },
            });

            if (!batchResponse.ok) { return []; }

            const batchData = await batchResponse.json() as {
                value?: {
                    id: number;
                    fields: Record<string, any>;
                }[];
            };

            return (batchData.value ?? []).map((wi) => ({
                id: wi.id,
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

    private normalizeUrl(url: string): string {
        return url.replace(/\/+$/, '');
    }

    private escapeWiql(text: string): string {
        return text.replace(/'/g, "''");
    }
}
