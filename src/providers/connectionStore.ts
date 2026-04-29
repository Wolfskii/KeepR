import * as vscode from 'vscode';
import { ProviderId } from './types';

/** Serializable connection configuration */
export interface ProviderConnection {
    /** Unique ID for this connection */
    id: string;
    /** Provider type */
    type: ProviderId;
    /** User-facing display name (e.g. "My Company AzDO", "personal-github") */
    name: string;
    /** Provider-specific config (non-secret) */
    config: Record<string, string>;
}

const CONNECTIONS_KEY = 'keepr.providerConnections';
const ACTIVE_KEY = 'keepr.activeConnection';

/**
 * Persists provider connections to globalState and tokens to SecretStorage.
 */
export class ConnectionStore {
    private readonly _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChange = this._onDidChange.event;

    constructor(
        private readonly globalState: vscode.Memento,
        private readonly secrets: vscode.SecretStorage,
    ) { }

    /** Get all saved connections */
    getAll(): ProviderConnection[] {
        return this.globalState.get<ProviderConnection[]>(CONNECTIONS_KEY, []);
    }

    /** Get a connection by ID */
    get(id: string): ProviderConnection | undefined {
        return this.getAll().find(c => c.id === id);
    }

    /** Add or update a connection */
    async save(connection: ProviderConnection): Promise<void> {
        const all = this.getAll();
        const idx = all.findIndex(c => c.id === connection.id);
        if (idx >= 0) {
            all[idx] = connection;
        } else {
            all.push(connection);
        }
        await this.globalState.update(CONNECTIONS_KEY, all);

        // If this is the only connection, auto-activate it
        if (all.length === 1 && !this.getActiveId()) {
            await this.setActiveId(connection.id);
        }

        this._onDidChange.fire();
    }

    /** Remove a connection */
    async remove(id: string): Promise<void> {
        const all = this.getAll().filter(c => c.id !== id);
        await this.globalState.update(CONNECTIONS_KEY, all);

        // Clear token
        await this.secrets.delete(`keepr.connection.${id}.token`);

        // If active was removed, clear or pick first
        if (this.getActiveId() === id) {
            await this.setActiveId(all.length > 0 ? all[0].id : undefined);
        }

        this._onDidChange.fire();
    }

    /** Store token for a connection */
    async storeToken(connectionId: string, token: string): Promise<void> {
        await this.secrets.store(`keepr.connection.${connectionId}.token`, token);
    }

    /** Get token for a connection */
    async getToken(connectionId: string): Promise<string | undefined> {
        return this.secrets.get(`keepr.connection.${connectionId}.token`);
    }

    /** Get the active connection ID */
    getActiveId(): string | undefined {
        return this.globalState.get<string>(ACTIVE_KEY);
    }

    /** Set the active connection */
    async setActiveId(id: string | undefined): Promise<void> {
        await this.globalState.update(ACTIVE_KEY, id);
        this._onDidChange.fire();
    }

    /** Get the active connection */
    getActive(): ProviderConnection | undefined {
        const id = this.getActiveId();
        return id ? this.get(id) : undefined;
    }

    /** Generate a unique connection ID */
    static generateId(): string {
        return `conn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    }

    dispose(): void {
        this._onDidChange.dispose();
    }
}
