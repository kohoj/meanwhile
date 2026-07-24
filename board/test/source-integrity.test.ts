import { expect, test } from "bun:test";

const productionSurfaceFiles = [
  "../src/ui/app.tsx",
  "../src/ui/live-deck.tsx",
  "../src/ui/conversation-detail.tsx",
] as const;

test("production collaboration surfaces never recognize preview identities", async () => {
  for (const relativePath of productionSurfaceFiles) {
    const source = await Bun.file(new URL(relativePath, import.meta.url)).text();
    expect(source).not.toContain("00000000-0000-4000-8000-000000000001");
    expect(source).not.toContain("DEMO_PREVIEWS");
    expect(source).not.toContain("deterministicDemo");
  }
});

test("Conversation Detail keeps the selected option 3 composition as a source-locked contract", async () => {
  const styles = await Bun.file(new URL("../src/ui/styles.css", import.meta.url)).text();
  const detail = await Bun.file(new URL("../src/ui/conversation-detail.tsx", import.meta.url)).text();

  const shell = styles.match(/\.conversation-detail-shell \{(?<body>[\s\S]*?)\n\}/)?.groups?.body;
  const main = styles.match(/\.cd-main \{(?<body>[\s\S]*?)\n\}/)?.groups?.body;
  const signal = styles.match(/\.cd-signal-field \{(?<body>[\s\S]*?)\n\}/)?.groups?.body;

  expect(shell).toContain("min-height: 1058px");
  expect(shell).toContain("grid-template-rows: 81px 121px minmax(0, 1fr) 197px");
  expect(main).toContain("grid-template-columns: 263fr 689fr 480fr");
  expect(signal).toContain("grid-template-columns: repeat(16, minmax(0, 1fr))");
  expect(signal).toContain("grid-template-rows: repeat(11, minmax(0, 1fr))");
  expect(signal).not.toContain("background-image");
  expect(detail).toContain("tones.map((tone, index)");
  expect(styles).toContain("repeat(var(--cd-index-count), minmax(57px, 1fr))");
  expect(styles).toContain(".cd-anchor-highlight");
  expect(styles).toContain(".cd-anchor-wire-turn");
  expect(detail).toContain("const transcriptObserver = new MutationObserver(schedule)");
  expect(detail).toContain('label: agent ? (followsWork ? "Answer" : "Acknowledged") : "Follow-up"');
  expect(detail).toContain("<PresenceRail project={project} visiblePeople={visiblePeople} relays={recentRelays} />");
});
