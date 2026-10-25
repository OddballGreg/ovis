### Fixed
- An OpenCode 1.x pane's status pill names the model the TUI's footer shows, so a model picked in
  the chip or in the terminal shows there at once, not only after the next reply. It is read again
  when a turn starts or ends and every 20 seconds while the page is shown.
- The server logs one line for each OpenCode model switch that fails, with its code and what the
  drive saw, so a real failure can be told from one the footer did not confirm.
