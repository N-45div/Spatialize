import {
  ArrowRightIcon, BooksIcon, CheckCircleIcon, CubeIcon, DatabaseIcon, FingerprintIcon, GithubLogoIcon,
  MicrophoneIcon, PathIcon, QuestionIcon, RobotIcon, RulerIcon, ShieldCheckIcon, UserCheckIcon, WarningCircleIcon
} from "@phosphor-icons/react";
import "../landing.css";

const REPO = "https://github.com/N-45div/Spatialize";
const DATASET = "https://tubqyqod.api.sanity.io/v2026-09-01/data/query/production?query=*%5B_type%3D%3D%22accessClaim%22%5D%7Bproperty%2CstepFree%2Cstatus%2C%22about%22%3Aentity-%3Etitle%2C%22source%22%3Asource-%3Etitle%7D";

const steps = [
  { icon: CubeIcon, title: "A plan becomes a twin", text: "A vision model drafts rooms, doors and routes from a floor plan. A deterministic topology gate rejects anything inconsistent, so broken geometry never ships." },
  { icon: DatabaseIcon, title: "Evidence lives in Sanity", text: "Every access claim cites a source and carries a review status: verified, unverified or disputed. Closures have dates. Obstacles have footprints." },
  { icon: RulerIcon, title: "Your route, your width", text: "Pick a destination and the clear width you need. The route is screened door by door and obstacle by obstacle, and the answer says why." },
  { icon: UserCheckIcon, title: "People approve changes", text: "Agents and visitors can propose. A move is previewed for every room first, and nothing is published until a reviewer says so." }
];

const toolGroups = [
  ["Ask", ["get_venue_overview", "list_destinations", "describe_room", "list_data_issues", "list_disputed_claims"]],
  ["Check", ["find_step_free_route", "check_route_clearance", "check_accessibility"]],
  ["Propose, then a person decides", ["propose_access_change", "propose_doorway", "propose_landmark", "propose_label_correction"]],
  ["What-if", ["simulate_closure", "focus_view"]]
] as const;

