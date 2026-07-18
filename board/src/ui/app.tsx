import { AnimatePresence, motion } from "framer-motion";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import useSWR from "swr";
import { type BoardRow, connectStream, useBoard } from "./store";
import "./styles.css";

const BUCKETS = [
  { key: "waiting", label: "Waiting on you", color: "var(--color-waiting)", icon: "◷" },
  { key: "recovering", label: "Recovering", color: "var(--color-recovering)", icon: "↻" },
  { key: "running", label: "Running", color: "var(--color-running)", icon: "●" },
  { key: "closed", label: "Closed", color: "var(--color-ok)", icon: "✓" },
] as const;

const STATUS_COLOR: Record<string, string> = {
  running: "var(--color-running)",
  provisioning: "var(--color-running)",
  queued: "var(--color-dim)",
  idle: "var(--color-waiting)",
  recovering: "var(--color-recovering)",
  continuity_lost: "var(--color-recovering)",
  succeeded: "var(--color-ok)",
  closed: "var(--color-ok)",
  failed: "var(--color-bad)",
  cancelled: "var(--color-dim)",
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

// Resolve a row's current bucket, preferring the live SSE status over the
// snapshot. Not a hook — read directly so it can run inside a filter callback.
const rowBucket = (row: BoardRow): string => {
  const live = useBoard.getState().liveStatus[`${row.kind}:${row.id}`];
  return live ? bucketFor(row.kind, live) : row.bucket;
};

const Dot: React.FC<{ status: string; live: boolean }> = ({ status, live }) => (
  <span
    style={{
      display: "inline-block",
      width: 10,
      height: 10,
      borderRadius: 999,
      background: STATUS_COLOR[status] ?? "var(--color-dim)",
      boxShadow: live ? `0 0 10px ${STATUS_COLOR[status] ?? "transparent"}` : "none",
    }}
  />
);

const Card: React.FC<{ row: BoardRow; onOpen: () => void }> = ({ row, onOpen }) => {
  const liveStatus = useBoard((s) => s.liveStatus[`${row.kind}:${row.id}`]);
  const status = liveStatus ?? row.status;
  return (
    <motion.button
      layout
      onClick={onOpen}
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.98 }}
      transition={{ type: "spring", stiffness: 260, damping: 26 }}
      style={{
        textAlign: "left",
        background: "var(--color-card)",
        border: "1px solid var(--color-border)",
        borderRadius: 14,
        padding: "18px 20px",
        cursor: "pointer",
        width: "100%",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
        <span style={{ fontWeight: 600, fontSize: 16 }}>{row.title || row.id}</span>
        <span style={{ display: "flex", alignItems: "center", gap: 8, whiteSpace: "nowrap" }}>
          <Dot status={status} live={row.live} />
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--color-dim)" }}>
            {status}
          </span>
        </span>
      </div>
      <div
        style={{ marginTop: 8, fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--color-faint)" }}
      >
        {row.kind} · {row.agentType}
      </div>
    </motion.button>
  );
};

const Detail: React.FC<{ row: BoardRow; onClose: () => void }> = ({ row, onClose }) => {
  const runTl = useBoard((s) => s.runTimelines[row.id]);
  const sessTl = useBoard((s) => s.sessionTimelines[row.id]);
  const messages = row.kind === "run" ? runTl?.messages : sessTl?.messages;
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        padding: 40,
      }}
    >
      <motion.div
        initial={{ scale: 0.96, y: 12 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.96, opacity: 0 }}
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--color-panel)",
          border: "1px solid var(--color-border)",
          borderRadius: 16,
          width: "min(820px, 100%)",
          maxHeight: "80vh",
          overflow: "auto",
          padding: 28,
        }}
      >
        <div style={{ fontSize: 20, fontWeight: 700 }}>{row.title || row.id}</div>
        <div
          style={{ marginTop: 6, fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--color-dim)" }}
        >
          {row.kind} · {row.agentType} · credentials shown as{" "}
          <span style={{ color: "var(--color-accent)" }}>mwk_••••••</span>
        </div>
        <div style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 12 }}>
          {messages && messages.length > 0 ? (
            messages.map((m) => (
              <div
                key={`${m.role}:${m.id}`}
                style={{
                  borderLeft: `2px solid var(--color-border)`,
                  paddingLeft: 14,
                  fontSize: 14,
                  color: m.role === "thought" ? "var(--color-dim)" : "var(--color-text)",
                }}
              >
                <div
                  style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--color-faint)" }}
                >
                  {m.role}
                </div>
                {m.text}
              </div>
            ))
          ) : (
            <div style={{ color: "var(--color-faint)" }}>
              No events yet, or this task is not being followed live.
            </div>
          )}
        </div>
        <div style={{ marginTop: 24, fontSize: 13, color: "var(--color-faint)" }}>
          Comments — coming soon (read-only board; you cannot control a run here).
        </div>
      </motion.div>
    </motion.div>
  );
};

const App: React.FC = () => {
  const { data } = useSWR<{ rows: BoardRow[]; capped: boolean }>("/board", fetcher, {
    refreshInterval: 5000,
  });
  const [open, setOpen] = useState<BoardRow | null>(null);
  useEffect(() => connectStream(), []);
  const rows = data?.rows ?? [];

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: "40px 32px" }}>
      <header style={{ display: "flex", alignItems: "baseline", gap: 14, marginBottom: 4 }}>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontWeight: 700,
            fontSize: 20,
            color: "var(--color-accent)",
          }}
        >
          meanwhile
        </span>
        <span style={{ color: "var(--color-dim)", fontFamily: "var(--font-mono)", fontSize: 14 }}>
          waiting for — delegated work
        </span>
      </header>
      <div style={{ height: 1, background: "var(--color-border)", margin: "16px 0 32px" }} />
      <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
        {BUCKETS.map((bucket) => {
          const inBucket = rows.filter((r) => rowBucket(r) === bucket.key);
          if (inBucket.length === 0) return null;
          return (
            <section key={bucket.key}>
              <h2
                style={{
                  fontSize: 13,
                  fontFamily: "var(--font-mono)",
                  color: bucket.color,
                  textTransform: "uppercase",
                  letterSpacing: 1,
                  marginBottom: 12,
                }}
              >
                {bucket.icon} {bucket.label} · {inBucket.length}
              </h2>
              <motion.div layout style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <AnimatePresence>
                  {inBucket.map((row) => (
                    <Card key={`${row.kind}:${row.id}`} row={row} onOpen={() => setOpen(row)} />
                  ))}
                </AnimatePresence>
              </motion.div>
            </section>
          );
        })}
        {rows.length === 0 ? (
          <div style={{ color: "var(--color-faint)", textAlign: "center", padding: 60 }}>
            No delegated work yet.
          </div>
        ) : null}
      </div>
      <AnimatePresence>
        {open ? <Detail row={open} onClose={() => setOpen(null)} /> : null}
      </AnimatePresence>
    </div>
  );
};

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
