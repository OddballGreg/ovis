### Added
- **Settings → Appearance → Agents order → Longest wait** lists blocked agents first, then unread
  finishes, then ready agents, then working ones, each with the oldest state change first. It
  follows herdr's own agent view sorted by status and then `state_change_seq`, except that an
  opened finish counts as ready and BG (waiting) counts as working.
