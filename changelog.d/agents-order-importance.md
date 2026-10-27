### Added
- **Settings → Appearance → Agents order → Importance** keeps Longest wait's groups (blocked,
  unread finishes, ready, working) and orders each by the band opencode-memory gives the pane's
  OpenCode session, P0 first. An agent that waits past its band's age (P1 15 min, P2 30 min, P3
  60 min, set in Settings) goes first in its band, and one that waits 4 times that competes with
  its group's most urgent band, so none waits forever. Each row shows its band, with memory's
  reason as its tooltip, and the row menu sets it by hand (Importance: Auto, P0 to P3) through
  this server. While opencode-memory is down or has no `session_importance` tool, every agent is
  P2 and the order is Longest wait's. The server asks memory at `OVIS_MEMORY_URL` (default
  `http://127.0.0.1:9824`, `off` to turn it off) with `OPENCODE_MEMORY_API_KEY` or memory's own
  key file, and keeps each pane's wait clock in `wait-clocks.json` beside the shared preferences.
