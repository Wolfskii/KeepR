<p align="center">
  <img src="resources/icon.png" width="128" alt="KeepR logo" />
</p>

<h1 align="center">KeepR — Code Bookmarks for VS Code</h1>

<p align="center">
  Bookmark lines with <strong>ticket numbers</strong>, <strong>statuses</strong>, and <strong>live work item tracking</strong> — across repos.
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=wolfskii.keepr">
    <img src="https://img.shields.io/visual-studio-marketplace/v/wolfskii.keepr?label=marketplace" alt="VS Code Marketplace" />
  </a>
  <a href="https://marketplace.visualstudio.com/items?itemName=wolfskii.keepr">
    <img src="https://img.shields.io/visual-studio-marketplace/i/wolfskii.keepr" alt="Installs" />
  </a>
  <img src="https://img.shields.io/github/license/Wolfskii/KeepR" alt="License" />
</p>

---

## Features

- **Toggle bookmarks** on any line (`Ctrl+Alt+K`)
- **Rich metadata** — attach a label, ticket/PBI number, and status to every bookmark
- **Statuses** — To Fix, Bug, Performance, Bad Practice, To Implement, Review, Note (customizable)
- **Sidebar tree view** with collapsible repo / file / status / ticket sections
- **Filter** by status or ticket number
- **Navigate** between bookmarks (`Ctrl+Alt+L` / `Ctrl+Alt+J`)
- **Per-status colored decorations** — highlighted lines, gutter borders, overview ruler markers
- **Line drift tracking** — bookmarks follow line changes as you edit
- **Per-repo persistence** — stored in `.vscode/keepr.json` per workspace folder
- **Copilot Chat integration** — use KeepR as a tool in GitHub Copilot Chat (Language Model Tools / MCP)

### Ticket Provider Integration

Connect your issue tracker for **live ticket search** and **work item status** in bookmarks:

| Provider | Search | Live State | Branches | Pull Requests |
|---|---|---|---|---|
| **Azure DevOps** | ✅ WIQL search | ✅ State + Board column | ✅ | ✅ |
| **GitHub** | ✅ Issues & PRs | ✅ Open / Closed | ✅ via PRs | ✅ |
| **Jira** | ✅ JQL search | ✅ Status + Category | ✅ via dev-status | ✅ via dev-status |

### Multi-Connection Support

Manage **multiple provider connections** simultaneously (e.g. work Azure DevOps + personal GitHub). Switch the active connection from the Providers panel in the sidebar.

### Copilot Chat / MCP Integration

KeepR exposes **Language Model Tools** that GitHub Copilot Chat (and other AI features in VS Code) can invoke directly. This means you can ask Copilot to manage your bookmarks conversationally:

| Tool | Description |
|---|---|
| `keepr_listBookmarks` | List all bookmarks, optionally filtered by status, ticket, or file path |
| `keepr_addBookmark` | Add a bookmark at a specific file and line with optional metadata |
| `keepr_editBookmark` | Edit a bookmark's label, ticket, or status |
| `keepr_removeBookmark` | Remove a bookmark by ID or by file path + line number |
| `keepr_getStats` | Get bookmark statistics: totals, breakdown by status/ticket/project |
| `keepr_getConnections` | Show configured provider connections (without exposing PATs/tokens) |
| `keepr_getTicketDetails` | Fetch live ticket/PBI details: state, branches, PRs, board column |

**Usage in Copilot Chat:**

Simply reference the tools in your chat messages — Copilot will call them automatically when relevant. Examples:

- *"What bookmarks do I have tagged as Bug?"*
- *"Add a bookmark at src/store.ts line 42 with status 'To Fix' and ticket 419046"*
- *"Change the status of the bookmark at src/store.ts line 42 to 'Review'"*
- *"Remove the bookmark at src/extension.ts line 15"*
- *"Give me a summary of my bookmarks"*
- *"What ticket providers do I have connected?"*
- *"Show me the status and PRs for PBI 419046"*
- *"Get details for all tickets linked to my bookmarks"*

> **Requirement:** VS Code 1.99+ and GitHub Copilot extension installed.

---

## Getting Started

1. **Install** from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=wolfskii.keepr)
2. **Toggle a bookmark** with `Ctrl+Alt+K` on any line
3. **Add a detailed bookmark** with `Ctrl+Alt+Shift+K` (label, ticket, status)
4. **Connect a ticket provider** — run `KeepR: Set Up Ticket Provider` from the command palette

### Provider Setup

#### Azure DevOps

