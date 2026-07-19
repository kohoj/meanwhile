import { AnimatePresence, motion } from "motion/react";
import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import useSWR from "swr";
import type { Brief } from "@kohoz/meanwhile/contracts";
import { type BoardRow, connectStream, useBoard } from "./store";
import "./styles.css";

const fetcher = (url: string) => fetch(url).then((r) => r.json());
const EASE = [0.22, 1, 0.36, 1] as const;

interface PromotableArtifactEntry {
  artifactId: string;
  path: string;
  mediaType: string;
  byteSize: number;
  brief: Brief | null;
}

// Plain-words relative time for the trust anchor — never a raw timestamp.
const ago = (iso: string | null): string | null => {
  if (!iso) return null;
  const diff = Date.now() - Date.parse(iso);
  if (Number.isNaN(diff) || diff < 0) return null;
  const m = Math.round(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
};

// ── Read-side classification. Only two things "need a human": a pending
// decision (waiting) or a break (crash). Everything else is background.
type Class = "wait" | "crash" | "running" | "done";
const classify = (kind: string, status: string): Class => {
  if (kind === "run") {
    if (status === "failed" || status === "timed_out") return "crash";
    if (status === "succeeded" || status === "cancelled") return "done";
    return "running";
  }
  if (status === "continuity_lost" || status === "failed") return "crash";
  if (status === "closed") return "done";
  if (status === "idle") return "wait";
  return "running";
};
const NEEDS_HUMAN = (c: Class) => c === "wait" || c === "crash";
const TONE: Record<Class, string> = {
  wait: "var(--color-wait)",
  crash: "var(--color-crash)",
  running: "var(--color-ink-3)",
  done: "var(--color-ink-4)",
};

const useLiveStatus = (row: BoardRow) =>
  useBoard((s) => s.liveStatus[`${row.kind}:${row.id}`]) ?? row.status;

// ── The one item that needs you: stated with weight, and with evidence. ──────
const Demand: React.FC<{ row: BoardRow; onOpen: () => void }> = ({ row, onOpen }) => {
  const status = useLiveStatus(row);
  const cls = classify(row.kind, status);
  const tone = TONE[cls];
  return (
    <motion.button
      type="button"
      onClick={onOpen}
      layout="position"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: 0.24, ease: EASE }}
      className="group block w-full rounded-2xl bg-[var(--color-raise)] p-6 text-left transition-transform duration-150 active:scale-[0.995]"
    >
      <div className="flex items-center gap-2.5">
        <span
          className="size-2 rounded-full"
          style={{ backgroundColor: tone, animation: "breathe 1.9s ease-in-out infinite" }}
        />
        <span
          className="font-[var(--font-mono)] text-[11px] uppercase tracking-[0.1em]"
          style={{ color: tone }}
        >
          {cls === "crash" ? "broke · holding" : "waiting on you"}
        </span>
      </div>
      <div className="mt-3 text-pretty text-[19px] font-medium leading-snug text-[var(--color-ink)]">
        {row.title || row.id}
      </div>
      <div className="mt-3 font-[var(--font-mono)] text-[12px] text-[var(--color-ink-3)]">
        {row.agentType} · {status} · open to see where →
      </div>
    </motion.button>
  );
};

// ── Background inventory: near-invisible proof-of-existence, opt-in to read. ──
const QuietRow: React.FC<{ row: BoardRow; onOpen: () => void }> = ({ row, onOpen }) => {
  const status = useLiveStatus(row);
  const cls = classify(row.kind, status);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors duration-150 hover:bg-[var(--color-raise)]"
    >
      <span className="size-1 rounded-full" style={{ backgroundColor: TONE[cls] }} />
      <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--color-ink-3)]">
        {row.title || row.id}
      </span>
      <span className="tnum shrink-0 font-[var(--font-mono)] text-[11px] text-[var(--color-ink-4)]">
        {status}
      </span>
    </button>
  );
};

