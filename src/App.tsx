import { useEffect, useMemo, useRef, useState } from "react";
import { Landing } from "./components/Landing";
import { SpatialCanvas } from "./components/SpatialCanvas";
import { sampleScene } from "./data/sample-scene";
import { SpatialSceneSchema, type SpatialScene } from "./domain/spatial-scene";
import {
  askVenue,
  createIngestionRun,
  extractRun,
  fetchScene,
  resolveAssetUrl,
  type AskResponse,
  type IngestionRun
} from "./lib/api";
import { routeToLandmark } from "./lib/routes";

type Conversation = {
  question: string;
  answer: string;
  audioUrl: string | null;
  mutations: { kind: string; summary: string }[];
  warnings: string[];
  manifestHash?: string;
};

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
  const destinations = scene.landmarks.filter((item) => item.type === "destination");
  const [destination, setDestination] = useState(destinations[0]?.id ?? "");
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
  const fileInput = useRef<HTMLInputElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const answerAudioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (destinations.length && !destinations.some((item) => item.id === destination)) {
      setDestination(destinations[0].id);
    }
  }, [scene.id, destinations, destination]);

  useEffect(() => {
    const onHashChange = () =>
      setView(window.location.hash === "#studio" ? "studio" : "landing");
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const route = useMemo(
    () => (destination ? routeToLandmark(scene, destination) : []),
    [scene, destination]
  );
  const selected = scene.landmarks.find((item) => item.id === destination);
  const lowConfidence = [...scene.rooms, ...scene.doors, ...scene.landmarks].filter(
    (item) => item.confidence < 0.85
  ).length;
  const routeDistance = useMemo(
    () =>
      route.slice(1).reduce((total, point, index) => {
        const previous = route[index];
        return total + Math.hypot(point[0] - previous[0], point[1] - previous[1]);
      }, 0),
    [route]
  );

  if (view === "landing") {
    return <Landing onEnter={() => { window.location.hash = "#studio"; }} />;
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

  function narrateRoute() {
    if (!selected || !("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    if (isSpeaking) {
      setIsSpeaking(false);
      return;
    }
    const narration = new SpeechSynthesisUtterance(
      `Route to ${selected.label}. Travel ${Math.round(routeDistance)} metres from the main entrance. The accessible route is highlighted in amber.`
    );
    narration.rate = 0.92;
    narration.onend = () => setIsSpeaking(false);
    setIsSpeaking(true);
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
        mutations: [],
        warnings: response.warnings
      });
      return;
    }
    const audioUrl = resolveAssetUrl(response.audio?.url);
    setConversation({
      question: response.question ?? question,
      answer: response.answer?.script ?? "",
      audioUrl,
      mutations: response.mutations.map(({ kind, summary }) => ({ kind, summary })),
      warnings: response.warnings,
      manifestHash: response.audio?.manifestHash
    });
    if (response.sceneChanged && ingestionRun) {
      void reloadScene(ingestionRun.runId);
    }
    if (audioUrl) {
      answerAudioRef.current?.pause();
      const audio = new Audio(audioUrl);
      answerAudioRef.current = audio;
      void audio.play().catch(() => undefined);
    } else if (response.answer?.script && "speechSynthesis" in window) {
      const fallback = new SpeechSynthesisUtterance(response.answer.script);
      fallback.rate = 0.95;
      window.speechSynthesis.speak(fallback);
    }
  }

  async function submitAsk(input: { text?: string; audio?: Blob; audioType?: string }) {
    if (!ingestionRun) return;
    setAsking(true);
    try {
      const question = input.text ?? "(voice question)";
      const response = await askVenue(ingestionRun.runId, input);
      applyAskResponse(question, response);
      setAskText("");
    } catch (error) {
      setConversation({
        question: input.text ?? "(voice question)",
        answer: error instanceof Error ? error.message : "The venue could not answer.",
        audioUrl: null,
        mutations: [],
        warnings: ["request-failed"]
      });
    } finally {
      setAsking(false);
    }
  }

  async function toggleRecording() {
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

          <button className={`source-card ${uploadState}`} onClick={() => fileInput.current?.click()}>
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
          <div className="voice-panel">
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
            {conversation && (
              <div className="conversation" aria-live="polite">
                <small>You: {conversation.question}</small>
                <p>{conversation.answer}</p>
                {conversation.mutations.map((mutation) => (
                  <div className="mutation-chip" key={mutation.summary}>
                    <b>{mutation.kind}</b> {mutation.summary}
                  </div>
                ))}
                {conversation.manifestHash && (
                  <small className="manifest-note">
                    provenance {conversation.manifestHash.slice(0, 12)}…
                  </small>
                )}
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
          <button className="secondary-action" onClick={downloadScene}>
            Export scene package <span>JSON + assets</span>
          </button>
        </aside>

        <section className="viewport">
          <SpatialCanvas scene={scene} route={route} selectedId={destination} mode={viewMode} />
          <div className="viewport-glow" />
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
                <b>{route.length ? "Step-free" : "No step-free route"}</b>
              </div>
            </div>
          )}
          <div className="orbit-hint"><i /> Drag to orbit · Scroll to zoom</div>
        </section>

        <aside className="inspector">
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
          {scene.review.issues.map((issue, index) => (
            <div className="review-card" key={issue.id}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <div><strong>{issue.message}</strong><small>{issue.severity} priority</small></div>
              <button>Review</button>
            </div>
          ))}

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
    </main>
  );
}
