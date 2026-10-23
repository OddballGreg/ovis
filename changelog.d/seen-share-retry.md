### Fixed
- Read finishes shared with other browsers now retry network and proxy errors with backoff, and
  resume after signing in again, without resending on every sidebar update.
