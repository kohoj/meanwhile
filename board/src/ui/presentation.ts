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

/**
 * Removes only Markdown presentation syntax. Code identifiers, globs, and snake_case remain
 * byte-for-byte readable because collaboration surfaces often carry executable vocabulary.
 */
export const plainInlineMarkdown = (value: string): string =>
  value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/(\*\*|__|~~)(\S(?:[^\n]*?\S)?)\1/g, "$2")
    .replace(/(^|[\s([{])([*_])(\S(?:[^\n]*?\S)?)\2(?=$|[\s)\]}.,!?])/g, "$1$3");

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

const ACTIVE_WORK_STATUSES = new Set(["queued", "provisioning", "running", "closing"]);

/**
 * Active work shows time since acceptance. Inactive work shows time since its last state change.
 * This keeps the compact card/header value honest across live, ready, and terminal work.
 */
export const workActivityAge = (
  row: Pick<PresentedBoardRow, "status" | "createdAt" | "updatedAt">,
  now = Date.now(),
): string => {
  const reference = ACTIVE_WORK_STATUSES.has(row.status) ? row.createdAt : row.updatedAt;
  const minutes = Math.max(1, Math.round((now - Date.parse(reference)) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`;
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
  pendingRelayCount = 0,
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
  const personalParts = [
    ...(needsCurrent === 0
      ? []
      : [`${needsCurrent} ${needsCurrent === 1 ? "task needs" : "tasks need"} you`]),
    ...(pendingRelayCount === 0
      ? []
      : [`${pendingRelayCount} ${pendingRelayCount === 1 ? "Relay is" : "Relays are"} waiting`]),
  ];
  const personal = personalParts.length === 0 ? "Nothing needs you." : `${personalParts.join(" · ")}.`;
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
