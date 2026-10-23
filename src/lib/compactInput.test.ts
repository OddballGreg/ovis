import { describe, expect, it } from "bun:test";

import { keyBarFolded } from "./compactInput.ts";

describe("keyBarFolded", () => {
  it("never folds the key bar while the Compact input line is off", () => {
    for (const shown of [false, true]) for (const inputLine of [false, true]) {
      expect(keyBarFolded({ compact: false, shown, inputLine })).toBe(false);
    }
  });

  it("folds the key bar behind the input line until its button shows it", () => {
    expect(keyBarFolded({ compact: true, shown: false, inputLine: true })).toBe(true);
    expect(keyBarFolded({ compact: true, shown: true, inputLine: true })).toBe(false);
  });

  it("keeps the key bar without an input line: it is then the only way back from direct typing", () => {
    expect(keyBarFolded({ compact: true, shown: false, inputLine: false })).toBe(false);
    expect(keyBarFolded({ compact: true, shown: true, inputLine: false })).toBe(false);
  });
});
