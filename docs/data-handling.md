# Data handling

Grok, Cursor, Cursor Cloud, and DSH are trusted peer coding agents. Selecting a
provider authorizes the task prompt and repository content to be sent to it.
The provider may run shell commands, install dependencies, and modify its
assigned worktree or cloud branch.

Credentials come only from the provider's normal login, process environment, or
an owner-only file. They are never accepted as MCP arguments or copied into
task receipts. Provider processes inherit the normal authenticated environment;
use a dedicated user account or narrower environment if that trust model is not
appropriate for a repository.

Local task state is stored below `$XDG_STATE_HOME/codex-co-engineer` or
`~/.local/state/codex-co-engineer` with owner-only directories and files. It
contains prompt text, bounded provider events, worker logs, local paths, branch
names, and provider task identifiers. Do not publish this directory.

Every local task runs in a managed worktree, including reviews. This protects
the caller's checkout from accidental mutation without restricting the peer
agent's normal capabilities. Cursor Cloud uses a provider-managed branch.

Live provider checks never run in GitHub CI. Public package validation scans the
packed payload for credentials, personal paths, and obsolete runtime files.