// ── Detail — a focused reading of the agent's evidence. ──────────────────────
const Detail: React.FC<{ row: BoardRow; onClose: () => void }> = ({ row, onClose }) => {
  const runTl = useBoard((s) => s.runTimelines[row.id]);
  const sessTl = useBoard((s) => s.sessionTimelines[row.id]);
  const loadHistory = useBoard((s) => s.loadHistory);
  const messages = row.kind === "run" ? runTl?.messages : sessTl?.messages;
  const status = useLiveStatus(row);
  const [loading, setLoading] = useState(!messages);
  const [promoting, setPromoting] = useState<string | null>(null);
  const [promotionError, setPromotionError] = useState<string | null>(null);
  const artifactUrl = row.kind === "run" ? `/task/run/${row.id}/artifacts` : null;
  const { data: artifactData, mutate: refreshArtifacts } = useSWR<{
    items: PromotableArtifactEntry[];
  }>(artifactUrl, fetcher);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  useEffect(() => {
    let alive = true;
    if (!messages || messages.length === 0) {
      setLoading(true);
      loadHistory(row.kind, row.id).finally(() => alive && setLoading(false));
    } else setLoading(false);
    return () => {
      alive = false;
    };
  }, [row.kind, row.id, loadHistory, messages]);

  const promote = async (entry: PromotableArtifactEntry) => {
    const identity = `${entry.artifactId}:${entry.path}`;
    setPromoting(identity);
    setPromotionError(null);
    const title = `${entry.path} · ${row.title || row.id}`.slice(0, 160);
    try {
      const response = await fetch("/briefs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, artifactId: entry.artifactId, path: entry.path }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({ error: "Could not keep this output." }));
        setPromotionError(body.error ?? "Could not keep this output.");
      } else {
        await refreshArtifacts();
      }
    } catch {
      setPromotionError("Could not reach the control plane.");
    } finally {
      setPromoting(null);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.16 }}
      onClick={onClose}
      className="fixed inset-0 z-[var(--z-backdrop)] flex items-end justify-center bg-black/60 p-4 sm:items-center sm:p-6"
    >
      <motion.div
        role="dialog"
        aria-modal
        initial={{ opacity: 0, y: 16, scale: 0.99 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 12 }}
        transition={{ duration: 0.22, ease: EASE }}
        onClick={(e) => e.stopPropagation()}
        className="z-[var(--z-modal)] flex max-h-[82dvh] w-full max-w-lg flex-col overflow-hidden rounded-3xl bg-[var(--color-raise)] shadow-[var(--shadow-modal)]"
      >
        <header className="px-7 pb-4 pt-6">
          <h2 className="text-balance text-[17px] font-semibold leading-snug text-[var(--color-ink)]">
            {row.title || row.id}
          </h2>
          <p className="mt-1.5 font-[var(--font-mono)] text-[11px] text-[var(--color-ink-3)]">
            {row.kind} · {row.agentType} · {status}
          </p>
        </header>
        <div className="flex-1 overflow-y-auto px-7 pb-3">
          {messages && messages.length > 0 ? (
            <ol className="flex flex-col gap-5">
              {messages.map((m) => (
                <li key={`${m.role}:${m.id}`}>
                  <div className="mb-1 font-[var(--font-mono)] text-[10px] uppercase tracking-[0.1em] text-[var(--color-ink-4)]">
                    {m.role}
                  </div>
                  <p
                    className={`text-pretty text-[14px] leading-relaxed ${m.role === "thought" ? "italic text-[var(--color-ink-3)]" : "text-[var(--color-ink-2)]"}`}
                  >
                    {m.text}
                  </p>
                </li>
              ))}
            </ol>
          ) : loading ? (
            <div className="flex flex-col gap-5">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex flex-col gap-2">
                  <div className="h-2 w-12 animate-pulse rounded bg-[var(--color-hair)]" />
                  <div className="h-3 w-11/12 animate-pulse rounded bg-[var(--color-hair)]" />
                  <div className="h-3 w-3/5 animate-pulse rounded bg-[var(--color-hair)]" />
                </div>
              ))}
            </div>
          ) : (
            <p className="py-16 text-center text-[13px] text-[var(--color-ink-3)]">
              No agent output was recorded.
            </p>
          )}
          {artifactData && artifactData.items.length > 0 ? (
            <section className="mt-8 border-t border-[var(--color-hair)] pt-5">
              <div className="font-[var(--font-mono)] text-[10px] uppercase tracking-[0.1em] text-[var(--color-ink-4)]">
                reusable output
              </div>
              <div className="mt-2 flex flex-col gap-1">
                {artifactData.items.map((entry) => {
                  const identity = `${entry.artifactId}:${entry.path}`;
                  return (
                    <div
                      key={identity}
                      className="flex items-center justify-between gap-3 rounded-lg px-2 py-2 hover:bg-[var(--color-bg)]"
                    >
                      <span className="min-w-0 truncate font-[var(--font-mono)] text-[12px] text-[var(--color-ink-3)]">
                        {entry.path}
                      </span>
                      {entry.brief ? (
                        <span className="shrink-0 font-[var(--font-mono)] text-[10px] text-[var(--color-ink-4)]">
                          kept
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => promote(entry)}
                          disabled={promoting !== null}
                          className="shrink-0 font-[var(--font-mono)] text-[10px] text-[var(--color-ink-3)] transition-colors hover:text-[var(--color-ink)] disabled:opacity-40"
                        >
                          {promoting === identity ? "keeping…" : "+ keep"}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
              {promotionError ? (
                <p className="mt-2 text-[12px]" style={{ color: "var(--color-crash)" }}>
                  {promotionError}
                </p>
              ) : null}
            </section>
          ) : null}
        </div>
        <footer className="px-7 pb-6 pt-3">
          <span className="font-[var(--font-mono)] text-[11px] text-[var(--color-ink-4)]">
            task lifecycle is read-only · credentials never leave the runtime · esc to close
          </span>
        </footer>
      </motion.div>
    </motion.div>
  );
};

// ── Delegate — the one thing you can start here. Intent first: the ask is the
// hero input; agent and repo are secondary. ─────────────────────────────────
const DelegateDialog: React.FC<{ onClose: () => void; onDone: () => void }> = ({
  onClose,
  onDone,
}) => {
  const [prompt, setPrompt] = useState("");
  const [agentType, setAgentType] = useState("demo");
  const [repo, setRepo] = useState("");
  const [selectedBriefIds, setSelectedBriefIds] = useState<string[]>([]);
  const [showBriefs, setShowBriefs] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { data: briefData } = useSWR<{ items: Brief[] }>("/briefs", fetcher);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = async () => {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/delegate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: prompt.trim(),
          agentType,
          repo: repo.trim(),
          kind: "run",
          briefIds: selectedBriefIds,
        }),
      });
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({ error: "Could not delegate." }));
        setError(error ?? "Could not delegate.");
        setBusy(false);
        return;
      }
      onDone();
    } catch {
      setError("Could not reach the control plane.");
      setBusy(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.16 }}
      onClick={onClose}
      className="fixed inset-0 z-[var(--z-backdrop)] flex items-end justify-center bg-black/60 p-4 sm:items-center sm:p-6"
    >
      <motion.div
        role="dialog"
        aria-modal
        initial={{ opacity: 0, y: 16, scale: 0.99 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 12 }}
        transition={{ duration: 0.22, ease: EASE }}
        onClick={(e) => e.stopPropagation()}
        className="z-[var(--z-modal)] w-full max-w-lg overflow-hidden rounded-3xl bg-[var(--color-raise)] p-7 shadow-[var(--shadow-modal)]"
      >
        <h2 className="text-[17px] font-semibold text-[var(--color-ink)]">Delegate work</h2>
        <p className="mt-1 text-[13px] text-[var(--color-ink-3)]">
          Describe the task. An agent picks it up; it shows up on your board.
        </p>

        <textarea
          autoFocus
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submit();
          }}
          rows={3}
          placeholder="e.g. Fix the failing auth tests and open a PR"
          className="mt-5 w-full resize-none rounded-xl bg-[var(--color-bg)] p-4 text-[15px] text-[var(--color-ink)] placeholder:text-[var(--color-ink-4)] focus:outline-none focus:ring-1 focus:ring-[var(--color-hair)]"
        />

        <div className="mt-4 flex flex-col gap-3 sm:flex-row">
          <label className="flex-1">
            <span className="font-[var(--font-mono)] text-[11px] uppercase tracking-[0.08em] text-[var(--color-ink-4)]">
              agent
            </span>
            <input
              value={agentType}
              onChange={(e) => setAgentType(e.target.value)}
              className="tnum mt-1 w-full rounded-lg bg-[var(--color-bg)] px-3 py-2 font-[var(--font-mono)] text-[13px] text-[var(--color-ink-2)] focus:outline-none focus:ring-1 focus:ring-[var(--color-hair)]"
            />
          </label>
          <label className="flex-[2]">
            <span className="font-[var(--font-mono)] text-[11px] uppercase tracking-[0.08em] text-[var(--color-ink-4)]">
              repository — optional
            </span>
            <input
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              placeholder="https://github.com/…"
              className="mt-1 w-full rounded-lg bg-[var(--color-bg)] px-3 py-2 font-[var(--font-mono)] text-[13px] text-[var(--color-ink-2)] placeholder:text-[var(--color-ink-4)] focus:outline-none focus:ring-1 focus:ring-[var(--color-hair)]"
            />
          </label>
        </div>

        {briefData && briefData.items.length > 0 ? (
          <div className="mt-4 border-t border-[var(--color-hair)] pt-3">
            <button
              type="button"
              onClick={() => setShowBriefs((value) => !value)}
              className="flex w-full items-center justify-between font-[var(--font-mono)] text-[11px] text-[var(--color-ink-3)]"
            >
              <span>
                prior briefs{selectedBriefIds.length > 0 ? ` · ${selectedBriefIds.length} selected` : ""}
              </span>
              <span>{showBriefs ? "▾" : "▸"}</span>
            </button>
            {showBriefs ? (
              <div className="mt-2 max-h-36 overflow-y-auto rounded-lg bg-[var(--color-bg)] p-1">
                {briefData.items.map((brief) => {
                  const selected = selectedBriefIds.includes(brief.id);
                  return (
                    <label
                      key={brief.id}
                      className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-[12px] text-[var(--color-ink-2)] hover:bg-[var(--color-raise)]"
                    >
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() =>
                          setSelectedBriefIds((current) =>
                            selected
                              ? current.filter((id) => id !== brief.id)
                              : [...current, brief.id],
                          )
                        }
                        className="accent-[var(--color-ink)]"
                      />
                      <span className="min-w-0 truncate">{brief.title}</span>
                    </label>
                  );
                })}
              </div>
            ) : null}
          </div>
        ) : null}

        {error ? (
          <p className="mt-4 text-[13px]" style={{ color: "var(--color-crash)" }}>
            {error}
          </p>
        ) : null}

        <div className="mt-6 flex items-center justify-between">
          <span className="font-[var(--font-mono)] text-[11px] text-[var(--color-ink-4)]">
            ⌘↵ to delegate · esc to cancel
          </span>
          <button
            type="button"
            onClick={submit}
            disabled={!prompt.trim() || busy}
            className="rounded-lg bg-[var(--color-ink)] px-4 py-2 text-[13px] font-medium text-[var(--color-bg)] transition-opacity duration-150 hover:opacity-90 disabled:opacity-40"
          >
            {busy ? "Delegating…" : "Delegate"}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
};

