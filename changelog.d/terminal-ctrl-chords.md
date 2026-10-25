### Fixed
- Key-bar Ctrl and a typed letter now sends the chord from the terminal input line too, and from
  direct typing with an IME such as Gboard, including a letter typed right after a word and a
  letter added to a word Gboard still had open when Ctrl was tapped, so Ctrl+P opens an agent's
  command palette instead of typing a "p". Tested in Chromium with simulated keyboard events;
  Gboard, Samsung Keyboard and iOS keyboards still need a check on a real device.
- A hardware Ctrl+letter in the terminal input line goes to the pane, except select all, the
  clipboard, undo and redo, and the line's own keys, which no longer open the browser's History,
  Downloads, bookmark or Save page dialogs: Ctrl+H deletes back, Ctrl+M sends, Ctrl+J breaks the
  line, and Ctrl+I, Ctrl+S and Ctrl+D on a line with text do nothing. Ctrl+D on an empty line goes
  to the pane; Ctrl+S, which would freeze the pane's output, goes only from the key bar.
- Ctrl+P in two boxes, the terminal input line and the chat composer, no longer opens the browser's
  print dialog; the change blocks it nowhere else.
