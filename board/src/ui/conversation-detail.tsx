import type {
  Principal,
  PresenceLease,
  Project,
  ProjectParticipant,
  ProjectRepositoryBinding,
  TaskAnnotation,
  TaskRelay,
} from "@kohoz/meanwhile/contracts";
import { code } from "@streamdown/code";
import {
  ArrowLeft,
  ArrowSquareOut,
  CheckCircle,
  List,
  LockSimple,
} from "@phosphor-icons/react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Streamdown } from "streamdown";
import seatAgent from "./assets/seat-agent.png";
import seatAlice from "./assets/seat-alice.png";
import seatBob from "./assets/seat-bob.png";
import seatPriya from "./assets/seat-priya.png";
import liveDeckBackground from "./assets/live-deck-background.png";
import {
  ConnectionHealth,
  type ConnectionState,
  PresenceRail,
  ProjectSource,
} from "./live-deck";
import {
  displayStatus,
  humanAgent,
  plainInlineMarkdown,
  type PresentedBoardRow,
  workActivityAge,
} from "./presentation";
import { useBoard } from "./store";
import { composeTranscript, type TranscriptDetail, workSummary } from "./transcript";

const HUMAN_SEATS = [seatAlice, seatBob, seatPriya] as const;
const NO_ANNOTATIONS: readonly TaskAnnotation[] = [];
const NO_RELAYS: readonly TaskRelay[] = [];

interface DraftAnnotation {
  readonly anchor: TaskAnnotation["anchor"];
  readonly top: number;
}

interface TranscriptIndexItem {
  readonly sequence: number;
  readonly blockId: string;
  readonly actor: string;
  readonly label: string;
  readonly time: string;
  readonly human: boolean;
}

interface AnchorVisual {
  readonly boxes: readonly { readonly left: number; readonly top: number; readonly width: number; readonly height: number }[];
  readonly sourceX: number;
  readonly sourceY: number;
  readonly elbowX: number;
  readonly targetX: number;
  readonly targetY: number;
}

export const annotationThreadForSequence = <
  Annotation extends { readonly anchor: { readonly sequence: number }; readonly resolvedAt: string | null },
>(annotations: readonly Annotation[], sequence: number): {
  readonly items: readonly Annotation[];
  readonly active: Annotation | null;
} => {
  const items = annotations.filter((annotation) => annotation.anchor.sequence === sequence);
  return {
    items,
    active: items.find((annotation) => annotation.resolvedAt === null) ?? items[0] ?? null,
  };
};

const stableSeat = (identity: Pick<Principal, "id" | "displayName">): string => {
  const name = identity.displayName.toLowerCase();
  if (name.includes("alice")) return seatAlice;
  if (name.includes("bob") || name.includes("owner")) return seatBob;
  if (name.includes("priya")) return seatPriya;
  let hash = 0;
  for (const character of identity.id) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return HUMAN_SEATS[hash % HUMAN_SEATS.length] ?? seatAlice;
};

const Portrait = ({ identity, size = "medium" }: {
  readonly identity: Pick<Principal, "id" | "displayName">;
  readonly size?: "small" | "medium" | "large";
}) => <img className={`cd-portrait cd-portrait-${size}`} src={stableSeat(identity)} alt="" />;

const AgentOrb = ({ size = "medium" }: { readonly size?: "small" | "medium" | "large" }) => (
  <span className={`cd-agent-orb cd-agent-orb-${size}`} aria-hidden="true">
    <img src={seatAgent} alt="" />
  </span>
);

export const TranscriptMarkdown = ({ text, className, live = false, anchorCopy = false }: {
  readonly text: string;
  readonly className?: string;
  readonly live?: boolean;
  readonly anchorCopy?: boolean;
}) => (
  <div className={className} data-anchor-copy={anchorCopy ? "" : undefined}>
    <Streamdown
      mode={live ? "streaming" : "static"}
      animated={live}
      isAnimating={live}
      plugins={{ code }}
      controls={{ code: { copy: true, download: false } }}
      linkSafety={{ enabled: true }}
      shikiTheme={["github-light", "github-dark-default"]}
    >
      {text}
    </Streamdown>
  </div>
);

const taskTitle = (value: string): string =>
  plainInlineMarkdown(value.split("\n").find((line) => line.trim()) ?? "Untitled task").trim();

const taskBody = (value: string): string => {
  const lines = value.split("\n");
  const body = lines.slice(1).join("\n").trim();
  return body || lines[0] || "Untitled task";
};

const clock = (value: string): string =>
  new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(new Date(value));

const date = (value: string): string =>
  new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(
    new Date(value),
  );

const latestTime = (details: readonly TranscriptDetail[]): string =>
  clock(
    details.reduce(
      (latest, detail) =>
        detail.value.lastOccurredAt > latest ? detail.value.lastOccurredAt : latest,
      details[0]?.value.lastOccurredAt ?? new Date(0).toISOString(),
    ),
  );

