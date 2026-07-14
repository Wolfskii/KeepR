import * as vscode from 'vscode';
import * as path from 'path';
import {
    Bookmark,
    BookmarkLocation,
    BookmarkStatus,
    KeepRState,
    RepoBookmarks,
    cleanRepoName,
    createEmptyState,
    generateId,
} from './models';

export interface BookmarkLineImpact {
    bookmarkId: string;
    reason: 'deleted';
    filePath: string;
    line: number;
}

/**
 * Manages bookmark persistence and in-memory state.
 * Stores one JSON file per workspace folder: `.vscode/keepr.json`
 */
export class BookmarkStore {
    private state: KeepRState = createEmptyState();
    private readonly _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChange = this._onDidChange.event;

    constructor(private readonly context: vscode.ExtensionContext) { }

    async load(): Promise<void> {
        this.state = createEmptyState();
        const folders = vscode.workspace.workspaceFolders ?? [];
        for (const folder of folders) {
            const fileUri = vscode.Uri.joinPath(folder.uri, '.vscode', 'keepr.json');
            try {
                const raw = await vscode.workspace.fs.readFile(fileUri);
                const json = JSON.parse(Buffer.from(raw).toString('utf-8')) as RepoBookmarks;
                json.rootUri = folder.uri.toString();
                json.repoName = json.repoName || cleanRepoName(folder.name);
                // Keep persisted displayName if set, otherwise derive from folder name
                if (!json.displayName) {
                    json.displayName = undefined;
                }
                this.state.repos.push(json);
            } catch {
                // File doesn't exist yet — create empty repo entry
                this.state.repos.push({
                    repoName: cleanRepoName(folder.name),
                    rootUri: folder.uri.toString(),
                    bookmarks: [],
                });
            }
        }
    }

    private async saveRepo(repo: RepoBookmarks): Promise<void> {
        const rootUri = vscode.Uri.parse(repo.rootUri);
        const fileUri = vscode.Uri.joinPath(rootUri, '.vscode', 'keepr.json');
        const dirUri = vscode.Uri.joinPath(rootUri, '.vscode');
        const data: Omit<RepoBookmarks, 'rootUri'> & { rootUri?: string } = { ...repo };
        delete data.rootUri; // don't persist the absolute URI
        const content = Buffer.from(JSON.stringify(data, null, 2), 'utf-8');
        // Ensure folder exists for first-time users/workspaces.
        await vscode.workspace.fs.createDirectory(dirUri);
        await vscode.workspace.fs.writeFile(fileUri, content);
    }

    private async saveAll(): Promise<void> {
        for (const repo of this.state.repos) {
            await this.saveRepo(repo);
        }
    }

    // ── Queries ──────────────────────────────────────────

    getState(): KeepRState {
        return this.state;
    }

    getAllBookmarks(): { repo: RepoBookmarks; bookmark: Bookmark }[] {
        const results: { repo: RepoBookmarks; bookmark: Bookmark }[] = [];
        for (const repo of this.state.repos) {
            for (const bm of repo.bookmarks) {
                results.push({ repo, bookmark: bm });
            }
        }
        return results;
    }

    getRepoForFile(fileUri: vscode.Uri): RepoBookmarks | undefined {
        return this.state.repos.find((r) => this.isFileInRepo(fileUri, r));
    }

    findBookmarkAtLine(fileUri: vscode.Uri, line: number): { repo: RepoBookmarks; bookmark: Bookmark } | undefined {
        const repo = this.getRepoForFile(fileUri);
        if (!repo) { return undefined; }
        const relPath = this.toRelativePath(fileUri, repo);
        const bookmark = repo.bookmarks.find((b) => b.location.filePath === relPath && b.location.line === line);
        return bookmark ? { repo, bookmark } : undefined;
    }

    findBookmarkById(id: string): { repo: RepoBookmarks; bookmark: Bookmark } | undefined {
        for (const repo of this.state.repos) {
            const bm = repo.bookmarks.find((b) => b.id === id);
            if (bm) { return { repo, bookmark: bm }; }
        }
        return undefined;
    }

    getBookmarksInFile(fileUri: vscode.Uri): Bookmark[] {
        const repo = this.getRepoForFile(fileUri);
        if (!repo) { return []; }
        const relPath = this.toRelativePath(fileUri, repo);
        return repo.bookmarks.filter((b) => b.location.filePath === relPath);
    }

    // ── Mutations ────────────────────────────────────────

    async addBookmark(
        fileUri: vscode.Uri,
        line: number,
        options?: {
            label?: string;
            ticket?: string;
            status?: BookmarkStatus;
            startColumn?: number;
            endColumn?: number;
            lineText?: string;
        },
    ): Promise<Bookmark | undefined> {
        const repo = this.getRepoForFile(fileUri);
        if (!repo) { return undefined; }

        const now = new Date().toISOString();
        const location: BookmarkLocation = {
            filePath: this.toRelativePath(fileUri, repo),
            line,
            startColumn: options?.startColumn,
            endColumn: options?.endColumn,
            lineText: options?.lineText,
        };

        const bookmark: Bookmark = {
            id: generateId(),
            location,
            label: options?.label,
            ticket: options?.ticket,
            status: options?.status,
            createdAt: now,
            updatedAt: now,
        };

        repo.bookmarks.push(bookmark);
        await this.saveRepo(repo);
        this._onDidChange.fire();
        return bookmark;
    }

