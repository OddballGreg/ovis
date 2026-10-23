/**
 * The Agents list's rows in the order it draws them: the pinned card first, in pin order, then
 * every PC's agents in the roster's order, or in that PC's own Activity or Longest wait order when
 * Settings asks for it (lib/sidebarOrder.ts). A row is its PC and its pane: two PCs may reuse a pane id.
 */
import type { Machine } from "../../shared/machines.ts";
import type { AgentStatus, HerdrPane } from "../../shared/protocol.ts";
import type { AgentOrder } from "./settings.ts";
import { sidebarAgents, type SidebarAgent } from "./sidebarAgents.ts";
import { activityOrder, waitingOrder } from "./sidebarOrder.ts";
import { sidebarPinKey, splitPinnedRows } from "./sidebarPins.ts";

export interface AgentRow { machine: Machine; entry: SidebarAgent }

export interface AgentRosterOptions {
  /** Settings → Agents order: Activity and Longest wait sort each PC's rows by that PC's own counters */
  order: AgentOrder;
  /** a PC's state-change counters, as lib/sidebarActivity.tsx keeps them */
  seqs(machineId: string): ReadonlyMap<string, number>;
  /** the status a row draws, an opened finish as ready (lib/sidebarActivity.tsx); Longest wait ranks by it */
  status(machineId: string, pane: HerdrPane): AgentStatus | undefined;
  /** the pinned rows' keys (lib/sidebarPins.ts), in pin order */
  pinned: readonly string[];
}

/** Every PC's agent rows as the list draws them: the pinned ones first, then the rest in source order. */
export function agentRoster(machines: readonly Machine[], options: AgentRosterOptions): { pinned: AgentRow[]; rest: AgentRow[] } {
  const rows = machines.flatMap((machine) => {
    const agents = sidebarAgents(machine.snapshot);
    const ordered = options.order === "activity" ? activityOrder(agents, (entry) => entry.pane, options.seqs(machine.id))
      : options.order === "waiting" ? waitingOrder(agents, (entry) => entry.pane, (entry) => options.status(machine.id, entry.pane), options.seqs(machine.id))
      : agents;
    return ordered.map((entry): AgentRow => ({ machine, entry }));
  });
  return splitPinnedRows(rows, options.pinned, ({ machine, entry }) => sidebarPinKey(machine.id, entry.pane.pane_id));
}
