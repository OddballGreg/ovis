export const MAX_MESSAGE_BYTES: number;
export const MAX_ANSWER_CHARS: number;
export const MAX_LABEL_CHARS: number;
export const MAX_HEADER_CHARS: number;
export const MAX_QUESTIONS: number;
export const MAX_OPTIONS: number;

export interface BridgeOption { label: string; description: string }
export interface BridgeQuestion { question: string; header: string; options: BridgeOption[]; multiple: boolean; custom: boolean }
export interface BridgeRequest { id: string; sessionID: string; questions: BridgeQuestion[] }
export type BridgeAnswer =
  | { ok: true; questions?: (BridgeRequest & { rootSessionID: string })[] }
  | { ok: false; code: string; message: string };

export interface BridgeClient {
  _client?: {
    get?(options: { url: string }): Promise<{ data?: unknown; error?: unknown; response?: { status: number } }>;
    post?(options: { url: string; path: Record<string, string>; body?: unknown; headers?: Record<string, string> }): Promise<{ data?: unknown; error?: unknown; response?: { status: number } }>;
  };
  session: { get(options: { path: { id: string } }): Promise<{ data?: { parentID?: string } }> };
}

export interface Bridge {
  pending: Map<string, BridgeRequest>;
  parents: Map<string, string | null>;
  handleEvent(event: unknown): void;
  handle(message: unknown): Promise<BridgeAnswer>;
  list(): Promise<BridgeAnswer>;
}

export interface Handler { handle(message: unknown): Promise<BridgeAnswer> }
type Log = (tag: string, data: Record<string, unknown>) => void;

export function socketPathFor(env?: Record<string, string | undefined>): string | null;
export function isTuiProcess(argv?: string[]): boolean;
export function enabled(env?: Record<string, string | undefined>, argv?: string[]): boolean;
export function normalizeRequest(value: unknown): BridgeRequest | null;
export function validateAnswers(request: BridgeRequest, answers: unknown): string | null;
export function createBridge(options: { client: BridgeClient; log?: Log }): Bridge;
export function listen(bridge: Handler, socketPath: string, options?: { log?: Log }): Promise<{ close(): void; server: import("node:net").Server } | null>;
export function createHub(): {
  bridges: Set<Bridge>;
  dispatch: Handler;
  add(bridge: Bridge, socketPath: string, log: Log): Promise<void>;
  remove(bridge: Bridge, socketPath: string, log: Log): Promise<void>;
  readonly listening: boolean;
};
export const OvisQuestionsPlugin: (input: { client?: BridgeClient }) => Promise<{ event?(input: { event: unknown }): Promise<void>; dispose?(): Promise<void> }>;
declare const plugin: { id: string; server: typeof OvisQuestionsPlugin };
export default plugin;
