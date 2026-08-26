/**
 * A tiny observable store for everything the agent does on this page.
 *
 * Tool callbacks fire outside React's render cycle, so they publish here and the
 * UI subscribes with useSyncExternalStore. Two things are tracked: the running
 * log of tool calls (so a person can watch their agent work) and the queue of
 * proposed scene changes waiting on human approval.
 */
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

export interface Proposal {
  id: string;
  mutation: SceneMutation;
  description: string;
  reason: string;
  at: number;
  impact: Extract<GateVerdict, { status: "accepted" }>["impact"];
  /** The already-validated scene this proposal would install. */
  scene: Extract<GateVerdict, { status: "accepted" }>["scene"];
}

export interface Refusal {
  id: string;
  description: string;
  violations: GateViolation[];
  at: number;
}

export interface AgentSessionState {
  calls: ToolCall[];
  proposals: Proposal[];
  refusals: Refusal[];
}

const MAX_CALLS = 40;

let state: AgentSessionState = { calls: [], proposals: [], refusals: [] };
const listeners = new Set<() => void>();
let counter = 0;

function nextId(prefix: string) {
  counter += 1;
  return `${prefix}_${counter}`;
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

export function recordCall(
  tool: string,
  args: Record<string, unknown>,
  outcome: CallOutcome,
  summary: string
) {
  const call: ToolCall = { id: nextId("call"), tool, args, at: Date.now(), outcome, summary };
  publish({ ...state, calls: [call, ...state.calls].slice(0, MAX_CALLS) });
  return call.id;
}

export function queueProposal(
  input: Omit<Proposal, "id" | "at">
): Proposal {
  const proposal: Proposal = { ...input, id: nextId("prop"), at: Date.now() };
  publish({ ...state, proposals: [...state.proposals, proposal] });
  return proposal;
}

export function recordRefusal(description: string, violations: GateViolation[]) {
  const refusal: Refusal = { id: nextId("ref"), description, violations, at: Date.now() };
  publish({ ...state, refusals: [refusal, ...state.refusals].slice(0, 10) });
  return refusal;
}

export function resolveProposal(id: string) {
  publish({ ...state, proposals: state.proposals.filter((item) => item.id !== id) });
}

export function findProposal(id: string) {
  return state.proposals.find((item) => item.id === id) ?? null;
}

export function dismissRefusal(id: string) {
  publish({ ...state, refusals: state.refusals.filter((item) => item.id !== id) });
}

export function clearAgentSession() {
  publish({ calls: [], proposals: [], refusals: [] });
}
