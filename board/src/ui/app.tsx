import type {
  Principal,
  Project,
  ProjectMember,
} from "@kohoz/meanwhile/contracts";
import { AnimatePresence, motion } from "motion/react";
import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import useSWR from "swr";
import {
  displayStatus,
  humanAgent,
  type PresentedBoardRow,
  projectVerdict,
  statusTone,
  taskAttention,
} from "./presentation";
import { useBoard } from "./store";
import "./styles.css";

type BoardRow = PresentedBoardRow;

interface SessionResponse {
  authenticated: boolean;
  principal?: Principal;
  projects?: readonly Project[];
}

interface BoardResponse {
  principal: Principal;
  project: Project;
  projects: readonly Project[];
  members: readonly ProjectMember[];
  rows: readonly BoardRow[];
  updatedAt: string;
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

const Login: React.FC<{ onLogin: () => void }> = ({ onLogin }) => {
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
      <form className="login-card" onSubmit={submit}>
        <div className="brand">meanwhile</div>
        <h1>Watch work together.</h1>
        <p>
          Use your personal access key. It is exchanged once for a short-lived, read-only
          browser session and is never stored by Project Watch.
        </p>
        <label htmlFor="api-key">Personal access key</label>
        <input
          id="api-key"
          autoFocus
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder="mwk_…"
        />
        {error ? <div className="login-error">{error}</div> : null}
        <button type="submit" disabled={busy || !apiKey.trim()}>
          {busy ? "Opening…" : "Open Project Watch"}
        </button>
        <div className="login-help">Need access? Ask a Project maintainer.</div>
      </form>
    </main>
  );
};

