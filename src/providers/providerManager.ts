import * as vscode from 'vscode';
import { TicketProvider, TicketInfo, TicketDetails, ProviderId, UserRelatedPullRequestInfo, UserRelatedTicketInfo } from './types';
import { AzureDevOpsProvider } from './azureDevOps';
import { GitHubProvider } from './github';
import { JiraProvider } from './jira';
import { ConnectionStore, ProviderConnection } from './connectionStore';

/**
 * Manages ticket providers and delegates to the active one.
 * Supports multi-connection model (ConnectionStore) with fallback to legacy VS Code settings.
 */
export class ProviderManager {
    private _connectionStore: ConnectionStore | undefined;

    /** Legacy providers (used when no ConnectionStore or no connections exist) */
    private legacyProviders = new Map<ProviderId, TicketProvider>();

    /** Active provider instance built from the active connection */
    private _activeProvider: TicketProvider | undefined;
    private _activeConnectionId: string | undefined;

    private readonly _onDidChangeProvider = new vscode.EventEmitter<ProviderId | undefined>();
    readonly onDidChangeProvider = this._onDidChangeProvider.event;

    constructor() {
        // Legacy fallback providers (read from VS Code settings)
        this.legacyProviders.set('azureDevOps', new AzureDevOpsProvider());
        this.legacyProviders.set('github', new GitHubProvider());
        this.legacyProviders.set('jira', new JiraProvider());
    }

    /** Connection store for multi-connection mode */
    get connectionStore(): ConnectionStore | undefined {
        return this._connectionStore;
    }

    /** Initialize with ConnectionStore for multi-connection support */
    initConnectionStore(store: ConnectionStore): void {
        this._connectionStore = store;
        store.onDidChange(() => {
            this.rebuildActiveProvider();
            this._onDidChangeProvider.fire(this.activeProviderId);
        });
        this.rebuildActiveProvider();
    }

    /** Initialize secret storage for legacy providers */
    initSecrets(secrets: vscode.SecretStorage): void {
        for (const provider of this.legacyProviders.values()) {
            provider.initSecrets(secrets);
        }
    }

    /** Build a provider instance from a connection's config */
    private createProviderFromConnection(conn: ProviderConnection): TicketProvider {
        const store = this._connectionStore!;
        const tokenGetter = () => store.getToken(conn.id);
        const tokenSetter = (token: string) => store.storeToken(conn.id, token);

        switch (conn.type) {
            case 'azureDevOps':
                return new AzureDevOpsProvider(
                    { orgUrl: conn.config.orgUrl, project: conn.config.project },
                    tokenGetter,
                    tokenSetter,
                );
            case 'github':
                return new GitHubProvider(
                    { owner: conn.config.owner, repo: conn.config.repo },
                    tokenGetter,
                    tokenSetter,
                );
            case 'jira':
                return new JiraProvider(
                    {
                        baseUrl: conn.config.baseUrl,
                        email: conn.config.email ?? '',
                        hosting: (conn.config.hosting as 'cloud' | 'server') ?? 'cloud',
                    },
                    tokenGetter,
                    tokenSetter,
                );
            default:
                throw new Error(`Unknown provider type: ${conn.type}`);
        }
    }

    /** Rebuild the active provider from the connection store */
    private rebuildActiveProvider(): void {
        if (!this._connectionStore) { return; }
        const conn = this._connectionStore.getActive();
        if (conn) {
            this._activeProvider = this.createProviderFromConnection(conn);
            this._activeConnectionId = conn.id;
        } else {
            this._activeProvider = undefined;
            this._activeConnectionId = undefined;
        }
    }

    /** The currently selected provider ID */
    get activeProviderId(): ProviderId | undefined {
        // Connection store takes priority
        if (this._connectionStore) {
            const conn = this._connectionStore.getActive();
            return conn?.type;
        }
        // Legacy: from VS Code settings
        const id = vscode.workspace.getConfiguration('keepr').get<string>('ticketProvider');
        if (id && this.legacyProviders.has(id as ProviderId)) {
            return id as ProviderId;
        }
        return undefined;
    }

    /** The currently active provider */
    get activeProvider(): TicketProvider | undefined {
        // Connection store takes priority
        if (this._connectionStore) {
            const connections = this._connectionStore.getAll();
            if (connections.length > 0) {
                return this._activeProvider;
            }
        }
        // Legacy fallback
        const id = this.activeProviderId;
        return id ? this.legacyProviders.get(id) : undefined;
    }

