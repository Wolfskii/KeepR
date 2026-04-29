# KeepR — Code Bookmarks for VS Code

Bookmark lines or code sections with **ticket numbers**, **statuses**, and **collapsible per-repo sections**.

## Features

- **Toggle bookmarks** on any line (`Ctrl+Alt+K`)
- **Rich metadata** — attach a label, ticket/PBI number, and status to every bookmark
- **Statuses** — To Fix, Bug, Performance, Bad Practice, To Implement, Review, Note (customizable)
- **Sidebar tree view** with collapsible repo / file / status / ticket sections
- **Filter** by status or ticket number
- **Navigate** between bookmarks (`Ctrl+Alt+L` / `Ctrl+Alt+J`)
- **Editor decorations** — highlighted lines + gutter border for bookmarked lines
- **Line drift tracking** — bookmarks follow line changes as you edit
- **Per-repo persistence** — stored in `.vscode/keepr.json` per workspace folder

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Alt+K` | Toggle bookmark on current line |
| `Ctrl+Alt+Shift+K` | Add bookmark with label / ticket / status |
| `Ctrl+Alt+L` | Jump to next bookmark |
| `Ctrl+Alt+J` | Jump to previous bookmark |

## Configuration

| Setting | Default | Description |
|---|---|---|
| `keepr.gutterIconEnabled` | `true` | Show bookmark icons in gutter |
| `keepr.lineHighlightEnabled` | `true` | Highlight bookmarked lines |
| `keepr.defaultGroupBy` | `"repo"` | Tree grouping: `repo`, `file`, `status`, `ticket` |
| `keepr.statusLabels` | See below | Customizable status list |

Default statuses: To Fix, Bug, Performance, Bad Practice, To Implement, Review, Note

## Storage

Bookmarks are saved to `.vscode/keepr.json` in each workspace folder root.
Add this file to `.gitignore` if you don't want to share bookmarks, or commit it to share with teammates.

## Development

```bash
cd KeepR
npm install
npm run compile   # or npm run watch
# Press F5 in VS Code to launch Extension Development Host
```
