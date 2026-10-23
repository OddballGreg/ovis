### Fixed
- Limit synchronous macOS process-start probes to one second and reuse brief, bounded readings
  so repeated conversation and pending-send checks launch fewer subprocesses.
