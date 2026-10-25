### Added
- An OpenCode 1.x pane's Chat shows its model as a chip beside the message box, which lists the
  models OpenCode offers, grouped by provider and searchable, and picks one in the pane's TUI
  through its own model dialog, then checks the prompt shows it. What it could not do there it says,
  with the terminal one tap away. The new workspace and tab dialogs take a model for OpenCode
  (`--model provider/model`), suggested from the same list. Both need OpenCode's 1.x HTTP source
  (`HERDR_WEB_OPENCODE_URL` or `HERDR_WEB_OPENCODE_SERVE=1`).
