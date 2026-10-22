### Fixed
- Earlier Claude sessions are listed from the store of the pane you open the list from
  (`CLAUDE_CONFIG_DIR`), and Resume starts the session in that same store, so a second account's
  session with the same id is neither listed nor opened by mistake. When the store cannot be told,
  a new tab would not start in the same store, or the PC's bridge is older, Resume is shown as
  unavailable instead of starting the session in the default store.
