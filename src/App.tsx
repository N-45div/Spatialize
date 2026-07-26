import { useMemo, useRef, useState } from "react";
import { SpatialCanvas } from "./components/SpatialCanvas";
import { sampleScene } from "./data/sample-scene";
import { routeToLandmark } from "./lib/routes";

function downloadScene() {
  const blob = new Blob([JSON.stringify(sampleScene, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${sampleScene.id}.scene.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export default function App() {
  const destinations = sampleScene.landmarks.filter((item) => item.type === "destination");
  const [destination, setDestination] = useState(destinations[0].id);
  const [viewMode, setViewMode] = useState<"3d" | "2d">("3d");
  const [isSpeaking, setIsSpeaking] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const route = useMemo(() => routeToLandmark(sampleScene, destination), [destination]);
  const selected = sampleScene.landmarks.find((item) => item.id === destination)!;
  const lowConfidence = [...sampleScene.rooms, ...sampleScene.landmarks]
    .filter((item) => item.confidence < 0.85).length;
  const routeDistance = useMemo(() => route.slice(1).reduce((total, point, index) => {
    const previous = route[index];
    return total + Math.hypot(point[0] - previous[0], point[1] - previous[1]);
  }, 0), [route]);

  function narrateRoute() {
    if (!("speechSynthesis" in window)) return;
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

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="/">
          <span className="brand-mark"><i /><i /><i /></span>
          <span>Spatialize<small>Spatial media studio</small></span>
        </a>
        <div className="topbar-copy"><span>Projects</span><b>/</b><strong>Harbor Arts Centre</strong></div>
        <div className="topbar-actions">
          <div className="b2-state"><span /> Synced to B2 <small>12 assets</small></div>
          <button className="share-action" onClick={downloadScene}>Share package</button>
        </div>
      </header>

      <section className="workspace">
        <aside className="sidebar">
          <div className="eyebrow"><span>Project 01</span><b>Scene v1.4</b></div>
          <h1>{sampleScene.name}</h1>
          <p className="lede">A flat venue plan transformed into a navigable, accessible spatial twin.</p>

          <button className="source-card" onClick={() => fileInput.current?.click()}>
            <div className="source-thumb">
              <span>PDF</span>
              <div className="mini-plan"><i /><i /><i /></div>
            </div>
            <div><strong>ground-floor-plan.pdf</strong><small>2.8 MB · 2480 × 1754</small></div>
            <span className="replace-label">Replace</span>
          </button>
          <input ref={fileInput} type="file" hidden accept="image/*,.pdf" />

          <div className="compile-proof">
            <span>Generated with Genblaze</span>
            <div><i /> 6 rooms</div><div><i /> 9 route nodes</div><div><i /> 5 landmarks</div>
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
          <SpatialCanvas scene={sampleScene} route={route} selectedId={destination} mode={viewMode} />
          <div className="viewport-glow" />
          <div className="viewport-head">
            <div><span>Interactive spatial twin</span><strong>Ground floor · Accessible view</strong></div>
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
          <div className="route-caption">
            <span className="route-number">01</span>
            <div><small>Active rehearsal</small><strong>Main entrance → {selected.label}</strong></div>
            <div className="route-stats">
              <span><strong>{Math.round(routeDistance)} m</strong><small>distance</small></span>
              <span><strong>{Math.max(1, Math.round(routeDistance / 1.1))} min</strong><small>walking</small></span>
              <b>Step-free</b>
            </div>
          </div>
          <div className="orbit-hint"><i /> Drag to orbit · Scroll to zoom</div>
        </section>

        <aside className="inspector">
          <div className="inspector-head">
            <div><span className="live-dot" /> Spatial intelligence</div>
            <span className="run-time">Run 00:18</span>
          </div>

          <div className="score">
            <div className="score-ring"><strong>92</strong><span>%</span><i /></div>
            <div><strong>Extraction confidence</strong><small>Ready for human review</small></div>
          </div>

          <div className="metric-grid">
            <div><strong>{sampleScene.rooms.length}</strong><span>Rooms</span></div>
            <div><strong>{sampleScene.landmarks.length}</strong><span>Landmarks</span></div>
            <div><strong>{sampleScene.routeGraph.edges.length}</strong><span>Connections</span></div>
            <div><strong>{lowConfidence}</strong><span>Check needed</span></div>
          </div>

          <div className="section-label">Review queue</div>
          {sampleScene.review.issues.map((issue) => (
            <div className="review-card" key={issue.id}>
              <span>01</span>
              <div><strong>{issue.message}</strong><small>Confidence 78% · medium priority</small></div>
              <button>Review</button>
            </div>
          ))}

          <div className="section-label">Pipeline provenance</div>
          <ol className="pipeline">
            <li className="done"><span /><div><strong>Plan normalized</strong><small>B2 source asset · SHA verified</small></div><time>04s</time></li>
            <li className="done"><span /><div><strong>Space interpreted</strong><small>Genblaze · scene schema v1.0</small></div><time>11s</time></li>
            <li className="active"><span>3</span><div><strong>Human review</strong><small>1 decision remaining</small></div></li>
            <li><span>4</span><div><strong>Publish to B2</strong><small>Awaiting approval</small></div></li>
          </ol>
          <div className="provenance-foot"><span>Immutable run manifest</span><strong>run_7F2A91</strong></div>
        </aside>
      </section>
    </main>
  );
}