    /** Get a specific provider by ID (legacy) */
    getProvider(id: ProviderId): TicketProvider | undefined {
        return this.legacyProviders.get(id);
    }

    /** All registered providers (legacy) */
    getAllProviders(): TicketProvider[] {
        return [...this.legacyProviders.values()];
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

    /** Tickets related to the logged-in user across all configured providers. */
    async getMyTicketsAcrossProviders(): Promise<AggregatedMyTicket[]> {
        const providers = this.getConfiguredProviders();
        const all: AggregatedMyTicket[] = [];

        for (const entry of providers) {
            try {
                const items = await entry.provider.getMyTickets();
                for (const item of items) {
                    all.push({
                        providerId: entry.provider.id,
                        providerLabel: entry.label,
                        item,
                    });
                }
            } catch {
                // Ignore provider-specific failures to keep merged results usable.
            }
        }

        return this.dedupeMyTickets(all);
    }

    /** Pull requests related to the logged-in user across all configured providers. */
    async getMyPullRequestsAcrossProviders(): Promise<AggregatedMyPullRequest[]> {
        const providers = this.getConfiguredProviders();
        const all: AggregatedMyPullRequest[] = [];

        for (const entry of providers) {
            try {
                const items = await entry.provider.getMyPullRequests();
                for (const item of items) {
                    all.push({
                        providerId: entry.provider.id,
                        providerLabel: entry.label,
                        item,
                    });
                }
            } catch {
                // Ignore provider-specific failures to keep merged results usable.
            }
        }

        return this.dedupeMyPullRequests(all);
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

    private getConfiguredProviders(): Array<{ provider: TicketProvider; label: string }> {
        const entries: Array<{ provider: TicketProvider; label: string }> = [];

        if (this._connectionStore) {
            const connections = this._connectionStore.getAll();
            for (const conn of connections) {
                try {
                    const provider = this.createProviderFromConnection(conn);
                    if (provider.isConfigured()) {
                        entries.push({ provider, label: conn.name });
                    }
                } catch {
                    // Skip invalid connection configs.
                }
            }
            return entries;
        }

        const active = this.activeProvider;
        if (active?.isConfigured()) {
            entries.push({ provider: active, label: active.displayName });
        }

        return entries;
    }

    private dedupeMyTickets(items: AggregatedMyTicket[]): AggregatedMyTicket[] {
        const map = new Map<string, AggregatedMyTicket>();
        for (const item of items) {
            const key = `${item.providerId}:${item.item.id}`;
            const prev = map.get(key);
            if (!prev) {
                map.set(key, item);
                continue;
            }
            // Merge relation info if duplicated from different provider-specific queries.
            if (!prev.item.relation && item.item.relation) {
                prev.item.relation = item.item.relation;
            }
        }
        return [...map.values()];
    }

    private dedupeMyPullRequests(items: AggregatedMyPullRequest[]): AggregatedMyPullRequest[] {
        const map = new Map<string, AggregatedMyPullRequest>();
        for (const item of items) {
            const stableId = item.item.id ?? item.item.url;
            const key = `${item.providerId}:${stableId}`;
            const prev = map.get(key);
            if (!prev) {
                map.set(key, item);
                continue;
            }
            if (!prev.item.relation && item.item.relation) {
                prev.item.relation = item.item.relation;
            }
        }
        return [...map.values()];
    }

    /** Listen for provider setting changes and fire event */
    watchConfigChanges(context: vscode.ExtensionContext): void {
        context.subscriptions.push(
            vscode.workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration('keepr.ticketProvider') ||
                    e.affectsConfiguration('keepr.azureDevOps') ||
                    e.affectsConfiguration('keepr.github') ||
                    e.affectsConfiguration('keepr.jira')) {
                    this._onDidChangeProvider.fire(this.activeProviderId);
                }
            }),
        );
    }

    dispose(): void {
        this._onDidChangeProvider.dispose();
    }
}

export interface AggregatedMyTicket {
    providerId: ProviderId;
    providerLabel: string;
    item: UserRelatedTicketInfo;
}

export interface AggregatedMyPullRequest {
    providerId: ProviderId;
    providerLabel: string;
    item: UserRelatedPullRequestInfo;
}
