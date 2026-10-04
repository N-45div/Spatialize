"""Measure the evidence agent against the live Sanity project and Context Knowledge Base.

For each question the computed verdict is fixed first; the agent then answers with the Knowledge Base.
A run passes when the agent made a successful knowledge_base_read, stated the computed verdict, never
stated a different one, and cited at least one evidence source by title. Writes nothing but one
diagnostic run document. Results go to agent-eval.json.

  python scripts/agent-eval.py [repeats]
"""

import json
import re
import statistics
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
from fastapi.testclient import TestClient
from spatialize_api.app import create_app
from spatialize_api.config import Settings

QUESTIONS = [
    ("studio-mark", 800, "Can I reach the learning studio from the entrance?"),
    ("studio-mark", 1300, "My wheelchair needs 1300 mm of clear width. Can I get into the learning studio?"),
    ("gallery-mark", 800, "Is the gallery reachable today?"),
    ("quiet-mark", 800, "Is the quiet room step-free?"),
    ("quiet-mark", 800, "Has anyone disagreed with the venue about access to the quiet room?"),
    ("gallery-mark", 800, "Was the gallery closed for maintenance, and does that still apply?"),
]
VERDICTS = ("CLEAR", "BLOCKED", "UNKNOWN")


def judge(result):
    text = result["agentSummary"] or ""
    # Verdicts are written in capitals; "clear width" or "treated as clear" is not a verdict.
    stated = {v for v in VERDICTS if re.search(rf"\b{v}\b", text)}
    titles = [s["title"] for s in result["evidence"] if not s["id"].startswith("scene-")]
    read = any(c["tool"] == "knowledge_base_read" and c["successful"] for c in result["contextReads"])
    return {
        "knowledgeBaseRead": read,
        "statesVerdict": result["verdict"] in stated,
        "statesOtherVerdict": bool(stated - {result["verdict"]}),
        "citesSource": any(t.lower() in text.lower() for t in titles) if titles else None,
    }


def main():
    repeats = int(sys.argv[1]) if len(sys.argv) > 1 else 2
    settings = Settings(storage_backend="local", local_data_dir=ROOT / "backend/.local-data-live")
    if not (settings.sanity_context_url and settings.sanity_context_token and settings.openai_api_key):
        raise SystemExit("Configure SANITY_CONTEXT_URL, SANITY_CONTEXT_TOKEN and OPENAI_API_KEY first.")
    runs = []
    with TestClient(create_app(settings=settings)) as client:
        run = client.post("/api/runs/demo").json()["runId"]
        path = f"/api/runs/{run}/access/check"
        client.get(f"/api/runs/{run}/access").raise_for_status()
        for repeat in range(repeats):
            for destination, width, question in QUESTIONS:
                began = time.time()
                result = client.post(path, json={"destinationId": destination, "clearanceMm": width,
                                                 "question": question, "useAgent": True}).json()
                seconds = round(time.time() - began, 1)
                verdict = judge(result) if result["agentStatus"] == "connected" else {}
                runs.append({"question": question, "clearanceMm": width, "verdict": result["verdict"],
                             "agentStatus": result["agentStatus"], "seconds": seconds, "answer": result["agentSummary"],
                             "paths": [json.loads(c["arguments"] or "{}").get("paths") for c in result["contextReads"]
                                       if c["tool"] == "knowledge_base_read"], **verdict})
                print(f"{repeat + 1}. {result['verdict']:8} {result['agentStatus']:11} {seconds:5.1f}s  {question}", flush=True)
    connected = [r for r in runs if r["agentStatus"] == "connected"]
    count = lambda key: sum(1 for r in connected if r.get(key))
    summary = {
        "model": settings.openai_agent_model,
        "endpoint": settings.sanity_context_url,
        "runs": len(runs),
        "connected": len(connected),
        "knowledgeBaseRead": count("knowledgeBaseRead"),
        "statesComputedVerdict": count("statesVerdict"),
        "statesADifferentVerdict": count("statesOtherVerdict"),
        "citesASourceByTitle": count("citesSource"),
        "medianSeconds": round(statistics.median(r["seconds"] for r in runs), 1),
        "maxSeconds": max(r["seconds"] for r in runs),
    }
    (ROOT / "agent-eval.json").write_text(json.dumps({"summary": summary, "runs": runs}, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
