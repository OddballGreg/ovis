### Added
- **Settings → Appearance → Agents order → Longest wait** lists blocked agents first, then unread
  finishes, then ready agents (an opened finish counts as ready), then working ones, each with the
  oldest state change first, as herdr's own agent view sorted by status and then
  `state_change_seq` does.
