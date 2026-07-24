import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  annotationThreadForSequence,
  TranscriptMarkdown,
} from "../src/ui/conversation-detail";
import { ConnectionHealth } from "../src/ui/live-deck";

describe("Conversation Detail transcript addressing", () => {
  test("keeps readable Streamdown prose inside an addressable DOM boundary", () => {
    const rendered = renderToStaticMarkup(
      <TranscriptMarkdown
        text="The second exchange reuses an invalidated authorization code."
        className="transcript-copy"
        anchorCopy
      />,
    );

    expect(rendered).toContain('class="transcript-copy"');
    expect(rendered).toContain('data-anchor-copy=""');
    expect(rendered).toContain("The second exchange reuses an invalidated authorization code.");
    expect(rendered.indexOf('data-anchor-copy=""')).toBeLessThan(
      rendered.indexOf("The second exchange reuses an invalidated authorization code."),
    );
  });

  test("does not make rendered annotation copy recursively addressable", () => {
    const rendered = renderToStaticMarkup(
      <TranscriptMarkdown text="A human-authored note." className="annotation-copy" />,
    );

    expect(rendered).not.toContain("data-anchor-copy");
  });

  test("never labels a failed refresh path as healthy", () => {
    const healthy = renderToStaticMarkup(<ConnectionHealth state="healthy" />);
    const reconnecting = renderToStaticMarkup(<ConnectionHealth state="reconnecting" />);

    expect(healthy).toContain("Healthy");
    expect(reconnecting).toContain("Reconnecting");
    expect(reconnecting).not.toContain("Healthy");
    expect(reconnecting).toContain('role="status"');
  });

  test("keeps every note at one transcript anchor visible and prioritizes unresolved work", () => {
    const thread = annotationThreadForSequence(
      [
        { id: "resolved", anchor: { sequence: 8 }, resolvedAt: "2026-07-24T09:00:00.000Z" },
        { id: "open", anchor: { sequence: 8 }, resolvedAt: null },
        { id: "other", anchor: { sequence: 9 }, resolvedAt: null },
      ],
      8,
    );

    expect(thread.items.map((annotation) => annotation.id)).toEqual(["resolved", "open"]);
    expect(thread.active?.id).toBe("open");
  });
});