const App: React.FC = () => {
  const { data, isLoading, mutate } = useSWR<{ rows: BoardRow[]; lastClosedAt: string | null }>(
    "/board",
    fetcher,
    { refreshInterval: 5000 },
  );
  const liveStatus = useBoard((s) => s.liveStatus);
  const [open, setOpen] = useState<BoardRow | null>(null);
  const [showQuiet, setShowQuiet] = useState(false);
  const [delegating, setDelegating] = useState(false);
  useEffect(() => connectStream(), []);

  const rows = data?.rows ?? [];
  const { demands, running, done } = useMemo(() => {
    const demands: BoardRow[] = [];
    const running: BoardRow[] = [];
    const done: BoardRow[] = [];
    for (const row of rows) {
      const status = liveStatus[`${row.kind}:${row.id}`] ?? row.status;
      const c = classify(row.kind, status);
      if (NEEDS_HUMAN(c)) demands.push(row);
      else if (c === "running") running.push(row);
      else done.push(row);
    }
    return { demands, running, done };
    // biome-ignore lint/correctness/useExhaustiveDependencies: liveStatus regroups
  }, [rows, liveStatus]);

  const calm = demands.length === 0;
  const quietCount = running.length + done.length;
  const lastDelivered = ago(data?.lastClosedAt ?? null);

  return (
    <div className="mx-auto flex min-h-dvh max-w-xl flex-col px-6 py-14 sm:py-20">
      {/* Masthead — whisper-quiet; the verdict is the hero, not the brand. */}
      <div className="mb-14 flex items-center justify-between">
        <span className="font-[var(--font-mono)] text-[12px] tracking-[0.04em] text-[var(--color-ink-3)]">
          meanwhile
        </span>
        <button
          type="button"
          onClick={() => setDelegating(true)}
          className="font-[var(--font-mono)] text-[11px] tracking-[0.04em] text-[var(--color-ink-3)] transition-colors duration-150 hover:text-[var(--color-ink)]"
        >
          + delegate
        </button>
      </div>

      {/* ── The Verdict ── */}
      {isLoading ? (
        <div className="h-12 w-3/4 animate-pulse rounded-lg bg-[var(--color-raise)]" />
      ) : (
        <AnimatePresence mode="wait">
          {calm ? (
            <motion.div
              key="calm"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
            >
              <h1 className="text-balance text-[34px] font-semibold leading-[1.1] tracking-[-0.02em] text-[var(--color-ink)] sm:text-[40px]">
                Nothing needs you.
              </h1>
              <p className="mt-4 text-[15px] text-[var(--color-ink-3)]">
                {quietCount === 0
                  ? "No delegated work yet."
                  : `${quietCount} ${quietCount === 1 ? "task is" : "tasks are"} handling themselves.`}
              </p>
              {/* Trust anchor — "fine" is believable next to recent evidence. */}
              {lastDelivered ? (
                <p className="mt-2 font-[var(--font-mono)] text-[12px] text-[var(--color-ink-4)]">
                  last delivered · {lastDelivered}
                </p>
              ) : null}
            </motion.div>
          ) : (
            <motion.div
              key="alert"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
            >
              <h1 className="text-balance text-[30px] font-semibold leading-[1.12] tracking-[-0.02em] text-[var(--color-ink)] sm:text-[34px]">
                <span className="tnum" style={{ color: "var(--color-wait)" }}>
                  {demands.length}
                </span>{" "}
                {demands.length === 1 ? "task needs" : "tasks need"} your call.
              </h1>
              <div className="mt-8 flex flex-col gap-3">
                <AnimatePresence initial={false}>
                  {demands.map((row) => (
                    <Demand key={`${row.kind}:${row.id}`} row={row} onOpen={() => setOpen(row)} />
                  ))}
                </AnimatePresence>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      )}

      {/* ── Background inventory — collapsed by default, opt-in to read ── */}
      {!isLoading && quietCount > 0 ? (
        <div className="mt-auto pt-16">
          <button
            type="button"
            onClick={() => setShowQuiet((v) => !v)}
            className="flex items-center gap-2 font-[var(--font-mono)] text-[11px] uppercase tracking-[0.08em] text-[var(--color-ink-4)] transition-colors hover:text-[var(--color-ink-3)]"
          >
            <span>{showQuiet ? "▾" : "▸"}</span>
            <span>
              {running.length} running · {done.length} closed
            </span>
          </button>
          <AnimatePresence initial={false}>
            {showQuiet ? (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.24, ease: EASE }}
                style={{ overflow: "hidden" }}
              >
                <div className="mt-3 flex flex-col gap-0.5">
                  {[...running, ...done].map((row) => (
                    <QuietRow key={`${row.kind}:${row.id}`} row={row} onOpen={() => setOpen(row)} />
                  ))}
                </div>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      ) : null}

      <AnimatePresence>
        {open ? <Detail row={open} onClose={() => setOpen(null)} /> : null}
      </AnimatePresence>
      <AnimatePresence>
        {delegating ? (
          <DelegateDialog
            onClose={() => setDelegating(false)}
            onDone={() => {
              setDelegating(false);
              mutate();
            }}
          />
        ) : null}
      </AnimatePresence>
    </div>
  );
};

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
