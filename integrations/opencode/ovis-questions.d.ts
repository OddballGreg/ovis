export const MAX_MESSAGE_BYTES: number;
export const MAX_ANSWER_CHARS: number;

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

export function socketPathFor(env?: Record<string, string | undefined>): string | null;
export function isTuiProcess(argv?: string[]): boolean;
export function enabled(env?: Record<string, string | undefined>, argv?: string[]): boolean;
export function normalizeRequest(value: unknown): BridgeRequest | null;
export function validateAnswers(request: BridgeRequest, answers: unknown): string | null;
export function createBridge(options: { client: BridgeClient; log?: (tag: string, data: Record<string, unknown>) => void }): Bridge;
export function listen(bridge: Bridge, socketPath: string, options?: { log?: (tag: string, data: Record<string, unknown>) => void }): Promise<{ close(): void } | null>;
export const OvisQuestionsPlugin: (input: { client?: BridgeClient }) => Promise<Record<string, unknown>>;
declare const plugin: { id: string; server: typeof OvisQuestionsPlugin };
export default plugin;
