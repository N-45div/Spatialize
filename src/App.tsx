import { useEffect, useMemo, useRef, useState } from "react";
import { Landing } from "./components/Landing";
import { SpatialCanvas } from "./components/SpatialCanvas";
import { Tour } from "./components/Tour";
import { sampleScene } from "./data/sample-scene";
import { SpatialSceneSchema, type SpatialScene } from "./domain/spatial-scene";
import {
  approveRun,
  askVenue,
  createIngestionRun,
  ensureDemoRun,
  extractRun,
  fetchRun,
  fetchScene,
  narrateText,
  resolveAssetUrl,
  type AskResponse,
  type ConversationTurn,
  type IngestionRun
} from "./lib/api";

const RUN_STORAGE_KEY = "spatialize-run-id";
const TOUR_STORAGE_KEY = "spatialize-tour-done";
import { AgentPanel } from "./components/AgentPanel";
import { useWebMCP } from "./webmcp/useWebMCP";
import {
  clearAgentSession,
  configureAgentSync,
  declineProposal,
  hydrateAgentSession,
  recordCall,
  recordConfirmation,
  resolveProposal,
  type Proposal
} from "./webmcp/session";
import {
  approveProposalRemote,
  declineProposalRemote,
  fetchReview,
  rememberVenueToken
} from "./lib/api";
import { dataIssues, formatMetres, planRoute } from "./webmcp/queries";

type Conversation = {
  question: string;
  answer: string;
  audioUrl: string | null;
  audioKind: "generated" | "fallback" | "none";
  voice?: string;
  mutations: { kind: string; summary: string }[];
  warnings: string[];
  manifestHash?: string;
};

type AskStage = null | "transcribing" | "thinking" | "speaking";

function parseScene(raw: unknown): SpatialScene | null {
  const parsed = SpatialSceneSchema.safeParse(raw);
  if (!parsed.success) {
    console.warn("Scene failed client-side validation", parsed.error);
    return null;
  }
  return parsed.data;
}

