import * as vscode from 'vscode';
import { ProviderId } from './types';
import { ConnectionStore, ProviderConnection } from './connectionStore';

/**
 * Interactive wizard for adding/editing provider connections.
 * All config is collected via QuickPick/InputBox — never opens VS Code settings.
 */

export async function runSetupWizard(
    connectionStore: ConnectionStore,
    existingConnection?: ProviderConnection,
): Promise<ProviderConnection | undefined> {
    // Step 1: pick provider type (skip if editing)
    let providerType = existingConnection?.type;
    if (!providerType) {
        const typePick = await vscode.window.showQuickPick([
            { label: '$(azure-devops) Azure DevOps', description: 'Work items, branches & PRs', _id: 'azureDevOps' as ProviderId },
            { label: '$(github) GitHub', description: 'Issues & Pull Requests', _id: 'github' as ProviderId },
            { label: '$(globe) Jira Cloud', description: 'Atlassian Cloud (*.atlassian.net)', _id: 'jira' as ProviderId, _hosting: 'cloud' },
            { label: '$(server) Jira Server / Data Center', description: 'Self-hosted Jira', _id: 'jira' as ProviderId, _hosting: 'server' },
        ], { placeHolder: 'Select a ticket provider', title: 'KeepR: Add Provider Connection' });
        if (!typePick) { return undefined; }
        providerType = typePick._id;

        // For Jira, remember hosting choice
        if (providerType === 'jira' && '_hosting' in typePick) {
            return runJiraWizard(connectionStore, (typePick as any)._hosting, existingConnection);
        }
    }

    switch (providerType) {
        case 'azureDevOps': return runAzureDevOpsWizard(connectionStore, existingConnection);
        case 'github': return runGitHubWizard(connectionStore, existingConnection);
        case 'jira': return runJiraWizard(connectionStore, existingConnection?.config.hosting ?? 'cloud', existingConnection);
        default: return undefined;
    }
}

async function runAzureDevOpsWizard(
    store: ConnectionStore,
    existing?: ProviderConnection,
): Promise<ProviderConnection | undefined> {
    const orgUrl = await vscode.window.showInputBox({
        title: 'Azure DevOps: Organization URL',
        prompt: 'e.g. https://dev.azure.com/myorg',
        value: existing?.config.orgUrl ?? '',
        validateInput: (v) => v.trim() ? undefined : 'URL is required',
    });
    if (orgUrl === undefined) { return undefined; }

    const project = await vscode.window.showInputBox({
        title: 'Azure DevOps: Project Name',
        prompt: 'The project containing your work items',
        value: existing?.config.project ?? '',
        validateInput: (v) => v.trim() ? undefined : 'Project is required',
    });
    if (project === undefined) { return undefined; }

    const pat = await vscode.window.showInputBox({
        title: 'Azure DevOps: Personal Access Token',
        prompt: 'Scope: Work Items (Read) + Code (Read) for branches/PRs',
        password: true,
        placeHolder: 'Paste PAT here…',
    });
    if (pat === undefined) { return undefined; }

    const name = await vscode.window.showInputBox({
        title: 'Connection Name',
        prompt: 'A friendly name for this connection',
        value: existing?.name ?? `${project} (Azure DevOps)`,
        validateInput: (v) => v.trim() ? undefined : 'Name is required',
    });
    if (name === undefined) { return undefined; }

    const connection: ProviderConnection = {
        id: existing?.id ?? ConnectionStore.generateId(),
        type: 'azureDevOps',
        name: name.trim(),
        config: { orgUrl: orgUrl.trim(), project: project.trim() },
    };

    await store.save(connection);
    if (pat) { await store.storeToken(connection.id, pat); }
    vscode.window.showInformationMessage(`KeepR: Azure DevOps connection "${connection.name}" saved.`);
    return connection;
}

