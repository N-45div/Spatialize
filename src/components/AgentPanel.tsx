import { useMemo, useState, useSyncExternalStore } from "react";
import type { SpatialScene } from "../domain/spatial-scene";
import {
  dismissRefusal,
  getAgentSession,
  subscribeToAgentSession,
  type Proposal
} from "../webmcp/session";
import { describeToolSurface } from "../webmcp/tools";
import type { WebMCPStatus } from "../webmcp/useWebMCP";

const PERSIST_LABEL = {
  local: "Held in this tab only — no venue record is loaded",
  saving: "Writing to the venue record…",
  saved: "On the venue record. Survives refresh, visible to every agent.",
  failed: "Could not reach the venue record. Held in this tab."
} as const;

/**
 * The three prompts that walk a first-time visitor through the whole idea:
 * an answer computed from geometry, a change that survives the gate and waits
 * for a person, and a change the gate will not allow at all.
 */
const TRY_THESE = [
  { arc: "ask", text: "Is the quiet room step-free from the main entrance?" },
  { arc: "report", text: "The quiet-room doorway has a step now — report it." },
  { arc: "refuse", text: "Add a doorway between the main lobby and the quiet room." }
] as const;

function kindLabel(readOnly: boolean, canPropose: boolean) {
  if (readOnly) return "reads";
  return canPropose ? "proposes" : "proposes · needs a venue record";
}

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
  scene,
  status,
  canPropose,
  onApprove,
  onReject
}: {
  scene: SpatialScene;
  status: WebMCPStatus;
  canPropose: boolean;
  onApprove: (proposal: Proposal) => void;
  onReject: (proposal: Proposal) => void;
}) {
  const session = useSyncExternalStore(subscribeToAgentSession, getAgentSession, getAgentSession);
  const [open, setOpen] = useState(true);
  const [showCatalog, setShowCatalog] = useState(false);
  const catalog = useMemo(() => describeToolSurface(scene), [scene]);

  let state: "live" | "off" | "pending" | "error" = "pending";
  if (!status.supported) state = "off";
  else if (status.error) state = "error";
  else if (status.registered.length) state = "live";

  const statusText = {
    live: `${status.registered.length} tools live`,
    off: "browser not agent-ready",
    pending: "registering…",
    error: "registration failed"
  }[state];

  const pending = session.proposals.length;
  const blocked = session.refusals.length;

  return (
    <section className={`agent-dock ${state}`} data-open={open} data-tour="agent">
      <button className="dock-bar" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span className="agent-dot" />
        <strong>Agent tools</strong>
        <span className="dock-meta">{statusText}</span>
        {pending > 0 && <span className="dock-badge amber">{pending} to approve</span>}
        {blocked > 0 && <span className="dock-badge rose">{blocked} blocked</span>}
        <span className="dock-chevron" aria-hidden>
          {open ? "▾" : "▴"}
        </span>
      </button>

      {open && (
        <div className="dock-body">
          <p className="dock-pitch">
            Ask your agent about this building and it answers from validated geometry, never
            from a guess. Tell it what changed on the ground and the change has to survive the
            topology gate <em>and</em> a person before it becomes venue data.
          </p>

          {state === "off" && (
            <p className="agent-hint">
              Open this page in the ChatGPT app browser, or Chrome 149+ with{" "}
              <code>chrome://flags/#enable-webmcp-testing</code> enabled, and the{" "}
              {catalog.length} tools below become callable by your agent.
            </p>
          )}

          {state === "error" && <p className="agent-hint error">{status.error}</p>}

          {state === "live" && !canPropose && (
            <p className="agent-hint">
              No venue record is loaded, so only the read tools are published. Reports need
              somewhere to be kept; the propose tools appear the moment a venue is.
            </p>
          )}

          {pending > 0 && (
            <>
              <div className="section-label">Waiting on you ({pending})</div>
              {session.proposals.map((proposal) => (
                <div className="proposal-card" key={proposal.id}>
                  <strong>{proposal.description}</strong>
                  <small className="proposal-reason">“{proposal.reason}”</small>
                  <small className="proposal-impact">{impactLine(proposal)}</small>
                  <small className={`proposal-persist ${proposal.persisted}`}>
                    {proposal.persisted === "failed" && proposal.failure
                      ? `Not on the venue record: ${proposal.failure}. Held in this tab.`
                      : PERSIST_LABEL[proposal.persisted]}
                  </small>
                  <div className="proposal-actions">
                    <button
                      className="approve"
                      disabled={proposal.persisted === "saving"}
                      onClick={() => onApprove(proposal)}
                    >
                      Approve
                    </button>
                    <button
                      className="reject"
                      disabled={proposal.persisted === "saving"}
                      onClick={() => onReject(proposal)}
                    >
                      Reject
                    </button>
                  </div>
                </div>
              ))}
            </>
          )}

          {blocked > 0 && (
            <>
              <div className="section-label">Refused by the topology gate</div>
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
                  <small>The agent was told exactly this. The scene did not change.</small>
                </div>
              ))}
            </>
          )}

          {session.disputes.length > 0 && (
            <>
              <div className="section-label">
                Declined, still on the record ({session.disputes.length})
              </div>
              {session.disputes.map((dispute) => (
                <div className="dispute-card" key={dispute.id}>
                  <strong>{dispute.description}</strong>
                  <small className="dispute-reason">“{dispute.reason}”</small>
                  <small className="dispute-note">
                    The venue declined this. It is kept as a disagreement, not deleted, and any
                    agent asking about this venue is told about it.
                  </small>
                </div>
              ))}
            </>
          )}

          {session.calls.length > 0 && (
            <>
              <div className="section-label">Agent activity</div>
              <ol className="agent-log">
                {session.calls.slice(0, 6).map((entry) => (
                  <li key={entry.id} className={entry.outcome}>
                    <div>
                      <code>{entry.tool}</code>
                      <span className="outcome">{entry.outcome}</span>
                    </div>
                    <small>{entry.summary}</small>
                    <time>{ago(entry.at)}</time>
                  </li>
                ))}
              </ol>
            </>
          )}

          {session.calls.length === 0 && (
            <>
              <div className="section-label">Try this, in order</div>
              <ol className="try-these">
                {TRY_THESE.map((item, index) => (
                  <li key={item.arc} className={item.arc}>
                    <span>{index + 1}</span>
                    <p>{item.text}</p>
                  </li>
                ))}
              </ol>
            </>
          )}

          <button className="catalog-toggle" onClick={() => setShowCatalog((value) => !value)}>
            {showCatalog ? "Hide" : "Show"} the {catalog.length} tools this page publishes
          </button>

          {showCatalog && (
            <ul className="tool-catalog">
              {catalog.map((tool) => (
                <li key={tool.name}>
                  <div>
                    <code>{tool.name}</code>
                    <span className={tool.readOnly ? "kind read" : "kind write"}>
                      {kindLabel(tool.readOnly, canPropose)}
                    </span>
                  </div>
                  <p>{tool.description}</p>
                  {tool.params.length > 0 && (
                    <div className="tool-params">
                      {tool.params.map((param) => (
                        <span key={param.name} className={param.required ? "required" : ""}>
                          {param.name}
                          <i>{param.type}</i>
                        </span>
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
