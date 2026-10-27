### Added
- **Settings → Appearance → Agents order → Importance** orders the agents by how much their work
  matters. It keeps Longest wait's groups: blocked, unread finishes, ready, then working. Within
  each group, the band that opencode-memory gives the pane's OpenCode session comes first, P0 to P3.
  Other agents count as P2. An agent that waits past its band's limit goes first in its band. The
  limits are 15 minutes for P1, 30 for P2 and 60 for P3, and you can change them in Settings. An
  agent that waits 4 times its limit is ordered with its group's most urgent band.
- In Importance order, each OpenCode agent row shows its band, with memory's reason as the
  tooltip. The row menu sets the band by hand: Importance: Auto, or P0 to P3. If memory refuses,
  the Agents list says why.
- The server asks opencode-memory at `OVIS_MEMORY_URL` (default `http://127.0.0.1:9824`, `off`
  turns it off). It uses `OPENCODE_MEMORY_API_KEY`, or memory's own key file. While memory is
  down or has no `session_importance` tool, every agent is P2. Each pane's wait clock is kept in
  `wait-clocks.json` beside the shared preferences, so a restart keeps it.
