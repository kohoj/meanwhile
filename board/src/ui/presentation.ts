import type { ProjectWorkItem } from "@kohoz/meanwhile/contracts";

type BoardSection = "attention" | "active" | "ready" | "completed";

export interface PresentedBoardRow extends ProjectWorkItem {
  readonly section: BoardSection;
}

export const humanAgent = (value: string): string =>
  value
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");

export const statusTone = (status: string): "alert" | "active" | "ready" | "quiet" => {
  if (["failed", "timed_out", "continuity_lost"].includes(status)) return "alert";
  if (status === "idle") return "ready";
  if (["queued", "provisioning", "running", "closing"].includes(status)) return "active";
  return "quiet";
};

export const displayStatus = (status: string): string => {
  if (status === "idle") return "ready";
  if (status === "succeeded" || status === "closed") return "completed";
  return status.replace("_", " ");
};

export const taskAttention = (
  row: Pick<PresentedBoardRow, "section" | "delegatedBy">,
  currentPrincipalId: string,
): string | null => {
  if (row.section !== "attention") return null;
  return row.delegatedBy.id === currentPrincipalId
    ? "Needs you"
    : `Needs ${row.delegatedBy.displayName}, not you`;
};

export const projectVerdict = (
  rows: readonly PresentedBoardRow[],
  currentPrincipalId: string,
  memberCount: number,
): { readonly personal: string; readonly project: string; readonly projectNeedsAttention: boolean } => {
  const needsCurrent = rows.filter(
    (row) => row.section === "attention" && row.delegatedBy.id === currentPrincipalId,
  ).length;
  const needsOthers = new Map<string, number>();
  for (const row of rows) {
    if (row.section !== "attention" || row.delegatedBy.id === currentPrincipalId) continue;
    needsOthers.set(row.delegatedBy.displayName, (needsOthers.get(row.delegatedBy.displayName) ?? 0) + 1);
  }
  const firstOther = [...needsOthers.entries()][0];
  const personal =
    needsCurrent === 0
      ? "Nothing needs you."
      : `${needsCurrent} ${needsCurrent === 1 ? "task needs" : "tasks need"} you.`;
  if (firstOther !== undefined) {
    return {
      personal,
      project: `${firstOther[1]} ${firstOther[1] === 1 ? "task needs" : "tasks need"} ${firstOther[0]}.`,
      projectNeedsAttention: true,
    };
  }
  if (rows.length === 0) {
    return {
      personal,
      project: "No work has been delegated to this Project yet.",
      projectNeedsAttention: false,
    };
  }
  return {
    personal,
    project:
      needsCurrent > 0
        ? "No other work needs attention."
        : memberCount > 1
          ? "Everyone else is clear."
          : "Project work is clear.",
    projectNeedsAttention: false,
  };
};
