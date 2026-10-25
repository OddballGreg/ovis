/**
 * OpenCode's model list as the composer's model chip and the new session dialog use it
 * (GET /api/pane/opencode-models, GET /api/agent/models; server/opencode-model.ts).
 */
import type { OpencodeModel, OpencodeModelCatalog, OpencodeProvider } from "../../shared/protocol.ts";

/** Whether a search names this model: every word in its name, its provider's name or its `provider/id`, in any case. */
export function opencodeModelMatches(query: string, provider: OpencodeProvider, model: OpencodeModel): boolean {
  const words = query.toLowerCase().split(/\s+/u).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = `${model.name} ${provider.name} ${provider.id}/${model.id}`.toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/** The name of the model a catalog says is in use, or null when it names none it lists. */
export function opencodeModelName(catalog: OpencodeModelCatalog, model: { provider_id: string; model_id: string } | null): string | null {
  if (model === null) return null;
  return catalog.providers.find((provider) => provider.id === model.provider_id)?.models.find((each) => each.id === model.model_id)?.name ?? null;
}

/** `--model` values for a new OpenCode session, `provider/id`, with the name each stands for. */
export function opencodeLaunchModels(catalog: OpencodeModelCatalog | null): { value: string; label: string }[] {
  if (catalog === null || !catalog.available) return [];
  return catalog.providers.flatMap((provider) => provider.models.map((model) => ({ value: `${provider.id}/${model.id}`, label: `${model.name} · ${provider.name}` })));
}
