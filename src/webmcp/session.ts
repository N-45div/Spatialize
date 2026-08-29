/**
 * A small observable store for everything the agent does on this page.
 *
 * Tool callbacks fire outside React's render cycle, so they publish here and
 * the UI subscribes with useSyncExternalStore. When a venue run is loaded the
 * store also mirrors itself to the backend's review ledger: proposals are
 * posted as they are made, decisions go through the server, and a fresh page
 * load is hydrated from what the server has. Without a run (the built-in
 * sample scene, or the backend unreachable) it stays local, and says so.
 */
import type { SpatialScene } from "../domain/spatial-scene";
import { postAudit, postProposal, type ReviewLedger } from "../lib/api";
import type { GateVerdict, GateViolation, SceneMutation } from "./gate";

export type CallOutcome = "answered" | "queued" | "refused" | "error";

export interface ToolCall {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  at: number;
  outcome: CallOutcome;
  summary: string;
}

/** Whether a proposal has reached the venue's record, or only this tab. */
export type Persistence = "local" | "saving" | "saved" | "failed";

export interface Proposal {
  id: string;
  mutation: SceneMutation;
  description: string;
  reason: string;
  at: number;
  impact: Extract<GateVerdict, { status: "accepted" }>["impact"];
  /**
   * The gate-validated scene this proposal would install. Present for
   * proposals made in this tab; null when hydrated from the server, which
   * holds the candidate itself and installs it on approval.
   */
  scene: SpatialScene | null;
  persisted: Persistence;
}

export interface Refusal {
  id: string;
  description: string;
  violations: GateViolation[];
  at: number;
}

/**
 * A report the venue team declined to accept.
 *
 * It is kept, deliberately. Visitors are a more reliable source on a building
 * than the building's own record — in the 2024 Euan's Guide survey, 77% of
 * disabled respondents found venue-published access information misleading or
 * wrong. A venue that could delete first-hand reports would be handing the
 * least accurate party a veto over the most accurate one, so rejection here
 * records a disagreement rather than erasing a claim.
 */
export interface Dispute {
  id: string;
  description: string;
  reason: string;
  /** What was proposed, so a route check can tell which doorway is contested. */
  mutation: SceneMutation | null;
  reportedAt: number;
  declinedAt: number;
}

export interface AgentSessionState {
  calls: ToolCall[];
  proposals: Proposal[];
  refusals: Refusal[];
  disputes: Dispute[];
}

interface SyncTarget {
  runId: string;
  sceneVersion: number;
}

const MAX_CALLS = 40;
const REASON_LIMIT = 240;

let state: AgentSessionState = { calls: [], proposals: [], refusals: [], disputes: [] };
let sync: SyncTarget | null = null;
const listeners = new Set<() => void>();

/**
 * Ids have to be unique across every visitor's browser, not just this tab,
 * because the server deduplicates proposals on them.
 */
function freshId(prefix: string) {
  const random =
    globalThis.crypto?.randomUUID?.().replaceAll("-", "") ??
    Math.random().toString(16).slice(2) + Date.now().toString(16);
  return `${prefix}_${random.slice(0, 12)}`;
}

function publish(next: AgentSessionState) {
  state = next;
  listeners.forEach((listener) => listener());
}

