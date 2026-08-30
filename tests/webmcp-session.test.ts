import { beforeEach, describe, expect, it } from "vitest";
import { sampleScene } from "../src/data/sample-scene";
import type { ReviewLedger } from "../src/lib/api";
import {
  clearAgentSession,
  configureAgentSync,
  getAgentSession,
  hydrateAgentSession,
  queueProposal
} from "../src/webmcp/session";

const impact = { lostStepFree: [], gainedStepFree: [], newlyBlockedDoors: [] };

function ledger(overrides: Partial<ReviewLedger> = {}): ReviewLedger {
  return {
    runId: "run_test",
    proposals: [
      {
        id: "prop_pending1",
        description: 'Mark "Quiet-room doorway" as not step-free',
        reason: "a step was installed",
        mutation: { kind: "set-door-accessible", doorId: "door-corridor-quiet", accessible: false },
        status: "pending",
        baseSceneVersion: 1,
        impact: { ...impact, lostStepFree: ["Quiet room"] },
        proposedAt: "2026-08-27T10:00:00Z",
        decidedAt: null,
        resultingSceneVersion: null,
        candidateScene: { key: "k1", sha256: "a".repeat(64) }
      },
      {
        id: "prop_declined1",
        description: 'Rename room "Quiet room" to "Sensory room"',
        reason: "the sign says Sensory Room",
        mutation: { kind: "relabel" },
        status: "declined",
        baseSceneVersion: 1,
        impact,
        proposedAt: "2026-08-26T09:00:00Z",
        decidedAt: "2026-08-26T12:00:00Z",
        resultingSceneVersion: null,
        candidateScene: { key: "k2", sha256: "b".repeat(64) }
      },
      {
        id: "prop_approved1",
        description: "Add restroom",
        reason: "found one",
        mutation: { kind: "add-landmark" },
        status: "approved",
        baseSceneVersion: 1,
        impact,
        proposedAt: "2026-08-25T09:00:00Z",
        decidedAt: "2026-08-25T10:00:00Z",
        resultingSceneVersion: 2,
        candidateScene: { key: "k3", sha256: "c".repeat(64) }
      }
    ],
    calls: [
      { id: "call_a", tool: "get_venue_overview", args: {}, outcome: "answered", summary: "first", at: "2026-08-27T09:00:00Z" },
      { id: "call_b", tool: "check_accessibility", args: {}, outcome: "answered", summary: "second", at: "2026-08-27T09:01:00Z" }
    ],
    ...overrides
  };
}

beforeEach(() => {
  configureAgentSync(null);
  clearAgentSession();
});

describe("hydrating from the venue record", () => {
  it("puts pending proposals in the queue and declined ones among the disputes", () => {
    hydrateAgentSession(ledger());

    const { proposals, disputes } = getAgentSession();
    expect(proposals.map((item) => item.id)).toEqual(["prop_pending1"]);
    expect(proposals[0].persisted).toBe("saved");
    expect(proposals[0].scene).toBeNull();
    expect(proposals[0].impact.lostStepFree).toEqual(["Quiet room"]);
    expect(disputes).toHaveLength(1);
    expect(disputes[0].reason).toBe("the sign says Sensory Room");
  });

  it("leaves approved proposals out — they are already the scene", () => {
    hydrateAgentSession(ledger());

    const ids = [...getAgentSession().proposals, ...getAgentSession().disputes].map((item) => item.id);
    expect(ids.some((id) => id.includes("approved"))).toBe(false);
  });

  it("shows the newest tool call first", () => {
    hydrateAgentSession(ledger());

    expect(getAgentSession().calls.map((item) => item.summary)).toEqual(["second", "first"]);
  });

  it("keeps a proposal the tab made that the server has not caught up with", () => {
    // The tools are live before the ledger fetch returns; an agent that acts
    // in that window must not have its work wiped when hydration lands.
    const local = queueProposal({
      mutation: { kind: "relabel", entityKind: "room", entityId: "quiet", label: "x", reason: "y" },
      description: "made before hydration landed",
      reason: "y",
      impact,
      scene: structuredClone(sampleScene)
    });

    hydrateAgentSession(ledger());

    const ids = getAgentSession().proposals.map((item) => item.id);
    expect(ids).toContain("prop_pending1");
    expect(ids).toContain(local.id);
  });

  it("drops a local proposal once the server knows about it", () => {
    const local = queueProposal({
      mutation: { kind: "relabel", entityKind: "room", entityId: "quiet", label: "x", reason: "y" },
      description: "now declined on the server",
      reason: "y",
      impact,
      scene: structuredClone(sampleScene)
    });
    const served = ledger();
    served.proposals.push({ ...served.proposals[1], id: local.id, status: "declined" });

    hydrateAgentSession(served);

    expect(getAgentSession().proposals.map((item) => item.id)).not.toContain(local.id);
    expect(getAgentSession().disputes.some((item) => item.id === `dispute_${local.id}`)).toBe(true);
  });
});

describe("proposal identity", () => {
  it("gives every proposal an id unique enough to share a server with other visitors", () => {
    const ids = new Set<string>();
    for (let index = 0; index < 50; index += 1) {
      ids.add(
        queueProposal({
          mutation: { kind: "relabel", entityKind: "room", entityId: "quiet", label: "x", reason: "y" },
          description: "d",
          reason: "y",
          impact,
          scene: structuredClone(sampleScene)
        }).id
      );
    }
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^prop_[a-f0-9]{12}$/);
  });

  it("marks a proposal as local when no venue record is loaded", () => {
    const proposal = queueProposal({
      mutation: { kind: "relabel", entityKind: "room", entityId: "quiet", label: "x", reason: "y" },
      description: "d",
      reason: "y",
      impact,
      scene: structuredClone(sampleScene)
    });

    expect(proposal.persisted).toBe("local");
  });
});
