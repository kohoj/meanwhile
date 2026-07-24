# External two-person collaboration acceptance

This is the human product gate for Shared Project. It follows the automated
local and deployed system proofs; it does not replace either one.

The acceptance record is deliberately classified as
`external-two-person-attested`. Software can bind the deployed revision,
Project, reciprocal work IDs, observations, and two independent attestation
digests. It cannot prove that a person is human. The receipt therefore records
`humanIdentity: not_machine_verified` and must never be described as automated
human-identity proof.

## Required evidence set

One release claim requires all of the following from the same clean revision:

1. a verified local collaboration-system receipt;
2. a verified deployed two-Principal HTTPS receipt;
3. the applicable clean `remote-live-agent` receipt for every agent type used;
4. two participant attestations produced independently after the journey;
5. one combined external collaboration acceptance receipt linked to the
   deployed system receipt.

Receipts are integrity records, not product feedback notes. Keep interview
notes separately and never put credentials, browser cookies, repository
secrets, personal email addresses, or free-form agent output in an attestation.

## Setup

The operator must:

1. deploy one clean Git revision behind separate HTTPS control-plane and Board
   origins;
2. verify the local and deployed collaboration receipts against that full SHA;
3. provision two person Principals as active members of one Project;
4. issue and deliver one personal revocable credential to each participant
   through a secure channel;
5. configure a credentialed live ACP agent supported by a clean release receipt;
6. generate one shared acceptance ID with `crypto.randomUUID()`.

The participants must be different people. Each uses their own device or
network and personal credential. Screen sharing, one operator driving both
sessions, two browser profiles on one machine, or two credentials exercised by
one person do not satisfy this gate.

## Journey

Run the journey without coaching the Connected Onboarding, Lobby, Live Deck, or
Conversation Detail reading tasks.

1. Each participant signs in with their own linked GitHub/Google identity or
   personal installation credential, completes Connected Onboarding, connects a
   supported live agent, and selects the shared Project. Neither may share a
   browser session or agent credential.
2. Each enters Project Lobby, confirms the shared Project is present and an
   unauthorized fixture Project is absent, then enters its Live Deck.
3. From `New task`, each delegates a small real repository task with Codex,
   Claude Code, or Pi—not the demo agent. Acceptance opens the new Run's native
   Conversation Detail; each then returns to the Live Deck.
4. Starting when the Live Deck becomes visible, each finds the other person's
   card within fifteen seconds, names its delegator and condition, and opens it.
5. Each follows the source-backed transcript, reads the original ask and ordered
   conversation, and confirms that working notes and tool details fold without
   being confused with human or agent messages.
6. The first participant selects exact transcript text and creates one
   Project-visible annotation. The second sees the same annotation, source
   anchor, and progress-rail position. Both record the same Annotation and work
   IDs.
7. From that conversation, the first participant Relays one exact source moment
   to the second with a human-written note. The second sees waiting attention in
   the Lobby, `Passed to you` on the matching Deck card, opens the anchored
   source and note, and acknowledges it. The first sees `Acknowledged` on the
   original conversation. Both record the same Relay and source-work IDs.
8. Both confirm that the Board presents no lifecycle controls for the other
   person's work. The linked deployed-system receipt remains the authoritative
   negative API proof.
9. Each answers two product questions independently: “Was this clear enough to
   look away and return?” and “Would you use it again for shared work?” Both
   answers must be yes for an accepted receipt.

If any step fails, stop. Preserve the failure as product feedback, fix the
smallest owning contract, and repeat on a new clean revision. Do not edit an
attestation to turn a failed journey into an accepted one.

## Participant input

After completing the journey, each participant creates a private JSON input on
their own device. Use the same `acceptanceId`, origins, and Project ID, but a
fresh `attestationId`. `participantRole` is `first` or `second`.