export function subscribeToAgentSession(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getAgentSession(): AgentSessionState {
  return state;
}

/** Point the store at a venue run, or at nothing for local-only operation. */
export function configureAgentSync(target: SyncTarget | null) {
  sync = target;
}

export function isAgentSessionSynced() {
  return sync !== null;
}

/** Replace local state with what the server holds for this run. */
export function hydrateAgentSession(ledger: ReviewLedger) {
  const proposals: Proposal[] = ledger.proposals
    .filter((item) => item.status === "pending")
    .map((item) => ({
      id: item.id,
      mutation: item.mutation as SceneMutation,
      description: item.description,
      reason: item.reason,
      at: Date.parse(item.proposedAt),
      impact: item.impact,
      scene: null,
      persisted: "saved"
    }));
  const disputes: Dispute[] = ledger.proposals
    .filter((item) => item.status === "declined")
    .map((item) => ({
      id: `dispute_${item.id}`,
      description: item.description,
      reason: item.reason,
      mutation: item.mutation as SceneMutation,
      reportedAt: Date.parse(item.proposedAt),
      declinedAt: Date.parse(item.decidedAt ?? item.proposedAt)
    }))
    .sort((a, b) => b.declinedAt - a.declinedAt);
  // The server keeps calls oldest-first; the page shows newest-first.
  const calls: ToolCall[] = ledger.calls
    .map((item) => ({ ...item, at: Date.parse(item.at) }))
    .reverse()
    .slice(0, MAX_CALLS);
  publish({ calls, proposals, refusals: [], disputes });
}

export function recordCall(
  tool: string,
  args: Record<string, unknown>,
  outcome: CallOutcome,
  summary: string
) {
  const call: ToolCall = { id: freshId("call"), tool, args, at: Date.now(), outcome, summary };
  publish({ ...state, calls: [call, ...state.calls].slice(0, MAX_CALLS) });
  if (sync) {
    void postAudit(sync.runId, [{ ...call, at: new Date(call.at).toISOString() }]).catch(
      () => undefined
    );
  }
  return call.id;
}

function patchProposal(id: string, patch: Partial<Proposal>) {
  publish({
    ...state,
    proposals: state.proposals.map((item) => (item.id === id ? { ...item, ...patch } : item))
  });
}

export function queueProposal(
  input: Omit<Proposal, "id" | "at" | "persisted">
): Proposal {
  const target = sync;
  const proposal: Proposal = {
    ...input,
    id: freshId("prop"),
    at: Date.now(),
    persisted: target ? "saving" : "local"
  };
  publish({ ...state, proposals: [...state.proposals, proposal] });

  if (target && proposal.scene) {
    void postProposal(target.runId, {
      id: proposal.id,
      description: proposal.description.slice(0, REASON_LIMIT),
      reason: proposal.reason.slice(0, REASON_LIMIT),
      mutation: proposal.mutation,
      baseSceneVersion: target.sceneVersion,
      candidateScene: proposal.scene
    })
      // The server's impact is computed from its own copy and is the one a
      // reviewer should see; the local figure was only a preview.
      .then((remote) => patchProposal(proposal.id, { persisted: "saved", impact: remote.impact }))
      .catch(() => patchProposal(proposal.id, { persisted: "failed" }));
  }
  return proposal;
}

export function recordRefusal(description: string, violations: GateViolation[]) {
  const refusal: Refusal = { id: freshId("ref"), description, violations, at: Date.now() };
  publish({ ...state, refusals: [refusal, ...state.refusals].slice(0, 10) });
  return refusal;
}

/** Drop a proposal from the local queue once the server (or the tab) has acted on it. */
export function resolveProposal(id: string) {
  publish({ ...state, proposals: state.proposals.filter((item) => item.id !== id) });
}

/** Decline a report without erasing it. The disagreement stays on the record. */
export function declineProposal(id: string) {
  const proposal = state.proposals.find((item) => item.id === id);
  if (!proposal) return null;
  const dispute: Dispute = {
    id: freshId("dispute"),
    description: proposal.description,
    reason: proposal.reason,
    mutation: proposal.mutation,
    reportedAt: proposal.at,
    declinedAt: Date.now()
  };
  publish({
    ...state,
    proposals: state.proposals.filter((item) => item.id !== id),
    disputes: [dispute, ...state.disputes]
  });
  return dispute;
}

export function findProposal(id: string) {
  return state.proposals.find((item) => item.id === id) ?? null;
}

export function dismissRefusal(id: string) {
  publish({ ...state, refusals: state.refusals.filter((item) => item.id !== id) });
}

export function clearAgentSession() {
  publish({ calls: [], proposals: [], refusals: [], disputes: [] });
}
