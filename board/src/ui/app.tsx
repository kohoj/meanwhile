import { AnimatePresence, motion } from "motion/react";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import useSWR from "swr";
import { type BoardRow, connectStream, useBoard } from "./store";
import "./styles.css";

// ── Status vocabulary ──────────────────────────────────────────────────────
// Each bucket carries a color AND a glyph AND a label — color is never the sole
// signal (accessibility). Buckets are ordered by "needs your attention first".
const BUCKETS = [
  { key: "waiting", label: "Waiting on you", tone: "var(--color-waiting)" },
  { key: "recovering", label: "Recovering", tone: "var(--color-recovering)" },
  { key: "running", label: "Running", tone: "var(--color-running)" },
  { key: "closed", label: "Closed", tone: "var(--color-ink-3)" },
] as const;

const STATUS_TONE: Record<string, string> = {
  running: "var(--color-running)",
  provisioning: "var(--color-running)",
  queued: "var(--color-ink-3)",
  idle: "var(--color-waiting)",
  closing: "var(--color-running)",
  continuity_lost: "var(--color-recovering)",
  succeeded: "var(--color-ok)",
  closed: "var(--color-ok)",
  failed: "var(--color-bad)",
  cancelled: "var(--color-ink-3)",
  timed_out: "var(--color-bad)",
};

const fetcher = (url: string) => fetch(url).then((r) => r.json());

const bucketFor = (kind: string, status: string): string => {
  if (kind === "run") {
    if (["succeeded", "failed", "cancelled", "timed_out"].includes(status)) return "closed";
    return "running";
  }
  if (status === "continuity_lost") return "recovering";
  if (["closed", "failed"].includes(status)) return "closed";
  if (status === "idle") return "waiting";
  return "running";
};

const rowBucket = (row: BoardRow): string => {
  const live = useBoard.getState().liveStatus[`${row.kind}:${row.id}`];
  return live ? bucketFor(row.kind, live) : row.bucket;
};

// ── Status dot ──────────────────────────────────────────────────────────────
// A live task's dot breathes; a settled one is still. Only opacity animates.
const Dot: React.FC<{ status: string; live: boolean }> = ({ status, live }) => {
  const tone = STATUS_TONE[status] ?? "var(--color-ink-3)";
  return (
    <span className="relative inline-flex size-2.5 items-center justify-center">
      {live ? (
        <motion.span
          className="absolute inline-flex size-2.5 rounded-full"
          style={{ backgroundColor: tone }}
          animate={{ opacity: [0.35, 0.15, 0.35] }}
          transition={{ duration: 2, repeat: Number.POSITIVE_INFINITY, ease: "easeInOut" }}
        />
      ) : null}
      <span className="inline-flex size-1.5 rounded-full" style={{ backgroundColor: tone }} />
    </span>
  );
};

// ── Task card ─────────────────────────────────────────────────────────────
const Card: React.FC<{ row: BoardRow; index: number; onOpen: () => void }> = ({
  row,
  index,
  onOpen,
}) => {
  const liveStatus = useBoard((s) => s.liveStatus[`${row.kind}:${row.id}`]);
  const status = liveStatus ?? row.status;
  const tone = STATUS_TONE[status] ?? "var(--color-ink-3)";
  return (
    <motion.button
      type="button"
      onClick={onOpen}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.18, ease: "easeOut", delay: Math.min(index * 0.04, 0.24) }}
      whileTap={{ scale: 0.99 }}
      className="group flex w-full items-center gap-4 rounded-xl bg-[var(--color-surface)] p-4 text-left shadow-[var(--shadow-card)] ring-1 ring-inset ring-[var(--color-line-soft)] transition-shadow duration-150 hover:shadow-[var(--shadow-lift)]"
    >
      <span
        aria-hidden
        className="h-9 w-0.5 shrink-0 rounded-full"
        style={{ backgroundColor: tone }}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] font-medium text-pretty text-[var(--color-ink)]">
          {row.title || row.id}
        </span>
        <span className="mt-1 block truncate font-[var(--font-mono)] text-xs text-[var(--color-ink-3)]">
          {row.kind} · {row.agentType}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-2">
        <Dot status={status} live={row.live} />
        <span className="tnum font-[var(--font-mono)] text-xs text-[var(--color-ink-2)]">
          {status}
        </span>
      </span>
    </motion.button>
  );
};

