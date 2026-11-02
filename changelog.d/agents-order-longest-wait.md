### Added
- **Settings → Appearance → Agents order → Longest wait** lists blocked agents first, then
  unread finishes and ready agents as one group, then working ones, each with the oldest state
  change first. Unread and ready share a group because a herdr restart turns unread finishes into
  ready ones that nobody opened. It follows herdr's own agent view sorted by status and then
  `state_change_seq`, except that unread and ready are one group and BG (waiting) counts as
  working.
