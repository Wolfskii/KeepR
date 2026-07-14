# KeepR Provider Permissions

This file describes the minimum token permissions needed for full KeepR provider features.

## Azure DevOps

Required PAT scopes for full KeepR functionality:

- Work Items: Read
- Code: Read

Why:

- Work Items Read is needed for ticket details, parent/child hierarchy, and acceptance criteria.
- Code Read is needed for linked branches, pull requests, and PR change summaries.

Common symptom of missing scope:

- KeepR can find tickets, but branch/PR or hierarchy details are missing.

## GitHub

For fine-grained PATs, grant:

- Issues: Read
- Pull requests: Read

For classic PATs:

- repo (private repositories), or
- public_repo (public repositories)

Why:

- Issues read powers issue details and search.
- Pull requests read powers linked PR metadata in ticket details.

## Jira Cloud / Server

Required access:

- Browse Projects permission on target projects
- API token or PAT credentials configured in KeepR
- Development tools integration access (for branch/PR details via dev-status endpoints)

Why:

- Issue details and hierarchy need project browse rights.
- Branch/PR data is only available when development integrations are enabled and visible.

## Security Notes

- KeepR stores tokens in VS Code Secret Storage.
- KeepR never returns token values from tools.
- Tool output only includes non-secret provider configuration and ticket metadata.
