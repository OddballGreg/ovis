import type { HerdrTab, PaneInfo } from "../../shared/protocol.ts";
import { tabLabelKey } from "./tabLabels.ts";

/**
 * The name a tab was given, or null while herdr names it itself: by its place in the row ("2"),
 * which herdr moves up when a tab before it closes while the tab keeps its number.
 */
export function customTabLabel(tab: Pick<HerdrTab, "label" | "number">, place: number = tab.number): string | null {
  const label = tab.label.trim();
  return label === "" || label === String(place) ? null : label;
}

/** A tab of one pane that was named (Rename pane) goes by that pane's name until the tab is named. */
export function lonePaneLabel(panes: readonly { label?: string | null }[]): string | null {
  if (panes.length !== 1) return null;
  const label = panes[0]?.label?.trim() ?? "";
  return label === "" ? null : label;
}

/** herdr names a tab by its place until it is renamed: the strip says so in words. */
export function tabLabel(tab: Pick<HerdrTab, "label" | "number">, t: (key: string, vars?: Record<string, string | number>) => string, place: number = tab.number, panes: readonly { label?: string | null }[] = []): string {
  return customTabLabel(tab, place) ?? lonePaneLabel(panes) ?? t("Tab {n}", { n: place });
}

type TabPane = Pick<PaneInfo, "pane_id" | "terminal_id">;

/**
 * The label a tab takes from its first message (lib/tabLabels.ts): only while herdr names it by its
 * number, never over a name someone gave it (Rename tab, the New tab dialog's Name, a script, an
 * agent's name typed as one). `panes` are the tab's, in the order whose label wins; null when none
 * has one. The tab's hover stays its pane's title.
 */
export function autoTabLabel(tab: Pick<HerdrTab, "label" | "number">, panes: readonly TabPane[], machineId: string, labels: Readonly<Record<string, string>>, place: number = tab.number): string | null {
  if (customTabLabel(tab, place) !== null) return null;
  for (const pane of panes) {
    const label = labels[tabLabelKey(machineId, pane)];
    if (label) return label;
  }
  return null;
}
