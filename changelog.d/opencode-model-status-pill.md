### Fixed
- An OpenCode 1.x pane's status pill names the model the TUI's footer shows, so a model picked in
  the chip or in the terminal shows there at once, not only after the next reply. It is read again
  when a turn starts or ends and every 20 seconds while the page is shown. While a read cannot name
  a model (a dialog covers the footer, or a switch is still on its way), the pill keeps the last
  model it showed and does not fall back to the reply's model and back again.
- With the TUI's model, the pill shows the TUI's own reasoning level, the one its footer draws after
  the provider, and none when the footer draws none. The last reply's level belonged to the model
  that wrote it and is no longer shown with another.
- The server logs one line for each OpenCode model switch that fails, or that the drive refuses
  before any key (a dialog already open, a footer that names no model), with the pane, its code and
  what the drive saw, so a real failure can be told from one the footer did not confirm.
