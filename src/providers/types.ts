import * as vscode from 'vscode';

/** Lightweight ticket info returned by search */
export interface TicketInfo {
    id: string;
    title: string;
    type: string;
    state: string;
    assignedTo?: string;
    url?: string;
}

export interface PullRequestChangeSummary {
    fileCount?: number;
    changedFiles: string[];
}

export interface PullRequestInfo {
    id?: string;
    title: string;
    url: string;
    status: string;
    sourceBranch?: string;
    targetBranch?: string;
    changes?: PullRequestChangeSummary;
}

export interface UserRelatedTicketInfo extends TicketInfo {
    relation?: string;
    createdAt?: string;
    updatedAt?: string;
}

export interface UserRelatedPullRequestInfo extends PullRequestInfo {
    relation?: string;
    state?: string;
    createdAt?: string;
    updatedAt?: string;
    author?: string;
}

export interface TicketHierarchyRef {
    id: string;
    title: string;
    type: string;
    state: string;
    assignedTo?: string;
    url?: string;
}

/** Full ticket details with branches, PRs, and cache timestamp */
export interface TicketDetails extends TicketInfo {
    boardColumn?: string;
    description?: string;
    acceptanceCriteria?: string;
    parent?: TicketHierarchyRef;
    children: TicketHierarchyRef[];
    branches: string[];
    pullRequests: PullRequestInfo[];
    _fetchedAt: number;
}

/** Provider ID constants */
export type ProviderId = 'azureDevOps' | 'github' | 'jira';

/** Every ticket provider must implement this interface */
export interface TicketProvider {
    readonly id: ProviderId;
    readonly displayName: string;

    /** Whether this provider has enough config to make API calls */
    isConfigured(): boolean;

    /** Initialize secrets storage (called once at activation) */
    initSecrets(secrets: vscode.SecretStorage): void;

    /** Store the auth token securely */
    storeToken(token: string): Promise<void>;

    /** Search for tickets by text or ID */
    searchTickets(query: string): Promise<TicketInfo[]>;

    /** Tickets related to the logged-in user (assigned/mentioned/created/etc.) */
    getMyTickets(): Promise<UserRelatedTicketInfo[]>;

    /** Pull requests related to the logged-in user (review/authored/mentioned/etc.) */
    getMyPullRequests(): Promise<UserRelatedPullRequestInfo[]>;

    /** Get full details including state, branches, PRs */
    getTicketDetails(ticketId: string): Promise<TicketDetails | undefined>;

    /** Build a browser-openable URL for the ticket, or undefined if not possible */
    getTicketUrl(ticketId: string): string | undefined;

    /** Invalidate cached data for a single ticket */
    invalidateCache(ticketId: string): void;

    /** Clear all cached data */
    clearCache(): void;
}
