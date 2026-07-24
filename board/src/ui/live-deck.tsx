import type {
  Principal,
  PresenceLease,
  Project,
  ProjectRepositoryBinding,
  TaskRelay,
} from "@kohoz/meanwhile/contracts";
import {
  ArrowLeft,
  ArrowRight,
  Brain,
  CheckCircle,
  FileText,
  GithubLogo,
  GitBranch,
  ShieldCheck,
  TerminalWindow,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import deckAgentBlue from "./assets/deck-agent-blue.png";
import deckAgentCoral from "./assets/deck-agent-coral.png";
import deckAgentNeutral from "./assets/deck-agent-neutral.png";
import deckAgentViolet from "./assets/deck-agent-violet.png";
import liveDeckBackground from "./assets/live-deck-background.png";
import seatAlice from "./assets/seat-alice.png";
import seatBob from "./assets/seat-bob.png";
import seatPriya from "./assets/seat-priya.png";
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
const AGENT_SEATS: Readonly<Record<DeckTone | "neutral", string>> = {
  coral: deckAgentCoral,
  blue: deckAgentBlue,
  violet: deckAgentViolet,
  neutral: deckAgentNeutral,
};

export const ProjectSource = ({
  repository,
}: {
  readonly repository: ProjectRepositoryBinding | null;
}) => repository ? (
  <span className="live-deck-source">
    <GithubLogo size={18} weight="fill" aria-hidden="true" />
    {repository.private ? "Private" : "Public"} <i>·</i> GitHub
  </span>
) : (
  <span className="live-deck-source">
    <GitBranch size={18} weight="regular" aria-hidden="true" />
    Repository <i>·</i> per task
  </span>
);

type DeckTone = "coral" | "blue" | "violet";
export type ConnectionState = "healthy" | "reconnecting";

export const ConnectionHealth = ({ state }: { readonly state: ConnectionState }) => (
  <div
    className={`live-deck-health is-${state}`}
    role="status"
    aria-live="polite"
    aria-atomic="true"
  >
    <span>Connection</span>
    <i aria-hidden="true"><b /><b /><b /><b /></i>
    <strong>{state === "healthy" ? "Healthy" : "Reconnecting"}</strong>
  </div>
);

interface DeckTurn {
  readonly actor: string;
  readonly role: "human" | "agent";
  readonly text: string;
  readonly time: string;
}

interface DeckFact {
  readonly kind: "file" | "brain" | "terminal" | "branch" | "shield" | "check";
  readonly label: string;
  readonly value: string;
}

interface DeckPreview {
  readonly elapsed: string;
  readonly turns: readonly DeckTurn[];
  readonly facts: readonly DeckFact[];
}

const SIGNAL_LEVELS = [
  0, 1, 2, 3, 5, 7, 9, 8, 9, 10,
  0, 2, 3, 6, 8, 12, 14, 15, 15, 13,
  1, 2, 4, 6, 8, 14, 16, 18, 17, 20,
  6, 7, 9, 8, 15, 16, 20, 19, 19, 18,
  1, 2, 3, 6, 9, 13, 14, 17, 16, 15,
  0, 1, 3, 4, 6, 4, 11, 7, 13, 12,
  0, 0, 1, 2, 4, 5, 6, 8, 7, 8,
  0, 1, 0, 0, 1, 3, 4, 4, 4, 4,
] as const;

const stableSeat = (identity: Pick<Principal, "id" | "displayName">): string => {
  const name = identity.displayName.toLowerCase();
  if (name.includes("alice")) return seatAlice;
  if (name.includes("bob") || name.includes("owner")) return seatBob;
  if (name.includes("priya")) return seatPriya;
  let hash = 0;
  for (const character of identity.id) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return HUMAN_SEATS[hash % HUMAN_SEATS.length] ?? seatAlice;
};

const PersonPortrait = ({ identity, size = "medium" }: {
  readonly identity: Pick<Principal, "id" | "displayName">;
  readonly size?: "tiny" | "small" | "medium" | "large";
}) => (
  <span className={`deck-person deck-person-${size}`} aria-hidden="true">
    <img src={stableSeat(identity)} alt="" />
  </span>
);

const AgentOrb = ({ tone, size = "medium", neutral = false }: {
  readonly tone: DeckTone;
  readonly size?: "small" | "medium";
  readonly neutral?: boolean;
}) => (
  <span className={`deck-agent-orb deck-agent-${tone} deck-agent-${size} ${neutral ? "deck-agent-neutral" : ""}`} aria-hidden="true">
    <img src={AGENT_SEATS[neutral ? "neutral" : tone]} alt="" />
  </span>
);

const SignalMatrix = ({ tone }: { readonly tone: DeckTone }) => (
  <span className={`deck-signal-matrix deck-signal-${tone}`} aria-hidden="true">
    {SIGNAL_LEVELS.map((level, index) => (
      <i key={index} style={{ "--signal-alpha": level / 100 } as CSSProperties} />
    ))}
  </span>
);

const titleFromPrompt = (prompt: string): string => {
  const line = prompt.split("\n").find((candidate) => candidate.trim())?.trim() ?? "Untitled task";
  return plainInlineMarkdown(line).slice(0, 96);
};

const promptBody = (prompt: string): string => {
  const lines = prompt.split("\n");
  const body = lines.slice(1).join("\n").trim();
  return plainInlineMarkdown(body || lines[0] || "Untitled task");
};

const shortClock = (value: string): string => new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
}).format(new Date(value));

