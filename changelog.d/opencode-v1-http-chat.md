### Added
- An OpenCode 1.x pane's chat can be read from OpenCode's own server instead of `opencode.db`, for
  a build that keeps its sessions somewhere else: `HERDR_WEB_OPENCODE_URL` names a running
  `opencode serve`, or `HERDR_WEB_OPENCODE_SERVE=1` has the app start one of its own on loopback
  (`HERDR_WEB_OPENCODE_BIN`), which stops with the app even when the app is killed. Off by default;
  a session the server never answered for is read from `opencode.db` as before.
