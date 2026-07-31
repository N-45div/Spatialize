import { useEffect, useState } from "react";

const STEPS = [
  {
    target: "viewport",
    title: "A living floor plan",
    body: "This 3D twin was compiled from a validated scene contract. Drag to orbit, scroll to zoom, or flip to Plan view."
  },
  {
    target: "ask",
    title: "Talk to the venue",
    body: "A demo venue is already loaded, so the voice agent is live. Hold a conversation, or type: “How far is the studio from the entrance?”"
  },
  {
    target: "ask",
    title: "Edit by speaking",
    body: "Try: “Mark the gallery door as not accessible.” The scene updates only if the change passes the topology gate — and it warns you if a step-free route is lost."
  },
  {
    target: "inspector",
    title: "Provenance everywhere",
    body: "Every transcript, scene version, and narration lands in Backblaze B2 with a SHA-256 genblaze manifest. Publishing stays human-approved."
  },
  {
    target: "source",
    title: "Bring your own plan",
    body: "Upload any floor plan (PNG, JPEG, WebP, PDF). An agentic Gemini loop extracts it, the gate validates it, and the twin rebuilds in about a minute."
  }
];

export function Tour({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const current = STEPS[step];

  useEffect(() => {
    const element = document.querySelector(`[data-tour="${current.target}"]`);
    element?.classList.add("tour-highlight");
    element?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    return () => element?.classList.remove("tour-highlight");
  }, [current.target]);

  function advance() {
    if (step + 1 >= STEPS.length) onDone();
    else setStep(step + 1);
  }

  return (
    <div className="tour-card" role="dialog" aria-label="Product tour">
      <div className="tour-progress">
        {STEPS.map((item, index) => (
          <i key={item.title + index} className={index <= step ? "on" : ""} />
        ))}
      </div>
      <strong>{current.title}</strong>
      <p>{current.body}</p>
      <div className="tour-actions">
        <button className="tour-skip" onClick={onDone}>Skip tour</button>
        <button className="tour-next" onClick={advance}>
          {step + 1 >= STEPS.length ? "Start exploring" : "Next"}
        </button>
      </div>
    </div>
  );
}
