### Added
- An OpenCode 1.x pane's chat can be read from OpenCode's own server instead of `opencode.db`, for
  a build that keeps its sessions somewhere else: `OVIS_OPENCODE_URL` names a running
  `opencode serve`, or `OVIS_OPENCODE_SERVE=1` has the app start one of its own on loopback
  (`OVIS_OPENCODE_BIN`). Off by default; when the server does not answer, the chat reads
  `opencode.db` as before.
