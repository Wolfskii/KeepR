import * as vscode from 'vscode';
import { ProviderManager, TicketInfo } from './providers';

/** Work-item type → codicon mapping */
function ticketIcon(type: string): string {
    switch (type.toLowerCase()) {
        case 'bug': return '$(bug)';
        case 'task': return '$(tasklist)';
        case 'user story': return '$(book)';
        case 'product backlog item': return '$(inbox)';
        case 'feature': return '$(rocket)';
        case 'epic': return '$(milestone)';
        case 'issue': return '$(issues)';
        case 'pull request': return '$(git-pull-request)';
        case 'story': return '$(book)';
        default: return '$(circle)';
    }
}

/**
 * Shows a QuickPick that lets the user either:
 *  - Search tickets via the active provider (if configured)
 *  - Type a ticket number manually
 *  - Skip (empty)
 *
 * Returns the chosen ticket string, empty string for "(none)", or undefined if cancelled.
 */
export async function pickTicket(
    providers: ProviderManager,
    currentValue?: string,
): Promise<string | undefined> {
    if (!providers.isConfigured()) {
        // No provider configured — fall back to simple input box
        return vscode.window.showInputBox({
            prompt: 'Ticket / PBI number (optional)',
            placeHolder: 'e.g. "419046" or "FEAT-123"',
            value: currentValue ?? '',
        });
    }

    return new Promise<string | undefined>((resolve) => {
        const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { _ticket?: string }>();
        const providerName = providers.activeProvider?.displayName ?? 'tickets';
        qp.title = 'Ticket / PBI';
        qp.placeholder = `Search ${providerName} or type a number…`;
        qp.value = currentValue ?? '';
        qp.matchOnDescription = true;
        qp.matchOnDetail = true;

        // Debounce timer for search
        let searchTimer: ReturnType<typeof setTimeout> | undefined;
        let lastQuery = '';

        const manualItem = (value: string): vscode.QuickPickItem & { _ticket: string } => ({
            label: `$(edit) Use "${value}"`,
            description: 'Enter manually',
            _ticket: value,
            alwaysShow: true,
        });

        const noneItem: vscode.QuickPickItem & { _ticket: string } = {
            label: '$(circle-slash) (none)',
            description: 'No ticket',
            _ticket: '',
            alwaysShow: true,
        };

        function ticketToItem(ti: TicketInfo): vscode.QuickPickItem & { _ticket: string } {
            return {
                label: `${ticketIcon(ti.type)} #${ti.id} — ${ti.title}`,
                description: `${ti.type} · ${ti.state}${ti.assignedTo ? ` · ${ti.assignedTo}` : ''}`,
                _ticket: String(ti.id),
                alwaysShow: true,
            };
        }

        async function doSearch(query: string): Promise<void> {
            if (query.length < 2) {
                qp.items = [
                    ...(query ? [manualItem(query)] : []),
                    noneItem,
                ];
                return;
            }

            qp.busy = true;
            try {
                const results = await providers.searchTickets(query);
                // Only update if query hasn't changed while we were fetching
                if (qp.value === query) {
                    const items: (vscode.QuickPickItem & { _ticket?: string })[] = [];
                    items.push(manualItem(query));
                    for (const ti of results) {
                        items.push(ticketToItem(ti));
                    }
                    items.push(noneItem);
                    qp.items = items;
                }
            } finally {
                qp.busy = false;
            }
        }

        qp.onDidChangeValue((value) => {
            if (searchTimer) { clearTimeout(searchTimer); }
            lastQuery = value;

            // Show manual + none immediately
            qp.items = [
                ...(value ? [manualItem(value)] : []),
                noneItem,
            ];

            // Debounce the provider search
            if (value.length >= 2) {
                searchTimer = setTimeout(() => doSearch(value), 350);
            }
        });

        qp.onDidAccept(() => {
            const selected = qp.selectedItems[0];
            if (selected && '_ticket' in selected) {
                // Preserve empty-string ticket from "(none)"; undefined means cancelled.
                resolve(selected._ticket);
            } else if (qp.value) {
                resolve(qp.value);
            } else {
                resolve('');
            }
            qp.dispose();
        });

        qp.onDidHide(() => {
            resolve(undefined);
            qp.dispose();
        });

        // Initialize items
        qp.items = [
            ...(currentValue ? [manualItem(currentValue)] : []),
            noneItem,
        ];

        qp.show();
    });
}
