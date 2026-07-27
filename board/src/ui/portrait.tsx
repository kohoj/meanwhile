import type { Principal } from "@kohoz/meanwhile/contracts";
import { Robot } from "@phosphor-icons/react";

export type PortraitIdentity = Pick<Principal, "id" | "displayName" | "avatarUrl">;

const initials = (displayName: string): string => {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return parts.slice(0, 2).map((part) => part[0]?.toLocaleUpperCase() ?? "").join("");
};

/**
 * One honest human portrait boundary. Provider imagery is rendered as supplied;
 * an unlinked Principal gets a neutral monogram, never an invented person.
 */
export const PersonPortrait = ({
  identity,
  className,
}: {
  readonly identity: PortraitIdentity;
  readonly className: string;
}) => (
  <span className={`person-portrait ${className}`} aria-hidden="true">
    {identity.avatarUrl ? (
      <img
        src={identity.avatarUrl}
        alt=""
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
      />
    ) : (
      <span className="person-portrait-fallback">{initials(identity.displayName)}</span>
    )}
  </span>
);

/** Agents are represented as agents, never by a fabricated human portrait. */
export const AgentPortrait = ({ className }: { readonly className: string }) => (
  <span className={`agent-portrait ${className}`} aria-hidden="true">
    <Robot weight="light" />
  </span>
);
