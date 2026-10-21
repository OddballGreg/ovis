### Changed
- GJC chat reads the active session reported by a native extension instead of querying the SDK
  broker. Install it with `bun scripts/install-gjc-integration.ts` and restart GJC; sessions
  without the extension use Terminal. Command menus use the filesystem skill catalog.