export function Landing({ onEnter }: { onEnter: () => void }) {
  return (
    <main className="lp">
      <nav className="lp-nav" aria-label="Main">
        <a className="lp-brand" href="/">
          <CubeIcon size={30} weight="duotone" aria-hidden="true" />
          <span>Spatialize<small>Spatial access studio</small></span>
        </a>
        <div className="lp-nav-links">
          <a href="#how">How it works</a>
          <a href="#evidence">Evidence</a>
          <a href="#agents">For agents</a>
          <a href={REPO} target="_blank" rel="noreferrer"><GithubLogoIcon size={18} aria-hidden="true" /> GitHub</a>
          <button className="lp-cta small" onClick={onEnter}>Open the studio</button>
        </div>
      </nav>

      <header className="lp-hero">
        <div className="lp-hero-copy">
          <span className="lp-eyebrow">Floor plans · sourced evidence · agents</span>
          <h1>Can I get there?<em>Ask the building. It shows its evidence.</em></h1>
          <p>
            Spatialize turns a flat floor plan into a validated 3D twin, checks a route against
            your clear width, and keeps every access claim sourced and reviewable in Sanity.
            When sources disagree, the answer is <b>UNKNOWN</b>, not a confident guess.
          </p>
          <div className="lp-actions">
            <button className="lp-cta" onClick={onEnter}>Try the live studio <ArrowRightIcon size={18} aria-hidden="true" /></button>
            <a className="lp-link" href={`${REPO}#readme`} target="_blank" rel="noreferrer">Read how it works</a>
          </div>
          <dl className="lp-verdicts" aria-label="Possible answers">
            <div className="clear"><dt><CheckCircleIcon size={18} weight="fill" aria-hidden="true" />CLEAR</dt><dd>The stored route passes your width</dd></div>
            <div className="blocked"><dt><WarningCircleIcon size={18} weight="fill" aria-hidden="true" />BLOCKED</dt><dd>A door, closure or obstacle stops it</dd></div>
            <div className="unknown"><dt><QuestionIcon size={18} weight="fill" aria-hidden="true" />UNKNOWN</dt><dd>The evidence is unconfirmed or disputed</dd></div>
          </dl>
        </div>
        <figure className="lp-shot">
          <div className="lp-shot-frame">
            <div className="lp-shot-bar" aria-hidden="true"><i /><i /><i /><span>spatialize-pink.vercel.app/#studio</span></div>
            <img src="/landing/quiet-answer.webp" width="1600" height="956"
              alt="The studio: a 3D floor plan with the route to the quiet room, an UNKNOWN verdict, and the evidence agent setting a venue guide beside a disputed visitor report." />
          </div>
          <div className="lp-chip verdict"><QuestionIcon size={18} weight="fill" aria-hidden="true" /> UNKNOWN · sources disagree</div>
          <div className="lp-chip call"><BooksIcon size={18} aria-hidden="true" /> knowledge_base_read · 4 entries</div>
          <figcaption>Live app. Harbor Arts Centre is a fictional demo venue with synthetic evidence.</figcaption>
        </figure>
      </header>

      <section id="how" className="lp-section">
        <h2>From a flat plan to an answer you can check</h2>
        <ol className="lp-steps">
          {steps.map(({ icon: Icon, title, text }, i) => (
            <li key={title}>
              <span className="lp-step-n">0{i + 1}</span>
              <Icon size={28} weight="duotone" aria-hidden="true" />
              <h3>{title}</h3>
              <p>{text}</p>
            </li>
          ))}
        </ol>
      </section>

      <section id="evidence" className="lp-section lp-split">
        <div>
          <span className="lp-eyebrow">Sanity Content Lake · Studio · Context</span>
          <h2>Evidence is data, not prose</h2>
          <p>
            Sources, claims, dated closures and obstacles are typed documents. The route check reads
            them on every request: a verified closure blocks, an unverified one makes the answer
            UNKNOWN, and an expired one is ignored. Disagreeing sources both stay on record.
          </p>
          <p>
            The evidence agent reads a <b>Sanity Context Knowledge Base</b> built from those same
            documents, with each source carrying the claims it backs and their status. When the
            Knowledge Base was built, Context flagged the quiet-room dispute by itself, and a
            standing instruction keeps both sides visible.
          </p>
          <a className="lp-link" href={DATASET} target="_blank" rel="noreferrer">Query the public dataset</a>
        </div>
        <div className="lp-doc" aria-label="An access claim document">
          <div className="lp-doc-head"><span>accessClaim</span><small>claim-report</small></div>
          <dl>
            <div><dt>entity</dt><dd>Quiet-room doorway</dd></div>
            <div><dt>property</dt><dd>step-free</dd></div>
            <div><dt>stepFree</dt><dd>false</dd></div>
            <div><dt>source</dt><dd>Visitor report: quiet-room threshold · 2 Oct</dd></div>
            <div><dt>status</dt><dd><mark>disputed</mark></dd></div>
          </dl>
          <p className="lp-doc-note">The venue guide says the same doorway is step-free. Both claims stay; nobody has measured.</p>
        </div>
      </section>

      <section className="lp-section lp-agent">
        <div className="lp-agent-copy">
          <span className="lp-eyebrow">Evidence agent</span>
          <h2>It explains the verdict. It can’t overrule it.</h2>
          <p>
            The verdict is computed first and handed to the agent as authoritative. The agent then
            calls the Knowledge Base through Sanity Context’s MCP endpoint and sets the sources side
            by side, with dates. Every call it made is shown in the app.
          </p>
          <ul className="lp-calls">
            <li><CheckCircleIcon size={18} weight="fill" aria-hidden="true" /><code>initial_context</code></li>
            <li><CheckCircleIcon size={18} weight="fill" aria-hidden="true" /><code>knowledge_base_read</code><small>disputed_reports, doorway_access, venue_guide, visitor_reports</small></li>
          </ul>
        </div>
        <blockquote>
          <p>“Harbor Arts access guide (observed 2026-09-18) states that the quiet-room doorway is step-free… Visitor report: quiet-room threshold (observed 2026-10-02) reports a raised threshold; the venue disputes it, and no follow-up measurement exists… Neither claim is settled.”</p>
          <footer>The live agent’s answer, abridged</footer>
        </blockquote>
      </section>

      <section className="lp-section lp-split reverse">
        <figure className="lp-shot plain">
          <div className="lp-shot-frame">
            <img src="/landing/move-preview.webp" width="1600" height="956"
              alt="A rehearsed obstacle move: a mint ghost shows the trolley's new place, and the panel lists each room's verdict before and after." />
          </div>
        </figure>
        <div>
          <span className="lp-eyebrow">Reviewed changes</span>
          <h2>Rehearse first. A person approves.</h2>
          <ul className="lp-list">
            <li><PathIcon size={20} aria-hidden="true" />A preview shows every room’s verdict before and after, and publishes nothing.</li>
            <li><UserCheckIcon size={20} aria-hidden="true" />A reviewer approves or declines with a reason; the approval becomes a dated source.</li>
            <li><ShieldCheckIcon size={20} aria-hidden="true" />Publication is versioned and revision-checked, so two reviewers can’t publish over each other.</li>
            <li><WarningCircleIcon size={20} aria-hidden="true" />A declined report stays on record as a dispute. A venue can disagree, not delete.</li>
          </ul>
        </div>
      </section>

      <section id="agents" className="lp-section">
        <span className="lp-eyebrow">For agents</span>
        <h2>Fourteen tools in the browser. Nothing they say goes live.</h2>
        <p className="lp-lede">
          In a WebMCP browser the studio registers fourteen tools on <code>document.modelContext</code>.
          Every write is a proposal: checked by the topology gate, applied by the server to its own
          copy, priced in real-world impact, and decided by a person.
        </p>
        <div className="lp-tools">
          {toolGroups.map(([group, tools]) => (
            <div key={group}>
              <h3><RobotIcon size={20} aria-hidden="true" />{group}</h3>
              <p>{tools.map(tool => <code key={tool}>{tool}</code>)}</p>
            </div>
          ))}
        </div>
        <div className="lp-voice">
          <MicrophoneIcon size={26} weight="duotone" aria-hidden="true" />
          <p><b>Or just say it.</b> A spoken “mark the gallery door inaccessible” goes through the same review as an agent’s proposal, with the sentence kept as its provenance.</p>
        </div>
      </section>

      <section className="lp-section lp-proof" aria-label="Measured">
        <div><b>109 + 65</b><span>frontend and backend tests</span></div>
        <div><b>5</b><span>Chrome journeys, end to end</span></div>
        <div><b>20 / 20</b><span>right tool chosen by a real model</span></div>
        <div><b>13 / 13</b><span>steps through Chrome’s own WebMCP host</span></div>
        <div><FingerprintIcon size={22} aria-hidden="true" /><span>SHA-256 manifests for every plan, scene and recording</span></div>
      </section>

      <footer className="lp-foot">
        <div className="lp-foot-cta">
          <h2>See it on a real floor plan.</h2>
          <button className="lp-cta" onClick={onEnter}>Open the studio <ArrowRightIcon size={18} aria-hidden="true" /></button>
        </div>
        <p>
          <ShieldCheckIcon size={18} aria-hidden="true" /> Rehearsal guidance only. CLEAR is a screening result for the stored
          route, not an accessibility certificate: turning space, slope, headroom and unrecorded obstacles are not assessed.
          Harbor Arts Centre is a fictional demo venue.
        </p>
        <nav aria-label="Project">
          <a href={REPO} target="_blank" rel="noreferrer">GitHub</a>
          <a href={`${REPO}/blob/main/ACCESS_DESK.md`} target="_blank" rel="noreferrer">Access Desk docs</a>
          <a href={`${REPO}/blob/main/ARCHITECTURE.md`} target="_blank" rel="noreferrer">Architecture</a>
          <a href="https://spatialize-tubqyqod.sanity.studio/" target="_blank" rel="noreferrer">Sanity Studio</a>
          <span>MIT licence</span>
        </nav>
      </footer>
    </main>
  );
}
