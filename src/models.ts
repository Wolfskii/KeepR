import * as vscode from 'vscode';

/** Status labels for bookmarks */
export type BookmarkStatus =
    | 'To Fix'
    | 'Bug'
    | 'Performance'
    | 'Bad Practice'
    | 'To Implement'
    | 'Review'
    | 'Note'
    | string; // allow custom statuses from settings

export interface BookmarkLocation {
    /** Workspace-relative file path */
    filePath: string;
    /** 0-based line number */
    line: number;
    /** 0-based start column (optional, for range bookmarks) */
    startColumn?: number;
    /** 0-based end column (optional, for range bookmarks) */
    endColumn?: number;
    /** Snapshot of the bookmarked text for display & drift detection */
    lineText?: string;
}

export interface Bookmark {
    id: string;
    location: BookmarkLocation;
    /** Free-form label / note */
    label?: string;
    /** Ticket / PBI / feature number */
    ticket?: string;
    /** Status tag */
    status?: BookmarkStatus;
    /** ISO timestamp */
    createdAt: string;
    /** ISO timestamp of last edit */
    updatedAt: string;
}

export interface RepoBookmarks {
    /** Display name of the repo / workspace folder */
    repoName: string;
    /** Absolute fsPath of the workspace folder root */
    rootUri: string;
    bookmarks: Bookmark[];
}

/** The full persisted state */
export interface KeepRState {
    version: 1;
    repos: RepoBookmarks[];
}

export function createEmptyState(): KeepRState {
    return { version: 1, repos: [] };
}

let _counter = 0;
export function generateId(): string {
    return `${Date.now().toString(36)}-${(++_counter).toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Status → ThemeIcon mapping */
export function statusIcon(status?: BookmarkStatus): vscode.ThemeIcon {
    switch (status) {
        case 'Bug':
            return new vscode.ThemeIcon('bug', new vscode.ThemeColor('charts.red'));
        case 'To Fix':
            return new vscode.ThemeIcon('wrench', new vscode.ThemeColor('charts.orange'));
        case 'Performance':
            return new vscode.ThemeIcon('dashboard', new vscode.ThemeColor('charts.yellow'));
        case 'Bad Practice':
            return new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.orange'));
        case 'To Implement':
            return new vscode.ThemeIcon('lightbulb', new vscode.ThemeColor('charts.blue'));
        case 'Review':
            return new vscode.ThemeIcon('eye', new vscode.ThemeColor('charts.purple'));
        case 'Note':
            return new vscode.ThemeIcon('note', new vscode.ThemeColor('charts.green'));
        default:
            return new vscode.ThemeIcon('bookmark');
    }
}
