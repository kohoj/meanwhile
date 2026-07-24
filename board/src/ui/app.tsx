import type {
  AgentConnection,
  AvailableAgentConnection,
  ExternalIdentity,
  ExternalProjectGrant,
  Principal,
  PresenceLease,
  Project,
  ProjectParticipant,
  ProjectRepositoryBinding,
  ProjectWorkItem,
  TaskRelay,
} from "@kohoz/meanwhile/contracts";
import { code } from "@streamdown/code";
import "@fontsource-variable/inter/wght.css";
import "@fontsource-variable/newsreader/wght.css";
import "@fontsource-variable/roboto-condensed/wght.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/600.css";
import {
  ArrowRight,
  Check,
  GithubLogo,
  GoogleLogo,
  Key,
  Robot,
  Stack,
} from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import {
  Component,
  StrictMode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import useSWR from "swr";
import { Streamdown } from "streamdown";
import "streamdown/styles.css";
import liveDeckBackground from "./assets/live-deck-background.png";
import seatAgent from "./assets/seat-agent.png";
import seatAlice from "./assets/seat-alice.png";
import seatBob from "./assets/seat-bob.png";
import seatPriya from "./assets/seat-priya.png";
import { ConversationDetail } from "./conversation-detail";
import { LiveDeckRoom } from "./live-deck";
import {
  displayStatus,
  humanAgent,
  plainInlineMarkdown,
  type PresentedBoardRow,
  statusTone,
  taskAttention,
} from "./presentation";
import { useBoard } from "./store";
import "./styles.css";
import { composeTranscript, type TranscriptDetail, workSummary } from "./transcript";

type BoardRow = PresentedBoardRow;
const NO_RELAYS: readonly TaskRelay[] = [];
const HUMAN_SEAT_ASSETS = [seatAlice, seatBob, seatPriya] as const;
const SIGNAL_FIELD_PALETTE = [
  "#f9f6f1",
  "#f9f5f0",
  "#f8f4ef",
  "#f8f3ef",
  "#f8f1ec",
  "#f8efeb",
  "#f8ece9",
  "#f7e9e5",
  "#f7e5e2",
  "#f6e0de",
  "#f5dbd9",
  "#f4d6d5",
  "#f3d1d0",
  "#f2cccb",
] as const;
const SIGNAL_FIELD_TONES = [
  [0, 0, 1, 1, 1, 3, 4, 5, 4, 4, 2, 1, 1, 1, 1, 0],
  [0, 1, 0, 1, 3, 5, 6, 7, 6, 5, 4, 2, 1, 1, 1, 1],
  [0, 0, 2, 4, 5, 7, 8, 9, 8, 7, 6, 4, 2, 1, 1, 1],
  [1, 2, 3, 6, 7, 8, 10, 11, 10, 9, 8, 6, 5, 3, 1, 1],
  [1, 4, 6, 7, 9, 10, 11, 13, 12, 11, 9, 7, 6, 4, 2, 1],
  [1, 4, 6, 7, 9, 10, 12, 13, 13, 12, 10, 9, 7, 5, 3, 1],
  [1, 3, 5, 7, 7, 9, 10, 12, 12, 10, 9, 7, 6, 4, 3, 1],
  [2, 2, 4, 5, 6, 8, 9, 10, 10, 9, 8, 6, 5, 2, 2, 1],
  [1, 1, 2, 4, 5, 6, 8, 10, 9, 7, 6, 5, 2, 2, 1, 1],
  [0, 0, 1, 2, 4, 5, 7, 7, 7, 6, 5, 2, 2, 1, 1, 1],
  [1, 1, 1, 1, 2, 2, 4, 5, 5, 4, 2, 1, 1, 1, 1, 1],
].flat();

const SignalField: React.FC = () => (
  <div className="signal-field" aria-hidden="true">
    {SIGNAL_FIELD_TONES.map((tone, index) => (
      <span key={index} style={{ backgroundColor: SIGNAL_FIELD_PALETTE[tone] }} />
    ))}
  </div>
);

interface IdentityShape {
  readonly id: string;
  readonly displayName: string;
}

interface ExternalAuthProvidersResponse {
  readonly providers: readonly {
    readonly provider: "github" | "google";
    readonly label: string;
  }[];
  readonly registration: "closed" | "open";
  readonly invitationReady: boolean;
}

const callbackAuthError = (): string | null => {
  const code = new URLSearchParams(window.location.search).get("auth_error");
  switch (code) {
    case "authorization_rejected":
      return "Authorization was cancelled or rejected.";
    case "identity_not_linked":
      return "This account is not linked here yet. Ask an owner for a fresh invitation link.";
    case "identity_conflict":
      return "That account already belongs to another member.";
    case "invitation_invalid":
      return "That invitation has expired or was already used. Ask an owner for a fresh link.";
    case "transaction_invalid":
      return "That sign-in attempt expired. Please start again.";
    case "provider_unavailable":
      return "The identity provider is temporarily unavailable.";
    default:
      return null;
  }
};

class ExternalAuthStartError extends Error {
  constructor(readonly status: number) {
    super("EXTERNAL_AUTH_START_FAILED");
  }
}

const startExternalAuth = async (
  provider: "github" | "google",
  intent: "login" | "link" | "invite",
): Promise<void> => {
  const response = await fetch(`/auth/${provider}/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ intent }),
  });
  const body = (await response.json().catch(() => null)) as {
    authorizationUrl?: unknown;
  } | null;
  if (!response.ok || typeof body?.authorizationUrl !== "string") {
    throw new ExternalAuthStartError(response.status);
  }
  window.location.assign(body.authorizationUrl);
};

const transitionSurface = (update: () => void): void => {
  const documentWithTransitions = document as Document & {
    startViewTransition?: (callback: () => void) => { readonly finished: Promise<void> };
  };
  const apply = () => {
    update();
    window.scrollTo(0, 0);
  };
  if (
    window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
    documentWithTransitions.startViewTransition === undefined
  ) {
    apply();
    return;
  }
  documentWithTransitions.startViewTransition(apply);
};

const stableSeatIndex = (identity: IdentityShape): number => {
  const knownName = identity.displayName.toLocaleLowerCase();
  if (knownName.includes("alice")) return 0;
  if (knownName.includes("bob") || knownName.includes("owner")) return 1;
  if (knownName.includes("priya")) return 2;
  let hash = 0;
  for (const character of identity.id) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return hash % HUMAN_SEAT_ASSETS.length;
};

const SeatMark: React.FC<{
  identity?: IdentityShape;
  agent?: boolean;
  size?: "small" | "medium" | "large";
}> = ({ identity, agent = false, size = "medium" }) => {
  const src = agent
    ? seatAgent
    : HUMAN_SEAT_ASSETS[stableSeatIndex(identity ?? { id: "unknown", displayName: "Member" })];
  return (
    <span className={`seat-mark ${size} ${agent ? "agent-seat" : "human-seat"}`} aria-hidden="true">
      <img src={src} alt="" />
    </span>
  );
};

const GRID_COLUMNS = 10;

interface GridMeasurement {
  readonly columns: number;
  readonly itemCount: number;
  readonly baselineCount: number;
  readonly opticalCount: number;
  readonly maxColumnErrorPx: number;
  readonly overlayErrorPx: number;
  readonly maxBaselineOffsetPx: number;
  readonly maxOpticalInkErrorPx: number;
}

const measureVisibleGrid = (): GridMeasurement | null => {
  const root = document.querySelector<HTMLElement>(
    ".watch-shell, .lobby-shell, .login-shell, .onboarding-shell",
  );
  if (!root) return null;
  const style = getComputedStyle(root);
  const columns = Number.parseInt(style.getPropertyValue("--grid-columns"), 10);
  const gap = Number.parseFloat(style.getPropertyValue("--grid-gutter"));
  const margin = Number.parseFloat(style.getPropertyValue("--grid-margin"));
  const baseline = Number.parseFloat(style.getPropertyValue("--grid-baseline"));
  const rootRect = root.getBoundingClientRect();
  const contentWidth = rootRect.width - margin * 2;
  const track = (contentWidth - gap * (columns - 1)) / columns;
  const starts = Array.from(
    { length: columns },
    (_, index) => rootRect.left + margin + index * (track + gap),
  );
  const ends = starts.map((start) => start + track);
  const nearestError = (value: number, candidates: readonly number[]) =>
    Math.min(...candidates.map((candidate) => Math.abs(candidate - value)));
  const placed = [
    ...root.querySelectorAll<HTMLElement>(
      ".grid-band > [data-grid-item], .subgrid-band > [data-grid-item]",
    ),
  ].filter(
    (element) => {
      if (element.getClientRects().length === 0 || element.dataset.gridOptical !== undefined) {
        return false;
      }
      const rect = element.getBoundingClientRect();
      return rect.right > rootRect.left && rect.left < rootRect.right;
    },
  );
  let maxColumnErrorPx = 0;
  for (const element of placed) {
    const rect = element.getBoundingClientRect();
    const edge = element.dataset.gridEdge ?? "both";
    if (edge !== "end") {
      maxColumnErrorPx = Math.max(maxColumnErrorPx, nearestError(rect.left, starts));
    }
    if (edge !== "start") {
      maxColumnErrorPx = Math.max(maxColumnErrorPx, nearestError(rect.right, ends));
    }
  }
  const guideColumns = [
    ...root.querySelectorAll<HTMLElement>(".grid-guide-column"),
  ].filter((element) => element.getClientRects().length > 0);
  let overlayErrorPx = 0;
  for (const [index, element] of guideColumns.entries()) {
    const rect = element.getBoundingClientRect();
    overlayErrorPx = Math.max(
      overlayErrorPx,
      Math.abs(rect.left - starts[index]),
      Math.abs(rect.right - ends[index]),
    );
  }
  const baselineElements = [
    ...root.querySelectorAll<HTMLElement>("[data-grid-baseline]"),
  ].filter((element) => element.getClientRects().length > 0);
  let maxBaselineOffsetPx = 0;
  for (const element of baselineElements) {
    const relativeTop = element.getBoundingClientRect().top - rootRect.top;
    const remainder = ((relativeTop % baseline) + baseline) % baseline;
    maxBaselineOffsetPx = Math.max(
      maxBaselineOffsetPx,
      Math.min(remainder, baseline - remainder),
    );
  }
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  const opticalElements = [
    ...root.querySelectorAll<HTMLElement>("[data-grid-optical]"),
  ].filter((element) => element.getClientRects().length > 0);
  let maxOpticalInkErrorPx = 0;
  if (context) {
    for (const element of opticalElements) {
      const computed = getComputedStyle(element);
      let character = element.textContent?.trim().charAt(0) ?? "";
      if (!character) continue;
      if (computed.textTransform === "uppercase") character = character.toUpperCase();
      context.font = `${computed.fontStyle} ${computed.fontWeight} ${computed.fontSize} ${computed.fontFamily}`;
      context.textAlign = "left";
      const inkLeft =
        element.getBoundingClientRect().left -
        context.measureText(character).actualBoundingBoxLeft;
      maxOpticalInkErrorPx = Math.max(
        maxOpticalInkErrorPx,
        nearestError(inkLeft, starts),
      );
    }
  }
  const round = (value: number) => Number(value.toFixed(2));
  return {
    columns,
    itemCount: placed.length,
    baselineCount: baselineElements.length,
    opticalCount: opticalElements.length,
    maxColumnErrorPx: round(maxColumnErrorPx),
    overlayErrorPx: round(overlayErrorPx),
    maxBaselineOffsetPx: round(maxBaselineOffsetPx),
    maxOpticalInkErrorPx: round(maxOpticalInkErrorPx),
  };
};

const GridSystem: React.FC = () => {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    let timeout: number | undefined;
    const alignInk = () => {
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");
      if (!context) return;
      for (const element of document.querySelectorAll<HTMLElement>("[data-grid-optical]")) {
        element.style.marginLeft = "0px";
        const computed = getComputedStyle(element);
        let character = element.textContent?.trim().charAt(0) ?? "";
        if (!character) continue;
        if (computed.textTransform === "uppercase") character = character.toUpperCase();
        context.font = `${computed.fontStyle} ${computed.fontWeight} ${computed.fontSize} ${computed.fontFamily}`;
        context.textAlign = "left";
        const offset = context.measureText(character).actualBoundingBoxLeft;
        if (Number.isFinite(offset)) element.style.marginLeft = `${offset.toFixed(2)}px`;
      }
      const root = document.querySelector<HTMLElement>(
        ".watch-shell, .lobby-shell, .login-shell, .onboarding-shell",
      );
      const measurement = measureVisibleGrid();
      if (root && measurement) root.dataset.gridAudit = JSON.stringify(measurement);
    };
    const scheduleAlignment = () => {
      window.clearTimeout(timeout);
      timeout = window.setTimeout(alignInk, 80);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "g" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.matches("input, textarea, select") || target.isContentEditable)
      ) return;
      setVisible((value) => !value);
    };
    const observer = new MutationObserver(scheduleAlignment);
    observer.observe(document.body, { childList: true, characterData: true, subtree: true });
    window.addEventListener("resize", scheduleAlignment);
    document.addEventListener("keydown", onKeyDown);
    void document.fonts.ready.then(alignInk);
    alignInk();
    const measuredWindow = window as Window & {
      __meanwhileMeasureGrid?: () => GridMeasurement | null;
    };
    measuredWindow.__meanwhileMeasureGrid = measureVisibleGrid;
    return () => {
      observer.disconnect();
      window.clearTimeout(timeout);
      window.removeEventListener("resize", scheduleAlignment);
      document.removeEventListener("keydown", onKeyDown);
      delete measuredWindow.__meanwhileMeasureGrid;
    };
  }, []);
  return (
    <>
      {visible ? (
        <>
          <button
            className="grid-toggle"
            type="button"
            aria-label="Hide layout grid"
            aria-pressed="true"
            title="Hide layout grid (G)"
            onClick={() => setVisible(false)}
          >
            <span>Hide grid</span>
            <kbd>G</kbd>
          </button>
          <div className="grid-guides visible" aria-hidden="true">
            <div className="grid-guide-columns">
              {Array.from({ length: GRID_COLUMNS }, (_, index) => (
                <i className="grid-guide-column" key={index}><span>{index + 1}</span></i>
              ))}
            </div>
            <div className="grid-guide-baseline" />
          </div>
        </>
      ) : null}
    </>
  );
};

const SkipLink: React.FC<{ targetId: string; children: ReactNode }> = ({ targetId, children }) => (
  <a
    className="skip-link"
    href={`#${targetId}`}
    onClick={(event) => {
      const target = document.getElementById(targetId);
      if (!target) return;
      event.preventDefault();
      target.focus();
      target.scrollIntoView({ block: "start" });
    }}
  >
    {children}
  </a>
);

const ProductStatus: React.FC<{
  message: string;
  retry?: () => void;
  alert?: boolean;
}> = ({ message, retry, alert = false }) => (
  <main className="app-loading" role={alert ? "alert" : "status"}>
    <div>
      <strong>meanwhile</strong>
      <span>{message}</span>
      {retry ? (
        <button type="button" onClick={retry}>Try again</button>
      ) : null}
    </div>
  </main>
);

interface SessionResponse {
  authenticated: boolean;
  principal?: Principal;
  projects?: readonly Project[];
}

interface BoardResponse {
  principal: Principal;
  project: Project;
  projects: readonly Project[];
  members: readonly ProjectParticipant[];
  rows: readonly BoardRow[];
  pendingRelays: readonly TaskRelay[];
  recentRelays: readonly TaskRelay[];
  presence: readonly PresenceLease[];
  delegation: {
    readonly agents: readonly AgentConnection[];
    readonly repository: ProjectRepositoryBinding | null;
  };
  updatedAt: string;
}

interface OnboardingResponse {
  principal: Principal;
  identities: readonly ExternalIdentity[];
  repositoryGrants: readonly ExternalProjectGrant[];
  repositoryBindings: readonly ProjectRepositoryBinding[];
  agentConnections: readonly AgentConnection[];
  availableAgents: readonly AvailableAgentConnection[];
  projects: readonly {
    project: Project;
    access: "watch" | "participate" | "administer";
    source: "membership" | "github";
    selected: boolean;
  }[];
}

interface LobbyTable {
  project: Project;
  access: "watch" | "participate" | "administer";
  accessSource: "membership" | "github";
  members: readonly ProjectParticipant[];
  work: {
    total: number;
    attention: number;
    active: number;
    ready: number;
    completed: number;
  };
  latestWork: ProjectWorkItem | null;
  pendingRelayCount: number;
  presence: readonly PresenceLease[];
}

interface LobbySpace {
  source: {
    provider: string;
    accountId: string;
    accountName: string;
  };
  tables: readonly LobbyTable[];
}

interface LobbyResponse {
  principal: Principal;
  spaces: readonly LobbySpace[];
  updatedAt: string;
}

interface CreatedRunResponse {
  readonly run: {
    readonly id: string;
  };
}

const fetchJson = async <T,>(url: string): Promise<T> => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(response.status === 401 ? "UNAUTHENTICATED" : "REQUEST_FAILED");
  return (await response.json()) as T;
};

const relativeTime = (value: string): string => {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
};

const compactElapsedTime = (value: string): string => relativeTime(value).replace(/ ago$/, "");

const clockTime = (value: string): string => new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
}).format(new Date(value));

