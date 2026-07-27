export type ConversationKind = "run" | "session" | "mirror";

export interface ConversationRef {
  readonly kind: ConversationKind;
  readonly id: string;
}

export type BoardRoute =
  | { readonly surface: "lobby" }
  | {
      readonly surface: "project";
      readonly projectId: string;
      readonly conversation: ConversationRef | null;
    };

const identifier = /^[A-Za-z0-9_-]+$/;

const decodedIdentifier = (value: string): string | null => {
  try {
    const decoded = decodeURIComponent(value);
    return identifier.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
};

/**
 * The browser location is a presentation address, never authorization evidence.
 * Unknown and malformed locations collapse to the Lobby without retaining input.
 */
export const parseBoardRoute = (pathname: string): BoardRoute => {
  if (pathname === "/" || pathname === "/lobby" || pathname === "/lobby/") {
    return { surface: "lobby" };
  }
  const match = pathname.match(
    /^\/projects\/([^/]+)(?:\/conversations\/(run|session|mirror)\/([^/]+))?\/?$/,
  );
  if (match === null) return { surface: "lobby" };
  const projectId = decodedIdentifier(match[1] ?? "");
  if (projectId === null) return { surface: "lobby" };
  if (match[2] === undefined) {
    return { surface: "project", projectId, conversation: null };
  }
  const id = decodedIdentifier(match[3] ?? "");
  if (id === null) return { surface: "lobby" };
  return {
    surface: "project",
    projectId,
    conversation: { kind: match[2] as ConversationKind, id },
  };
};

export const boardRoutePath = (route: BoardRoute): string => {
  if (route.surface === "lobby") return "/";
  const project = encodeURIComponent(route.projectId);
  if (route.conversation === null) return `/projects/${project}`;
  return `/projects/${project}/conversations/${route.conversation.kind}/${encodeURIComponent(route.conversation.id)}`;
};

export const resolveConversationRef = <
  Row extends { readonly kind: ConversationKind; readonly id: string },
>(rows: readonly Row[], ref: ConversationRef | null): Row | null => {
  if (ref === null) return null;
  return rows.find((row) => row.kind === ref.kind && row.id === ref.id) ?? null;
};
