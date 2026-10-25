import { expect, it } from "bun:test";

import type { OpencodeModelCatalog } from "../../shared/protocol.ts";
import { opencodeLaunchModels, opencodeModelMatches, opencodeModelName } from "./opencodeModels.ts";

const catalog: OpencodeModelCatalog = {
  available: true,
  providers: [
    { id: "go", name: "OpenCode Go", models: [{ id: "kimi-k3", name: "Kimi K3" }] },
    { id: "duo", name: "GitLab Duo", models: [{ id: "opus-5", name: "Agentic Chat (Claude Opus 5)" }] },
  ],
  current: { provider_id: "duo", model_id: "opus-5" },
};

it("finds a model by any words of its name, its provider or its id", () => {
  const [go, duo] = catalog.providers;
  expect(opencodeModelMatches("", go!, go!.models[0]!)).toBe(true);
  expect(opencodeModelMatches("kimi go", go!, go!.models[0]!)).toBe(true);
  expect(opencodeModelMatches("OPUS duo", duo!, duo!.models[0]!)).toBe(true);
  expect(opencodeModelMatches("duo/opus", duo!, duo!.models[0]!)).toBe(true);
  expect(opencodeModelMatches("opus go", duo!, duo!.models[0]!)).toBe(false);
});

it("names the model in use only when the list has it", () => {
  expect(opencodeModelName(catalog, catalog.current)).toBe("Agentic Chat (Claude Opus 5)");
  expect(opencodeModelName(catalog, { provider_id: "go", model_id: "gone" })).toBeNull();
  expect(opencodeModelName(catalog, null)).toBeNull();
});

it("offers each model as provider/id for a new session", () => {
  expect(opencodeLaunchModels(catalog)).toEqual([
    { value: "go/kimi-k3", label: "Kimi K3 · OpenCode Go" },
    { value: "duo/opus-5", label: "Agentic Chat (Claude Opus 5) · GitLab Duo" },
  ]);
  expect(opencodeLaunchModels({ ...catalog, available: false })).toEqual([]);
  expect(opencodeLaunchModels(null)).toEqual([]);
});
