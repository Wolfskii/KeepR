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

### Ticket Provider Integration

Connect your issue tracker for **live ticket search** and **work item status** in bookmarks:

| Provider | Search | Live State | Branches | Pull Requests |
|---|---|---|---|---|
| **Azure DevOps** | ✅ WIQL search | ✅ State + Board column | ✅ | ✅ |
| **GitHub** | ✅ Issues & PRs | ✅ Open / Closed | ✅ via PRs | ✅ |
| **Jira** | ✅ JQL search | ✅ Status + Category | ✅ via dev-status | ✅ via dev-status |

On first install, KeepR will prompt you to connect a provider. You can also run **KeepR: Set Up Ticket Provider** from the command palette at any time.

---

## Getting Started

1. **Install** from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=wolfskii.keepr)
2. **Toggle a bookmark** with `Ctrl+Alt+K` on any line
3. **Add a detailed bookmark** with `Ctrl+Alt+Shift+K` (label, ticket, status)
4. **Connect a ticket provider** — run `KeepR: Set Up Ticket Provider` from the command palette

### Provider Setup

#### Azure DevOps

1. Set `keepr.ticketProvider` to `azureDevOps`
2. Set `keepr.azureDevOps.orgUrl` (e.g. `https://dev.azure.com/myorg`)
3. Set `keepr.azureDevOps.project` (e.g. `MyProject`)
4. Run **KeepR: Set Azure DevOps PAT** and paste your Personal Access Token
   - PAT scope: **Work Items → Read** (and **Code → Read** for branch/PR info)

#### GitHub

1. Set `keepr.ticketProvider` to `github`
2. Set `keepr.github.owner` (e.g. `Wolfskii`)
3. Set `keepr.github.repo` (e.g. `KeepR`)
4. Run **KeepR: Set GitHub Token** and paste a Personal Access Token (optional for public repos; required for private repos and branch/PR info)
   - Token scope: `repo` (for private repos) or `public_repo` (for public only)

#### Jira

1. Set `keepr.ticketProvider` to `jira`
2. Set `keepr.jira.baseUrl` (e.g. `https://mycompany.atlassian.net`)
3. Set `keepr.jira.email` (your Jira account email)
4. Run **KeepR: Set Jira API Token** and paste your API token
   - Generate at: [Atlassian API tokens](https://id.atlassian.com/manage-profile/security/api-tokens)

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
| `KeepR: Open Ticket in Browser` | Open the linked ticket in your browser |
| `KeepR: Refresh Work Item Status` | Re-fetch live status for all linked tickets |
| `KeepR: Set Up Ticket Provider` | Configure Azure DevOps, GitHub, or Jira |
| `KeepR: Set Azure DevOps PAT` | Store PAT securely |
| `KeepR: Set GitHub Token` | Store GitHub token securely |
| `KeepR: Set Jira API Token` | Store Jira token securely |
| `KeepR: Rename Project` | Rename a repo section in the tree |
| `KeepR: Clear All Bookmarks` | Remove all bookmarks in the workspace |

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
| `keepr.jira.baseUrl` | Instance URL (`https://mycompany.atlassian.net`) |
| `keepr.jira.email` | Account email |
| `keepr.jira.apiToken` | API token (prefer using the secure command instead) |
</details>

---

## Storage

Bookmarks are saved to `.vscode/keepr.json` in each workspace folder root.
Add this file to `.gitignore` if you don't want to share bookmarks, or commit it to share with teammates.

---

## Development

```bash
git clone https://github.com/Wolfskii/KeepR.git
cd KeepR
npm install
npm run compile   # or npm run watch
# Press F5 in VS Code to launch Extension Development Host
```

---

## License

[MIT](LICENSE) © wolfskii