const objectValue = (value: unknown): Readonly<Record<string, unknown>> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;

const pathsIn = (detail: Extract<TranscriptDetail, { readonly type: "tool" }>): number => {
  const input = objectValue(detail.value.rawInput);
  if (input === null) return 0;
  const many = Array.isArray(input.paths)
    ? input.paths.filter((value) => typeof value === "string").length
    : 0;
  return many + (typeof input.path === "string" || typeof input.filePath === "string" ? 1 : 0);
};

const factForWork = (details: readonly TranscriptDetail[]): DeckFact => {
  const summary = workSummary(details);
  const thoughtCount = details.filter((detail) => detail.type === "thought").length;
  if (thoughtCount > 0) {
    return {
      kind: "brain",
      label: summary.title,
      value: `${thoughtCount} ${thoughtCount === 1 ? "update" : "updates"}`,
    };
  }
  const lastTool = [...details].reverse().find(
    (detail): detail is Extract<TranscriptDetail, { readonly type: "tool" }> =>
      detail.type === "tool",
  );
  if (lastTool === undefined) return { kind: "check", label: summary.title, value: "Recorded" };
  if (["glob", "grep", "list", "read"].includes(lastTool.value.kind ?? "")) {
    const count = details.reduce(
      (total, detail) => total + (detail.type === "tool" ? pathsIn(detail) : 0),
      0,
    );
    return {
      kind: "file",
      label: summary.title,
      value: count > 0 ? String(count) : (summary.status ?? "Recorded"),
    };
  }
  if (lastTool.value.kind === "execute") {
    const output = objectValue(lastTool.value.rawOutput);
    const passed = typeof output?.passed === "number" ? `${output.passed} passed` : null;
    return { kind: "terminal", label: summary.title, value: passed ?? summary.status ?? "Recorded" };
  }
  if (lastTool.value.kind === "edit") {
    return { kind: "branch", label: summary.title, value: summary.status ?? "Recorded" };
  }
  return { kind: "check", label: summary.title, value: summary.status ?? "Recorded" };
};

const toneFor = (row: PresentedBoardRow, index: number): DeckTone => {
  if (row.agentType === "pi") return "violet";
  if (row.agentType === "codex" && index !== 3) return "blue";
  return "coral";
};

