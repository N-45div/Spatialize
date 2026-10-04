import { MagnifyingGlassIcon, InfoIcon, TrafficConeIcon, CheckCircleIcon, WarningCircleIcon, QuestionIcon, ArrowUpRightIcon, BooksIcon, SpinnerGapIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Point, SpatialScene } from "../domain/spatial-scene";
import { accessRequest, type AccessAnswer, type AccessSnapshot, type MovePreview, type Obstacle, type ObstacleMove } from "../lib/access-api";

export interface AccessVisual {
  obstacles: Obstacle[];
  preview: Obstacle[];
  route: Point[] | null;
  focusedId: string | null;
  verdict?: AccessAnswer["verdict"] | null;
}

export function AccessDesk({ runId, scene, sceneVersion, onVisual }: {
  runId: string | null; scene: SpatialScene; sceneVersion: number;
  onVisual: (visual: AccessVisual) => void;
}) {
  const [snapshot, setSnapshot] = useState<AccessSnapshot | null>(null);
  const [answer, setAnswer] = useState<AccessAnswer | null>(null);
  const [destination, setDestination] = useState("studio-mark");
  const [clearance, setClearance] = useState(800);
  const [question, setQuestion] = useState("Can I reach this room today? Show the evidence.");
  const [useAgent, setUseAgent] = useState(true);
  const [researching, setResearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<MovePreview | null>(null);
  const [obstacleId, setObstacleId] = useState("gallery-trolley");
  const [roomId, setRoomId] = useState("gallery");
  const [x, setX] = useState(13.5);
  const [z, setZ] = useState(5.3);
  const [reason, setReason] = useState("Move the trolley away from the entrance route");
  const [decisionReason, setDecisionReason] = useState("Layout checked by the venue reviewer");
  const requestId = useRef(0);
  const destinations = scene.landmarks.filter(item => item.type === "destination");
  const target = destinations.some(item => item.id === destination) ? destination : destinations[0]?.id ?? "";
  const current = snapshot?.venueId === scene.id && snapshot.sceneVersion === sceneVersion ? snapshot : null;
  const visibleAnswer = answer && current && answer.destinationId === target && answer.clearanceMm === clearance
    && answer.sceneVersion === sceneVersion && answer.accessVersion === current.version ? answer : null;
  const agentOn = useAgent && Boolean(current?.agentConfigured);
  const knowledgeReads = visibleAnswer?.contextReads.filter(read => read.successful && read.tool === "knowledge_base_read").length ?? 0;
  const load = useCallback(async () => {
    if (!runId) return;
    const data = await accessRequest<AccessSnapshot>(runId);
    setSnapshot(data);
    onVisual({ obstacles: data.obstacles, preview: [], route: null, focusedId: null });
    return data;
  }, [runId, onVisual]);

  useEffect(() => {
    let cancelled = false;
    if (runId) accessRequest<AccessSnapshot>(runId).then(data => {
      if (!cancelled) {
        setSnapshot(data);
        setError(null);
        onVisual({ obstacles: data.obstacles, preview: [], route: null, focusedId: null });
      }
    }).catch((err: unknown) => {
      if (!cancelled) setError(err instanceof Error ? err.message : "Evidence unavailable");
    });
    return () => { cancelled = true; requestId.current += 1; };
  }, [runId, sceneVersion, onVisual]);

  async function perform(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError(null);
    try { await action(); }
    catch (err) { setError(err instanceof Error ? err.message : "The request failed"); }
    finally { setBusy(false); }
  }
  async function check() {
    if (!runId || !current) return;
    const id = ++requestId.current;
    const body = { question, destinationId: target, clearanceMm: clearance };
    let checked = false;
    // The computed verdict shows at once; the agent's source reading follows when it arrives.
    await perform(async () => {
      const data = await accessRequest<AccessAnswer>(runId, "/check", { ...body, useAgent: false });
      if (id !== requestId.current) return;
      checked = true;
      setAnswer(data);
      setPreview(null);
      onVisual({ obstacles: current.obstacles, preview: [], route: data.route, focusedId: target, verdict: data.verdict });
    });
    if (!checked || !agentOn) return;
    setResearching(true);
    try {
      const data = await accessRequest<AccessAnswer>(runId, "/check", { ...body, useAgent: true });
      if (id === requestId.current) setAnswer(data);
    } catch (err) {
      if (id === requestId.current) setAnswer(previous => previous && { ...previous, agentStatus: "unavailable",
        agentMessage: err instanceof Error ? err.message : "Source research failed. The computed verdict stands." });
    } finally {
      if (id === requestId.current) setResearching(false);
    }
  }
  function move(): ObstacleMove {
    return { obstacleId, roomId, position: [x, z], rotation: current?.obstacles.find(o => o.id === obstacleId)?.rotation ?? 0,
      reason, baseSceneVersion: sceneVersion, baseAccessVersion: current?.version ?? 1 };
  }
  function resetVisual(clearRoute = false, focus = target) {
    setPreview(null);
    if (clearRoute) { requestId.current += 1; setResearching(false); }
    onVisual({ obstacles: current?.obstacles ?? [], preview: [], route: clearRoute ? null : visibleAnswer?.route ?? null, focusedId: focus, verdict: clearRoute ? null : visibleAnswer?.verdict });
  }
  return <section className="access-desk" aria-label="Access desk">
    <div className="access-heading"><div><span className="section-label">Evidence + geometry</span><h2>Access desk</h2></div>
      <span className="access-mode" title={current?.synthetic ? "Fictional demo venue with synthetic evidence" : undefined}>{current ? current.contentMode === "sanity" ? "Sanity connected" : "Demo fixtures"
        : error ? "Evidence unavailable" : "Connecting…"}</span></div>
    <p className="access-intro">A route, a reason, and the evidence behind it.</p>
    {current?.synthetic && <p className="fixture-note" title="Harbor Arts is fictional. All reports and obstacles are synthetic demo fixtures."><InfoIcon size={18} aria-hidden="true" />Fictional demo venue / Synthetic evidence</p>}
    {!runId && <p role="status">Connecting to the venue API…</p>}
    <form onSubmit={event => { event.preventDefault(); void check(); }}>
      <label>Destination<select value={target} disabled={busy} onChange={event => { setDestination(event.target.value); resetVisual(true, event.target.value); }}>
        {destinations.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
      </select></label>
      <label>Required clear width <span>mm</span><input type="number" min="300" max="2500" step="10" value={clearance}
        disabled={busy} onChange={event => { setClearance(Number(event.target.value)); resetVisual(true); }} /></label>
      <div className="agent-ask">
        <div className="agent-ask-head"><BooksIcon size={22} aria-hidden="true" />
          <span><strong>Evidence agent</strong><small>Reads this venue's sources through a Sanity Context Knowledge Base</small></span>
          <label className="access-toggle"><input type="checkbox" checked={agentOn} disabled={!current?.agentConfigured || busy || researching}
            onChange={event => setUseAgent(event.target.checked)} /> Ask</label></div>
        {agentOn && <label>Your question<textarea rows={2} value={question} maxLength={1200} disabled={busy || researching}
          onChange={event => setQuestion(event.target.value)} /></label>}
        {current && !current.agentConfigured && <small className="access-muted">The agent is not configured on this server. The route check below still runs on the structured evidence.</small>}
      </div>
      <button className="access-primary" disabled={busy || researching || !current || !target || clearance < 300 || clearance > 2500}>
        <MagnifyingGlassIcon size={20} aria-hidden="true" />{busy ? "Checking..." : "Check access"}
      </button>
    </form>
    {error && <div className="access-error" role="alert">{error}<button disabled={busy} onClick={() => void perform(async () => { await load(); })}>Reload evidence</button></div>}
    {visibleAnswer && <article className={`access-answer ${visibleAnswer.verdict.toLowerCase()}`} aria-live="polite">
      <div className="verdict-line"><strong>{visibleAnswer.verdict === "CLEAR" ? <CheckCircleIcon size={25} weight="fill" aria-hidden="true" /> : visibleAnswer.verdict === "BLOCKED" ? <WarningCircleIcon size={25} weight="fill" aria-hidden="true" /> : <QuestionIcon size={25} weight="fill" aria-hidden="true" />}{visibleAnswer.verdict}</strong><span>{visibleAnswer.distanceMeters === null ? "No route" : `${visibleAnswer.distanceMeters} m route`}</span></div>
      <p>{visibleAnswer.destinationLabel} · {visibleAnswer.clearanceMm} mm requested</p>
      <ul>{visibleAnswer.reasons.map((item, i) => <li key={`${item.entityId}-${i}`}><button onClick={() => onVisual({
        obstacles: current?.obstacles ?? [], preview: [], route: visibleAnswer.route, focusedId: item.entityId, verdict: visibleAnswer.verdict
      })}>{item.message}<span>Locate <ArrowUpRightIcon size={14} aria-hidden="true" /></span></button></li>)}</ul>
      {researching && <p className="agent-research pending" role="status"><SpinnerGapIcon size={16} aria-hidden="true" />Agent is reading the Knowledge Base…</p>}
      {visibleAnswer.agentSummary && <div className="agent-research"><strong><BooksIcon size={18} aria-hidden="true" />What the sources say</strong>
        <p>{visibleAnswer.agentSummary}</p>
        <small>{knowledgeReads} Knowledge Base {knowledgeReads === 1 ? "read" : "reads"} · The verdict above is computed from structured evidence; the agent cannot change it.</small></div>}
      {visibleAnswer.agentMessage && !researching && <p className="access-muted">{visibleAnswer.agentMessage}</p>}
      {visibleAnswer.contextReads.length > 0 && <details className="context-reads"><summary>Context retrieval record ({visibleAnswer.contextReads.length} calls)</summary>{visibleAnswer.contextReads.map((read, i) =>
        <details key={i}><summary>{read.tool} · {read.successful ? "retrieved" : "failed"}</summary>{read.arguments && read.arguments !== "{}" && <code>{read.arguments}</code>}<pre>{read.output}</pre></details>)}</details>}

      <details className="evidence-list"><summary>Evidence ({visibleAnswer.evidence.length})</summary>
        {visibleAnswer.evidence.map(source => <article key={source.id} className="access-source">
          <strong>{source.title}</strong><small>{source.publisher} · {new Date(source.observedAt).toLocaleDateString()}{source.synthetic ? " · Synthetic" : ""}</small>
          <p>{source.body}</p>
          {visibleAnswer.claims?.filter(c => c.sourceId === source.id).map(c => <div className="claim-line" key={c.id}>
            {c.property}: {String(c.value)} <b>{c.status}</b>
          </div>)}
          {source.url && /^https?:\/\//i.test(source.url) && <a href={source.url} target="_blank" rel="noreferrer">Open source ↗</a>}
        </article>)}
      <small className="snapshot-meta">Scene v{visibleAnswer.sceneVersion} · Access v{visibleAnswer.accessVersion} · {new Date(visibleAnswer.checkedAt).toLocaleTimeString()}</small>
      <details><summary>What this check covers</summary>{visibleAnswer.limitations.map(text => <p key={text}>{text}</p>)}</details>
      </details>

    </article>}
    {current && current.obstacles.length > 0 && <details className="move-desk"><summary><TrafficConeIcon size={22} aria-hidden="true" /><span>Rehearse an obstacle move</span><b>Review required</b></summary>
      <p>Preview the impact. A person decides before the layout changes.</p>
      <label>Obstacle<select value={obstacleId} disabled={busy} onChange={event => { setObstacleId(event.target.value); resetVisual(); }}>
        {current.obstacles.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}</select></label>
      <label>Place in room<select value={roomId} disabled={busy} onChange={event => { setRoomId(event.target.value); resetVisual(); }}>
        {current.rooms.map(room => <option key={room.id} value={room.id}>{room.label}</option>)}</select></label>
      <div className="coordinate-row"><label>X · metres<input type="number" step="0.1" value={x} disabled={busy} onChange={event => { setX(Number(event.target.value)); resetVisual(); }} /></label>
        <label>Z · metres<input type="number" step="0.1" value={z} disabled={busy} onChange={event => { setZ(Number(event.target.value)); resetVisual(); }} /></label></div>
      <label>Reason<input value={reason} disabled={busy} maxLength={300} onChange={event => { setReason(event.target.value); resetVisual(); }} /></label>
      <button className="access-secondary" disabled={busy || !runId || reason.trim().length < 3} onClick={() => void perform(async () => {
        const data = await accessRequest<MovePreview>(runId!, "/preview", move()); setPreview(data);
        onVisual({ obstacles: current.obstacles, preview: data.obstacles, route: visibleAnswer?.route ?? null, focusedId: obstacleId });
      })}>Preview move</button>
      {preview && preview.accessVersion === current.version && <div className="move-preview"><strong>Before → After · {preview.clearanceMm} mm</strong>
        {preview.impact.map(item => <p key={item.destination}>{item.destination}<span>{item.before} → {item.after}</span></p>)}
        <button disabled={busy} className="access-primary" onClick={() => void perform(async () => {
          await accessRequest(runId!, "/proposals", move()); await load(); setPreview(null);
        })}>Submit for review</button><button className="access-secondary" onClick={() => resetVisual()}>Cancel preview</button>
      </div>}
      {current.proposals.length > 0 && <section className="access-reviews"><h3>Review record</h3>
        <label>Decision reason<input value={decisionReason} maxLength={300} disabled={busy} onChange={event => setDecisionReason(event.target.value)} /></label>
        {[...current.proposals].reverse().map(proposal => <article key={proposal.id}>
          <strong>{proposal.move.reason}</strong><small>{proposal.status}{proposal.resultingVersion ? ` · Published access v${proposal.resultingVersion}` : ""}</small>
          {proposal.decisionReason && <p>{proposal.decisionReason}</p>}
          {proposal.status === "pending" && <div className="decision-buttons">{(["approve", "decline"] as const).map(decision => <button key={decision}
            disabled={busy || decisionReason.trim().length < 3} onClick={() => void perform(async () => {
              await accessRequest(runId!, `/proposals/${proposal.id}/decision`, { decision, reason: decisionReason }, true);
              await load(); setPreview(null); setAnswer(null);
            })}>{decision === "approve" ? "Approve move" : "Decline"}</button>)}</div>}
        </article>)}
      </section>}
    </details>}
  </section>;
}
