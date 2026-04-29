import * as vscode from 'vscode';
import { ProviderManager } from './providers';

const ONBOARDING_SHOWN_KEY = 'keepr.onboardingShown';

/**
 * Shows a one-time setup prompt on first install if no ticket provider is configured.
 */
export function showOnboardingIfNeeded(
    context: vscode.ExtensionContext,
    providers: ProviderManager,
): void {
    const alreadyShown = context.globalState.get<boolean>(ONBOARDING_SHOWN_KEY);
    if (alreadyShown) { return; }

    // Mark as shown immediately so it doesn't re-trigger
    context.globalState.update(ONBOARDING_SHOWN_KEY, true);

    if (providers.isConfigured()) { return; } // already set up

    // Show a non-blocking notification after a short delay
    setTimeout(() => {
        vscode.window.showInformationMessage(
            'KeepR: Connect a ticket provider (Azure DevOps, GitHub, or Jira) for ticket search and live status in bookmarks.',
            'Set Up Now',
            'Later',
        ).then((choice) => {
            if (choice === 'Set Up Now') {
                vscode.commands.executeCommand('keepr.setupProvider');
            }
        });
    }, 3000);
}