const FactIcon = ({ kind }: { readonly kind: DeckFact["kind"] }) => {
  const iconProps = { size: 14, weight: "regular" as const, "aria-hidden": true };
  if (kind === "brain") return <Brain {...iconProps} />;
  if (kind === "terminal") return <TerminalWindow {...iconProps} />;
  if (kind === "branch") return <GitBranch {...iconProps} />;
  if (kind === "shield") return <ShieldCheck {...iconProps} />;
  if (kind === "check") return <CheckCircle {...iconProps} />;
  return <FileText {...iconProps} />;
};

const DeckTaskCard = ({ row, index, selected, relayCount, onFocus, onOpen }: {
  readonly row: PresentedBoardRow;
  readonly index: number;
  readonly selected: boolean;
  readonly relayCount: number;
  readonly onFocus: () => void;
  readonly onOpen: () => void;
}) => {
  const loadHistory = useBoard((state) => state.loadHistory);
  const runTimeline = useBoard((state) => row.kind === "run" ? state.runTimelines[row.id] : undefined);
  const sessionTimeline = useBoard((state) => row.kind === "session" ? state.sessionTimelines[row.id] : undefined);
  const historyLoading = useBoard((state) => state.loading[`${row.kind}:${row.id}`] ?? false);
  const historyError = useBoard((state) => state.errors[`${row.kind}:${row.id}`] ?? null);
  const timeline = row.kind === "run" ? runTimeline : sessionTimeline;
  useEffect(() => {
    void loadHistory(row.kind, row.id, row.projectId);
  }, [loadHistory, row.id, row.kind, row.projectId]);

  const preview = useMemo<DeckPreview>(() => {
    const blocks = composeTranscript(timeline?.messages ?? [], timeline?.toolCalls ?? []);
    const realTurns = ([
      {
        actor: row.delegatedBy.displayName,
        role: "human",
        text: promptBody(row.title),
        time: shortClock(row.createdAt),
      },
      ...blocks.flatMap((block): DeckTurn[] => {
        if (block.type !== "message" || block.value.role === "thought") return [];
        return [{
          actor: block.value.role === "user" ? row.delegatedBy.displayName : humanAgent(row.agentType),
          role: block.value.role === "user" ? ("human" as const) : ("agent" as const),
          text: block.value.text,
          time: shortClock(block.value.lastOccurredAt),
        }];
      }),
    ] satisfies DeckTurn[]).slice(0, 4);
    const realFacts = blocks.flatMap((block): DeckFact[] =>
      block.type === "work" ? [factForWork(block.details)] : []);
    const transcriptFact: DeckFact = historyError !== null
      ? { kind: "shield", label: "Transcript", value: "Unavailable" }
      : historyLoading && timeline === undefined
        ? { kind: "brain", label: "Transcript", value: "Opening…" }
        : { kind: "check", label: "Task status", value: displayStatus(row.status) };
    return {
      elapsed: workActivityAge(row),
      turns: realTurns,
      facts: [...realFacts, transcriptFact].slice(0, 4),
    };
  }, [historyError, historyLoading, row, timeline]);

  const tone = toneFor(row, index);
  const agentName = humanAgent(row.agentType);
  const status = ["queued", "provisioning", "running"].includes(row.status)
    ? "LIVE"
    : row.status === "idle"
      ? "READY"
      : displayStatus(row.status).toUpperCase();
  return (
    <article
      className={`deck-task-card tone-${tone} ${selected ? "is-selected" : ""} ${relayCount > 0 ? "has-incoming-relay" : ""}`}
      onPointerEnter={onFocus}
      onFocusCapture={onFocus}
    >
      <SignalMatrix tone={tone} />
      <header className="deck-card-identity">
        <div className="deck-collaboration-mark">
          <PersonPortrait identity={row.delegatedBy} size="large" />
          <span>×</span>
          <AgentOrb tone={tone} neutral={selected} />
        </div>
        <div className="deck-card-parties">
          <strong>{row.delegatedBy.displayName}</strong>
          <span>{agentName}</span>
        </div>
        <div className="deck-card-status">
          <strong><i />{relayCount > 0 ? "PASSED TO YOU" : status}</strong>
          <span>{relayCount > 0 ? `${status} · ${preview.elapsed}` : preview.elapsed}</span>
        </div>
      </header>
      <h2>
        <button type="button" onClick={onOpen} aria-label={`Open conversation: ${titleFromPrompt(row.title)}`}>
          {titleFromPrompt(row.title)}
        </button>
      </h2>
      <div className="deck-card-turns">
        {preview.turns.map((turn, turnIndex) => (
          <section className="deck-turn" key={`${turn.actor}:${turn.time}:${turnIndex}`}>
            {turn.role === "human" ? (
              <PersonPortrait identity={row.delegatedBy} size="small" />
            ) : (
              <AgentOrb tone={tone} size="small" neutral={selected} />
            )}
            <div>
              <header><strong>{turn.actor}</strong><time>{turn.time}</time></header>
              <p>{turn.text}</p>
            </div>
          </section>
        ))}
      </div>
      <div className="deck-card-facts">
        {preview.facts.map((fact, factIndex) => (
          <div className="deck-fact" key={`${fact.label}:${factIndex}`}>
            <FactIcon kind={fact.kind} />
            <span>{fact.label}</span>
            <strong>{fact.value}</strong>
          </div>
        ))}
      </div>
      <button className="deck-open-conversation" type="button" onClick={onOpen}>
        <span>{relayCount > 0 ? "Open passed moment" : "Open conversation"}</span>
        <ArrowRight size={20} weight="light" aria-hidden="true" />
      </button>
    </article>
  );
};