async function runGitHubWizard(
    store: ConnectionStore,
    existing?: ProviderConnection,
): Promise<ProviderConnection | undefined> {
    const owner = await vscode.window.showInputBox({
        title: 'GitHub: Repository Owner',
        prompt: 'GitHub user or organization (e.g. Wolfskii)',
        value: existing?.config.owner ?? '',
        validateInput: (v) => v.trim() ? undefined : 'Owner is required',
    });
    if (owner === undefined) { return undefined; }

    const repo = await vscode.window.showInputBox({
        title: 'GitHub: Repository Name',
        prompt: 'e.g. KeepR',
        value: existing?.config.repo ?? '',
        validateInput: (v) => v.trim() ? undefined : 'Repo name is required',
    });
    if (repo === undefined) { return undefined; }

    const token = await vscode.window.showInputBox({
        title: 'GitHub: Personal Access Token (optional for public repos)',
        prompt: 'Scope: repo (private) or public_repo (public only)',
        password: true,
        placeHolder: 'Paste token or leave empty…',
    });
    if (token === undefined) { return undefined; }

    const name = await vscode.window.showInputBox({
        title: 'Connection Name',
        prompt: 'A friendly name for this connection',
        value: existing?.name ?? `${owner}/${repo}`,
        validateInput: (v) => v.trim() ? undefined : 'Name is required',
    });
    if (name === undefined) { return undefined; }

    const connection: ProviderConnection = {
        id: existing?.id ?? ConnectionStore.generateId(),
        type: 'github',
        name: name.trim(),
        config: { owner: owner.trim(), repo: repo.trim() },
    };

    await store.save(connection);
    if (token) { await store.storeToken(connection.id, token); }
    vscode.window.showInformationMessage(`KeepR: GitHub connection "${connection.name}" saved.`);
    return connection;
}

async function runJiraWizard(
    store: ConnectionStore,
    hosting: string,
    existing?: ProviderConnection,
): Promise<ProviderConnection | undefined> {
    const isServer = hosting === 'server';

    const baseUrl = await vscode.window.showInputBox({
        title: `Jira ${isServer ? 'Server' : 'Cloud'}: Base URL`,
        prompt: isServer
            ? 'e.g. https://jira.mycompany.com'
            : 'e.g. https://mycompany.atlassian.net',
        value: existing?.config.baseUrl ?? '',
        validateInput: (v) => v.trim() ? undefined : 'URL is required',
    });
    if (baseUrl === undefined) { return undefined; }

    let email = '';
    if (!isServer) {
        const emailInput = await vscode.window.showInputBox({
            title: 'Jira Cloud: Account Email',
            prompt: 'Your Atlassian account email',
            value: existing?.config.email ?? '',
            validateInput: (v) => v.trim() ? undefined : 'Email is required for Jira Cloud',
        });
        if (emailInput === undefined) { return undefined; }
        email = emailInput.trim();
    } else {
        const usernameInput = await vscode.window.showInputBox({
            title: 'Jira Server: Username (optional)',
            prompt: 'Leave empty for PAT-only (Bearer) auth',
            value: existing?.config.email ?? '',
        });
        if (usernameInput === undefined) { return undefined; }
        email = usernameInput.trim();
    }

    const token = await vscode.window.showInputBox({
        title: isServer ? 'Jira Server: Password or Personal Access Token' : 'Jira Cloud: API Token',
        prompt: isServer
            ? 'For PAT-only auth leave username empty above'
            : 'Generate at id.atlassian.com/manage-profile/security/api-tokens',
        password: true,
        placeHolder: 'Paste token here…',
        validateInput: (v) => v.trim() ? undefined : 'Token is required',
    });
    if (token === undefined) { return undefined; }

    const name = await vscode.window.showInputBox({
        title: 'Connection Name',
        prompt: 'A friendly name for this connection',
        value: existing?.name ?? `Jira ${isServer ? 'Server' : 'Cloud'}`,
        validateInput: (v) => v.trim() ? undefined : 'Name is required',
    });
    if (name === undefined) { return undefined; }

    const connection: ProviderConnection = {
        id: existing?.id ?? ConnectionStore.generateId(),
        type: 'jira',
        name: name.trim(),
        config: { baseUrl: baseUrl.trim(), email, hosting },
    };

    await store.save(connection);
    if (token) { await store.storeToken(connection.id, token); }
    vscode.window.showInformationMessage(`KeepR: Jira connection "${connection.name}" saved.`);
    return connection;
}