const latestWorkTime = (details: readonly TranscriptDetail[]): string =>
  clockTime(details.reduce(
    (latest, detail) => detail.value.lastOccurredAt > latest ? detail.value.lastOccurredAt : latest,
    details[0]?.value.lastOccurredAt ?? new Date(0).toISOString(),
  ));

const RoomClock: React.FC = () => {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const interval = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(interval);
  }, []);
  const date = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(now);
  const time = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(now);
  return (
    <div className="room-clock" data-grid-item data-grid-edge="end">
      <span>Room time</span>
      <time dateTime={now.toISOString()}>
        <span className="room-clock-date">{date}</span>{" "}
        <span className="room-clock-time">{time}</span>
      </time>
    </div>
  );
};

const taskTitle = (value: string): string => {
  const firstLine = value
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  const plain = plainInlineMarkdown(firstLine ?? "Untitled task")
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[>*+-]\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length <= 96) return plain;
  const sentence = plain.slice(0, 96).match(/^(.{24,}?[.!?。！？])(?:\s|$)/)?.[1];
  const bounded = sentence ?? plain.slice(0, 96).replace(/\s+\S*$/, "");
  return `${bounded || plain.slice(0, 96)}…`;
};

const taskPromptBody = (value: string): string => {
  const lines = value.split("\n");
  const firstContentIndex = lines.findIndex((line) => line.trim().length > 0);
  if (firstContentIndex === -1) return value;
  const remainder = lines.slice(firstContentIndex + 1).join("\n").trim();
  return remainder || value;
};