// ── Task detail ─────────────────────────────────────────────────────────────
const Detail: React.FC<{ row: BoardRow; onClose: () => void }> = ({ row, onClose }) => {
  const runTl = useBoard((s) => s.runTimelines[row.id]);
  const sessTl = useBoard((s) => s.sessionTimelines[row.id]);
  const loadHistory = useBoard((s) => s.loadHistory);
  const messages = row.kind === "run" ? runTl?.messages : sessTl?.messages;
  const [loading, setLoading] = useState(!messages);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  // A task fan-in never followed (typically closed) has no live timeline —
  // fetch its full history on open.
  useEffect(() => {
    let alive = true;
    if (!messages || messages.length === 0) {
      setLoading(true);
      loadHistory(row.kind, row.id).finally(() => alive && setLoading(false));
    } else {
      setLoading(false);
    }
    return () => {
      alive = false;
    };
  }, [row.kind, row.id, loadHistory, messages]);
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15, ease: "easeOut" }}
      onClick={onClose}
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-6"
    >
      <motion.div
        role="dialog"
        aria-modal
        initial={{ opacity: 0, scale: 0.97, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.98, y: 6 }}
        transition={{ duration: 0.18, ease: "easeOut" }}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[80dvh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-[var(--color-surface)] shadow-[var(--shadow-modal)] ring-1 ring-inset ring-[var(--color-line)]"
      >
        <header className="border-b border-[var(--color-line-soft)] p-6">
          <h2 className="text-lg font-semibold text-balance text-[var(--color-ink)]">
            {row.title || row.id}
          </h2>
          <p className="mt-1.5 font-[var(--font-mono)] text-xs text-[var(--color-ink-3)]">
            {row.kind} · {row.agentType} · credentials shown as{" "}
            <span className="text-[var(--color-ink-2)]">mwk_••••••</span>
          </p>
        </header>
        <div className="flex-1 overflow-y-auto p-6">
          {messages && messages.length > 0 ? (
            <ol className="flex flex-col gap-4">
              {messages.map((m) => (
                <li
                  key={`${m.role}:${m.id}`}
                  className="border-l-2 border-[var(--color-line)] pl-3.5"
                >
                  <span className="font-[var(--font-mono)] text-[11px] uppercase tracking-wide text-[var(--color-ink-3)]">
                    {m.role}
                  </span>
                  <p
                    className={`mt-0.5 text-sm text-pretty ${m.role === "thought" ? "text-[var(--color-ink-3)] italic" : "text-[var(--color-ink)]"}`}
                  >
                    {m.text}
                  </p>
                </li>
              ))}
            </ol>
          ) : loading ? (
            <div className="flex flex-col gap-3">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex flex-col gap-1.5 border-l-2 border-[var(--color-line)] pl-3.5">
                  <div className="h-2.5 w-16 animate-pulse rounded bg-[var(--color-surface-2)]" />
                  <div className="h-3.5 w-3/4 animate-pulse rounded bg-[var(--color-surface-2)]" />
                </div>
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2 py-14 text-center">
              <p className="text-sm text-[var(--color-ink-2)]">No output recorded</p>
              <p className="text-xs text-[var(--color-ink-3)]">
                This task didn't emit any agent messages.
              </p>
            </div>
          )}
        </div>
        <footer className="border-t border-[var(--color-line-soft)] px-6 py-3.5">
          <span className="text-xs text-[var(--color-ink-3)]">
            Read-only — you can watch delegated work here, not steer it. Comments coming soon.
          </span>
        </footer>
      </motion.div>
    </motion.div>
  );
};

// ── Board ───────────────────────────────────────────────────────────────────
const App: React.FC = () => {
  const { data, isLoading } = useSWR<{ rows: BoardRow[]; capped: boolean }>("/board", fetcher, {
    refreshInterval: 5000,
  });
  const [open, setOpen] = useState<BoardRow | null>(null);
  useEffect(() => connectStream(), []);
  const rows = data?.rows ?? [];
  const activeCount = rows.filter((r) => r.live).length;

  return (
    <div className="mx-auto min-h-dvh max-w-3xl px-6 py-10">
      <header className="mb-8">
        <div className="flex items-baseline gap-3">
          <span className="font-[var(--font-mono)] text-base font-semibold text-[var(--color-ink)]">
            meanwhile
          </span>
          <span className="font-[var(--font-mono)] text-sm text-[var(--color-ink-3)]">
            waiting for
          </span>
        </div>
        <p className="mt-1.5 text-sm text-pretty text-[var(--color-ink-2)]">
          Work you delegated to AI agents.{" "}
          <span className="tnum text-[var(--color-ink-3)]">{activeCount} active</span>.
        </p>
      </header>

      {isLoading ? (
        <div className="flex flex-col gap-2.5">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-[68px] animate-pulse rounded-xl bg-[var(--color-surface)] ring-1 ring-inset ring-[var(--color-line-soft)]"
            />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center gap-1.5 rounded-xl border border-dashed border-[var(--color-line)] py-20 text-center">
          <p className="text-sm text-[var(--color-ink-2)]">Nothing delegated yet</p>
          <p className="text-xs text-[var(--color-ink-3)]">
            Runs and sessions will appear here as they start.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-7">
          {BUCKETS.map((bucket) => {
            const inBucket = rows.filter((r) => rowBucket(r) === bucket.key);
            if (inBucket.length === 0) return null;
            return (
              <section key={bucket.key}>
                <div className="mb-2.5 flex items-center gap-2 px-1">
                  <span className="size-1.5 rounded-full" style={{ backgroundColor: bucket.tone }} />
                  <h2 className="font-[var(--font-mono)] text-[11px] font-medium uppercase tracking-wide text-[var(--color-ink-2)]">
                    {bucket.label}
                  </h2>
                  <span className="tnum font-[var(--font-mono)] text-[11px] text-[var(--color-ink-3)]">
                    {inBucket.length}
                  </span>
                </div>
                <div className="flex flex-col gap-2.5">
                  <AnimatePresence mode="popLayout">
                    {inBucket.map((row, i) => (
                      <Card
                        key={`${row.kind}:${row.id}`}
                        row={row}
                        index={i}
                        onOpen={() => setOpen(row)}
                      />
                    ))}
                  </AnimatePresence>
                </div>
              </section>
            );
          })}
        </div>
      )}

      <AnimatePresence>{open ? <Detail row={open} onClose={() => setOpen(null)} /> : null}</AnimatePresence>
    </div>
  );
};

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