```json
{
  "acceptanceId": "00000000-0000-4000-8000-000000000010",
  "participantRole": "first",
  "attestationId": "00000000-0000-4000-8000-000000000011",
  "observedAt": "2026-07-23T10:00:00.000Z",
  "attestedAt": "2026-07-23T10:04:00.000Z",
  "deployment": {
    "controlPlaneOrigin": "https://api.example.com/",
    "boardOrigin": "https://watch.example.com/",
    "projectId": "00000000-0000-4000-8000-000000000012"
  },
  "humanContext": {
    "distinctHuman": "attested",
    "personalCredential": "used",
    "separateDeviceOrNetwork": "attested"
  },
  "work": {
    "ownWorkId": "00000000-0000-4000-8000-000000000013",
    "ownAgentType": "codex",
    "executionClass": "credentialed-live-agent",
    "observedOtherWorkId": "00000000-0000-4000-8000-000000000014"
  },
  "experience": {
    "connectedOnboardingCompleted": true,
    "projectLobbyEntered": true,
    "ownTaskDelegatedFromBoard": true,
    "liveDeckUnderstood": true,
    "otherWorkVisible": true,
    "otherDelegatorIdentified": true,
    "otherConversationOpened": true,
    "liveTranscriptFollowed": true,
    "foldableDetailsUnderstood": true,
    "annotation": {
      "id": "00000000-0000-4000-8000-000000000016",
      "workId": "00000000-0000-4000-8000-000000000014",
      "relationship": "author",
      "sourceAnchorUnderstood": true,
      "progressRailUnderstood": true,
      "projectVisibilityUnderstood": true
    },
    "relay": {
      "id": "00000000-0000-4000-8000-000000000015",
      "workId": "00000000-0000-4000-8000-000000000014",
      "relationship": "author",
      "roomAttentionUnderstood": true,
      "sourceAnchorUnderstood": true,
      "acknowledged": true,
      "acknowledgementReceiptUnderstood": true
    },
    "noCrossMemberControlsPresented": true,
    "otherWorkFoundSeconds": 7,
    "trustedEnoughToLookAway": true,
    "wouldUseAgain": true
  },
  "verdict": "accepted"
}
```

The two participants' `ownWorkId` and `observedOtherWorkId` values must be
reciprocal. For `experience.annotation`, the first participant records
`relationship: author` and the second records `relationship: viewer`; both
record the same Annotation and source-work IDs. For `experience.relay`, the
first records `relationship: author` and the second records `relationship:
recipient`; both record the same Relay and source-work IDs and only attest after
the recipient acknowledgement and author receipt are visible.

Each participant creates a digest-bound attestation locally:

```console
bun run acceptance:external-collaboration:participant -- \
  participant-input.json \
  --output=participant-attestation.json
```

Transfer only the resulting attestation to the operator. It contains no
credential or browser-session material.

## Assemble and verify

The operator combines both attestations with the already verified deployed
system receipt:

```console
bun run acceptance:external-collaboration -- \
  --system-receipt=.proof/deployed-project-collaboration.json \
  --first-attestation=first-attestation.json \
  --second-attestation=second-attestation.json \
  --output=.proof/external-project-collaboration-acceptance.json

bun run acceptance:external-collaboration:verify -- \
  .proof/external-project-collaboration-acceptance.json \
  --system-receipt=.proof/deployed-project-collaboration.json \
  --commit="$(git rev-parse HEAD)"
```

Assembly fails closed when the deployed revision is dirty, origins or Project
do not match, attestation identities collapse, work references are not
reciprocal, the live agent is not supported, Live Deck discovery exceeds fifteen
seconds, Annotation or Relay identities disagree, either participant rejects
the experience, or a source digest has changed.

Passing verification permits the precise claim:

> Two participants independently attested that they completed the Shared
> Project journey on the linked clean deployed system and accepted it.

It does not permit claims that Meanwhile machine-verified their human identity,
that every deployment topology is proven, or that unrelated live-agent paths
are accepted.