const RelayHandoff = ({ tone, relay }: {
  readonly tone: DeckTone;
  readonly relay: TaskRelay;
}) => (
  <article className="deck-handoff">
    <div className="deck-handoff-route">
      <img src={stableSeat(relay.author)} alt="" /><span>→</span>
      <img src={stableSeat(relay.recipient)} alt="" />
      <strong>{relay.author.displayName}</strong>
      <ArrowRight size={12} weight="light" aria-hidden="true" />
      <strong>{relay.recipient.displayName}</strong>
      <time>{shortClock(relay.createdAt)}</time>
    </div>
    <p>{relay.body}</p>
  </article>
);

export const PresenceRail = ({ project, visiblePeople, relays = [] }: {
  readonly project: Project;
  readonly visiblePeople: readonly PresenceLease["principal"][];
  readonly relays?: readonly TaskRelay[];
}) => {
  const visible = visiblePeople.slice(0, 3);
  const recentRelays = [...relays]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, 3);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const interval = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(interval);
  }, []);
  const zone = new Intl.DateTimeFormat("en-US", { timeZoneName: "short" })
    .formatToParts(now)
    .find((part) => part.type === "timeZoneName")?.value ?? "Local";
  return (
    <footer className="deck-room-rail">
      <section className="deck-presence">
        <span>ROOM {project.name.toUpperCase()}</span>
        <div>
          <strong>{visible.length} online</strong>
          <div className="deck-presence-people">
            {visible.map((person, index) => (
              <article key={person.id}>
                <PersonPortrait identity={person} size="medium" />
                {index < visible.length - 1 ? <i /> : null}
                <span>{person.displayName}</span>
              </article>
            ))}
          </div>
        </div>
      </section>
      <section className="deck-recent-handoffs">
        <span>RECENT HANDOFFS</span>
        <div>
          {recentRelays.length === 0 ? (
            <p className="deck-no-handoffs">No handoffs have been passed in this room yet.</p>
          ) : recentRelays.map((relay, index) => (
            <RelayHandoff
              key={relay.id}
              relay={relay}
              tone={(["coral", "blue", "violet"] as const)[index] ?? "coral"}
            />
          ))}
        </div>
      </section>
      <section className="deck-room-time">
        <span>{new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(now)}</span>
        <strong>{new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(now)}</strong>
        <em>{zone}</em>
      </section>
    </footer>
  );
};