const sha256 = async (value: string): Promise<string> => {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const DetailSignalField = () => {
  const tones = [
    0, 0, 1, 1, 2, 3, 4, 4, 3, 2, 1, 0, 0, 0, 0, 0,
    0, 1, 2, 3, 5, 7, 8, 8, 7, 5, 3, 1, 0, 0, 0, 0,
    1, 2, 4, 6, 8, 10, 11, 11, 10, 8, 6, 4, 2, 1, 0, 0,
    1, 3, 5, 7, 9, 11, 13, 13, 12, 10, 8, 6, 4, 2, 1, 0,
    2, 4, 6, 8, 10, 12, 13, 13, 12, 11, 9, 7, 5, 3, 1, 0,
    2, 4, 6, 8, 10, 12, 13, 13, 12, 10, 8, 6, 4, 2, 1, 0,
    1, 3, 5, 7, 9, 11, 12, 12, 11, 9, 7, 5, 3, 2, 1, 0,
    1, 2, 4, 6, 8, 9, 10, 10, 9, 8, 6, 4, 2, 1, 0, 0,
    0, 1, 3, 5, 6, 8, 9, 9, 8, 6, 5, 3, 2, 1, 0, 0,
    0, 1, 2, 3, 5, 6, 7, 7, 6, 5, 3, 2, 1, 0, 0, 0,
    0, 0, 1, 2, 3, 4, 5, 5, 4, 3, 2, 1, 0, 0, 0, 0,
  ] as const;
  const palette = [
    "#fbfaf7", "#faf7f3", "#f9f3f0", "#f9eeec", "#f8e9e8", "#f7e4e4", "#f6dfdf",
    "#f4dada", "#f2d6d6", "#efd2d2", "#edcecf", "#eacaca", "#e7c7c8", "#e4c4c5",
  ] as const;
  return (
    <span className="cd-signal-field" aria-hidden="true">
      {tones.map((tone, index) => <i key={index} style={{ backgroundColor: palette[tone] }} />)}
    </span>
  );
};

const SourceBlock = ({ sequence, blockId, children, className = "" }: {
  readonly sequence: number;
  readonly blockId: string;
  readonly children: ReactNode;
  readonly className?: string;
}) => (
  <section
    id={`transcript-${sequence}`}
    className={`cd-anchor-source ${className}`}
    data-anchor-sequence={sequence}
    data-anchor-block-id={blockId}
  >
    {children}
  </section>
);

const record = (value: unknown): Readonly<Record<string, unknown>> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;

const textValue = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const numericValue = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const toolPaths = (detail: Extract<TranscriptDetail, { readonly type: "tool" }>): readonly string[] => {
  const input = record(detail.value.rawInput);
  if (input === null) return [];
  const paths = Array.isArray(input.paths)
    ? input.paths.filter((value): value is string => typeof value === "string")
    : [];
  const single = textValue(input.path) ?? textValue(input.filePath);
  return single === null ? paths : [...paths, single];
};

const ToolResult = ({ detail }: {
  readonly detail: Extract<TranscriptDetail, { readonly type: "tool" }>;
}) => {
  const input = record(detail.value.rawInput);
  const output = record(detail.value.rawOutput);
  const paths = toolPaths(detail);
  const command = textValue(input?.command);
  const changedPath = textValue(input?.path) ?? textValue(input?.filePath);
  const change = textValue(output?.change) ?? textValue(output?.finding);
  const passed = numericValue(output?.passed);
  const failed = numericValue(output?.failed);
  if (paths.length > 0 && ["glob", "grep", "list", "read"].includes(detail.value.kind ?? "")) {
    return <div className="cd-fold-content" data-anchor-copy>{paths.map((path) => <code key={path}>{path}</code>)}</div>;
  }
  if (detail.value.kind === "execute" && (command !== null || passed !== null || failed !== null)) {
    return (
      <div className="cd-fold-content cd-test-result" data-anchor-copy>
        <code>{command ?? detail.value.title ?? "Command"}</code>
        <span>
          {passed !== null ? <strong>{passed} passed</strong> : null}
          {failed !== null ? <i>{failed} failed</i> : null}
        </span>
      </div>
    );
  }
  if (detail.value.kind === "edit" && (change !== null || changedPath !== null)) {
    return (
      <div className="cd-fold-content cd-fix-result" data-anchor-copy>
        {change !== null ? <strong>{change}</strong> : null}
        {changedPath !== null ? <code>{changedPath}</code> : null}
      </div>
    );
  }
  return (
    <div className="cd-fold-content cd-raw-tool-result" data-anchor-copy>
      <pre>{JSON.stringify(detail.value.rawOutput ?? detail.value.rawInput, null, 2)}</pre>
    </div>
  );
};

const TranscriptWork = ({ details }: { readonly details: readonly TranscriptDetail[] }) => {
  const reasoning = details.filter(
    (detail): detail is Extract<TranscriptDetail, { readonly type: "thought" }> =>
      detail.type === "thought",
  );
  const tools = details.filter(
    (detail): detail is Extract<TranscriptDetail, { readonly type: "tool" }> =>
      detail.type === "tool",
  );
  if (reasoning.length > 0) {
    return (
      <div className="cd-reasoning-content">
        <DetailSignalField />
        <div>
          {reasoning.map((detail) => (
            <TranscriptMarkdown key={detail.value.id} text={detail.value.text} className="cd-message-markdown" anchorCopy />
          ))}
          {tools.map((detail) => <ToolResult key={detail.value.id} detail={detail} />)}
        </div>
      </div>
    );
  }
  return <>{tools.map((detail) => <ToolResult key={detail.value.id} detail={detail} />)}</>;
};

const Transcript = ({ row, live }: {
  readonly row: PresentedBoardRow;
  readonly live: boolean;
}) => {
  const runTimeline = useBoard((state) => row.kind === "run" ? state.runTimelines[row.id] : undefined);
  const sessionTimeline = useBoard((state) => row.kind === "session" ? state.sessionTimelines[row.id] : undefined);
  const timeline = row.kind === "run" ? runTimeline : sessionTimeline;
  const blocks = composeTranscript(timeline?.messages ?? [], timeline?.toolCalls ?? []);
  const lastAgentId = [...(timeline?.messages ?? [])].reverse().find((message) => message.role === "agent")?.id;
  return (
    <>
      <SourceBlock sequence={0} blockId="ask" className="cd-opening-message">
        <header><Portrait identity={row.delegatedBy} size="medium" /><strong>{row.delegatedBy.displayName}</strong><time>{clock(row.createdAt)}</time></header>
        <TranscriptMarkdown text={taskBody(row.title)} className="cd-opening-copy" anchorCopy />
      </SourceBlock>
      {blocks.map((block, blockIndex) => {
        if (block.type === "work") {
          const summary = workSummary(block.details);
          const containsReasoning = block.details.some((detail) => detail.type === "thought");
          return (
            <SourceBlock
              key={block.id}
              sequence={block.lastSequence}
              blockId={block.id}
              className={containsReasoning ? "cd-reasoning-block" : "cd-fold-row"}
            >
              <details open={containsReasoning || undefined}>
                <summary><span>{summary.title}</span><time>{latestTime(block.details)}</time></summary>
                <TranscriptWork details={block.details} />
              </details>
            </SourceBlock>
          );
        }
        const agent = block.value.role !== "user";
        const followsWork = blocks.slice(0, blockIndex).some((candidate) => candidate.type === "work");
        return (
          <SourceBlock
            key={block.value.id}
            sequence={block.lastSequence}
            blockId={`message.${block.value.id}`}
            className={`cd-agent-message ${agent && followsWork ? "cd-answer-message" : ""}`}
          >
            <header>{agent ? <AgentOrb size="medium" /> : <Portrait identity={row.delegatedBy} size="medium" />}<strong>{agent ? humanAgent(row.agentType) : row.delegatedBy.displayName}</strong><time>{clock(block.value.lastOccurredAt)}</time></header>
            <TranscriptMarkdown text={block.value.text} className="cd-message-markdown" live={agent && live && block.value.id === lastAgentId} anchorCopy />
          </SourceBlock>
        );
      })}
    </>
  );
};

const AnnotationCard = ({ annotation, canResolve, onResolve }: {
  readonly annotation: TaskAnnotation;
  readonly canResolve: boolean;
  readonly onResolve: (annotation: TaskAnnotation) => Promise<void>;
}) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <article className={`cd-annotation-card ${annotation.resolvedAt ? "is-resolved" : ""}`}>
      <header>
        <strong>{annotation.author.displayName}</strong>
        <time>{clock(annotation.createdAt)}</time>
        <span><LockSimple size={13} weight="regular" aria-hidden="true" />Visible in Northstar</span>
      </header>
      <TranscriptMarkdown text={annotation.body} className="cd-annotation-copy" />
      {annotation.resolvedAt ? (
        <footer><CheckCircle size={16} weight="regular" aria-hidden="true" />Resolved</footer>
      ) : canResolve ? (
        <button type="button" disabled={busy} onClick={async () => {
          setBusy(true);
          setError(null);
          await onResolve(annotation)
            .catch(() => setError("This note could not be resolved."))
            .finally(() => setBusy(false));
        }}><CheckCircle size={16} weight="regular" aria-hidden="true" />{busy ? "Resolving…" : "Resolve"}</button>
      ) : null}
      {error ? <span className="cd-annotation-error" role="alert">{error}</span> : null}
    </article>
  );
};

