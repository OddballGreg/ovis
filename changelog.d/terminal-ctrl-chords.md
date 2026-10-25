### Fixed
- Key-bar Ctrl and a typed letter now sends the chord from the terminal input line too, and from
  direct typing with an IME such as Gboard, including a letter typed right after a word, so Ctrl+P
  opens an agent's command palette instead of typing a "p". Tested in Chromium with simulated
  keyboard events; Gboard, Samsung Keyboard and iOS keyboards still need a check on a real device.
- A hardware Ctrl+letter in the terminal input line goes to the pane, except the line's own
  editing keys: select all, the clipboard, undo and redo, Ctrl+H, I, J and M, and Ctrl+D and
  Ctrl+S while the line holds text.
- Ctrl+P in two boxes, the terminal input line and the chat composer, no longer opens the browser's
  print dialog; the change blocks it nowhere else.
