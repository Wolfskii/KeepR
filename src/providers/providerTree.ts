import * as vscode from 'vscode';
import { ConnectionStore, ProviderConnection } from './connectionStore';

type ProviderTreeNode = ConnectionNode | AddConnectionNode;

class ConnectionNode {
    readonly type = 'connection' as const;
    constructor(
        public readonly connection: ProviderConnection,
        public readonly isActive: boolean,
    ) { }
}

class AddConnectionNode {
    readonly type = 'addConnection' as const;
}

/**
 * Tree data provider for the "Providers" sidebar panel.
 * Shows all saved connections with active indicator, plus an "Add" entry.
 */
export class ProviderTreeProvider implements vscode.TreeDataProvider<ProviderTreeNode> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<ProviderTreeNode | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    constructor(private readonly store: ConnectionStore) { }

    refresh(): void {
        this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(element: ProviderTreeNode): vscode.TreeItem {
        if (element.type === 'addConnection') {
            const item = new vscode.TreeItem('Add Connection…', vscode.TreeItemCollapsibleState.None);
            item.iconPath = new vscode.ThemeIcon('add');
            item.command = { command: 'keepr.addConnection', title: 'Add Connection' };
            item.contextValue = 'addConnection';
            return item;
        }

        const conn = element.connection;
        const label = element.isActive ? `● ${conn.name}` : conn.name;
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);

        item.description = this.providerLabel(conn.type);
        item.tooltip = this.buildTooltip(conn, element.isActive);
        item.iconPath = this.providerIcon(conn.type);
        item.contextValue = element.isActive ? 'activeConnection' : 'connection';

        // Click → activate
        item.command = {
            command: 'keepr.activateConnection',
            title: 'Activate Connection',
            arguments: [conn.id],
        };

        return item;
    }

    getChildren(element?: ProviderTreeNode): ProviderTreeNode[] {
        if (element) { return []; } // flat list

        const connections = this.store.getAll();
        const activeId = this.store.getActiveId();

        const nodes: ProviderTreeNode[] = connections.map(c =>
            new ConnectionNode(c, c.id === activeId),
        );
        nodes.push(new AddConnectionNode());
        return nodes;
    }

    private providerIcon(type: string): vscode.ThemeIcon {
        switch (type) {
            case 'azureDevOps': return new vscode.ThemeIcon('azure-devops', new vscode.ThemeColor('charts.blue'));
            case 'github': return new vscode.ThemeIcon('github', new vscode.ThemeColor('charts.foreground'));
            case 'jira': return new vscode.ThemeIcon('globe', new vscode.ThemeColor('charts.blue'));
            default: return new vscode.ThemeIcon('plug');
        }
    }

    private providerLabel(type: string): string {
        switch (type) {
            case 'azureDevOps': return 'Azure DevOps';
            case 'github': return 'GitHub';
            case 'jira': return 'Jira';
            default: return type;
        }
    }

    private buildTooltip(conn: ProviderConnection, isActive: boolean): vscode.MarkdownString {
        const md = new vscode.MarkdownString();
        md.isTrusted = true;
        md.appendMarkdown(`**${conn.name}**\n\n`);
        md.appendMarkdown(`Provider: ${this.providerLabel(conn.type)}\n\n`);
        if (isActive) { md.appendMarkdown(`✅ **Active** — used for ticket search and status\n\n`); }

        switch (conn.type) {
            case 'azureDevOps':
                md.appendMarkdown(`Org: \`${conn.config.orgUrl ?? ''}\`\n\n`);
                md.appendMarkdown(`Project: \`${conn.config.project ?? ''}\`\n\n`);
                break;
            case 'github':
                md.appendMarkdown(`Repo: \`${conn.config.owner ?? ''}/${conn.config.repo ?? ''}\`\n\n`);
                break;
            case 'jira':
                md.appendMarkdown(`URL: \`${conn.config.baseUrl ?? ''}\`\n\n`);
                md.appendMarkdown(`Hosting: ${conn.config.hosting === 'server' ? 'Server / DC' : 'Cloud'}\n\n`);
                break;
        }
        return md;
    }

    dispose(): void {
        this._onDidChangeTreeData.dispose();
    }
}