export const LiveDeckRoom = ({
  principal,
  project,
  repository,
  presence,
  rows,
  pendingRelays,
  recentRelays,
  connectionState,
  onBack,
  onDelegate,
  onOpenTask,
}: {
  readonly principal: Principal;
  readonly project: Project;
  readonly repository: ProjectRepositoryBinding | null;
  readonly presence: readonly PresenceLease[];
  readonly rows: readonly PresentedBoardRow[];
  readonly pendingRelays: readonly TaskRelay[];
  readonly recentRelays: readonly TaskRelay[];
  readonly connectionState: ConnectionState;
  readonly onBack: () => void;
  readonly onDelegate: () => void;
  readonly onOpenTask: (row: PresentedBoardRow) => void;
}) => {
  const pendingTaskKeys = useMemo(
    () => new Set(pendingRelays.map((relay) => `${relay.task.kind}:${relay.task.id}`)),
    [pendingRelays],
  );
  const pendingRowId = rows.find((row) => pendingTaskKeys.has(`${row.kind}:${row.id}`))?.id ?? null;
  const [focusedId, setFocusedId] = useState(pendingRowId ?? rows[0]?.id ?? null);
  useEffect(() => {
    if (pendingRowId !== null) setFocusedId(pendingRowId);
  }, [pendingRowId]);
  const visiblePeople = useMemo(() => {
    const unique = new Map(presence.map((lease) => [lease.principal.id, lease.principal]));
    return [...unique.values()].sort((left, right) =>
      left.displayName.localeCompare(right.displayName));
  }, [presence]);
  return (
    <div className="live-deck-shell" style={{ "--deck-background": `url(${liveDeckBackground})` } as CSSProperties}>
      <header className="live-deck-header">
        <strong className="live-deck-brand">meanwhile</strong>
        <i className="live-deck-header-rule" />
        <button className="live-deck-back" type="button" onClick={onBack}>
          <ArrowLeft size={18} weight="bold" aria-hidden="true" /> Projects
        </button>
        <div className="live-deck-project-context">
          <strong
            className="live-deck-project"
            style={{ viewTransitionName: `project-title-${project.id}` }}
          >
            {project.name}
          </strong>
          <ProjectSource repository={repository} />
        </div>
        <div className="live-deck-online">
          <div>{visiblePeople.slice(0, 3).map((person) => <PersonPortrait key={person.id} identity={person} size="small" />)}</div>
          <span><i />{visiblePeople.length} online</span>
        </div>
        <i className="live-deck-header-rule live-deck-header-rule-right" />
        <ConnectionHealth state={connectionState} />
        <button className="live-deck-new-task" type="button" onClick={onDelegate}>New task</button>
      </header>

      <main className="live-deck-main">
        <header className="live-deck-label"><strong>Live Deck</strong><i>·</i><span>{rows.length} tasks</span></header>
        <section className="live-deck-scroller" aria-label={`${project.name} live conversations`}>
          {rows.length === 0 ? (
            <button className="live-deck-empty" type="button" onClick={onDelegate}>
              <strong>No live conversations yet.</strong><span>Delegate the first task</span>
            </button>
          ) : rows.map((row, index) => (
            <DeckTaskCard
              key={`${row.kind}:${row.id}`}
              row={row}
              index={index}
              selected={focusedId === row.id}
              relayCount={pendingRelays.filter((relay) => relay.task.kind === row.kind && relay.task.id === row.id).length}
              onFocus={() => setFocusedId(row.id)}
              onOpen={() => onOpenTask(row)}
            />
          ))}
        </section>
      </main>

      <PresenceRail project={project} visiblePeople={visiblePeople} relays={recentRelays} />
      <span className="sr-only">Signed in as {principal.displayName}</span>
    </div>
  );
};
