export function Landing({ onEnter }: { onEnter: () => void }) {
  return (
    <main className="landing">
      <div className="landing-aurora" aria-hidden />
      <nav className="landing-nav">
        <a className="brand" href="/">
          <span className="brand-mark"><i /><i /><i /></span>
          <span>Spatialize<small>Spatial media studio</small></span>
        </a>
        <div className="landing-nav-actions">
          <a href="https://github.com/N-45div/Spatialize" target="_blank" rel="noreferrer">
            GitHub
          </a>
          <button className="landing-cta small" onClick={onEnter}>Open the studio</button>
        </div>
      </nav>

      <section className="hero">
        <div className="hero-copy">
          <span className="hero-eyebrow">Backblaze Generative Media Hackathon · Genblaze × B2</span>
          <h1>
            Speak to a floor plan.
            <em>It answers. It builds itself.</em>
          </h1>
          <p>
            Spatialize turns a flat venue plan into an explorable, audible,
            voice-editable spatial twin. Ask for a route and hear step-free
            guidance. Say “the gallery door has steps” and watch the 3D scene
            update — only if the change survives a machine-checked topology gate.
          </p>
          <div className="hero-actions">
            <button className="landing-cta" onClick={onEnter}>
              Try the live studio <i>→</i>
            </button>
            <a
              className="hero-secondary"
              href="https://github.com/N-45div/Spatialize/blob/main/ARCHITECTURE.md"
              target="_blank"
              rel="noreferrer"
            >
              Read the architecture
            </a>
          </div>
          <div className="hero-baseline">
            <span><b>SHA-256</b> provenance on every artifact</span>
            <span><b>0</b> unvalidated vertices shipped</span>
            <span><b>100%</b> answers grounded in geometry</span>
          </div>
        </div>

        <div className="hero-visual" aria-hidden>
          <div className="plan-card">
            <div className="plan-grid" />
            <div className="plan-room r1"><span>LOBBY</span></div>
            <div className="plan-room r2"><span>GALLERY</span></div>
            <div className="plan-room r3"><span>CAFE</span></div>
            <div className="plan-room r4"><span>WC</span></div>
            <svg className="plan-route" viewBox="0 0 300 190">
              <path d="M22 108 L92 108 L92 62 L188 62 L188 118 L262 118" />
            </svg>
            <i className="plan-dot d1" />
            <i className="plan-dot d2" />
          </div>
          <div className="float-chip voice-chip">
            <i className="audio-bars"><b /><b /><b /></i>
            “How far is the restroom?”
            <small>32 m · step-free · spoken back</small>
          </div>
          <div className="float-chip manifest-chip">
            manifest <b>71062c46…</b> <small>verified · stored in B2</small>
          </div>
        </div>
      </section>

      <section className="feature-row">
        <article>
          <span className="feature-index">01</span>
          <h3>Agentic extraction</h3>
          <p>
            A genblaze <b>AgentLoop</b> lets a vision model propose the scene —
            and a deterministic topology validator dispose. Failed geometry
            returns as the next prompt. Broken scenes cannot ship.
          </p>
        </article>
        <article>
          <span className="feature-index">02</span>
          <h3>Voice-editable twin</h3>
          <p>
            AssemblyAI hears you, a LangGraph agent acts through gated tools,
            Gemini speaks back. Sever a step-free route and the venue
            <b> warns you out loud</b>.
          </p>
        </article>
        <article>
          <span className="feature-index">03</span>
          <h3>Provenance everywhere</h3>
          <p>
            Every plan, scene version, transcript, and narration lands in
            <b> Backblaze B2</b> with a SHA-256 genblaze manifest. Any vertex
            traces to a model run or a human utterance.
          </p>
        </article>
      </section>

      <section className="pipeline-strip" aria-label="Pipeline">
        <span>plan</span><i>→</i>
        <span>vision × AgentLoop</span><i>→</i>
        <span>topology gate</span><i>→</i>
        <span>human review</span><i>→</i>
        <span>voice Q&amp;A + edits</span><i>→</i>
        <span>B2 manifests</span>
      </section>

      <footer className="landing-foot">
        Rehearsal guidance only — no live-navigation or safety claims.
        Publishing is human-approved.
      </footer>
    </main>
  );
}
