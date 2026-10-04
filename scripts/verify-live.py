"""Run the access-desk journey against the live Sanity project and Context endpoint.

Uses the credentials in the root .env (never printed) and the API in-process. It writes one
diagnostic run to the dataset, approves one synthetic obstacle move there, then asks the
evidence agent about the quiet room. The summary goes to sanity-live-verification.json.

  python scripts/verify-live.py
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
from fastapi.testclient import TestClient
from spatialize_api.app import create_app
from spatialize_api.config import Settings


def main():
    settings = Settings(storage_backend="local", local_data_dir=ROOT / "backend/.local-data-live")
    if not (settings.sanity_project_id and settings.sanity_api_token):
        raise SystemExit("Set SANITY_PROJECT_ID and SANITY_API_TOKEN in the root .env first.")
    with TestClient(create_app(settings=settings)) as client:
        run = client.post("/api/runs/demo").json()["runId"]
        path = f"/api/runs/{run}/access"
        snapshot = client.get(path).json()
        assert snapshot["contentMode"] == "sanity", snapshot

        def verdict(destination, width=800):
            return client.post(path + "/check", json={"destinationId": destination, "clearanceMm": width}).json()[
                "verdict"
            ]

        verdicts = {
            "studio-mark:800": verdict("studio-mark"),
            "studio-mark:1300": verdict("studio-mark", 1300),
            "gallery-mark:800": verdict("gallery-mark"),
        }
        move = {
            "obstacleId": "gallery-trolley", "roomId": "gallery", "position": [13.5, 5.3],
            "reason": "Live verification: clear the gallery approach",
            "baseSceneVersion": snapshot["sceneVersion"], "baseAccessVersion": snapshot["version"],
        }
        preview = client.post(path + "/preview", json=move).json()
        published_after_preview = client.get(path).json()["obstacles"][0]["position"]
        proposal = client.post(path + "/proposals", json=move).json()
        headers = {"X-Venue-Token": settings.venue_token} if settings.venue_token else {}
        client.post(
            path + f"/proposals/{proposal['id']}/decision",
            json={"decision": "approve", "reason": "Live verification of the reviewed move"},
            headers=headers,
        ).raise_for_status()
        after = client.get(path).json()
        answer = client.post(path + "/check", json={
            "destinationId": "quiet-mark", "question": "Is the quiet room step-free? Show the evidence.",
            "useAgent": True,
        }).json()
    report = {
        "projectId": settings.sanity_project_id,
        "dataset": settings.sanity_dataset,
        "contentMode": snapshot["contentMode"],
        "runId": run,
        "verdicts": verdicts,
        "previewImpact": preview["impact"],
        "previewPublished": published_after_preview != [8, 2.7],
        "persisted": {"accessVersion": after["version"], "position": after["obstacles"][0]["position"],
                      "reviews": len(after["proposals"])},
        "quietRoomVerdict": answer["verdict"],
        "contextEndpoint": settings.sanity_context_url,
        "agentModel": settings.openai_agent_model,
        "agentStatus": answer["agentStatus"],
        "contextCalls": [
            {"tool": r["tool"], "arguments": r["arguments"], "successful": r["successful"]}
            for r in answer["contextReads"]
        ],
        "agentSummary": answer["agentSummary"],
    }
    (ROOT / "sanity-live-verification.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))
    ok = (
        verdicts == {"studio-mark:800": "CLEAR", "studio-mark:1300": "BLOCKED", "gallery-mark:800": "BLOCKED"}
        and not report["previewPublished"] and after["version"] == 2 and answer["verdict"] == "UNKNOWN"
        and answer["agentStatus"] == "connected"
    )
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
