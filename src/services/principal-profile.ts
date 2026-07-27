import type { ExternalIdentity, Principal, PrincipalSummary } from "../domain"

const preferredIdentity = (identities: readonly ExternalIdentity[]): ExternalIdentity | undefined =>
  identities.find((identity) => identity.provider === "github" && identity.revokedAt === null) ??
  identities.find((identity) => identity.revokedAt === null)

/**
 * Projects the current provider profile without moving any authorization into
 * the provider. Principal identity remains stable; name and portrait are only
 * human-facing presentation facts.
 */
export const presentPrincipalProfile = <PrincipalType extends PrincipalSummary>(
  principal: PrincipalType,
  identities: readonly ExternalIdentity[],
): PrincipalType => {
  const identity = preferredIdentity(identities)
  if (identity === undefined) return principal
  return {
    ...principal,
    displayName: identity.displayName ?? identity.login ?? principal.displayName,
    avatarUrl: identity.avatarUrl,
  }
}

export const presentPrincipal = (
  principal: Principal,
  identities: readonly ExternalIdentity[],
): Principal => presentPrincipalProfile(principal, identities)
