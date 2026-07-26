import { useMemo, useState } from "react";
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
  const route = useMemo(() => routeToLandmark(sampleScene, destination), [destination]);
  const selected = sampleScene.landmarks.find((item) => item.id === destination)!;
  const lowConfidence = [...sampleScene.rooms, ...sampleScene.landmarks]
    .filter((item) => item.confidence < 0.85).length;

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="/">
          <span className="brand-mark">S</span>
          <span>Spatialize</span>
        </a>
        <div className="topbar-copy">Plans you can explore, hear and touch.</div>
        <div className="status-pill"><span /> Foundation prototype</div>
      </header>

      <section className="workspace">
        <aside className="sidebar">
          <div className="eyebrow">Spatial package · 01</div>
          <h1>{sampleScene.name}</h1>
          <p className="lede">
            A flat venue plan compiled into an accessible spatial experience.
          </p>

          <div className="source-card">
            <div className="source-thumb">
              <span>PDF</span>
              <div className="mini-plan"><i /><i /><i /></div>
            </div>
            <div>
              <strong>ground-floor-plan.pdf</strong>
              <small>Interpreted locally · sample data</small>
            </div>
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
                <b>↗</b>
              </button>
            ))}
          </div>

          <button className="primary-action" onClick={downloadScene}>
            Export spatial package <span>↓</span>
          </button>
        </aside>

        <section className="viewport">
          <SpatialCanvas scene={sampleScene} route={route} />
          <div className="viewport-head">
            <div><span>Interactive model</span><strong>Ground floor</strong></div>
            <div className="view-controls"><button>3D</button><button disabled>2D</button></div>
          </div>
          <div className="route-caption">
            <span className="route-icon">⌁</span>
            <div>
              <small>Active rehearsal</small>
              <strong>Main entrance → {selected.label}</strong>
            </div>
            <span className="route-ready">Route ready</span>
          </div>
          <div className="orbit-hint">Drag to orbit · Scroll to zoom</div>
        </section>

        <aside className="inspector">
          <div className="inspector-head">
            <div><span className="live-dot" /> Spatial intelligence</div>
            <button aria-label="More options">•••</button>
          </div>

          <div className="score">
            <div className="score-ring"><strong>92</strong><span>%</span></div>
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
              <span>!</span>
              <div><strong>{issue.message}</strong><small>Model confidence 78% · medium priority</small></div>
            </div>
          ))}

          <div className="section-label">Pipeline</div>
          <ol className="pipeline">
            <li className="done"><span>✓</span><div><strong>Plan normalized</strong><small>Image asset</small></div></li>
            <li className="done"><span>✓</span><div><strong>Space interpreted</strong><small>Scene schema v1.0</small></div></li>
            <li className="active"><span>3</span><div><strong>Human review</strong><small>1 decision remaining</small></div></li>
            <li><span>4</span><div><strong>Publish to B2</strong><small>Awaiting approval</small></div></li>
          </ol>
        </aside>
      </section>
    </main>
  );
}
