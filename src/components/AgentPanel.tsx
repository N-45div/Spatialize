import { useSyncExternalStore } from "react";
import {
  dismissRefusal,
  getAgentSession,
  subscribeToAgentSession,
  type Proposal
} from "../webmcp/session";
import type { WebMCPStatus } from "../webmcp/useWebMCP";

const OUTCOME_LABEL = {
  answered: "answered",
  queued: "queued",
  refused: "refused",
  error: "error"
} as const;

function ago(timestamp: number) {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.round(seconds / 60)}m ago`;
}

function impactLine(proposal: Proposal) {
  const { lostStepFree, gainedStepFree } = proposal.impact;
  if (lostStepFree.length) return `Removes step-free access to ${lostStepFree.join(", ")}`;
  if (gainedStepFree.length) return `Restores step-free access to ${gainedStepFree.join(", ")}`;
  return "No change to step-free reachability";
}

export function AgentPanel({
  status,
  onApprove,
  onReject
}: {
  status: WebMCPStatus;
  onApprove: (proposal: Proposal) => void;
  onReject: (id: string) => void;
}) {
  const session = useSyncExternalStore(subscribeToAgentSession, getAgentSession, getAgentSession);

  const state = !status.supported
    ? "off"
    : status.error
      ? "error"
      : status.registered.length
        ? "live"
        : "pending";

  return (
    <div className={`agent-panel ${state}`} data-tour="agent">
      <div className="agent-head">
        <div>
          <span className="agent-dot" />
          Agent tools
        </div>
        <span className="agent-count">
          {state === "live" ? `${status.registered.length} registered` : null}
          {state === "off" ? "browser not agent-ready" : null}
          {state === "pending" ? "registering…" : null}
          {state === "error" ? "registration failed" : null}
        </span>
      </div>

      {state === "off" && (
        <p className="agent-hint">
          This page publishes its tools with WebMCP. Open it in the ChatGPT app browser, or in
          Chrome 149+ with <code>chrome://flags/#enable-webmcp-testing</code> enabled, and your
          agent can route, audit and correct this venue directly.
        </p>
      )}

      {state === "error" && <p className="agent-hint error">{status.error}</p>}

      {state === "live" && !session.calls.length && (
        <p className="agent-hint">
          Ready. Ask your agent something like <em>“is the quiet room step-free from the
          entrance?”</em> or tell it <em>“the quiet-room doorway has a step now”</em>.
        </p>
      )}

      {session.proposals.length > 0 && (
        <>
          <div className="section-label">
            Awaiting your approval ({session.proposals.length})
          </div>
          {session.proposals.map((proposal) => (
            <div className="proposal-card" key={proposal.id}>
              <strong>{proposal.description}</strong>
              <small className="proposal-reason">“{proposal.reason}”</small>
              <small className="proposal-impact">{impactLine(proposal)}</small>
              <div className="proposal-actions">
                <button className="approve" onClick={() => onApprove(proposal)}>
                  Approve
                </button>
                <button className="reject" onClick={() => onReject(proposal.id)}>
                  Reject
                </button>
              </div>
            </div>
          ))}
        </>
      )}

      {session.refusals.length > 0 && (
        <>
          <div className="section-label">Blocked by the topology gate</div>
          {session.refusals.map((refusal) => (
            <div className="refusal-card" key={refusal.id}>
              <div className="refusal-head">
                <strong>{refusal.description}</strong>
                <button onClick={() => dismissRefusal(refusal.id)} aria-label="Dismiss">
                  ×
                </button>
              </div>
              <ul>
                {refusal.violations.slice(0, 3).map((violation, index) => (
                  <li key={`${refusal.id}-${index}`}>
                    <code>{violation.path || "scene"}</code> {violation.message}
                  </li>
                ))}
              </ul>
              <small>The scene was not modified.</small>
            </div>
          ))}
        </>
      )}

      {session.calls.length > 0 && (
        <>
          <div className="section-label">Agent activity</div>
          <ol className="agent-log">
            {session.calls.slice(0, 8).map((entry) => (
              <li key={entry.id} className={entry.outcome}>
                <div>
                  <code>{entry.tool}</code>
                  <span className="outcome">{OUTCOME_LABEL[entry.outcome]}</span>
                </div>
                <small>{entry.summary}</small>
                <time>{ago(entry.at)}</time>
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}