export const ConversationDetail = ({
  row,
  current,
  project,
  repository,
  members,
  presence,
  recentRelays,
  connectionState,
  onBack,
  onDelegate,
  onRelayChanged,
}: {
  readonly row: PresentedBoardRow;
  readonly current: Principal;
  readonly project: Project;
  readonly repository: ProjectRepositoryBinding | null;
  readonly members: readonly ProjectParticipant[];
  readonly presence: readonly PresenceLease[];
  readonly recentRelays: readonly TaskRelay[];
  readonly connectionState: ConnectionState;
  readonly onBack: () => void;
  readonly onDelegate: () => void;
  readonly onRelayChanged: () => void;
}) => {
  const loadHistory = useBoard((state) => state.loadHistory);
  const ingestEvent = useBoard((state) => state.ingestEvent);
  const refreshAnnotations = useBoard((state) => state.refreshAnnotations);
  const refreshRelays = useBoard((state) => state.refreshRelays);
  const replaceAnnotation = useBoard((state) => state.replaceAnnotation);
  const replaceRelay = useBoard((state) => state.replaceRelay);
  const annotations = useBoard((state) => state.taskAnnotations[`${row.kind}:${row.id}`] ?? NO_ANNOTATIONS);
  const relays = useBoard((state) => state.taskRelays[`${row.kind}:${row.id}`] ?? NO_RELAYS);
  const runTimeline = useBoard((state) => row.kind === "run" ? state.runTimelines[row.id] : undefined);
  const sessionTimeline = useBoard((state) => row.kind === "session" ? state.sessionTimelines[row.id] : undefined);
  const historyLoading = useBoard((state) => state.loading[`${row.kind}:${row.id}`] ?? false);
  const historyError = useBoard((state) => state.errors[`${row.kind}:${row.id}`] ?? null);
  const timeline = row.kind === "run" ? runTimeline : sessionTimeline;
  const transcriptRef = useRef<HTMLDivElement>(null);
  const [activeSequence, setActiveSequence] = useState(0);
  const [draft, setDraft] = useState<DraftAnnotation | null>(null);
  const [note, setNote] = useState("");
  const [noteError, setNoteError] = useState<string | null>(null);
  const [noteBusy, setNoteBusy] = useState(false);
  const [relayOpen, setRelayOpen] = useState(false);
  const [relayRecipientId, setRelayRecipientId] = useState(
    () => members.find((member) => member.principal.kind === "person" && member.principal.id !== current.id)?.principal.id ?? "",
  );
  const [relayNote, setRelayNote] = useState("");
  const [relayBusy, setRelayBusy] = useState(false);
  const [relayError, setRelayError] = useState<string | null>(null);
  const [relayAcknowledgeBusy, setRelayAcknowledgeBusy] = useState(false);
  const [relayAcknowledgeError, setRelayAcknowledgeError] = useState<string | null>(null);
  const [anchorVisual, setAnchorVisual] = useState<AnchorVisual | null>(null);
  const live = ["queued", "provisioning", "running", "closing"].includes(row.status);
  const visiblePeople = useMemo(() => {
    const unique = new Map(presence.map((lease) => [lease.principal.id, lease.principal]));
    return [...unique.values()].sort((left, right) =>
      left.displayName.localeCompare(right.displayName));
  }, [presence]);
  const displayAnnotations = annotations;
  const currentParticipant = members.find((member) => member.principal.id === current.id);
  const relayRecipients = useMemo(
    () => members
      .filter((member) => member.principal.kind === "person" && member.principal.id !== current.id)
      .map((member) => member.principal),
    [current.id, members],
  );
  const relayRecipient = relayRecipients.find((recipient) => recipient.id === relayRecipientId)
    ?? relayRecipients[0]
    ?? null;
  const defaultRelayRecipientId = relayRecipients[0]?.id ?? "";
  const incomingRelay = relays.find((relay) => relay.recipient.id === current.id) ?? null;
  const outgoingRelay = relays.find((relay) => relay.author.id === current.id) ?? null;
  const index = useMemo<readonly TranscriptIndexItem[]>(() => {
    const blocks = composeTranscript(timeline?.messages ?? [], timeline?.toolCalls ?? []);
    return [
      { sequence: 0, blockId: "ask", actor: row.delegatedBy.displayName, label: "Initial ask", time: clock(row.createdAt), human: true },
      ...blocks.map((block, blockIndex): TranscriptIndexItem => {
        if (block.type === "work") {
          return {
            sequence: block.lastSequence,
            blockId: block.id,
            actor: humanAgent(row.agentType),
            label: workSummary(block.details).title.replace(/\s*·.*$/, ""),
            time: latestTime(block.details),
            human: false,
          };
        }
        const agent = block.value.role !== "user";
        const followsWork = blocks.slice(0, blockIndex).some((candidate) => candidate.type === "work");
        return {
          sequence: block.lastSequence,
          blockId: `message.${block.value.id}`,
          actor: agent ? humanAgent(row.agentType) : row.delegatedBy.displayName,
          label: agent ? (followsWork ? "Answer" : "Acknowledged") : "Follow-up",
          time: clock(block.value.lastOccurredAt),
          human: !agent,
        };
      }),
    ];
  }, [row, timeline]);
  const activeIndexPosition = Math.max(0, index.findIndex((item) => item.sequence === activeSequence));
  const activeIndexItem = index[activeIndexPosition] ?? index[0];
  const incomingRelayIndex = incomingRelay === null
    ? null
    : index.find((item) => item.sequence === incomingRelay.anchorSequence) ?? null;
  const incomingRelayTop = incomingRelay === null
    ? null
    : index.length <= 1
      ? 0
      : (Math.max(0, index.findIndex((item) => item.sequence === incomingRelay.anchorSequence)) /
        (index.length - 1)) * 100;

  useEffect(() => {
    setActiveSequence(0);
    setDraft(null);
    setNote("");
    setRelayOpen(false);
    setRelayNote("");
    setRelayError(null);
    setRelayAcknowledgeError(null);
    setRelayRecipientId(defaultRelayRecipientId);
    let disposed = false;
    let source: EventSource | null = null;
    void loadHistory(row.kind, row.id, row.projectId).then((loaded) => {
      if (disposed || !loaded) return;
      const state = useBoard.getState();
      const cursor = row.kind === "run" ? (state.runTimelines[row.id]?.cursor ?? 0) : (state.sessionTimelines[row.id]?.cursor ?? 0);
      source = new EventSource(`/task/${row.kind}/${row.id}/follow?after=${encodeURIComponent(String(cursor))}`);
      source.addEventListener("task", (event) => {
        try { ingestEvent(row.kind, row.id, JSON.parse((event as MessageEvent<string>).data)); }
        catch { source?.close(); }
      });
    });
    void refreshAnnotations(row.kind, row.id, row.projectId);
    void refreshRelays(row.kind, row.id, row.projectId);
    const collaborationPoll = window.setInterval(() => {
      void refreshAnnotations(row.kind, row.id, row.projectId);
      void refreshRelays(row.kind, row.id, row.projectId);
    }, 5_000);
    return () => {
      disposed = true;
      source?.close();
      window.clearInterval(collaborationPoll);
    };
  }, [defaultRelayRecipientId, ingestEvent, loadHistory, refreshAnnotations, refreshRelays, row.id, row.kind, row.projectId]);

  const firstOpenAnnotationSequence = displayAnnotations.find(
    (annotation) => annotation.resolvedAt === null,
  )?.anchor.sequence ?? displayAnnotations[0]?.anchor.sequence ?? null;
  useEffect(() => {
    if (activeSequence === 0 && draft === null && firstOpenAnnotationSequence !== null) {
      setActiveSequence(firstOpenAnnotationSequence);
    }
  }, [activeSequence, draft, firstOpenAnnotationSequence]);

  const pendingIncomingRelayId = incomingRelay?.acknowledgedAt === null ? incomingRelay.id : null;
  useEffect(() => {
    if (pendingIncomingRelayId === null || incomingRelay === null) return;
    setActiveSequence(incomingRelay.anchorSequence);
    setDraft(null);
  }, [incomingRelay?.anchorSequence, pendingIncomingRelayId]);

  const captureSelection = async () => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    const startCopy = range.startContainer.parentElement?.closest<HTMLElement>("[data-anchor-copy]");
    const endCopy = range.endContainer.parentElement?.closest<HTMLElement>("[data-anchor-copy]");
    if (!startCopy || startCopy !== endCopy || !transcriptRef.current?.contains(startCopy)) return;
    const source = startCopy.closest<HTMLElement>(".cd-anchor-source");
    if (!source) return;
    const sourceText = startCopy.textContent ?? "";
    const quote = range.toString();
    if (!quote.trim() || quote.length > 4_096) return;
    const beforeSelection = document.createRange();
    beforeSelection.selectNodeContents(startCopy);
    beforeSelection.setEnd(range.startContainer, range.startOffset);
    const throughSelection = document.createRange();
    throughSelection.selectNodeContents(startCopy);
    throughSelection.setEnd(range.endContainer, range.endOffset);
    const startOffset = beforeSelection.toString().length;
    const endOffset = throughSelection.toString().length;
    if (sourceText.slice(startOffset, endOffset) !== quote) return;
    const sequence = Number(source.dataset.anchorSequence ?? "0");
    const blockId = source.dataset.anchorBlockId ?? `event.${sequence}`;
    const rect = range.getBoundingClientRect();
    const transcriptRect = transcriptRef.current.getBoundingClientRect();
    setActiveSequence(sequence);
    setDraft({
      top: Math.min(88, Math.max(8, ((rect.top - transcriptRect.top) / transcriptRect.height) * 100)),
      anchor: {
        sequence,
        blockId,
        startOffset,
        endOffset,
        quote,
        prefix: sourceText.slice(Math.max(0, startOffset - 256), startOffset),
        suffix: sourceText.slice(endOffset, endOffset + 256),
        contentDigest: await sha256(sourceText),
      },
    });
  };

  const resolveAnnotation = async (annotation: TaskAnnotation) => {
    const response = await fetch(
      `/projects/${row.projectId}/annotations/${annotation.id}/resolve`,
      { method: "POST" },
    ).catch(() => null);
    if (!response?.ok) throw new Error("ANNOTATION_RESOLVE_FAILED");
    const result = (await response.json()) as { annotation: TaskAnnotation };
    replaceAnnotation(result.annotation);
  };

  const createAnnotation = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!draft || !note.trim() || noteBusy) return;
    setNoteBusy(true);
    setNoteError(null);
    const response = await fetch(`/projects/${row.projectId}/annotations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task: { kind: row.kind, id: row.id }, anchor: draft.anchor, body: note.trim() }),
    }).catch(() => null);
    if (!response?.ok) {
      setNoteError("The note could not be added.");
      setNoteBusy(false);
      return;
    }
    const result = (await response.json()) as { annotation: TaskAnnotation };
    replaceAnnotation(result.annotation);
    setNote("");
    setNoteBusy(false);
  };

  const createRelay = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!draft || !relayRecipient || !relayNote.trim() || relayBusy) return;
    setRelayBusy(true);
    setRelayError(null);
    const response = await fetch(`/projects/${row.projectId}/relays`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task: { kind: row.kind, id: row.id },
        anchorSequence: draft.anchor.sequence,
        recipientPrincipalId: relayRecipient.id,
        body: relayNote.trim(),
      }),
    }).catch(() => null);
    if (!response?.ok) {
      setRelayError("This moment could not be passed.");
      setRelayBusy(false);
      return;
    }
    const result = (await response.json()) as { relay: TaskRelay };
    replaceRelay(result.relay);
    onRelayChanged();
    setRelayOpen(false);
    setRelayNote("");
    setRelayBusy(false);
  };

  const acknowledgeRelay = async () => {
    if (incomingRelay === null || incomingRelay.acknowledgedAt !== null || relayAcknowledgeBusy) {
      return;
    }
    setRelayAcknowledgeBusy(true);
    setRelayAcknowledgeError(null);
    const response = await fetch(
      `/projects/${row.projectId}/relays/${incomingRelay.id}/acknowledge`,
      { method: "POST" },
    ).catch(() => null);
    if (!response?.ok) {
      setRelayAcknowledgeError("This handoff could not be acknowledged.");
      setRelayAcknowledgeBusy(false);
      return;
    }
    const result = (await response.json()) as { relay: TaskRelay };
    replaceRelay(result.relay);
    onRelayChanged();
    setRelayAcknowledgeBusy(false);
  };

  const annotatedSequences = new Set(displayAnnotations.map((annotation) => annotation.anchor.sequence));
  const marginaliaIndex = index.filter(
    (item) => item.label !== "Acknowledged" || annotatedSequences.has(item.sequence),
  );
  const marginalia = marginaliaIndex.map((item, itemIndex) => ({
    item,
    top: marginaliaIndex.length === 1 ? 0 : (itemIndex / (marginaliaIndex.length - 1)) * 100,
    annotated: annotatedSequences.has(item.sequence),
  }));
  const activeAnnotationThread = annotationThreadForSequence(displayAnnotations, activeSequence);
  const activeSequenceAnnotations = activeAnnotationThread.items;
  const activeAnnotation = activeAnnotationThread.active;

  useLayoutEffect(() => {
    const transcript = transcriptRef.current;
    const main = transcript?.closest<HTMLElement>(".cd-main") ?? null;
    if (transcript === null || main === null || activeAnnotation === null) {
      setAnchorVisual(null);
      return;
    }
    let frame = 0;
    const measure = () => {
      const source = [...transcript.querySelectorAll<HTMLElement>(".cd-anchor-source")].find(
        (candidate) =>
          Number(candidate.dataset.anchorSequence ?? "-1") === activeAnnotation.anchor.sequence &&
          candidate.dataset.anchorBlockId === activeAnnotation.anchor.blockId,
      );
      const target = main.querySelector<HTMLElement>(
        `.cd-marginalia-timeline button[data-anchor-sequence="${activeAnnotation.anchor.sequence}"] > i`,
      );
      if (source === undefined || target === null) {
        setAnchorVisual(null);
        return;
      }
      const copies = [...source.querySelectorAll<HTMLElement>("[data-anchor-copy]")];
      const copy = copies.find((candidate) => {
        const text = candidate.textContent ?? "";
        return text.slice(activeAnnotation.anchor.startOffset, activeAnnotation.anchor.endOffset) === activeAnnotation.anchor.quote;
      }) ?? copies.find((candidate) => (candidate.textContent ?? "").includes(activeAnnotation.anchor.quote));
      if (copy === undefined) {
        setAnchorVisual(null);
        return;
      }
      const disclosure = copy.closest<HTMLDetailsElement>("details");
      if (disclosure !== null && !disclosure.open) {
        setAnchorVisual(null);
        return;
      }
      const text = copy.textContent ?? "";
      const exactStart = text.slice(activeAnnotation.anchor.startOffset, activeAnnotation.anchor.endOffset) === activeAnnotation.anchor.quote
        ? activeAnnotation.anchor.startOffset
        : text.indexOf(activeAnnotation.anchor.quote);
      if (exactStart < 0) {
        setAnchorVisual(null);
        return;
      }
      const exactEnd = exactStart + activeAnnotation.anchor.quote.length;
      const walker = document.createTreeWalker(copy, NodeFilter.SHOW_TEXT);
      let cursor = 0;
      let startNode: Text | null = null;
      let startOffset = 0;
      let endNode: Text | null = null;
      let endOffset = 0;
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const value = node.textContent ?? "";
        const next = cursor + value.length;
        if (startNode === null && exactStart >= cursor && exactStart <= next) {
          startNode = node as Text;
          startOffset = exactStart - cursor;
        }
        if (exactEnd >= cursor && exactEnd <= next) {
          endNode = node as Text;
          endOffset = exactEnd - cursor;
          break;
        }
        cursor = next;
      }
      if (startNode === null || endNode === null) {
        setAnchorVisual(null);
        return;
      }
      const range = document.createRange();
      range.setStart(startNode, startOffset);
      range.setEnd(endNode, endOffset);
      const mainRect = main.getBoundingClientRect();
      const boxes = [...range.getClientRects()]
        .filter((rect) => rect.width > 0 && rect.height > 0)
        .map((rect) => ({
          left: rect.left - mainRect.left - 3,
          top: rect.top - mainRect.top - 2,
          width: rect.width + 6,
          height: rect.height + 4,
        }));
      const last = boxes.at(-1);
      if (last === undefined) {
        setAnchorVisual(null);
        return;
      }
      const targetRect = target.getBoundingClientRect();
      const transcriptRect = transcript.getBoundingClientRect();
      const sourceX = last.left + last.width;
      const sourceY = last.top + last.height / 2;
      const targetX = targetRect.left - mainRect.left + targetRect.width / 2;
      const targetY = targetRect.top - mainRect.top + targetRect.height / 2;
      setAnchorVisual({
        boxes,
        sourceX,
        sourceY,
        elbowX: Math.max(sourceX + 14, transcriptRect.right - mainRect.left - 112),
        targetX,
        targetY,
      });
    };
    const schedule = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(measure);
    };
    const transcriptObserver = new MutationObserver(schedule);
    transcriptObserver.observe(transcript, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["open"],
    });
    schedule();
    window.addEventListener("resize", schedule);
    transcript.addEventListener("scroll", schedule, { passive: true });
    return () => {
      window.cancelAnimationFrame(frame);
      transcriptObserver.disconnect();
      window.removeEventListener("resize", schedule);
      transcript.removeEventListener("scroll", schedule);
    };
  }, [activeAnnotation, activeSequence, index.length]);

  return (
    <div className="conversation-detail-shell" style={{ "--cd-background": `url(${liveDeckBackground})` } as React.CSSProperties}>
      <header className="live-deck-header cd-global-header">
        <strong className="live-deck-brand">meanwhile</strong><i className="live-deck-header-rule" />
        <button className="live-deck-back" type="button" onClick={onBack}><ArrowLeft size={18} weight="bold" aria-hidden="true" />Live Deck</button>
        <div className="live-deck-project-context">
          <strong className="live-deck-project">{project.name}</strong>
          <ProjectSource repository={repository} />
        </div>
        <div className="live-deck-online"><div>{visiblePeople.slice(0, 3).map((person) => <Portrait key={person.id} identity={person} size="small" />)}</div><span><i />{visiblePeople.length} online</span></div>
        <i className="live-deck-header-rule live-deck-header-rule-right" />
        <ConnectionHealth state={connectionState} />
        <button className="live-deck-new-task" type="button" onClick={onDelegate}>New task</button>
      </header>

      <section className="cd-task-banner">
        <article className="cd-task-pair"><Portrait identity={row.delegatedBy} size="large" /><span>×</span><AgentOrb size="large" /><strong>{humanAgent(row.agentType)}</strong><em>{row.delegatedBy.displayName}</em></article>
        <div className="cd-task-live"><strong><i />{live ? "LIVE" : displayStatus(row.status).toUpperCase()}</strong><span>{workActivityAge(row)}</span></div>
        <i className="cd-banner-rule" />
        <h1>{taskTitle(row.title)}</h1>
        <time><span>Started {clock(row.createdAt)}</span><strong>{date(row.createdAt)}</strong></time>
        <button type="button" onClick={onBack}>Open in Live Deck <ArrowSquareOut size={16} weight="regular" aria-hidden="true" /></button>
      </section>

      <main className="cd-main">
        <aside className="cd-index-panel">
          <header><strong>TRANSCRIPT INDEX</strong><List size={14} weight="regular" aria-hidden="true" /></header>
          <div className="cd-index-line" />
          <nav style={{ "--cd-index-count": Math.max(1, index.length) } as React.CSSProperties}>
            {index.map((item) => (
              <button className={activeSequence === item.sequence ? "is-active" : ""} type="button" key={`${item.sequence}:${item.blockId}`} onClick={() => {
                setActiveSequence(item.sequence);
                document.getElementById(`transcript-${item.sequence}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
              }}>
                <time>{item.time}</time>{item.human ? <Portrait identity={row.delegatedBy} size="small" /> : <AgentOrb size="small" />}<span><strong>{item.actor}</strong><em>{item.label}</em></span>
              </button>
            ))}
          </nav>
        </aside>

        <section
          className="cd-transcript-panel"
          aria-label="Live agent transcript"
          ref={transcriptRef}
          onPointerUp={() => void captureSelection()}
          onDoubleClick={() => void captureSelection()}
          onKeyUp={() => void captureSelection()}
        >
          <Transcript row={row} live={live} />
          {historyLoading && timeline === undefined ? (
            <div className="cd-transcript-state" role="status">Opening the agent transcript…</div>
          ) : null}
          {historyError && timeline === undefined ? (
            <div className="cd-transcript-state is-error" role="alert">
              <span>{historyError}</span>
              <button type="button" onClick={() => void loadHistory(row.kind, row.id, row.projectId)}>Retry</button>
            </div>
          ) : null}
        </section>

        <aside className="cd-marginalia-panel" aria-label="Transcript marginalia">
          <header><strong>MARGINALIA</strong><span>{displayAnnotations.length} {displayAnnotations.length === 1 ? "annotation" : "annotations"}</span></header>
          <div
            className="cd-marginalia-timeline"
            style={{ "--cd-anchor-count": index.length } as React.CSSProperties}
          >
            <i className="cd-marginalia-line" />
            {marginalia.map(({ item, top, annotated = false }) => (
              <button type="button" key={item.blockId} data-anchor-sequence={item.sequence} className={`${activeSequence === item.sequence ? "is-active" : ""} ${annotated ? "has-annotation" : ""}`} style={{ top: `${top}%` }} onClick={() => {
                setActiveSequence(item.sequence);
                document.getElementById(`transcript-${item.sequence}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
              }}><i /><time>{item.time}</time><span>{item.label}</span></button>
            ))}
          </div>
          {activeIndexItem ? (
            <div className="cd-mobile-anchor-current" aria-live="polite">
              <time>{activeIndexItem.time}</time>
              <strong>{activeIndexItem.label}</strong>
              <span>{activeIndexPosition + 1} / {index.length}</span>
            </div>
          ) : null}
          <section
            className={`cd-annotation-stack ${incomingRelay ? "has-incoming-relay" : ""}`}
            style={{ top: `${incomingRelayTop ?? draft?.top ?? 42}%` }}
          >
            {incomingRelay ? (
              <article
                className={`cd-incoming-relay ${incomingRelay.acknowledgedAt ? "is-acknowledged" : ""}`}
                aria-label={`Relay from ${incomingRelay.author.displayName}`}
              >
                <header>
                  <Portrait identity={incomingRelay.author} size="small" />
                  <span><strong>{incomingRelay.author.displayName}</strong><em>passed this to you</em></span>
                  <time>{clock(incomingRelay.createdAt)}</time>
                </header>
                <button type="button" className="cd-incoming-relay-source" onClick={() => {
                  setActiveSequence(incomingRelay.anchorSequence);
                  document.getElementById(`transcript-${incomingRelay.anchorSequence}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
                }}>
                  <span>Exact moment</span>
                  <strong>{incomingRelayIndex?.label ?? `Transcript moment ${incomingRelay.anchorSequence}`}</strong>
                  <ArrowSquareOut size={14} weight="regular" aria-hidden="true" />
                </button>
                <p>{incomingRelay.body}</p>
                <footer>
                  <span>{incomingRelay.acknowledgedAt ? `Received ${clock(incomingRelay.acknowledgedAt)}` : "Only you can close this handoff."}</span>
                  {incomingRelay.acknowledgedAt ? (
                    <strong><CheckCircle size={14} weight="regular" aria-hidden="true" />Acknowledged</strong>
                  ) : (
                    <button type="button" disabled={relayAcknowledgeBusy} onClick={() => void acknowledgeRelay()}>
                      {relayAcknowledgeBusy ? "Acknowledging…" : "Acknowledge"}
                    </button>
                  )}
                </footer>
                {relayAcknowledgeError ? <span className="cd-incoming-relay-error" role="alert">{relayAcknowledgeError}</span> : null}
              </article>
            ) : null}
            <div className="cd-annotation-thread">
              {activeSequenceAnnotations.map((annotation) => (
                <AnnotationCard
                  key={annotation.id}
                  annotation={annotation}
                  canResolve={annotation.author.id === current.id || currentParticipant?.access === "administer"}
                  onResolve={resolveAnnotation}
                />
              ))}
            </div>
            <form className="cd-note-composer" onSubmit={createAnnotation}>
              <div><Portrait identity={current} size="small" /><input aria-label="Annotation note" value={note} onChange={(event) => setNote(event.target.value)} maxLength={2_000} placeholder={draft ? "Add a note…" : "Select transcript text first…"} disabled={!draft} /></div>
              <footer>Anchored to selected transcript text <button type="submit" disabled={!draft || !note.trim() || noteBusy}>{noteBusy ? "Adding…" : "Add"}</button></footer>
            </form>
            {noteError ? <span className="cd-note-error" role="alert">{noteError}</span> : null}
            <button
              className="cd-relay-exact"
              type="button"
              disabled={relayRecipients.length === 0}
              onClick={() => setRelayOpen((value) => !value)}
            >
              {relayRecipients.length === 0 ? "Relay needs another teammate" : "Relay this exact moment"}
            </button>
            {relayOpen ? (
              <form className="cd-relay-popover" aria-label="Relay exact transcript moment" onSubmit={createRelay}>
                <header>
                  <span>EXACT MOMENT</span>
                  <q>{draft?.anchor.quote ?? "Select transcript text first."}</q>
                </header>
                <fieldset>
                  <legend>Pass to</legend>
                  <div>
                    {relayRecipients.map((recipient) => (
                      <button
                        type="button"
                        key={recipient.id}
                        className={relayRecipient?.id === recipient.id ? "is-selected" : ""}
                        aria-pressed={relayRecipient?.id === recipient.id}
                        onClick={() => setRelayRecipientId(recipient.id)}
                      >
                        <Portrait identity={recipient} size="small" />
                        <span>{recipient.displayName}</span>
                        <i>{relayRecipient?.id === recipient.id ? "Selected" : ""}</i>
                      </button>
                    ))}
                  </div>
                </fieldset>
                <label>
                  <span>What should they carry?</span>
                  <textarea
                    value={relayNote}
                    onChange={(event) => setRelayNote(event.target.value)}
                    maxLength={2_000}
                    placeholder="Add the thought, decision, or question that travels with this source moment…"
                  />
                </label>
                <footer>
                  <span>Source and note travel together.</span>
                  <button type="submit" disabled={!draft || !relayRecipient || !relayNote.trim() || relayBusy}>
                    {relayBusy ? "Passing…" : relayRecipient ? `Pass to ${relayRecipient.displayName}` : "Choose a teammate"}
                  </button>
                </footer>
                {relayError ? <p role="alert">{relayError}</p> : null}
              </form>
            ) : null}
            {outgoingRelay ? (
              <div className="cd-relay-receipt">
                <CheckCircle size={14} weight="regular" aria-hidden="true" />
                <span>
                  <strong>Passed to {outgoingRelay.recipient.displayName}</strong>
                  <small>{outgoingRelay.acknowledgedAt ? "Acknowledged" : "Awaiting acknowledgement"}</small>
                </span>
              </div>
            ) : null}
          </section>
        </aside>
        {anchorVisual ? (
          <div className="cd-anchor-visual" aria-hidden="true">
            {anchorVisual.boxes.map((box, boxIndex) => (
              <i className="cd-anchor-highlight" key={boxIndex} style={box} />
            ))}
            <i
              className="cd-anchor-wire cd-anchor-wire-source"
              style={{
                left: anchorVisual.sourceX,
                top: anchorVisual.sourceY,
                width: Math.max(0, anchorVisual.elbowX - anchorVisual.sourceX),
              }}
            />
            <i
              className="cd-anchor-wire cd-anchor-wire-turn"
              style={{
                left: anchorVisual.elbowX,
                top: Math.min(anchorVisual.sourceY, anchorVisual.targetY),
                height: Math.abs(anchorVisual.targetY - anchorVisual.sourceY),
              }}
            />
            <i
              className="cd-anchor-wire cd-anchor-wire-target"
              style={{
                left: anchorVisual.elbowX,
                top: anchorVisual.targetY,
                width: Math.max(0, anchorVisual.targetX - anchorVisual.elbowX - 5),
              }}
            />
          </div>
        ) : null}
      </main>

      <PresenceRail project={project} visiblePeople={visiblePeople} relays={recentRelays} />
    </div>
  );
};
