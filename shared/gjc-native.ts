/** The GJC extension publishes only identity, never conversation contents. */
export interface GjcNativeBinding {
  version: 1;
  pid: number;
  processStartedAt: number;
  instanceId: string;
  /** Changes only with session identity; heartbeats refresh updatedAt alone. */
  sequence: number;
  updatedAt: number;
  session: { id: string; path: string; cwd: string } | null;
}

export const GJC_NATIVE_DIRECTORY = "herdr-web-ui";
export const GJC_NATIVE_HEARTBEAT_MS = 2_000;
export const GJC_NATIVE_LEASE_MS = 10_000;