const TaskList: React.FC<{
  rows: readonly BoardRow[];
  selected: BoardRow | null;
  onSelect: (row: BoardRow) => void;
}> = ({ rows, selected, onSelect }) => {
  if (rows.length === 0) {
    return (
      <section className="task-list empty" aria-label="Project work">
        <div className="project-empty">
          <span>Project work</span>
          <h2>No delegated work yet.</h2>
          <p>
            Tasks appear here when members delegate through an agent integration, the CLI,
            SDK, or API.
          </p>
        </div>
      </section>
    );
  }
  const groups = [
    ["attention", "Needs attention"],
    ["active", "Active"],
    ["ready", "Ready"],
    ["completed", "Completed"],
  ] as const;
  return (
    <section className="task-list" aria-label="Project work">
      {groups.map(([section, label]) => {
        const items = rows.filter((row) => row.section === section);
        if (items.length === 0) return null;
        return (
          <div className="task-group" key={section}>
            <h2>{label}</h2>
            <div className="task-group-rows">
              {items.map((row) => {
                const tone = statusTone(row.status);
                const isSelected = selected?.id === row.id && selected.kind === row.kind;
                return (
                  <button
                    type="button"
                    key={`${row.kind}:${row.id}`}
                    className={`task-row ${isSelected ? "selected" : ""} tone-${tone}`}
                    onClick={() => onSelect(row)}
                  >
                    <span className="delegator">{row.delegatedBy.displayName}</span>
                    <span className="task-title">{row.title}</span>
                    <span className="agent">{humanAgent(row.agentType)}</span>
                    <span className="status"><i />{displayStatus(row.status)}</span>
                    <span className="time">{relativeTime(row.updatedAt)}</span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </section>
  );
};

const TaskDetail: React.FC<{ row: BoardRow | null; current: Principal }> = ({ row, current }) => {
  const loadHistory = useBoard((state) => state.loadHistory);
  const runTimeline = useBoard((state) => (row?.kind === "run" ? state.runTimelines[row.id] : undefined));
  const sessionTimeline = useBoard((state) =>
    row?.kind === "session" ? state.sessionTimelines[row.id] : undefined,
  );
  const loading = useBoard((state) => (row ? state.loading[`${row.kind}:${row.id}`] : false));
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    setExpanded(false);
    if (row) void loadHistory(row.kind, row.id);
  }, [row?.kind, row?.id, loadHistory]);
  if (row === null) {
    return <aside className="task-detail empty">Task conversations open here.</aside>;
  }
  const timeline = row.kind === "run" ? runTimeline : sessionTimeline;
  const agentMessages = timeline?.messages ?? [];
  const messages = [
    { id: "delegation", actor: row.delegatedBy.displayName, kind: "person", text: row.title },
    ...agentMessages.map((message) => ({
      id: message.id,
      actor: message.role === "user" ? row.delegatedBy.displayName : humanAgent(row.agentType),
      kind: message.role === "user" ? "person" : "agent",
      text: message.text,
    })),
    ...(["failed", "timed_out", "continuity_lost"].includes(row.status)
      ? [{ id: "terminal", actor: "System", kind: "system", text: `Task ${displayStatus(row.status)}.` }]
      : []),
  ];
  const visible = expanded ? messages : messages.slice(0, 4);
  const attention = taskAttention(row, current.id);
  return (
    <aside className="task-detail">
      <div className="detail-kicker">Task detail</div>
      <h2>{row.title}</h2>
      <div className="detail-meta">
        Delegated by {row.delegatedBy.displayName}<b>·</b>{humanAgent(row.agentType)}<b>·</b>
        <span className={`tone-${statusTone(row.status)}`}>{displayStatus(row.status)}</span>
        <b>·</b>{relativeTime(row.updatedAt)}
      </div>
      {attention ? (
        <div className={`ownership ${row.delegatedBy.id === current.id ? "mine" : "theirs"}`}>
          {attention}
        </div>
      ) : null}
      <div className="conversation">
        {loading && messages.length === 1 ? <div className="loading-line">Loading conversation…</div> : null}
        {visible.map((message) => (
          <div className={`conversation-row ${message.kind}`} key={message.id}>
            <div className="conversation-rail"><i /></div>
            <div className="conversation-actor">{message.actor}</div>
            <div className="conversation-time">{relativeTime(row.createdAt)}</div>
            <div className="conversation-copy">{message.text}</div>
          </div>
        ))}
      </div>
      {messages.length > 4 ? (
        <button type="button" className="full-conversation" onClick={() => setExpanded((value) => !value)}>
          {expanded ? "Show concise conversation" : "Open full conversation"}
        </button>
      ) : null}
    </aside>
  );
};

const ProjectWatch: React.FC<{ onLogout: () => void }> = ({ onLogout }) => {
  const [projectId, setProjectId] = useState<string | null>(null);
  const [accountOpen, setAccountOpen] = useState(false);
  const { data, mutate, isLoading } = useSWR<BoardResponse>(
    `/board${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`,
    fetchJson,
    { refreshInterval: 5_000, keepPreviousData: true },
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = useMemo(() => {
    const exact = data?.rows.find((row) => `${row.kind}:${row.id}` === selectedId);
    return exact ?? data?.rows.find((row) => row.section === "attention") ?? data?.rows[0] ?? null;
  }, [data, selectedId]);
  useEffect(() => {
    if (data && projectId === null) setProjectId(data.project.id);
  }, [data, projectId]);
  if (isLoading && data === undefined) return <div className="app-loading">meanwhile</div>;
  if (!data) return <div className="app-loading">Project Watch is unavailable.</div>;
  const verdict = projectVerdict(data.rows, data.principal.id, data.members.length);
  return (
    <div className="watch-shell">
      <header className="topbar">
        <div className="brand">meanwhile</div>
        <label className="project-switcher">
          <span className="sr-only">Project</span>
          <select
            value={data.project.id}
            onChange={(event) => {
              setProjectId(event.target.value);
              setSelectedId(null);
            }}
          >
            {data.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </label>
        <div className="people-count">{data.members.length} {data.members.length === 1 ? "person" : "people"}</div>
        <div className="account">
          <button
            className="identity"
            type="button"
            aria-expanded={accountOpen}
            onClick={() => setAccountOpen((value) => !value)}
          >
            {data.principal.displayName}
          </button>
          {accountOpen ? (
            <div className="account-menu">
              <span>Signed in as {data.principal.displayName}</span>
              <button type="button" onClick={onLogout}>Sign out</button>
            </div>
          ) : null}
        </div>
      </header>
      <section className="verdict">
        <h1>{verdict.personal}</h1>
        <p className={verdict.projectNeedsAttention ? "project-alert" : undefined}>
          {verdict.project}
        </p>
        <button type="button" className="refresh" onClick={() => mutate()}>Refresh</button>
      </section>
      <main className="work-surface">
        <TaskList
          rows={data.rows}
          selected={selected}
          onSelect={(row) => setSelectedId(`${row.kind}:${row.id}`)}
        />
        <AnimatePresence mode="wait">
          <motion.div
            key={selected ? `${selected.kind}:${selected.id}` : "empty"}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.16 }}
            className="detail-motion"
          >
            <TaskDetail row={selected} current={data.principal} />
          </motion.div>
        </AnimatePresence>
      </main>
    </div>
  );
};

const App: React.FC = () => {
  const { data, error, isLoading, mutate } = useSWR<SessionResponse>("/session", fetchJson, {
    shouldRetryOnError: false,
  });
  if (isLoading) return <div className="app-loading">meanwhile</div>;
  if (error instanceof Error && error.message !== "UNAUTHENTICATED") {
    return <div className="app-loading">Project Watch is unavailable.</div>;
  }
  if (!data?.authenticated) return <Login onLogin={() => mutate()} />;
  return (
    <ProjectWatch
      onLogout={async () => {
        await fetch("/logout", { method: "POST" });
        await mutate({ authenticated: false }, { revalidate: false });
      }}
    />
  );
};

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
