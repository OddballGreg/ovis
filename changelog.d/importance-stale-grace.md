### Fixed
- One slow or failed opencode-memory answer no longer turns every agent neutral (P2) in
  Importance order and herdr's sidebar until the next answer: the levels of memory's last answer
  stay for 10 minutes after it, and only then does every agent go neutral. Memory without the
  `session_importance` tool still leaves every agent neutral at once.