1. Run **KeepR: Add Provider Connection** (or **KeepR: Set Up Ticket Provider**)
2. Select **Azure DevOps**
3. Enter your organization URL (e.g. `https://dev.azure.com/myorg`)
4. Enter your project name
5. Paste your Personal Access Token
   - PAT scope: **Work Items → Read** (and **Code → Read** for branch/PR info)

#### GitHub

1. Run **KeepR: Add Provider Connection**
2. Select **GitHub**
3. Enter the repository owner (user or org)
4. Enter the repository name
5. Paste a Personal Access Token (optional for public repos; required for private repos and branch/PR info)
   - Token scope: `repo` (for private repos) or `public_repo` (for public only)

#### Jira

**Jira Cloud** (default):

1. Run **KeepR: Add Provider Connection**
2. Select **Jira**
3. Enter your instance URL (e.g. `https://mycompany.atlassian.net`)
4. Enter your Jira account email
5. Paste your API token
   - Generate at: [Atlassian API tokens](https://id.atlassian.com/manage-profile/security/api-tokens)

**Jira Server / Data Center** (self-hosted):

1. Run **KeepR: Add Provider Connection**
2. Select **Jira** → choose **Server / Data Center** hosting
3. Enter your instance URL (e.g. `https://jira.mycompany.com`)
4. Optionally enter your username (leave empty for PAT-only auth)
5. Paste your token

---

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Alt+K` | Toggle bookmark on current line |
| `Ctrl+Alt+Shift+K` | Add bookmark with label / ticket / status |
| `Ctrl+Alt+L` | Jump to next bookmark |
| `Ctrl+Alt+J` | Jump to previous bookmark |

---

## Commands

| Command | Description |
|---|---|
| `KeepR: Toggle Bookmark` | Add/remove bookmark at cursor |
| `KeepR: Add Bookmark with Details` | Add bookmark with label, ticket, and status |
| `KeepR: Edit Bookmark` | Edit label, ticket, or status |
| `KeepR: Remove Bookmark` | Remove a bookmark |
| `KeepR: Go to Bookmark` | Quick-pick to jump to any bookmark |
| `KeepR: Next / Previous Bookmark` | Navigate between bookmarks in current file |
| `KeepR: Filter by Status` | Show only bookmarks with a specific status |
| `KeepR: Filter by Ticket` | Show only bookmarks with a specific ticket |
| `KeepR: Clear Filter` | Remove active filter |
| `KeepR: Collapse All Sections` | Collapse all tree sections |
| `KeepR: Expand All Sections` | Expand all tree sections |
| `KeepR: Rename Project` | Rename a repo section in the tree |
| `KeepR: Open Ticket in Browser` | Open the linked ticket in your browser |
| `KeepR: Refresh Work Item Status` | Re-fetch live status for all linked tickets |
| `KeepR: Clear All Bookmarks` | Remove all bookmarks in the workspace |
| `KeepR: Set Up Ticket Provider` | Configure Azure DevOps, GitHub, or Jira |
| `KeepR: Add Provider Connection` | Add a new provider connection |
| `KeepR: Edit Provider Connection` | Edit an existing connection's settings |
| `KeepR: Remove Provider Connection` | Remove a connection |
| `KeepR: Set Active Provider Connection` | Switch which connection is active |

---

## Configuration

| Setting | Default | Description |
|---|---|---|
| `keepr.ticketProvider` | `""` | Active provider: `azureDevOps`, `github`, `jira`, or empty |
| `keepr.gutterIconEnabled` | `true` | Show bookmark icons in gutter |
| `keepr.lineHighlightEnabled` | `true` | Highlight bookmarked lines |
| `keepr.defaultGroupBy` | `"repo"` | Tree grouping: `repo`, `file`, `status`, `ticket` |
| `keepr.statusLabels` | See below | Customizable status list |

Default statuses: To Fix, Bug, Performance, Bad Practice, To Implement, Review, Note

### Provider Settings

<details>
<summary><strong>Azure DevOps</strong></summary>

| Setting | Description |
|---|---|
| `keepr.azureDevOps.orgUrl` | Organization URL (`https://dev.azure.com/myorg`) |
| `keepr.azureDevOps.project` | Project name |
| `keepr.azureDevOps.pat` | PAT (prefer using the secure command instead) |

</details>

<details>
<summary><strong>GitHub</strong></summary>

| Setting | Description |
|---|---|
| `keepr.github.owner` | Repository owner (user or org) |
| `keepr.github.repo` | Repository name |
| `keepr.github.token` | Token (prefer using the secure command instead) |

</details>

<details>
<summary><strong>Jira</strong></summary>

| Setting | Description |
|---|---|
| `keepr.jira.hosting` | Hosting type: `cloud` (default) or `server` (self-hosted Server/DC) |
| `keepr.jira.baseUrl` | Instance URL (`https://mycompany.atlassian.net` or `https://jira.mycompany.com`) |
| `keepr.jira.email` | Cloud: account email. Server: username (optional — leave empty for PAT auth) |
| `keepr.jira.apiToken` | API token (prefer using the secure command instead) |

</details>

---

## Copilot Chat Tools (Language Model Tools)

KeepR registers tools with VS Code's Language Model API, making them available to GitHub Copilot Chat and any other AI features that support tool calling.

### Available Tools

#### `keepr_listBookmarks`

Lists all bookmarks in the workspace. Supports optional filters:

- `status` — filter by status label (e.g. "Bug", "To Fix")
- `ticket` — filter by ticket number (substring match)
- `filePath` — filter by file path (substring match)

Returns: file path, line number, label, status, ticket, and bookmark ID for each match.

#### `keepr_addBookmark`

Adds a new bookmark at a specific location.

**Required parameters:**

- `filePath` — workspace-relative or absolute file path
- `line` — 1-based line number

**Optional parameters:**

- `label` — descriptive note
- `ticket` — ticket/PBI number to link
- `status` — status tag (To Fix, Bug, Performance, Bad Practice, To Implement, Review, Note)

#### `keepr_editBookmark`

Edits an existing bookmark's metadata. Identify the bookmark by:

- `id` — the bookmark's unique ID (from `keepr_listBookmarks`), OR
- `filePath` + `line` — file path and 1-based line number

**Editable fields (all optional):**

- `label` — new label/note (empty string to clear)
- `ticket` — new ticket/PBI number (empty string to clear)
- `status` — new status (empty string to clear)

#### `keepr_removeBookmark`

Removes a bookmark. Provide either:

- `id` — the bookmark's unique ID (returned by `keepr_listBookmarks`)
- `filePath` + `line` — file path and 1-based line number

#### `keepr_getStats`

Returns a statistical summary:

- Total bookmark count
- Breakdown by status
- Breakdown by project/repo
- Breakdown by ticket number

#### `keepr_getConnections`

Lists all configured ticket provider connections with their type, display name, and non-secret config (org URLs, project names, etc.). **Never exposes PATs or tokens.** Shows which connection is currently active. If no connections exist, returns setup instructions.

#### `keepr_getTicketDetails`

Fetches live details from the active ticket provider. Parameters:

- `ticketId` — look up a specific ticket by ID
- `all` — set to `true` to fetch details for all unique tickets linked to bookmarks

Returns for each ticket:

- Title, type, state, assigned person
- Board column (Azure DevOps)
- Associated branches
- Pull requests (title, status, URL)
- Direct URL to the ticket

Requires an active, configured provider connection.

### How It Works

These tools are registered via `vscode.lm.registerTool()` and are declared in the extension's `package.json` under `contributes.languageModelTools`. When GitHub Copilot Chat processes your messages, it can automatically invoke these tools to answer questions about your bookmarks or manage them on your behalf.

No additional configuration is needed — the tools are available as soon as KeepR is activated.

---

## Storage

Bookmarks are saved to `.vscode/keepr.json` in each workspace folder root.
Add this file to `.gitignore` if you don't want to share bookmarks, or commit it to share with teammates.

Provider connections and tokens are stored in VS Code's global state and secure secret storage respectively — they persist across workspaces.

---

## Development

```bash
git clone https://github.com/Wolfskii/KeepR.git
cd KeepR
npm install
npm run compile   # or npm run watch
# Press F5 in VS Code to launch Extension Development Host
```

### Project Structure

```
src/
├── extension.ts       # Activation entry point
├── models.ts          # Bookmark types and helpers
├── store.ts           # Bookmark persistence and CRUD
├── commands.ts        # All VS Code command handlers
├── tools.ts           # Language Model Tools (Copilot Chat / MCP)
├── treeProvider.ts    # Sidebar tree view data provider
├── decorations.ts     # Editor line decorations
├── ticketPicker.ts    # Ticket search quick-pick UI
├── onboarding.ts      # First-install onboarding flow
└── providers/
    ├── types.ts           # TicketProvider interface
    ├── azureDevOps.ts     # Azure DevOps implementation
    ├── github.ts          # GitHub implementation
    ├── jira.ts            # Jira implementation
    ├── providerManager.ts # Active provider management
    ├── connectionStore.ts # Multi-connection persistence
    ├── providerTree.ts    # Provider sidebar tree
    ├── setupWizard.ts     # Connection setup wizard
    └── index.ts           # Re-exports
```

---

## License

[MIT](LICENSE) © wolfskii