const Login: React.FC<{
  onLogin: () => void;
  providerData: ExternalAuthProvidersResponse | undefined;
  currentPrincipal?: Principal;
  onCancelInvitation?: () => Promise<void>;
}> = ({ onLogin, providerData, currentPrincipal, onCancelInvitation }) => {
  const [apiKey, setApiKey] = useState("");
  const [localOpen, setLocalOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [providerBusy, setProviderBusy] = useState<"github" | "google" | null>(null);
  const [error, setError] = useState<string | null>(() => callbackAuthError());
  useEffect(() => {
    if (window.location.search.includes("auth_error=")) {
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, []);
  const configuredProviders = new Set(
    providerData?.providers.map((provider) => provider.provider) ?? [],
  );
  const invitationReady = providerData?.invitationReady ?? false;
  const registrationOpen = providerData?.registration === "open";
  const beginProvider = async (provider: "github" | "google") => {
    if (!configuredProviders.has(provider) || providerBusy !== null) return;
    setProviderBusy(provider);
    setError(null);
    try {
      await startExternalAuth(provider, invitationReady ? "invite" : "login");
    } catch (cause) {
      setProviderBusy(null);
      const status = cause instanceof ExternalAuthStartError ? cause.status : null;
      setError(
        status === 502
          ? "The identity service is unavailable. Try again, or use installation access."
          : status === 401 || status === 403
            ? "This identity cannot enter yet. Use a fresh invitation, or use installation access."
            : `${provider === "github" ? "GitHub" : "Google"} sign-in could not start. Try again, or use installation access.`,
      );
    }
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!apiKey.trim() || busy) return;
    setBusy(true);
    setError(null);
    const response = await fetch("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: apiKey.trim() }),
    }).catch(() => null);
    if (response?.ok) onLogin();
    else {
      setBusy(false);
      setError(
        response?.status === 502
          ? "The control plane is unavailable."
          : "That key could not open a Project session.",
      );
    }
  };
  return (
    <main className="login-shell">
      <GridSystem />
      <header className="login-brand grid-band">
        <div className="brand" data-grid-item><span data-grid-optical>meanwhile</span></div>
        <p data-grid-item>Open source · deployment neutral</p>
      </header>
      <div className="login-stage grid-band">
      <section className="login-intro" data-grid-item>
        <span className="login-kicker" data-grid-item>Shared agent rooms</span>
        <h1 data-grid-item data-grid-optical>Enter as yourself.<br />See the work together.</h1>
        <p data-grid-item>
          Sign-in establishes who you are. Repository access, agent authority, and the Projects
          you surface stay separate—and remain revocable.
        </p>
        <div className="login-custody" data-grid-item aria-label="Onboarding authority path">
          <strong>Identity</strong><i />
          <span>Repositories</span><i />
          <span>Agents</span><i />
          <span>Rooms</span>
        </div>
      </section>
      <section className="login-card" data-grid-item aria-label="Sign in to Meanwhile">
        <div className="login-card-head">
          <span>{invitationReady ? "Accept your invitation" : registrationOpen ? "Join this installation" : "Choose an identity"}</span>
          <small>{invitationReady ? "Ready to join" : registrationOpen ? "Open registration" : "This installation"}</small>
        </div>
        {invitationReady ? (
          <div className="invitation-note" role="status">
            <Check size={16} weight="bold" aria-hidden="true" />
            <span>
              <strong>Invitation secured</strong>
              <small>
                {currentPrincipal
                  ? `You are currently ${currentPrincipal.displayName}. Choose the invited identity without merging accounts.`
                  : "Choose the account that should represent you here."}
              </small>
            </span>
          </div>
        ) : null}
        <div className="provider-stack">
          <button
            type="button"
            className="provider-login"
            disabled={!configuredProviders.has("github") || providerBusy !== null}
            onClick={() => void beginProvider("github")}
          >
            <GithubLogo size={21} weight="fill" aria-hidden="true" />
            <span><strong>Continue with GitHub</strong><small>{configuredProviders.has("github") ? (providerBusy === "github" ? "Opening GitHub…" : invitationReady || registrationOpen ? "Join and connect allowed repositories" : "Identity and repository access") : "GitHub App not configured"}</small></span>
            <ArrowRight size={17} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="provider-login"
            disabled={!configuredProviders.has("google") || providerBusy !== null}
            onClick={() => void beginProvider("google")}
          >
            <GoogleLogo size={21} weight="bold" aria-hidden="true" />
            <span><strong>Continue with Google</strong><small>{configuredProviders.has("google") ? (providerBusy === "google" ? "Opening Google…" : invitationReady || registrationOpen ? "Join with this identity" : "Identity only") : "Google OAuth not configured"}</small></span>
            <ArrowRight size={17} aria-hidden="true" />
          </button>
        </div>
        {!localOpen && error ? <div className="login-error" role="alert">{error}</div> : null}
        {invitationReady ? (
          currentPrincipal && onCancelInvitation ? (
            <button
              type="button"
              className="invitation-return"
              onClick={() => void onCancelInvitation()}
            >
              <span>Keep current session</span>
              <strong>Return as {currentPrincipal.displayName}</strong>
            </button>
          ) : null
        ) : (
          <>
            <button
              type="button"
              className="local-login-toggle"
              aria-expanded={localOpen}
              aria-controls="local-installation-login"
              onClick={() => setLocalOpen((value) => !value)}
            >
              <Key size={18} weight="light" aria-hidden="true" />
              <span><strong>Use installation access</strong><small>Self-hosted and offline mode</small></span>
              <span aria-hidden="true">{localOpen ? "−" : "+"}</span>
            </button>
            {localOpen ? (
              <form
                id="local-installation-login"
                className="local-login-form"
                aria-busy={busy}
                onSubmit={submit}
              >
                <label htmlFor="api-key">Personal Meanwhile key</label>
                <div className="local-login-field">
                  <input
                    id="api-key"
                    autoFocus
                    type="password"
                    autoComplete="off"
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    placeholder="mwk_…"
                  />
                  <button type="submit" disabled={busy || !apiKey.trim()}>
                    {busy ? "Opening…" : "Continue"}
                  </button>
                </div>
                {error ? <div className="login-error" role="alert">{error}</div> : null}
                <p>
                  The key is exchanged once for an HttpOnly browser session. It is never stored by
                  this web app.
                </p>
              </form>
            ) : null}
          </>
        )}
      </section>
      </div>
      <footer className="login-foot grid-band">
        <p data-grid-item>Bring your agent. Bring your sandbox.</p>
        <strong data-grid-item>Meanwhile owns the run.</strong>
      </footer>
    </main>
  );
};

const ConnectedOnboarding: React.FC<{
  data: OnboardingResponse;
  onChanged: () => Promise<unknown>;
  onComplete: () => void;
  onLogout: () => void;
}> = ({ data, onChanged, onComplete, onLogout }) => {
  const { data: providerData } = useSWR<ExternalAuthProvidersResponse>(
    "/auth/providers",
    fetchJson,
    { shouldRetryOnError: false },
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selectedProjects = data.projects.filter((entry) => entry.selected);
  const connectedAgentTypes = new Set(data.agentConnections.map((item) => item.agentType));
  const bindings = new Map(data.repositoryBindings.map((item) => [item.projectId, item]));
  const administeringGrants = data.repositoryGrants.filter(
    (grant) => grant.access === "administer",
  );
  const grantIsMapped = (grant: OnboardingResponse["repositoryGrants"][number]) =>
    data.repositoryBindings.some(
      (binding) =>
        binding.provider === grant.provider &&
        binding.installationId === grant.installationId &&
        binding.repositoryId === grant.repositoryId,
    );
  const githubConfigured =
    providerData?.providers.some((provider) => provider.provider === "github") ?? false;
  const complete = data.agentConnections.length > 0 && selectedProjects.length > 0;
  const mutate = async (
    key: string,
    url: string,
    method: "POST" | "PUT" | "DELETE",
    body?: Record<string, unknown>,
  ) => {
    if (busy !== null) return;
    setBusy(key);
    setError(null);
    try {
      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }).catch(() => null);
      if (!response?.ok) {
        const failure = (await response?.json().catch(() => null)) as { error?: unknown } | null;
        setError(typeof failure?.error === "string" ? failure.error : "That authorization could not be updated.");
        return;
      }
      await onChanged();
    } catch {
      setError("The change was accepted, but the current setup could not be refreshed. Try again.");
    } finally {
      setBusy(null);
    }
  };
  const identityLabel =
    data.identities.length === 0
      ? "Installation identity"
      : data.identities.map((identity) => identity.provider).join(" + ");
  return (
    <main
      className="onboarding-shell"
      style={{ "--onboarding-background": `url(${liveDeckBackground})` } as CSSProperties}
    >
      <GridSystem />
      <header className="onboarding-topbar grid-band">
        <div className="brand" data-grid-item><span data-grid-optical>meanwhile</span></div>
        <div className="onboarding-location" data-grid-item>Connected onboarding</div>
        <button type="button" className="onboarding-exit" data-grid-item onClick={onLogout}>Sign out</button>
      </header>
      <section className="onboarding-intro grid-band">
        <span data-grid-item>First entry</span>
        <h1 data-grid-item data-grid-optical>Prepare the rooms<br />you want to share.</h1>
        <p data-grid-item>
          Four independent setup steps. Nothing is bundled into sign-in, and each connection can be
          revoked without changing who owns the work.
        </p>
        <div className="onboarding-progress" data-grid-item aria-label="Onboarding progress">
          {[
            ["01", "Identity", true],
            ["02", "Repositories", data.repositoryGrants.length > 0 || !githubConfigured],
            ["03", "Agents", data.agentConnections.length > 0],
            ["04", "Projects", selectedProjects.length > 0],
          ].map(([index, label, done]) => (
            <span className={done ? "done" : ""} key={String(index)}>
              <i>{index}</i><strong>{label}</strong>{done ? <Check size={13} weight="bold" /> : null}
            </span>
          ))}
        </div>
      </section>
      <section className="onboarding-body grid-band" aria-label="Connection setup">
        <article className="onboarding-step identity-step" data-grid-item>
          <header><span>01</span><h2>Identity</h2><strong>Connected</strong></header>
          <div className="identity-proof">
            <SeatMark identity={data.principal} size="large" />
            <div><strong>{data.principal.displayName}</strong><span>{identityLabel}</span></div>
            <Check size={18} weight="bold" aria-hidden="true" />
          </div>
          <p>
            This Principal owns every delegation you make. A provider account can prove identity;
            it never becomes the Project&apos;s authority.
          </p>
        </article>

        <article className="onboarding-step repository-step" data-grid-item>
          <header>
            <span>02</span><h2>Repositories</h2>
            <strong>{data.repositoryGrants.length > 0 ? `${data.repositoryGrants.length} available` : "Local mode"}</strong>
          </header>
          {data.repositoryGrants.length === 0 ? (
            <div className="local-repository-mode">
              <GithubLogo size={22} weight="light" aria-hidden="true" />
              <div><strong>No GitHub grant attached</strong><span>{githubConfigured ? "Link GitHub to reveal App-authorized repositories." : "Public HTTPS repositories remain available per task."}</span></div>
              {githubConfigured ? (
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={async () => {
                    if (busy !== null) return;
                    setBusy("repository:github");
                    setError(null);
                    try {
                      await startExternalAuth("github", "link");
                    } catch {
                      setBusy(null);
                      setError("Could not start GitHub authorization.");
                    }
                  }}
                >
                  {busy === "repository:github" ? "Opening…" : "Link GitHub"}
                </button>
              ) : null}
            </div>
          ) : (
            <div className="repository-grants">
              {data.repositoryGrants.map((grant) => {
                const mapped = grantIsMapped(grant);
                const key = `import:${grant.id}`;
                return (
                <div className={mapped ? "mapped" : ""} key={grant.id}>
                  <GithubLogo size={18} weight="fill" aria-hidden="true" />
                  <span><strong>{grant.repositoryFullName}</strong><small>{grant.private ? "Private" : "Public"} · {grant.access}</small></span>
                  {mapped ? (
                    <Check size={14} weight="bold" aria-label="In Lobby" />
                  ) : grant.access === "administer" ? (
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void mutate(key, "/onboarding/projects", "POST", { grantId: grant.id })}
                    >
                      {busy === key ? "Adding…" : "Add to Lobby"}
                    </button>
                  ) : (
                    <small>Ask a repository admin to add this room</small>
                  )}
                </div>
                );
              })}
            </div>
          )}
          <p>
            GitHub returns only repositories allowed by the App installation and your own account.
            Checkout authority remains short-lived and never enters the transcript.
          </p>
        </article>

        <article className="onboarding-step agent-step" data-grid-item>
          <header><span>03</span><h2>Agents</h2><strong>{data.agentConnections.length} authorized</strong></header>
          <div className="agent-options">
            {data.availableAgents.map((agent) => {
              const connected = connectedAgentTypes.has(agent.agentType);
              const connection = data.agentConnections.find((item) => item.agentType === agent.agentType);
              const key = `agent:${agent.agentType}`;
              return (
                <button
                  type="button"
                  className={connected ? "selected" : ""}
                  key={agent.agentType}
                  disabled={busy !== null}
                  aria-pressed={connected}
                  onClick={() =>
                    void mutate(
                      key,
                      connected && connection
                        ? `/onboarding/agent-connections/${connection.id}`
                        : "/onboarding/agent-connections",
                      connected ? "DELETE" : "POST",
                      connected ? undefined : { agentType: agent.agentType },
                    )
                  }
                >
                  <Robot size={20} weight="light" aria-hidden="true" />
                  <span><strong>{agent.label}</strong><small>{agent.capabilities.runtimeProviders.join(" + ") || "No runtime"}</small></span>
                  <i>{busy === key ? "…" : connected ? <Check size={14} weight="bold" /> : "+"}</i>
                </button>
              );
            })}
          </div>
          <p>Authorizing an agent enables only your own future work. Runtime credentials remain a separate deployment concern, and this never grants control of another member&apos;s run.</p>
        </article>

        <article className="onboarding-step project-step" data-grid-item>
          <header><span>04</span><h2>Projects</h2><strong>{selectedProjects.length} selected</strong></header>
          <div className="project-options">
            {data.projects.map((entry) => {
              const key = `project:${entry.project.id}`;
              const binding = bindings.get(entry.project.id);
              const boundGrant = binding
                ? administeringGrants.find(
                    (grant) =>
                      grant.provider === binding.provider &&
                      grant.installationId === binding.installationId &&
                      grant.repositoryId === binding.repositoryId,
                  )
                : undefined;
              const canBindRepository =
                entry.access === "administer" &&
                administeringGrants.length > 0;
              return (
                <div className={entry.selected ? "selected" : ""} key={entry.project.id}>
                  <button
                    type="button"
                    disabled={busy !== null}
                    aria-pressed={entry.selected}
                    onClick={() =>
                      void mutate(
                        key,
                        `/onboarding/projects/${entry.project.id}/selection`,
                        "PUT",
                        { selected: !entry.selected },
                      )
                    }
                  >
                    <Stack size={18} weight="light" aria-hidden="true" />
                    <span><strong>{entry.project.name}</strong><small>{binding?.repositoryFullName ?? "Local Project"}</small></span>
                    <i>{busy === key ? "…" : entry.selected ? <Check size={14} weight="bold" /> : "+"}</i>
                  </button>
                  {entry.selected && canBindRepository ? (
                    <label>
                      <span>Repository · optional</span>
                      <select
                        value={boundGrant?.id ?? ""}
                        disabled={busy !== null}
                        onChange={(event) => {
                          if (event.target.value) {
                            void mutate(
                              `repository:${entry.project.id}`,
                              `/onboarding/projects/${entry.project.id}/repository`,
                              "PUT",
                              { grantId: event.target.value },
                            );
                          }
                        }}
                      >
                        <option value="">Choose repository</option>
                        {administeringGrants.map((grant) => (
                          <option key={grant.id} value={grant.id}>{grant.repositoryFullName}</option>
                        ))}
                      </select>
                    </label>
                  ) : entry.selected && binding ? (
                    <div className="project-binding-readonly">
                      <span>Repository</span>
                      <strong>{binding.repositoryFullName}</strong>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
          <p>Selection changes only what appears in your Lobby. It cannot create membership or widen repository access.</p>
        </article>
      </section>
      <footer className="onboarding-footer grid-band">
        <div data-grid-item>
          <span>{complete ? "Ready" : "Still needed"}</span>
          <strong>
            {data.agentConnections.length === 0
              ? "Authorize at least one agent."
              : selectedProjects.length === 0
                ? "Choose at least one Project."
                : "Your Lobby is ready."}
          </strong>
        </div>
        {error ? <p className="onboarding-error" role="alert" data-grid-item>{error}</p> : null}
        <button type="button" data-grid-item disabled={!complete || busy !== null} onClick={onComplete}>
          Enter Project Lobby <ArrowRight size={17} aria-hidden="true" />
        </button>
      </footer>
    </main>
  );
};

const Account: React.FC<{
  principal: Principal;
  onLogout: () => void;
}> = ({ principal, onLogout }) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverId = useId();
  useEffect(() => {
    if (!open) return;
    const closeFromOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeFromKeyboard = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeFromOutside);
    document.addEventListener("keydown", closeFromKeyboard);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside);
      document.removeEventListener("keydown", closeFromKeyboard);
    };
  }, [open]);
  return (
    <div className="account" ref={rootRef}>
      <button
        ref={triggerRef}
        className="identity"
        type="button"
        aria-label={`Account for ${principal.displayName}`}
        aria-haspopup="dialog"
        aria-controls={popoverId}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <SeatMark identity={principal} size="small" />
        <span>{principal.displayName}</span>
      </button>
      {open ? (
        <div className="account-menu" id={popoverId} role="dialog" aria-label="Account">
          <span>Signed in as {principal.displayName}</span>
          <button type="button" onClick={onLogout}>Sign out</button>
        </div>
      ) : null}
    </div>
  );
};

const roomCondition = (table: LobbyTable): { label: string; tone: string } => {
  if (table.pendingRelayCount > 0) return { label: `${table.pendingRelayCount} waiting for you`, tone: "alert" };
  if (table.work.attention > 0) return { label: `${table.work.attention} need attention`, tone: "alert" };
  if (table.work.active > 0) return { label: `${table.work.active} live now`, tone: "active" };
  if (table.work.ready > 0) return { label: `${table.work.ready} ready`, tone: "ready" };
  return { label: "Quiet", tone: "quiet" };
};

const LOBBY_CARD_TONES = ["coral", "blue", "violet"] as const;

const LobbySignalField: React.FC<{ tone: (typeof LOBBY_CARD_TONES)[number] }> = ({ tone }) => (
  <span className={`lobby-signal-field signal-${tone}`} aria-hidden="true">
    {SIGNAL_FIELD_TONES.map((level, index) => (
      <i
        key={index}
        style={{ "--lobby-signal-alpha": Math.max(0.018, level / 24) } as CSSProperties}
      />
    ))}
  </span>
);

const ProjectLobby: React.FC<{
  onOpen: (projectId: string) => void;
  onLogout: () => void;
}> = ({ onOpen, onLogout }) => {
  const { data, mutate, isLoading } = useSWR<LobbyResponse>("/lobby", fetchJson, {
    refreshInterval: 5_000,
    keepPreviousData: true,
  });
  if (isLoading && data === undefined) return <ProductStatus message="Opening your Project Lobby…" />;
  if (!data) {
    return <ProductStatus alert message="Project Lobby is unavailable." retry={() => void mutate()} />;
  }
  const tables = data.spaces.flatMap((space) => space.tables);
  const tableTones = new Map(
    tables.map((table, index) => [
      table.project.id,
      LOBBY_CARD_TONES[index % LOBBY_CARD_TONES.length] ?? "coral",
    ]),
  );
  const relayCount = tables.reduce((total, table) => total + table.pendingRelayCount, 0);
  const activeCount = tables.reduce((total, table) => total + table.work.active, 0);
  return (
    <div
      className="lobby-shell"
      style={{ "--lobby-background": `url(${liveDeckBackground})` } as CSSProperties}
    >
      <GridSystem />
      <SkipLink targetId="project-lobby-content">Skip to Project tables</SkipLink>
      <header className="lobby-topbar grid-band">
        <div className="brand" data-grid-item><span data-grid-optical>meanwhile</span></div>
        <div className="lobby-location" data-grid-item data-grid-baseline>Project Lobby</div>
        <div className="lobby-account" data-grid-item>
          <Account principal={data.principal} onLogout={onLogout} />
        </div>
      </header>
      <section className="lobby-intro grid-band">
        <div className="lobby-eyebrow" data-grid-item data-grid-baseline>Your rooms</div>
        <h1 data-grid-item data-grid-optical data-grid-baseline>Find the table where work is alive.</h1>
        <p data-grid-item data-grid-baseline>
          {relayCount > 0
            ? `${relayCount} Relay${relayCount === 1 ? " is" : "s are"} waiting across your Projects.`
            : activeCount > 0
              ? `${activeCount} agent${activeCount === 1 ? " is" : "s are"} working across your Projects.`
              : "Every Project you can enter is gathered here."}
        </p>
        <button type="button" className="refresh" data-grid-item data-grid-edge="end" onClick={() => mutate()}>Refresh</button>
      </section>
      <main className="lobby-content" id="project-lobby-content" tabIndex={-1}>
        {tables.length === 0 ? (
          <section className="lobby-empty">
            <h2>No Project tables yet.</h2>
            <p>Create or join a Project to begin watching delegated work together.</p>
          </section>
        ) : (
          data.spaces.map((space) => (
            <section className="lobby-space" key={`${space.source.provider}:${space.source.accountId}`}>
              <div className="lobby-section-head grid-band">
                <div data-grid-item>
                  <span>{space.source.provider === "meanwhile" ? "Workspace" : space.source.provider}</span>
                  <h2 data-grid-baseline>{space.source.accountName}</h2>
                </div>
                <p data-grid-item data-grid-edge="end">{space.tables.length} {space.tables.length === 1 ? "table" : "tables"}</p>
              </div>
              <div className="table-grid grid-band">
                {space.tables.map((table) => {
                  const condition = roomCondition(table);
                  const cardTone = tableTones.get(table.project.id) ?? "coral";
                  const people = [...new Map(
                    table.presence.map((lease) => [lease.principal.id, lease.principal]),
                  ).values()];
                  return (
                    <article
                      className={`table-card tone-${condition.tone} table-accent-${cardTone}`}
                      data-grid-item
                      key={table.project.id}
                    >
                      <LobbySignalField tone={cardTone} />
                      <header className="table-card-head">
                        <span>{table.accessSource === "github" ? `GitHub ${table.access}` : table.access === "administer" ? "maintainer" : "member"}</span>
                        <strong>{condition.label}</strong>
                      </header>
                      <div className="table-card-body">
                        <div className="table-card-presence" aria-label={`${people.length} online`}>
                          <div>
                            {people.slice(0, 3).map((person) => (
                              <SeatMark identity={person} size="small" key={person.id} />
                            ))}
                          </div>
                          <span className={people.length > 0 ? "is-online" : "is-empty"}>
                            <i />{people.length} online
                          </span>
                        </div>
                        <h2
                          data-grid-optical
                          data-grid-baseline
                          style={{ viewTransitionName: `project-title-${table.project.id}` }}
                        >
                          {table.project.name}
                        </h2>
                        <p>
                          {table.latestWork === null
                            ? "No work has been delegated at this table yet."
                            : taskTitle(table.latestWork.title)}
                        </p>
                      </div>
                      <dl className="table-signals">
                        <div><dt>Online</dt><dd>{people.length}</dd></div>
                        <div><dt>Active</dt><dd>{table.work.active}</dd></div>
                        <div><dt>Work</dt><dd>{table.work.total}</dd></div>
                      </dl>
                      <div className="table-members">
                        {people.length > 0
                          ? `${people.slice(0, 3).map((person) => person.displayName).join(", ")}${people.length > 3 ? ` and ${people.length - 3} more` : ""}`
                          : `${table.members.length} ${table.members.length === 1 ? "person has" : "people have"} access; no one is in the room.`}
                      </div>
                      <footer className="table-card-footer">
                        <span>{table.accessSource === "github" ? `GitHub ${table.access}` : `Member ${table.access}`}</span>
                        <button
                          type="button"
                          aria-label={`Enter ${table.project.name}`}
                          onClick={() => onOpen(table.project.id)}
                        >
                          Enter room <ArrowRight size={18} weight="light" aria-hidden="true" />
                        </button>
                      </footer>
                    </article>
                  );
                })}
              </div>
            </section>
          ))
        )}
      </main>
    </div>
  );
};

const TaskList: React.FC<{
  rows: readonly BoardRow[];
  pendingRelays: readonly TaskRelay[];
  selected: BoardRow | null;
  personalVerdict: string;
  projectCondition: string;
  onSelect: (row: BoardRow) => void;
  onDelegate: (event: React.MouseEvent<HTMLButtonElement>) => void;
}> = ({
  rows,
  pendingRelays,
  selected,
  personalVerdict,
  projectCondition,
  onSelect,
  onDelegate,
}) => {
  if (rows.length === 0) {
    return (
      <section className="room-pulse empty grid-band" aria-label="Project work">
        <header className="room-pulse-label" data-grid-item>
          <strong>Room pulse</strong>
          <span>{personalVerdict}</span>
        </header>
        <div className="pulse-empty" data-grid-item>
          <div>
            <strong>No delegated work yet.</strong>
            <span>{projectCondition}</span>
          </div>
          <button type="button" data-delegate-trigger="empty" onClick={onDelegate}>
            Delegate the first task
          </button>
        </div>
      </section>
    );
  }
  const relayedTaskIds = new Set(
    pendingRelays.map((relay) => `${relay.task.kind}:${relay.task.id}`),
  );
  return (
    <section className="room-pulse grid-band" aria-label="Project work">
      <header className="room-pulse-label" data-grid-item>
        <strong>Room pulse</strong>
        <span>{rows.length} work {rows.length === 1 ? "item" : "items"}</span>
        <em>{personalVerdict}</em>
      </header>
      <div className="room-pulse-track subgrid-band" data-grid-item>
        {rows.map((row) => {
          const tone = statusTone(row.status);
          const isSelected = selected?.id === row.id && selected.kind === row.kind;
          const relayCount = pendingRelays.filter(
            (relay) => relay.task.kind === row.kind && relay.task.id === row.id,
          ).length;
          const relayed = relayedTaskIds.has(`${row.kind}:${row.id}`);
          return (
            <button
              type="button"
              key={`${row.kind}:${row.id}`}
              className={`pulse-task ${isSelected ? "selected" : ""} tone-${tone}`}
              data-grid-item
              onClick={() => onSelect(row)}
              aria-pressed={isSelected}
            >
              <span className="pulse-delegator">
                {relayed || isSelected ? <i className="relay-dot" /> : null}
                {row.delegatedBy.displayName}
              </span>
              <span className="pulse-title">{taskTitle(row.title)}</span>
              <span className="pulse-meta">
                <span>{humanAgent(row.agentType)}</span>
                <span className="pulse-state">
                  {relayCount > 0 ? `${relayCount} relayed` : displayStatus(row.status)}
                  <b>·</b>
                  {compactElapsedTime(row.updatedAt)}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
};

const Markdown: React.FC<{ text: string; live?: boolean; className?: string }> = ({
  text,
  live = false,
  className,
}) => (
  <Streamdown
    className={className}
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
);

const boundedJson = (value: unknown): string => {
  const serialized = JSON.stringify(value, null, 2) ?? "null";
  return serialized.length <= 20_000 ? serialized : `${serialized.slice(0, 20_000)}\n…`;
};

const humanToolStatus = (status: string | null): string => {
  if (status === null) return "";
  if (["pending", "in_progress", "running"].includes(status)) return "running";
  if (["completed", "succeeded"].includes(status)) return "done";
  return status.replaceAll("_", " ");
};

const humanToolKind = (kind: string | null): string => {
  if (!kind) return "Tool";
  const labels: Record<string, string> = {
    apply_patch: "Patch",
    bash: "Terminal",
    edit: "Edit",
    glob: "Find files",
    grep: "Search",
    list: "List",
    read: "Read",
    webfetch: "Fetch",
    websearch: "Search web",
    write: "Write",
  };
  return labels[kind] ?? kind.replaceAll("_", " ");
};

const toolSubject = (detail: TranscriptDetail & { type: "tool" }): string | null => {
  const input = detail.value.rawInput;
  if (typeof input !== "object" || input === null) return null;
  const record = input as Record<string, unknown>;
  if (Array.isArray(record.paths)) {
    const count = record.paths.filter((value) => typeof value === "string" && value.trim()).length;
    if (count > 0) return `${count} ${count === 1 ? "file" : "files"}`;
  }
  for (const key of ["filePath", "path", "pattern", "query", "url", "command"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
};

const WorkDetail: React.FC<{ detail: TranscriptDetail }> = ({ detail }) => {
  if (detail.type === "thought") {
    return (
      <section className="reasoning-detail">
        <Markdown text={detail.value.text} className="work-markdown" />
      </section>
    );
  }
  const subject = toolSubject(detail);
  return (
    <details className="tool-call-detail">
      <summary>
        <span className="tool-call-title">
          <strong>{humanToolKind(detail.value.kind)}</strong>
          {subject ? <i>{subject}</i> : null}
        </span>
        {detail.value.status ? <span>{humanToolStatus(detail.value.status)}</span> : null}
      </summary>
      <div className="tool-detail-body">
        <section><h4>Input</h4><pre>{boundedJson(detail.value.rawInput)}</pre></section>
        <section><h4>Output</h4><pre>{boundedJson(detail.value.rawOutput)}</pre></section>
      </div>
    </details>
  );
};

const RelayCard: React.FC<{
  relay: TaskRelay;
  current: Principal;
  onAcknowledge: (relay: TaskRelay) => Promise<boolean>;
}> = ({ relay, current, onAcknowledge }) => {
  const incoming = relay.recipient.id === current.id;
  const pending = incoming && relay.acknowledgedAt === null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <article className={`relay-card ${pending ? "incoming" : ""}`}>
      <header className="relay-card-heading">
        <strong>{relay.author.displayName} passed this moment</strong>
        <span>{clockTime(relay.createdAt)}</span>
      </header>
      <div className="relay-transfer">
        <SeatMark identity={relay.author} size="medium" />
        <div className="relay-note">
          <span>For {incoming ? "you" : relay.recipient.displayName}</span>
          <Markdown text={relay.body} className="relay-body" />
        </div>
      </div>
      {relay.acknowledgedAt ? (
        <section className="relay-receipt" aria-label={`${relay.recipient.displayName} acknowledged this Relay`}>
          <header>
            <strong>{relay.recipient.displayName}</strong>
            <span>{clockTime(relay.acknowledgedAt)}</span>
          </header>
          <div>
            <SeatMark identity={relay.recipient} size="medium" />
            <p>Acknowledged.</p>
          </div>
        </section>
      ) : (
        <footer className="relay-card-footer">
          <span>{relay.anchorSequence === 0 ? "Original ask" : "Agent transcript"}</span>
          {pending ? (
          <button
            type="button"
            className="relay-acknowledge"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              const acknowledged = await onAcknowledge(relay).catch(() => false);
              if (!acknowledged) setError("Could not mark this handoff received.");
              setBusy(false);
            }}
          >
            {busy ? "Receiving…" : "Got it"}
          </button>
          ) : (
            <em className="relay-state">in transit</em>
          )}
        </footer>
      )}
      {error ? <span className="relay-card-error" role="alert">{error}</span> : null}
    </article>
  );
};

const RelayComposer: React.FC<{
  row: BoardRow;
  anchorSequence: number;
  anchorLabel: string;
  preferredRecipientId?: string;
  members: readonly ProjectParticipant[];
  current: Principal;
  onCreated: (relay: TaskRelay) => void;
}> = ({
  row,
  anchorSequence,
  anchorLabel,
  preferredRecipientId,
  members,
  current,
  onCreated,
}) => {
  const recipients = useMemo(
    () => members.filter(
      (member) =>
        member.access !== "watch" &&
        member.principal.kind === "person" &&
        member.principal.id !== current.id,
    ),
    [current.id, members],
  );
  const [recipientId, setRecipientId] = useState(
    recipients.some((member) => member.principal.id === preferredRecipientId)
      ? (preferredRecipientId ?? "")
      : (recipients[0]?.principal.id ?? ""),
  );
  const [recipientTouched, setRecipientTouched] = useState(false);
  const preferredRecipient = recipients.find(
    (member) => member.principal.id === preferredRecipientId,
  )?.principal.id;
  const fallbackRecipient = recipients[0]?.principal.id ?? "";
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const messageId = useId();
  const selectedRecipient = recipients.find(
    (member) => member.principal.id === recipientId,
  )?.principal;
  useEffect(() => {
    const recipientStillEligible = recipients.some(
      (member) => member.principal.id === recipientId,
    );
    if (!recipientStillEligible) {
      setRecipientTouched(false);
      setRecipientId(preferredRecipient ?? fallbackRecipient);
      return;
    }
    if (!recipientTouched) setRecipientId(preferredRecipient ?? fallbackRecipient);
  }, [fallbackRecipient, preferredRecipient, recipientId, recipientTouched, recipients]);
  return (
    <form
      className="relay-composer"
      aria-busy={busy}
      onSubmit={async (event) => {
        event.preventDefault();
        if (!recipientId || !body.trim() || busy) return;
        setBusy(true);
        setError(null);
        const response = await fetch(`/projects/${row.projectId}/relays`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            task: { kind: row.kind, id: row.id },
            anchorSequence,
            recipientPrincipalId: recipientId,
            body: body.trim(),
          }),
        }).catch(() => null);
        if (response?.ok) {
          const result = (await response.json()) as { relay: TaskRelay };
          setBody("");
          setBusy(false);
          onCreated(result.relay);
          return;
        }
        setBusy(false);
        const result = (await response?.json().catch(() => null)) as { error?: string } | null;
        setError(result?.error ?? "Could not send this Relay.");
      }}
    >
      <div className="relay-compose-head">
        <span>Relay to</span>
        <div className="relay-recipient-field">
          {selectedRecipient ? <SeatMark identity={selectedRecipient} size="small" /> : null}
          <select
            aria-label="Relay recipient"
            value={recipientId}
            onChange={(event) => {
              setRecipientTouched(true);
              setRecipientId(event.target.value);
            }}
          >
            {recipients.map((member) => (
              <option key={member.principal.id} value={member.principal.id}>
                {member.principal.displayName}
              </option>
            ))}
          </select>
        </div>
      </div>
      <label className="relay-message-label" htmlFor={messageId}>
        Message <i>will include context</i>
      </label>
      <div className="relay-message-field">
        <textarea
          id={messageId}
          aria-label="Relay message"
          value={body}
          maxLength={2_000}
          onChange={(event) => setBody(event.target.value)}
          placeholder="Add the thought they should carry forward…"
        />
        <div className="relay-context">— selected from {anchorLabel}</div>
      </div>
      {error ? <div className="relay-error" role="alert">{error}</div> : null}
      <div className="relay-compose-actions">
        <button type="submit" disabled={busy || !recipientId || !body.trim()}>
          {busy ? "Passing…" : "Pass this moment"}
        </button>
      </div>
      <p className="relay-visibility">
        <span>Everyone at this table can see the Relay.</span>
        <span>Only {selectedRecipient?.displayName ?? "the recipient"} can acknowledge it.</span>
      </p>
    </form>
  );
};

const TaskDetail: React.FC<{
  row: BoardRow | null;
  current: Principal;
  members: readonly ProjectParticipant[];
  onRelayChanged: () => void;
  onTaskChanged: () => Promise<void>;
}> = ({ row, current, members, onRelayChanged, onTaskChanged }) => {
  const loadHistory = useBoard((state) => state.loadHistory);
  const ingestEvent = useBoard((state) => state.ingestEvent);
  const refreshRelays = useBoard((state) => state.refreshRelays);
  const replaceRelay = useBoard((state) => state.replaceRelay);
  const runTimeline = useBoard((state) => (row?.kind === "run" ? state.runTimelines[row.id] : undefined));
  const sessionTimeline = useBoard((state) =>
    row?.kind === "session" ? state.sessionTimelines[row.id] : undefined,
  );
  const relays = useBoard((state) =>
    row ? state.taskRelays[`${row.kind}:${row.id}`] ?? NO_RELAYS : NO_RELAYS,
  );
  const loading = useBoard((state) => (row ? state.loading[`${row.kind}:${row.id}`] : false));
  const timeline = row?.kind === "run" ? runTimeline : sessionTimeline;
  const threadScrollRef = useRef<HTMLDivElement>(null);
  const [relayAnchor, setRelayAnchor] = useState<number | null>(null);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const [following, setFollowing] = useState(true);
  useEffect(() => {
    setRelayAnchor(null);
    setStopping(false);
    setStopError(null);
    setFollowing(true);
    if (!row) return;
    let disposed = false;
    let source: EventSource | null = null;
    void loadHistory(row.kind, row.id, row.projectId).then(() => {
      if (disposed) return;
      const state = useBoard.getState();
      const cursor =
        row.kind === "run"
          ? (state.runTimelines[row.id]?.cursor ?? 0)
          : (state.sessionTimelines[row.id]?.cursor ?? 0);
      source = new EventSource(
        `/task/${row.kind}/${row.id}/follow?after=${encodeURIComponent(String(cursor))}`,
      );
      source.addEventListener("task", (event) => {
        try {
          ingestEvent(row.kind, row.id, JSON.parse((event as MessageEvent<string>).data));
        } catch {
          source?.close();
        }
      });
    });
    const relayPoll = window.setInterval(
      () => void refreshRelays(row.kind, row.id, row.projectId),
      5_000,
    );
    return () => {
      disposed = true;
      source?.close();
      window.clearInterval(relayPoll);
    };
  }, [row?.kind, row?.id, row?.projectId, loadHistory, ingestEvent, refreshRelays]);
  useEffect(() => {
    if (!row || !following) return;
    const frame = window.requestAnimationFrame(() => {
      const scroller = threadScrollRef.current;
      scroller?.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [row?.kind, row?.id, timeline?.cursor, relays.length, following]);
  if (row === null) {
    return (
      <section className="task-detail empty" aria-label="Task detail">
        <div className="empty-conversation">
          <span>Shared transcript</span>
          <h2 data-grid-optical>The room is quiet.</h2>
          <p>The first delegated task will open here for everyone in the Project.</p>
        </div>
      </section>
    );
  }
  const blocks = composeTranscript(timeline?.messages ?? [], timeline?.toolCalls ?? []);
  const lastAgentMessageId = [...(timeline?.messages ?? [])]
    .reverse()
    .find((message) => message.role === "agent")?.id;
  const firstAgentMessage = (timeline?.messages ?? []).find((message) => message.role === "agent");
  const attention = taskAttention(row, current.id);
  const live = ["queued", "provisioning", "running", "closing"].includes(row.status);
  const canRelay = members.some(
    (member) => member.principal.id !== current.id && member.principal.kind === "person",
  );
  const latestSequence = blocks.at(-1)?.lastSequence ?? 0;
  const acknowledge = async (relay: TaskRelay): Promise<boolean> => {
    const response = await fetch(
      `/projects/${row.projectId}/relays/${relay.id}/acknowledge`,
      { method: "POST" },
    ).catch(() => null);
    if (!response?.ok) return false;
    const result = (await response.json()) as { relay: TaskRelay };
    replaceRelay(result.relay);
    onRelayChanged();
    return true;
  };
  const activeAnchor = relayAnchor ?? latestSequence;
  const selectedBlock = blocks.find((block) => block.lastSequence === activeAnchor);
  const anchorExcerpt =
    activeAnchor === 0
      ? taskTitle(row.title)
      : selectedBlock?.type === "message"
        ? taskTitle(selectedBlock.value.text)
        : selectedBlock?.type === "work"
          ? workSummary(selectedBlock.details).title
          : `Latest ${humanAgent(row.agentType)} update`;
  return (
    <section className="task-detail" aria-label="Task detail">
      <div className="thread-scroll">
        <div className="agent-workbench grid-band">
          <aside className="speaker-rail" data-grid-item aria-label="Conversation participants">
            <h3>Who spoke</h3>
            <div className="speaker-sequence">
              <article className="speaker human-speaker">
                <SeatMark identity={row.delegatedBy} size="medium" />
                <div>
                  <strong>{row.delegatedBy.displayName}</strong>
                  <span>{clockTime(row.createdAt)}</span>
                </div>
              </article>
              <article className="speaker agent-speaker">
                <SeatMark agent size="medium" />
                <div>
                  <strong>{humanAgent(row.agentType)}</strong>
                  <span className={`tone-${statusTone(row.status)}`}>
                    {firstAgentMessage ? clockTime(firstAgentMessage.firstOccurredAt) : displayStatus(row.status)}
                  </span>
                </div>
              </article>
            </div>
            <div className="task-custody">
              <span>{row.delegatedBy.displayName} delegated</span>
              {attention ? <strong>{attention}</strong> : <strong>Shared with the room</strong>}
              {row.kind === "run" && row.delegatedBy.id === current.id && live ? (
                <button
                  type="button"
                  disabled={stopping}
                  onClick={async () => {
                    setStopping(true);
                    setStopError(null);
                    const response = await fetch(`/task/run/${row.id}/cancel`, { method: "POST" })
                      .catch(() => null);
                    if (!response?.ok) {
                      setStopError("Could not stop this run. Its state is unchanged.");
                      setStopping(false);
                      return;
                    }
                    await onTaskChanged().catch(() => undefined);
                    setStopping(false);
                  }}
                >
                  {stopping ? "Stopping…" : "Stop my run"}
                </button>
              ) : null}
              {stopError ? <span className="task-control-error" role="alert">{stopError}</span> : null}
            </div>
          </aside>

          <div className="agent-thread-frame" data-grid-item>
            <section
              className="conversation agent-thread"
              aria-label="Live agent transcript"
              ref={threadScrollRef}
              onScroll={(event) => {
                const scroller = event.currentTarget;
                const isNearLatest = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;
                if (isNearLatest !== following) setFollowing(isNearLatest);
              }}
            >
            <section className={`opening-ask ${activeAnchor === 0 ? "selected-moment" : ""}`}>
              <Markdown text={taskPromptBody(row.title)} className="thread-message-copy" />
              {canRelay ? (
                <button type="button" onClick={() => setRelayAnchor(0)}>Pass this ask</button>
              ) : null}
            </section>
            {loading && timeline === undefined ? (
              <div className="loading-line">Opening the agent thread…</div>
            ) : null}
            {blocks.map((block, index) => {
              const sequence = block.lastSequence;
              const selectedMoment = activeAnchor === sequence;
              if (block.type === "work") {
                const summary = workSummary(block.details);
                const containsReasoning = block.details.some((detail) => detail.type === "thought");
                return (
                  <div
                    className={`transcript-block work-block ${selectedMoment ? "selected-moment" : ""}`}
                    key={block.id}
                  >
                    <details className="agent-work" open={containsReasoning ? true : undefined}>
                      <summary>
                        <strong>{summary.title}</strong>
                        <span className="work-state">{latestWorkTime(block.details)}</span>
                      </summary>
                      <div className="agent-work-body">
                        {containsReasoning ? <SignalField /> : null}
                        <div className="agent-work-content">
                          {block.details.map((detail) => (
                            <WorkDetail key={`${detail.type}:${detail.value.id}`} detail={detail} />
                          ))}
                        </div>
                      </div>
                    </details>
                    {canRelay ? (
                      <button
                        className="relay-anchor"
                        type="button"
                        aria-label={`Pass ${summary.title} to a teammate`}
                        onClick={() => setRelayAnchor(sequence)}
                      >
                        Pass moment
                      </button>
                    ) : null}
                  </div>
                );
              }
              const fromPerson = block.value.role === "user";
              const actor = fromPerson ? row.delegatedBy.displayName : humanAgent(row.agentType);
              return (
                <div
                  className={`transcript-block ${selectedMoment ? "selected-moment" : ""}`}
                  key={`message:${block.value.id}`}
                >
                  <section className={`thread-message ${fromPerson ? "human-message" : "agent-message"}`}>
                    <header className="thread-message-header">
                      <div>
                        <strong>{actor}</strong>
                        <span>{clockTime(block.value.lastOccurredAt)}</span>
                      </div>
                      {canRelay ? (
                        <button type="button" onClick={() => setRelayAnchor(sequence)}>Pass moment</button>
                      ) : null}
                    </header>
                    <div className={fromPerson ? "human-message-bubble" : undefined}>
                      <Markdown
                        text={block.value.text}
                        className="thread-message-copy"
                        live={!fromPerson && live && block.value.id === lastAgentMessageId}
                      />
                    </div>
                  </section>
                </div>
              );
            })}
            {timeline && blocks.length === 0 && !loading ? (
              <div className="transcript-awaiting">
                <strong>{humanAgent(row.agentType)} is starting.</strong>
                <span>Working notes, tool calls, and the response will appear here.</span>
              </div>
            ) : null}
            {timeline?.plan !== null || timeline?.usage !== null ? (
              <details className="run-facts">
                <summary>Run facts</summary>
                <pre>{boundedJson({ plan: timeline?.plan, usage: timeline?.usage })}</pre>
              </details>
            ) : null}
            </section>
            {!following ? (
              <button
                type="button"
                className="jump-latest"
                onClick={() => {
                  const scroller = threadScrollRef.current;
                  scroller?.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
                  setFollowing(true);
                }}
              >
                Latest
              </button>
            ) : null}
          </div>

          <aside className="handoff-panel" data-grid-item aria-label="Human handoff">
            <header className="handoff-heading">
              <strong>Handoff thread</strong>
              <span>{relays.length === 0 ? "No moments passed" : `${relays.length} passed`}</span>
            </header>
            <div className="handoff-list">
              {relays.length === 0 ? (
                <p>Choose a moment in the transcript, then pass the context without taking control of the agent.</p>
              ) : relays.map((relay) => (
                <RelayCard key={relay.id} relay={relay} current={current} onAcknowledge={acknowledge} />
              ))}
            </div>
            {canRelay ? (
              <section className="relay-margin-compose">
                <div className="selected-source">
                  <span>Selected moment</span>
                  <strong>{anchorExcerpt}</strong>
                </div>
                <RelayComposer
                  row={row}
                  anchorSequence={activeAnchor}
                  anchorLabel={activeAnchor === 0 ? "the original ask" : `${humanAgent(row.agentType)} above`}
                  preferredRecipientId={relays.at(-1)?.recipient.id}
                  members={members}
                  current={current}
                  onCreated={(relay) => {
                    replaceRelay(relay);
                    onRelayChanged();
                  }}
                />
              </section>
            ) : (
              <p className="handoff-unavailable">Add another person to this Project before passing a moment.</p>
            )}
          </aside>
        </div>
      </div>
    </section>
  );
};

const TaskComposer: React.FC<{
  project: Project;
  principal: Principal;
  agents: readonly AgentConnection[];
  repository: ProjectRepositoryBinding | null;
  onCancel: () => void;
  onCreated: (runId: string) => Promise<void>;
}> = ({ project, principal, agents, repository, onCancel, onCreated }) => {
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const [prompt, setPrompt] = useState("");
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [revision, setRevision] = useState("");
  const [agentType, setAgentType] = useState(agents[0]?.agentType ?? "");
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    promptRef.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    const closeFromKeyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onCancel();
    };
    document.addEventListener("keydown", closeFromKeyboard);
    return () => document.removeEventListener("keydown", closeFromKeyboard);
  }, [busy, onCancel]);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!prompt.trim() || (!repository && !repositoryUrl.trim()) || !agentType || busy) return;
    setBusy(true);
    setError(null);
    const response = await fetch(`/projects/${project.id}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: prompt.trim(),
        repositoryUrl: repository?.repositoryUrl ?? repositoryUrl.trim(),
        revision: revision.trim(),
        agentType,
        idempotencyKey,
      }),
    }).catch(() => null);
    if (response?.ok) {
      const created = (await response.json()) as CreatedRunResponse;
      await onCreated(created.run.id);
      return;
    }
    const body = (await response?.json().catch(() => null)) as { error?: unknown } | null;
    setError(
      typeof body?.error === "string"
        ? body.error
        : response?.status === 502
          ? "The control plane is unavailable."
          : "The task could not be delegated.",
    );
    setBusy(false);
  };
  return (
    <section className="task-composer" aria-label="Delegate a new task">
      <header className="composer-header">
        <div className="detail-kicker"><span>New delegation</span><i>one-shot run</i></div>
        <h2 data-grid-optical>Put work on this table.</h2>
        <p>
          Describe the outcome. Meanwhile will create durable work attributed to you, then open
          its live agent transcript here.
        </p>
      </header>
      <form aria-busy={busy} onSubmit={submit}>
        <div className="composer-body">
          <label className="composer-field composer-ask">
            <span>What should the agent do?</span>
            <textarea
              ref={promptRef}
              required
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Audit the authentication path and fix the highest-risk gap…"
            />
          </label>
          <div className="composer-source">
            {repository ? (
              <div className="composer-field composer-bound-source">
                <span>Authorized repository</span>
                <strong><GithubLogo size={16} weight="fill" aria-hidden="true" />{repository.repositoryFullName}</strong>
                <small>{repository.accountName} · checkout uses your current GitHub grant</small>
              </div>
            ) : (
              <label className="composer-field">
                <span>Repository</span>
                <input
                  type="url"
                  required
                  value={repositoryUrl}
                  onChange={(event) => setRepositoryUrl(event.target.value)}
                  placeholder="https://github.com/owner/repository"
                />
              </label>
            )}
            <label className="composer-field revision-field">
              <span>Branch, tag, or commit <i>optional</i></span>
              <input
                value={revision}
                onChange={(event) => setRevision(event.target.value)}
                placeholder="main"
              />
            </label>
          </div>
          <p className="source-note">
            {repository
              ? "Meanwhile will resolve short-lived checkout authority at execution time; the browser never receives a repository credential."
              : "This local installation has no repository binding. Use a public HTTPS repository; no credential is embedded in the task."}
          </p>
          {agents.length > 1 ? (
            <label className="composer-field composer-agent">
              <span>Authorized agent</span>
              <select value={agentType} onChange={(event) => setAgentType(event.target.value)}>
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.agentType}>{agent.label}</option>
                ))}
              </select>
            </label>
          ) : null}
          <section className="custody-contract" aria-label="Delegation authority">
            <div className="custody-route">
              <span>{principal.displayName}</span><i>delegates to</i><strong>{humanAgent(agentType)}</strong>
            </div>
            <dl>
              <div><dt>Room</dt><dd>{project.name}</dd></div>
              <div><dt>Visible to</dt><dd>Everyone at this table</dd></div>
              <div><dt>Control stays with</dt><dd>You</dd></div>
            </dl>
          </section>
          {error ? <div className="composer-error" role="alert">{error}</div> : null}
        </div>
        <footer className="composer-actions">
          <button type="button" className="composer-cancel" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button
            type="submit"
            className="composer-submit"
            disabled={busy || !prompt.trim() || (!repository && !repositoryUrl.trim()) || !agentType}
          >
            {busy ? "Delegating…" : `Delegate to ${humanAgent(agentType)}`}
          </button>
        </footer>
      </form>
    </section>
  );
};

const ProjectWatch: React.FC<{
  initialProjectId: string;
  onLobby: () => void;
}> = ({ initialProjectId, onLobby }) => {
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0 });
  }, []);
  const [projectId, setProjectId] = useState<string | null>(initialProjectId);
  const { data, error, mutate, isLoading } = useSWR<BoardResponse>(
    `/board${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`,
    fetchJson,
    { refreshInterval: 5_000, keepPreviousData: true },
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [taskOpen, setTaskOpen] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerOrigin, setComposerOrigin] = useState<"room" | "detail">("room");
  const composerContextRef = useRef<HTMLDivElement>(null);
  const roomScrollYRef = useRef(0);
  const [presenceClientId] = useState(() => {
    const key = "meanwhile.project-presence-client";
    const existing = window.sessionStorage.getItem(key);
    if (existing) return existing;
    const created = crypto.randomUUID();
    window.sessionStorage.setItem(key, created);
    return created;
  });
  const openComposer = (origin: "room" | "detail") => {
    setComposerOrigin(origin);
    setComposerOpen(true);
  };
  const closeComposer = () => {
    setComposerOpen(false);
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLButtonElement>(".live-deck-new-task")?.focus();
    });
  };
  const trapComposerFocus = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeComposer();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>(
      "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex='-1'])",
    )].filter((element) => element.getClientRects().length > 0);
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  const openTask = (row: PresentedBoardRow) => {
    roomScrollYRef.current = window.scrollY;
    setSelectedId(`${row.kind}:${row.id}`);
    transitionSurface(() => setTaskOpen(true));
    window.requestAnimationFrame(() => window.scrollTo({ top: 0, left: 0 }));
  };
  const closeTask = () => {
    transitionSurface(() => setTaskOpen(false));
    window.requestAnimationFrame(() =>
      window.scrollTo({ top: roomScrollYRef.current, left: 0 }));
  };
  const replaceRelay = useBoard((state) => state.replaceRelay);
  const selected = useMemo(() => {
    const exact = data?.rows.find((row) => `${row.kind}:${row.id}` === selectedId);
    const pendingRelay = data?.pendingRelays[0];
    const relayed = pendingRelay
      ? data?.rows.find(
          (row) => row.kind === pendingRelay.task.kind && row.id === pendingRelay.task.id,
        )
      : undefined;
    return exact ?? relayed ?? data?.rows.find((row) => row.section === "attention") ?? data?.rows[0] ?? null;
  }, [data, selectedId]);
  useEffect(() => {
    if (selectedId === null && selected !== null) {
      setSelectedId(`${selected.kind}:${selected.id}`);
    }
  }, [selected, selectedId]);
  useEffect(() => {
    if (data && projectId === null) setProjectId(data.project.id);
  }, [data, projectId]);
  useEffect(() => {
    if (!data) return;
    const path = `/projects/${data.project.id}/presence/${presenceClientId}`;
    let active = true;
    const heartbeat = async (refresh: boolean) => {
      const response = await fetch(path, { method: "PUT" }).catch(() => null);
      if (active && refresh && response?.ok) await mutate();
    };
    void heartbeat(true);
    const interval = window.setInterval(() => void heartbeat(false), 15_000);
    return () => {
      active = false;
      window.clearInterval(interval);
      void fetch(path, { method: "DELETE", keepalive: true }).catch(() => null);
    };
  }, [data?.project.id, mutate, presenceClientId]);
  useEffect(() => {
    for (const relay of data?.pendingRelays ?? []) replaceRelay(relay);
  }, [data?.pendingRelays, replaceRelay]);
  useEffect(() => {
    const context = composerContextRef.current;
    if (!context) return;
    context.inert = composerOpen;
    return () => { context.inert = false; };
  }, [composerOpen]);
  if (isLoading && data === undefined) return <ProductStatus message="Opening the Project room…" />;
  if (!data) {
    return <ProductStatus alert message="Project Watch is unavailable." retry={() => void mutate()} />;
  }
  const roomSurface = (
    <LiveDeckRoom
      principal={data.principal}
      project={data.project}
      repository={data.delegation.repository}
      presence={data.presence}
      rows={data.rows}
      pendingRelays={data.pendingRelays}
      recentRelays={data.recentRelays}
      connectionState={error === undefined ? "healthy" : "reconnecting"}
      onBack={onLobby}
      onDelegate={() => openComposer("room")}
      onOpenTask={openTask}
    />
  );
  const detailSurface = selected === null ? roomSurface : (
    <ConversationDetail
      row={selected}
      current={data.principal}
      project={data.project}
      repository={data.delegation.repository}
      members={data.members}
      presence={data.presence}
      recentRelays={data.recentRelays}
      connectionState={error === undefined ? "healthy" : "reconnecting"}
      onBack={closeTask}
      onDelegate={() => openComposer("detail")}
      onRelayChanged={() => void mutate()}
    />
  );
  return (
    <>
      <div ref={composerContextRef} className={composerOpen ? "task-composer-context is-obscured" : "task-composer-context"} aria-hidden={composerOpen || undefined}>
        {taskOpen ? detailSurface : roomSurface}
      </div>
      <AnimatePresence>
        {composerOpen ? (
          <motion.div
            className="task-composer-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.22, 0.61, 0.36, 1] }}
          >
            <motion.div
              className="task-composer-dialog"
              role="dialog"
              aria-modal="true"
              aria-label="Delegate a new task"
              onKeyDown={trapComposerFocus}
              initial={{ opacity: 0, y: 18, scale: 0.992 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 10, scale: 0.996 }}
              transition={{ duration: 0.28, ease: [0.22, 0.61, 0.36, 1] }}
            >
              <div className="task-composer-dialog-bar">
                <span>{data.project.name}</span>
                <strong>{composerOrigin === "detail" ? "Conversation · New task" : "Live Deck · New task"}</strong>
                <button type="button" onClick={closeComposer}>Close</button>
              </div>
              <TaskComposer
                project={data.project}
                principal={data.principal}
                agents={data.delegation.agents}
                repository={data.delegation.repository}
                onCancel={closeComposer}
                onCreated={async (runId) => {
                  await mutate();
                  setSelectedId(`run:${runId}`);
                  setComposerOpen(false);
                  setTaskOpen(true);
                }}
              />
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </>
  );
};

const AuthenticatedFlow: React.FC<{ onLogout: () => void }> = ({ onLogout }) => {
  const { data, isLoading, mutate } = useSWR<OnboardingResponse>("/onboarding", fetchJson, {
    shouldRetryOnError: false,
  });
  const [openedProjectId, setOpenedProjectId] = useState<string | null>(null);
  const [entered, setEntered] = useState(false);
  const initialReady = useRef<boolean | null>(null);
  if (isLoading && data === undefined) return <ProductStatus message="Preparing your Projects…" />;
  if (data === undefined) {
    return <ProductStatus alert message="Connected onboarding is unavailable." retry={() => void mutate()} />;
  }
  const selectedProjects = data.projects.filter((entry) => entry.selected);
  const ready = data.agentConnections.length > 0 && selectedProjects.length > 0;
  if (initialReady.current === null) initialReady.current = ready;
  if (!ready || (initialReady.current === false && !entered)) {
    return (
      <ConnectedOnboarding
        data={data}
        onChanged={() => mutate()}
        onComplete={() => transitionSurface(() => setEntered(true))}
        onLogout={onLogout}
      />
    );
  }
  return openedProjectId === null ? (
    <ProjectLobby
      onOpen={(projectId) => transitionSurface(() => setOpenedProjectId(projectId))}
      onLogout={onLogout}
    />
  ) : (
    <ProjectWatch
      initialProjectId={openedProjectId}
      onLobby={() => transitionSurface(() => setOpenedProjectId(null))}
    />
  );
};

const App: React.FC = () => {
  const { data, error, isLoading, mutate } = useSWR<SessionResponse>("/session", fetchJson, {
    shouldRetryOnError: false,
  });
  const {
    data: providerData,
    isLoading: providersLoading,
    mutate: mutateProviders,
  } = useSWR<ExternalAuthProvidersResponse>("/auth/providers", fetchJson, {
    shouldRetryOnError: false,
  });
  if (isLoading || providersLoading) return <ProductStatus message="Opening Meanwhile…" />;
  if (error instanceof Error && error.message !== "UNAUTHENTICATED") {
    return (
      <ProductStatus
        alert
        message="Project Watch is unavailable."
        retry={() => window.location.reload()}
      />
    );
  }
  if (providerData?.invitationReady) {
    return (
      <Login
        currentPrincipal={data?.authenticated ? data.principal : undefined}
        onLogin={() => mutate()}
        providerData={providerData}
        onCancelInvitation={data?.authenticated
          ? async () => {
              const response = await fetch("/auth/invitation/cancel", { method: "POST" });
              if (!response.ok) return;
              await mutateProviders(
                { ...providerData, invitationReady: false },
                { revalidate: false },
              );
            }
          : undefined}
      />
    );
  }
  if (!data?.authenticated) {
    return <Login onLogin={() => mutate()} providerData={providerData} />;
  }
  const logout = async () => {
        await fetch("/logout", { method: "POST" });
        await mutate({ authenticated: false }, { revalidate: false });
  };
  return <AuthenticatedFlow onLogout={logout} />;
};

class WatchErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <ProductStatus
          alert
          message="Project Watch needs to reload."
          retry={() => window.location.reload()}
        />
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <WatchErrorBoundary><App /></WatchErrorBoundary>
  </StrictMode>,
);
