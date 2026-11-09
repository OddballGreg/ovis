### Added
- A session parked in opencode-memory (P4) goes after every other agent in Importance order,
  never ages and is never lifted, and the Agents list folds those rows into a Parked group at its
  bottom. The row menu and `POST /api/agent/importance` accept P4, and the herdr sync reports it
  as `prio` P4.