    async removeBookmark(id: string): Promise<boolean> {
        for (const repo of this.state.repos) {
            const idx = repo.bookmarks.findIndex((b) => b.id === id);
            if (idx >= 0) {
                repo.bookmarks.splice(idx, 1);
                await this.saveRepo(repo);
                this._onDidChange.fire();
                return true;
            }
        }
        return false;
    }

    async renameRepo(repoName: string, displayName: string | undefined): Promise<boolean> {
        const repo = this.state.repos.find((r) => r.repoName === repoName);
        if (!repo) { return false; }
        repo.displayName = displayName || undefined;
        await this.saveRepo(repo);
        this._onDidChange.fire();
        return true;
    }

    getDisplayName(repo: RepoBookmarks): string {
        return repo.displayName || repo.repoName;
    }

    async updateBookmark(
        id: string,
        updates: Partial<Pick<Bookmark, 'label' | 'ticket' | 'status'>>,
    ): Promise<boolean> {
        const found = this.findBookmarkById(id);
        if (!found) { return false; }
        const { repo, bookmark } = found;
        if (updates.label !== undefined) { bookmark.label = updates.label; }
        if (updates.ticket !== undefined) { bookmark.ticket = updates.ticket; }
        if (updates.status !== undefined) { bookmark.status = updates.status; }
        bookmark.updatedAt = new Date().toISOString();
        await this.saveRepo(repo);
        this._onDidChange.fire();
        return true;
    }

    async setBookmarkLineText(id: string, lineText: string | undefined): Promise<boolean> {
        const found = this.findBookmarkById(id);
        if (!found) { return false; }
        const { repo, bookmark } = found;
        bookmark.location.lineText = lineText;
        bookmark.updatedAt = new Date().toISOString();
        await this.saveRepo(repo);
        this._onDidChange.fire();
        return true;
    }

    detectLineImpacts(
        fileUri: vscode.Uri,
        changes: readonly vscode.TextDocumentContentChangeEvent[],
    ): BookmarkLineImpact[] {
        const repo = this.getRepoForFile(fileUri);
        if (!repo) { return []; }

        const relPath = this.toRelativePath(fileUri, repo);
        const fileBookmarks = repo.bookmarks.filter((b) => b.location.filePath === relPath);
        if (fileBookmarks.length === 0) { return []; }

        const impacts = new Map<string, BookmarkLineImpact>();

        for (const change of changes) {
            const startLine = change.range.start.line;
            const endLine = change.range.end.line;
            const newLineCount = (change.text.match(/\n/g) || []).length;
            const delta = newLineCount - (endLine - startLine);

            if (delta >= 0) { continue; }

            for (const bm of fileBookmarks) {
                if (bm.location.line >= startLine && bm.location.line <= endLine) {
                    impacts.set(bm.id, {
                        bookmarkId: bm.id,
                        reason: 'deleted',
                        filePath: relPath,
                        line: bm.location.line,
                    });
                }
            }
        }

        return [...impacts.values()];
    }

    async clearAll(): Promise<void> {
        for (const repo of this.state.repos) {
            repo.bookmarks = [];
        }
        await this.saveAll();
        this._onDidChange.fire();
    }

    /** Update line numbers after edits (called on document change) */
    async adjustLines(fileUri: vscode.Uri, changes: readonly vscode.TextDocumentContentChangeEvent[]): Promise<void> {
        const repo = this.getRepoForFile(fileUri);
        if (!repo) { return; }
        const relPath = this.toRelativePath(fileUri, repo);
        const bookmarks = repo.bookmarks.filter((b) => b.location.filePath === relPath);
        if (bookmarks.length === 0) { return; }

        let dirty = false;
        for (const change of changes) {
            const startLine = change.range.start.line;
            const endLine = change.range.end.line;
            const newLineCount = (change.text.match(/\n/g) || []).length;
            const delta = newLineCount - (endLine - startLine);

            if (delta === 0) { continue; }

            for (const bm of bookmarks) {
                if (bm.location.line > endLine) {
                    bm.location.line += delta;
                    dirty = true;
                } else if (bm.location.line >= startLine && bm.location.line <= endLine && delta < 0) {
                    // Line was deleted — move bookmark to start of change
                    bm.location.line = startLine;
                    dirty = true;
                }
            }
        }

        if (dirty) {
            await this.saveRepo(repo);
            this._onDidChange.fire();
        }
    }

    // ── Helpers ──────────────────────────────────────────

    toRelativePath(fileUri: vscode.Uri, repo: RepoBookmarks): string {
        const rootUri = vscode.Uri.parse(repo.rootUri);
        if (rootUri.scheme === 'file' && fileUri.scheme === 'file') {
            const rel = path.relative(rootUri.fsPath, fileUri.fsPath);
            return rel.split(path.sep).join('/');
        }
        return fileUri.toString().slice(rootUri.toString().length + 1);
    }

    private isFileInRepo(fileUri: vscode.Uri, repo: RepoBookmarks): boolean {
        const rootUri = vscode.Uri.parse(repo.rootUri);

        if (rootUri.scheme === 'file' && fileUri.scheme === 'file') {
            const root = path.resolve(rootUri.fsPath).toLowerCase();
            const file = path.resolve(fileUri.fsPath).toLowerCase();
            const rel = path.relative(root, file);
            return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
        }

        const filePath = fileUri.toString();
        return filePath.startsWith(repo.rootUri);
    }

    resolveUri(repo: RepoBookmarks, bookmark: Bookmark): vscode.Uri {
        const rootUri = vscode.Uri.parse(repo.rootUri);
        return vscode.Uri.joinPath(rootUri, bookmark.location.filePath);
    }

    dispose(): void {
        this._onDidChange.dispose();
    }
}