export default function App() {
  const [view, setView] = useState(window.location.hash === "#studio" ? "studio" : "landing");
  const [liveScene, setLiveScene] = useState<SpatialScene | null>(null);
  const scene = liveScene ?? sampleScene;
  const destinations = useMemo(
    () => scene.landmarks.filter((item) => item.type === "destination"),
    [scene]
  );
  // The chosen id is kept as-is; the effective destination is derived so a
  // venue swap falls back to that venue's first destination without an effect.
  // Any landmark can be focused — an agent asking about the lift must see the
  // lift — while the sidebar lists only the destination-type ones.
  const [destinationChoice, setDestination] = useState(destinations[0]?.id ?? "");
  const destination = useMemo(
    () =>
      scene.landmarks.some((item) => item.id === destinationChoice)
        ? destinationChoice
        : (destinations[0]?.id ?? ""),
    [scene, destinations, destinationChoice]
  );
  const [viewMode, setViewMode] = useState<"3d" | "2d">("3d");
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [sourceName, setSourceName] = useState("ground-floor-plan.pdf");
  const [uploadState, setUploadState] = useState<"idle" | "uploading" | "stored" | "error">("idle");
  const [uploadMessage, setUploadMessage] = useState("2.8 MB · 2480 × 1754");
  const [ingestionRun, setIngestionRun] = useState<IngestionRun | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [recording, setRecording] = useState(false);
  const [asking, setAsking] = useState(false);
  const [askText, setAskText] = useState("");
  const [micError, setMicError] = useState<string | null>(null);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [demoNotice, setDemoNotice] = useState(false);
  const [showTour, setShowTour] = useState(false);
  const [askStage, setAskStage] = useState<AskStage>(null);
  const [askVoice, setAskVoice] = useState<string | null>(null);
  // Resolved issues belong to one scene version. Keying them on it means a new
  // version starts clean without an effect having to reset anything.
  const [resolvedState, setResolvedState] = useState<{ key: string; ids: string[] }>({
    key: "",
    ids: []
  });
  const [approving, setApproving] = useState(false);
  const historyRef = useRef<ConversationTurn[]>([]);
  const stageTimerRef = useRef<number | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const answerAudioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const onHashChange = () =>
      setView(window.location.hash === "#studio" ? "studio" : "landing");
    window.addEventListener("hashchange", onHashChange);
    // A venue reviewer arrives with ?venue=<token> once; it is kept in this
    // browser and sent only when deciding a proposal.
    rememberVenueToken(new URLSearchParams(window.location.search).get("venue"));
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const resolvedKey = `${ingestionRun?.runId ?? ""}:${ingestionRun?.sceneVersion ?? 0}`;
  const resolvedIssues = resolvedState.key === resolvedKey ? resolvedState.ids : [];
  const setResolvedIssues = (ids: string[]) => setResolvedState({ key: resolvedKey, ids });

  async function resolveIssue(issueId: string) {
    if (!ingestionRun || approving) return;
    const next = resolvedIssues.includes(issueId)
      ? resolvedIssues
      : [...resolvedIssues, issueId];
    setResolvedIssues(next);
    const outstanding = scene.review.issues.some((issue) => !next.includes(issue.id));
    if (outstanding) return;
    setApproving(true);
    try {
      const approved = await approveRun(ingestionRun.runId, next);
      setIngestionRun(approved);
      await reloadScene(approved.runId);
    } catch {
      setResolvedIssues([]);
    } finally {
      setApproving(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    async function adopt(run: IngestionRun, isDemo: boolean) {
      const raw = await fetchScene(run.runId);
      const parsed = parseScene(raw);
      if (cancelled || !parsed) return false;
      setIngestionRun(run);
      setLiveScene(parsed);
      if (isDemo) {
        setSourceName("harbor-arts-demo.png");
        setUploadState("stored");
        setUploadMessage("Demo venue loaded · voice is live");
        setDemoNotice(true);
      }
      return true;
    }
    (async () => {
      const savedId = localStorage.getItem(RUN_STORAGE_KEY);
      if (savedId) {
        const isDemo = savedId.startsWith("run_demo");
        try {
          const saved = await fetchRun(savedId);
          if (await adopt(saved, isDemo)) {
            if (!isDemo) {
              setSourceName("previous upload");
              setUploadState("stored");
              setUploadMessage(`Run ${saved.runId} restored`);
            }
            return;
          }
        } catch {
          localStorage.removeItem(RUN_STORAGE_KEY);
        }
      }
      try {
        const demo = await ensureDemoRun();
        if (await adopt(demo, true)) {
          localStorage.setItem(RUN_STORAGE_KEY, demo.runId);
          if (!localStorage.getItem(TOUR_STORAGE_KEY)) setShowTour(true);
        }
      } catch {
        /* backend unreachable: stay on the client-side sample */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // One route computation feeds the drawn route, the caption and the agent's
  // routing tool, so none of them can disagree about whether somewhere is
  // reachable or how far it is.
  const accessPlan = useMemo(
    () => (destination ? planRoute(scene, { to: destination, stepFree: true }) : null),
    [scene, destination]
  );
  const blockedBy = accessPlan?.fallbackUsed ? accessPlan.plan.blockers[0]?.doorLabel : null;
  const route = accessPlan && !accessPlan.fallbackUsed ? accessPlan.plan.positions : [];
  const routeDistance = accessPlan?.plan.totalDistance ?? 0;
  const selected = scene.landmarks.find((item) => item.id === destination);
  const lowConfidence = dataIssues(scene).lowConfidence.length;

  // Publish this venue's tools to any agent in the browser. Registered once per
  // venue; swapping the floor plan re-registers and fires `toolchange`.
  // A venue record to propose against means a run *with a scene loaded*. During
  // an upload the run exists before its scene does, and offering the write
  // tools then would file proposals about the previous venue.
  const canPropose = Boolean(ingestionRun && liveScene);
  const webmcp = useWebMCP(scene, { focusLandmark: setDestination, setViewMode }, { canPropose });

  // Mirror the agent session to the run's review ledger on the server. The
  // scene version travels with it so a proposal is stamped with what it was
  // made against, and approval can refuse one that has gone stale.
  const runId = ingestionRun?.runId ?? null;
  const sceneVersion = ingestionRun?.sceneVersion ?? 0;
  useEffect(() => {
    configureAgentSync(runId ? { runId, sceneVersion } : null);
  }, [runId, sceneVersion]);

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    clearAgentSession();
    fetchReview(runId)
      .then((ledger) => {
        if (!cancelled) hydrateAgentSession(ledger);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [runId]);

  if (view === "landing") {
    return <Landing onEnter={() => { window.location.hash = "#studio"; }} />;
  }

  /**
   * The server said no to a decision — most often because another reviewer
   * already made it, or the venue moved on. Rather than leave a dead card,
   * take the server's word for what is pending now.
   */
  async function resyncAfterDecisionFailure(proposalId: string, error: unknown, action: string) {
    recordCall(
      "human_review",
      { proposal: proposalId },
      "error",
      error instanceof Error ? error.message : `${action} failed`
    );
    if (!ingestionRun) return;
    try {
      hydrateAgentSession(await fetchReview(ingestionRun.runId));
    } catch {
      /* the ledger is unreachable too; the card stays until it is not */
    }
  }

  /**
   * A person accepts an agent's proposal. When the proposal is on the venue
   * record the server does the installing — it re-checks the version and
   * writes a new scene. A proposal that never reached the record (no run, or
   * the record was unreachable) is applied in this tab from its gate-checked
   * scene, and the dock has already said that is where it lives.
   */
  async function approveProposal(proposal: Proposal) {
    if (ingestionRun && proposal.persisted === "saved") {
      try {
        const { run, scene: installed } = await approveProposalRemote(ingestionRun.runId, proposal.id);
        setIngestionRun(run);
        const parsed = parseScene(installed);
        if (parsed) setLiveScene(parsed);
        else await reloadScene(run.runId);
      } catch (error) {
        await resyncAfterDecisionFailure(proposal.id, error, "Approval");
        return;
      }
    } else if (proposal.scene) {
      setLiveScene(proposal.scene);
    }
    resolveProposal(proposal.id);
    recordConfirmation(proposal);
    recordCall("human_review", { proposal: proposal.id }, "answered", `Approved: ${proposal.description}`);
  }

  /**
   * Declining does not delete the report. Visitors are a better source on a
   * building than the building's own record, so the disagreement is kept and
   * an agent can read it back through list_disputed_claims.
   */
  async function rejectProposal(proposal: Proposal) {
    if (ingestionRun && proposal.persisted === "saved") {
      try {
        await declineProposalRemote(ingestionRun.runId, proposal.id);
      } catch (error) {
        await resyncAfterDecisionFailure(proposal.id, error, "Decline");
        return;
      }
    }
    const dispute = declineProposal(proposal.id);
    recordCall(
      "human_review",
      { proposal: proposal.id },
      "refused",
      dispute ? `Declined, kept as disputed: ${dispute.description}` : "Declined by the venue team"
    );
  }

  function downloadScene() {
    const blob = new Blob([JSON.stringify(scene, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${scene.id}.scene.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function narrateRoute() {
    if (!selected) return;
    const script =
      `Route to ${selected.label}. Travel ${Math.round(routeDistance)} metres from the main ` +
      "entrance. The accessible route is highlighted in amber.";
    if (isSpeaking) {
      window.speechSynthesis?.cancel();
      answerAudioRef.current?.pause();
      setIsSpeaking(false);
      return;
    }
    setIsSpeaking(true);
    if (ingestionRun) {
      try {
        const { audio } = await narrateText(ingestionRun.runId, script);
        const url = resolveAssetUrl(audio.url);
        if (url) {
          answerAudioRef.current?.pause();
          const element = new Audio(url);
          answerAudioRef.current = element;
          element.onended = () => setIsSpeaking(false);
          await element.play();
          return;
        }
      } catch {
        /* fall through to on-device speech */
      }
    }
    if (!("speechSynthesis" in window)) {
      setIsSpeaking(false);
      return;
    }
    window.speechSynthesis.cancel();
    const narration = new SpeechSynthesisUtterance(script);
    narration.rate = 0.92;
    narration.onend = () => setIsSpeaking(false);
    window.speechSynthesis.speak(narration);
  }

  async function reloadScene(runId: string) {
    const raw = await fetchScene(runId);
    const parsed = parseScene(raw);
    if (parsed) setLiveScene(parsed);
  }

  async function handlePlanSelected(file: File | undefined) {
    if (!file) return;
    setSourceName(file.name);
    setUploadState("uploading");
    setUploadMessage("Hashing and securing source…");
    try {
      const run = await createIngestionRun(file);
      setIngestionRun(run);
      setDemoNotice(false);
      historyRef.current = [];
      setConversation(null);
      localStorage.setItem(RUN_STORAGE_KEY, run.runId);
      setUploadState("stored");
      setUploadMessage(`${(run.source.size / 1024).toFixed(1)} KB · SHA ${run.source.sha256.slice(0, 8)}`);
      setExtracting(true);
      setUploadMessage("Agentic extraction running…");
      try {
        const extracted = await extractRun(run.runId);
        setIngestionRun(extracted);
        await reloadScene(extracted.runId);
        setUploadMessage("Scene extracted · pending review");
      } catch (error) {
        setUploadMessage(
          error instanceof Error ? error.message : "Extraction unavailable — source stored"
        );
      } finally {
        setExtracting(false);
      }
    } catch (error) {
      setUploadState("error");
      setUploadMessage(error instanceof Error ? error.message : "Plan upload failed");
    } finally {
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  function applyAskResponse(question: string, response: AskResponse) {
    if (response.status === "low-confidence") {
      setConversation({
        question,
        answer: response.message ?? "Please repeat the question.",
        audioUrl: null,
        audioKind: "none",
        mutations: [],
        warnings: response.warnings
      });
      return;
    }
    const asked = response.question ?? question;
    const script = response.answer?.script ?? "";
    const audioUrl = resolveAssetUrl(response.audio?.url);
    setConversation({
      question: asked,
      answer: script,
      audioUrl,
      audioKind: audioUrl ? "generated" : script ? "fallback" : "none",
      voice: response.audio?.voice,
      mutations: response.mutations.map(({ kind, summary }) => ({ kind, summary })),
      warnings: response.warnings,
      manifestHash: response.audio?.manifestHash
    });
    if (script) historyRef.current = [...historyRef.current.slice(-5), { question: asked, answer: script }];
    if (response.sceneChanged && ingestionRun) {
      // The server wrote a new version. Carry the number, or every proposal
      // an agent makes from now on is stamped stale and can never be approved.
      const version = response.sceneVersion;
      if (typeof version === "number") {
        setIngestionRun((current) =>
          current ? { ...current, sceneVersion: version, status: "review-required" } : current
        );
      }
      void reloadScene(ingestionRun.runId);
    }
    if (response.proposals?.length && ingestionRun) {
      // The voice edit was filed on the venue record; show it in the queue.
      void fetchReview(ingestionRun.runId).then(hydrateAgentSession).catch(() => undefined);
    }
    if (audioUrl) {
      setAskStage("speaking");
      setAskVoice(response.audio?.voice ?? null);
      const audio = answerAudioRef.current ?? new Audio();
      answerAudioRef.current = audio;
      audio.src = audioUrl;
      audio.onended = () => setAskStage(null);
      void audio.play().catch(() => setAskStage(null));
    } else if (script && "speechSynthesis" in window) {
      const fallback = new SpeechSynthesisUtterance(script);
      fallback.rate = 0.95;
      window.speechSynthesis.speak(fallback);
    }
  }

  function replayAnswer() {
    const url = conversation?.audioUrl;
    if (!url) return;
    if (!answerAudioRef.current) answerAudioRef.current = new Audio();
    const audio = answerAudioRef.current;
    audio.src = url;
    audio.currentTime = 0;
    void audio.play().catch(() => undefined);
  }

  function primeAnswerAudio() {
    // Start a silent clip inside the user gesture so the browser lets the
    // real answer audio play when it arrives ~30s later.
    answerAudioRef.current?.pause();
    const element = new Audio(
      "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA="
    );
    answerAudioRef.current = element;
    void element.play().catch(() => undefined);
  }

  async function submitAsk(input: { text?: string; audio?: Blob; audioType?: string }) {
    if (!ingestionRun) return;
    if (!input.audio) primeAnswerAudio();
    setAsking(true);
    setAskStage(input.audio ? "transcribing" : "thinking");
    if (stageTimerRef.current) window.clearTimeout(stageTimerRef.current);
    if (input.audio) {
      stageTimerRef.current = window.setTimeout(() => setAskStage("thinking"), 9000);
    }
    try {
      const question = input.text ?? "(voice question)";
      const response = await askVenue(ingestionRun.runId, {
        ...input,
        history: historyRef.current
      });
      applyAskResponse(question, response);
      setAskText("");
    } catch (error) {
      setConversation({
        question: input.text ?? "(voice question)",
        answer: error instanceof Error ? error.message : "The venue could not answer.",
        audioUrl: null,
        audioKind: "none",
        mutations: [],
        warnings: ["request-failed"]
      });
    } finally {
      if (stageTimerRef.current) window.clearTimeout(stageTimerRef.current);
      setAsking(false);
      setAskStage((stage) => (stage === "speaking" ? stage : null));
    }
  }

  async function toggleRecording() {
    primeAnswerAudio();
    if (recording) {
      recorderRef.current?.stop();
      return;
    }
    setMicError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : "audio/mp4";
      const recorder = new MediaRecorder(stream, { mimeType });
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        setRecording(false);
        const blob = new Blob(chunksRef.current, { type: mimeType });
        if (blob.size < 1_000) {
          setMicError("That recording was too short — try again.");
          return;
        }
        void submitAsk({ audio: blob, audioType: mimeType });
      };
      recorderRef.current = recorder;
      recorder.start();
      setRecording(true);
    } catch {
      setMicError("Microphone unavailable — type your question instead.");
    }
  }

  const storageLabel = ingestionRun?.source.uri.startsWith("b2://")
    ? "Synced to B2"
    : ingestionRun
      ? "Source secured"
      : "Demo scene";
  const voiceReady = Boolean(ingestionRun && liveScene);

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="/">
          <span className="brand-mark"><i /><i /><i /></span>
          <span>Spatialize<small>Spatial media studio</small></span>
        </a>
        <div className="topbar-copy"><span>Projects</span><b>/</b><strong>{scene.name}</strong></div>
        <div className="topbar-actions">
          <div className="b2-state"><span /> {storageLabel} <small>{ingestionRun ? `run ${ingestionRun.runId.slice(0, 12)}` : "sample data"}</small></div>
          <button className="share-action" onClick={downloadScene}>Share package</button>
        </div>
      </header>

      <section className="workspace">
        <aside className="sidebar">
          <div className="eyebrow"><span>Project 01</span><b>Scene schema v1.1</b></div>
          <h1>{scene.name}</h1>
          <p className="lede">A flat venue plan transformed into a navigable, accessible spatial twin.</p>

          <button
            className={`source-card ${uploadState}`}
            data-tour="source"
            onClick={() => fileInput.current?.click()}
          >
            <div className="source-thumb">
              <span>PDF</span>
              <div className="mini-plan"><i /><i /><i /></div>
            </div>
            <div><strong>{sourceName}</strong><small>{uploadMessage}</small></div>
            <span className="replace-label">
              {uploadState === "uploading" || extracting ? "Working" : "Replace"}
            </span>
          </button>
          <input
            ref={fileInput}
            type="file"
            hidden
            accept="image/png,image/jpeg,image/webp,application/pdf"
            onChange={(event) => void handlePlanSelected(event.target.files?.[0])}
          />

          <div className="compile-proof">
            <span>{liveScene ? `Live scene v${ingestionRun?.sceneVersion ?? 1}` : "Validated spatial contract"}</span>
            <div><i /> {scene.rooms.length} rooms</div>
            <div><i /> {scene.routeGraph.nodes.length} route nodes</div>
            <div><i /> {scene.landmarks.length} landmarks</div>
          </div>

          <div className="section-label">Ask the venue</div>
          {demoNotice && (
            <div className="demo-notice" role="status">
              <b>Demo venue loaded — voice is live.</b>
              <span>No upload needed. Try one of these, spoken or typed:</span>
              <div className="demo-prompts">
                <button onClick={() => setAskText("How far is the studio from the entrance?")}>
                  “How far is the studio?”
                </button>
                <button onClick={() => setAskText("Mark the gallery door as not accessible. I confirm.")}>
                  “Mark the gallery door inaccessible”
                </button>
              </div>
              <button className="demo-dismiss" onClick={() => setDemoNotice(false)} aria-label="Dismiss">
                ×
              </button>
            </div>
          )}
          <div className="voice-panel" data-tour="ask">
            <button
              className={recording ? "voice-action recording" : "voice-action"}
              disabled={!voiceReady || asking}
              onClick={() => void toggleRecording()}
              title={voiceReady ? "Ask by voice" : "Upload and extract a plan first"}
            >
              <span>{recording ? "Stop and send" : asking ? "Thinking…" : "Hold a conversation"}</span>
              <i className="audio-bars"><b /><b /><b /></i>
            </button>
            <div className="ask-row">
              <input
                value={askText}
                placeholder={voiceReady ? "…or type: add a cafe near the entrance" : "Upload a plan to start"}
                disabled={!voiceReady || asking}
                onChange={(event) => setAskText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && askText.trim()) void submitAsk({ text: askText.trim() });
                }}
              />
              <button
                disabled={!voiceReady || asking || !askText.trim()}
                onClick={() => void submitAsk({ text: askText.trim() })}
              >
                Ask
              </button>
            </div>
            {micError && <small className="mic-error">{micError}</small>}
            {askStage && (
              <div className="ask-status" aria-live="polite">
                <i className="audio-bars"><b /><b /><b /></i>
                {askStage === "transcribing" && "Transcribing your voice (AssemblyAI)…"}
                {askStage === "thinking" && "Thinking over the validated scene…"}
                {askStage === "speaking" && `Speaking — ${askVoice ?? "generated voice"}…`}
              </div>
            )}
            {conversation && (
              <div className="conversation" aria-live="polite">
                <small>You: {conversation.question}</small>
                <p>{conversation.answer}</p>
                {conversation.audioKind === "generated" && conversation.audioUrl && (
                  <div className="answer-voice">
                    <button onClick={replayAnswer} aria-label="Replay the spoken answer">
                      ▶
                    </button>
                    <span title={`genblaze manifest ${conversation.manifestHash ?? ""}`}>
                      {conversation.voice ?? "generated voice"}
                    </span>
                  </div>
                )}
                {conversation.audioKind === "fallback" && (
                  <small className="fallback-note">
                    ⚠ On-device fallback voice — audio generation was unavailable for this answer.
                  </small>
                )}
                {conversation.mutations.map((mutation) => (
                  <div className="mutation-chip" key={mutation.summary}>
                    <b>{mutation.kind}</b> {mutation.summary}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="section-label">Rehearse a route</div>
          <div className="destination-list">
            {destinations.map((item, index) => (
              <button
                className={destination === item.id ? "destination active" : "destination"}
                key={item.id}
                onClick={() => setDestination(item.id)}
              >
                <span>{String(index + 1).padStart(2, "0")}</span>
                <div><strong>{item.label}</strong><small>From main entrance</small></div>
                <b>View</b>
              </button>
            ))}
          </div>

          <button className={isSpeaking ? "primary-action speaking" : "primary-action"} onClick={narrateRoute}>
            <span>{isSpeaking ? "Stop guidance" : "Play route guidance"}</span>
            <i className="audio-bars"><b /><b /><b /></i>
          </button>
          {accessPlan?.plan.found && selected && (
            <section className="route-words" aria-label="Route in words">
              <div className="section-label">Route, in words</div>
              <ol>
                {accessPlan.plan.steps.map((step, index) => (
                  <li key={`${step.from}-${step.to}`}>
                    <span>{index + 1}</span>
                    <div>
                      {step.fromRoom} to {step.toRoom}
                      {step.doorLabel ? ` through ${step.doorLabel}` : ""}
                      {step.doorWidth ? ` (${Math.round(step.doorWidth * 1000)} mm clear)` : ""}
                      {step.accessible ? "" : " — has steps"}
                      <small>{formatMetres(step.distance)}</small>
                    </div>
                  </li>
                ))}
              </ol>
              {blockedBy && (
                <p className="route-words-note">Not step-free: this route passes {blockedBy}.</p>
              )}
            </section>
          )}

          <button className="secondary-action" onClick={downloadScene}>
            Export scene package <span>JSON + assets</span>
          </button>
        </aside>

        <section className="viewport" data-tour="viewport">
          <SpatialCanvas scene={scene} route={route} selectedId={destination} mode={viewMode} />
          <div className="viewport-glow" />
          <AgentPanel
            scene={scene}
            status={webmcp}
            canPropose={canPropose}
            onApprove={approveProposal}
            onReject={rejectProposal}
          />
          <div className="viewport-head">
            <div><span>Interactive spatial twin</span><strong>{liveScene ? "Extracted scene · Accessible view" : "Ground floor · Accessible view"}</strong></div>
            <div className="view-controls">
              <button className={viewMode === "3d" ? "active" : ""} onClick={() => setViewMode("3d")}>3D</button>
              <button className={viewMode === "2d" ? "active" : ""} onClick={() => setViewMode("2d")}>Plan</button>
            </div>
          </div>
          <div className="scene-legend">
            <span><i className="public-key" /> Public</span>
            <span><i className="route-key" /> Accessible route</span>
            <span><i className="review-key" /> Review</span>
          </div>
          {selected && (
            <div className="route-caption">
              <span className="route-number">01</span>
              <div><small>Active rehearsal</small><strong>Main entrance → {selected.label}</strong></div>
              <div className="route-stats">
                <span><strong>{Math.round(routeDistance)} m</strong><small>distance</small></span>
                <span><strong>{Math.max(1, Math.round(routeDistance / 1.1))} min</strong><small>walking</small></span>
                <b className={blockedBy || !route.length ? "blocked" : ""}>
                  {blockedBy
                    ? `Blocked at ${blockedBy}`
                    : route.length
                      ? "Step-free"
                      : "No step-free route"}
                </b>
              </div>
            </div>
          )}
          <div className="orbit-hint"><i /> Drag to orbit · Scroll to zoom</div>
        </section>

        <aside className="inspector" data-tour="inspector">
          <div className="inspector-head">
            <div><span className="live-dot" /> Spatial intelligence</div>
            <span className="run-time">{extracting ? "Extracting…" : ingestionRun ? ingestionRun.status : "Demo"}</span>
          </div>

          <div className="score">
            <div className="score-ring"><strong>{Math.round(
              (scene.rooms.concat().reduce((total, room) => total + room.confidence, 0) /
                Math.max(1, scene.rooms.length)) * 100
            )}</strong><span>%</span><i /></div>
            <div><strong>Extraction confidence</strong><small>{scene.review.status === "approved" ? "Approved scene" : "Ready for human review"}</small></div>
          </div>

          <div className="metric-grid">
            <div><strong>{scene.rooms.length}</strong><span>Rooms</span></div>
            <div><strong>{scene.landmarks.length}</strong><span>Landmarks</span></div>
            <div><strong>{scene.doors.length}</strong><span>Validated doors</span></div>
            <div><strong>{lowConfidence}</strong><span>Check needed</span></div>
          </div>

          <div className="section-label">Review queue</div>
          {scene.review.issues.length === 0 && (
            <div className="review-card"><span>—</span><div><strong>No open issues</strong><small>Scene is clean</small></div></div>
          )}
          {scene.review.issues.map((issue, index) => {
            const done = resolvedIssues.includes(issue.id);
            return (
              <div className={done ? "review-card resolved" : "review-card"} key={issue.id}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <div><strong>{issue.message}</strong><small>{issue.severity} priority</small></div>
                <button disabled={done || approving} onClick={() => void resolveIssue(issue.id)}>
                  {approving ? "…" : done ? "✓ Done" : "Resolve"}
                </button>
              </div>
            );
          })}

          <div className="section-label">Pipeline provenance</div>
          <ol className="pipeline">
            <li className={ingestionRun ? "done" : ""}><span /><div><strong>Plan normalized</strong><small>{storageLabel} · SHA verified</small></div></li>
            <li className={liveScene ? "done" : extracting ? "active" : ""}><span>2</span><div><strong>Agentic extraction</strong><small>Gemini × topology gate · lineage kept</small></div></li>
            <li className={ingestionRun?.status === "approved" ? "done" : liveScene ? "active" : ""}><span>3</span><div><strong>Human review</strong><small>{scene.review.issues.length} decision(s) remaining</small></div></li>
            <li className={ingestionRun?.status === "approved" ? "done" : ""}><span>4</span><div><strong>Publish to B2</strong><small>{ingestionRun?.status === "approved" ? "Approved" : "Awaiting approval"}</small></div></li>
          </ol>
          <div className="provenance-foot"><span>Immutable run manifest</span><strong>{ingestionRun?.runId ?? "run_demo"}</strong></div>
        </aside>
      </section>
      {showTour && (
        <Tour
          onDone={() => {
            setShowTour(false);
            localStorage.setItem(TOUR_STORAGE_KEY, "1");
          }}
        />
      )}
    </main>
  );
}
