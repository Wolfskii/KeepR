import * as vscode from 'vscode';
import { TicketProvider, TicketInfo, TicketDetails, ProviderId } from './types';
import { AzureDevOpsProvider } from './azureDevOps';
import { GitHubProvider } from './github';
import { JiraProvider } from './jira';

/**
 * Manages ticket providers and delegates to the active one.
 * The active provider is set by `keepr.ticketProvider` setting.
 */
export class ProviderManager {
    private providers = new Map<ProviderId, TicketProvider>();
    private readonly _onDidChangeProvider = new vscode.EventEmitter<ProviderId | undefined>();
    readonly onDidChangeProvider = this._onDidChangeProvider.event;

    constructor() {
        this.providers.set('azureDevOps', new AzureDevOpsProvider());
        this.providers.set('github', new GitHubProvider());
        this.providers.set('jira', new JiraProvider());
    }

    /** Initialize secret storage for all providers */
    initSecrets(secrets: vscode.SecretStorage): void {
        for (const provider of this.providers.values()) {
            provider.initSecrets(secrets);
        }
    }

    /** The currently selected provider ID from settings */
    get activeProviderId(): ProviderId | undefined {
        const id = vscode.workspace.getConfiguration('keepr').get<string>('ticketProvider');
        if (id && this.providers.has(id as ProviderId)) {
            return id as ProviderId;
        }
        return undefined;
    }

    /** The currently active provider, or undefined if none selected */
    get activeProvider(): TicketProvider | undefined {
        const id = this.activeProviderId;
        return id ? this.providers.get(id) : undefined;
    }

    /** Get a specific provider by ID */
    getProvider(id: ProviderId): TicketProvider | undefined {
        return this.providers.get(id);
    }

    /** All registered providers */
    getAllProviders(): TicketProvider[] {
        return [...this.providers.values()];
    }

    /** Whether the active provider is fully configured */
    isConfigured(): boolean {
        return this.activeProvider?.isConfigured() ?? false;
    }

    /** Store token for the active provider */
    async storeToken(token: string): Promise<void> {
        await this.activeProvider?.storeToken(token);
    }

    /** Search tickets using the active provider */
    async searchTickets(query: string): Promise<TicketInfo[]> {
        return this.activeProvider?.searchTickets(query) ?? [];
    }

    /** Get ticket details using the active provider */
    async getTicketDetails(ticketId: string): Promise<TicketDetails | undefined> {
        return this.activeProvider?.getTicketDetails(ticketId);
    }

    /** Get ticket URL using the active provider */
    getTicketUrl(ticketId: string): string | undefined {
        return this.activeProvider?.getTicketUrl(ticketId);
    }

    /** Invalidate cache entry */
    invalidateCache(ticketId: string): void {
        this.activeProvider?.invalidateCache(ticketId);
    }

    /** Clear all cached data */
    clearCache(): void {
        this.activeProvider?.clearCache();
    }

    /** Listen for provider setting changes and fire event */
    watchConfigChanges(context: vscode.ExtensionContext): void {
        context.subscriptions.push(
            vscode.workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration('keepr.ticketProvider')) {
                    this._onDidChangeProvider.fire(this.activeProviderId);
                }
            }),
        );
    }

    dispose(): void {
        this._onDidChangeProvider.dispose();
    }
}
