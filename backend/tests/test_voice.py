"""Voice pipeline tests: scene tools, the mutation gate, and the /ask endpoint."""

import json
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from spatialize_api.agents.tools import SceneSession, ToolError
from spatialize_api.agents.voice import DisabledVoiceAgent
from spatialize_api.app import create_app
from spatialize_api.config import Settings
from spatialize_api.media.pipelines import Narration, Transcript, WordTiming

from .test_api import FixtureExtractor, create_run, valid_scene


def session() -> SceneSession:
    return SceneSession(scene=valid_scene("run_test"), spoken_quote="test edit")


# ---------- read tools ----------


def test_route_between_landmarks() -> None:
    route = session().compute_route("entrance", "gallery-mark")
    assert route.node_ids == ["n0", "n1"]
    assert route.distance == pytest.approx(8)
    assert route.door_ids == ["gallery-door"]
    assert route.step_free


def test_resolve_landmark_fuzzy_and_unknown() -> None:
    tools = session()
    assert tools.resolve_landmark("galery")["match"] == "gallery-mark"
    with pytest.raises(ToolError, match="Nothing in this venue matches"):
        tools.resolve_landmark("swimming pool")


def test_describe_route_crosses_the_door() -> None:
    described = session().describe_route("entrance", "gallery-mark")
    assert described["stepFree"] is True
    assert described["doorsUsed"] == ["Gallery door"]
    assert any("Gallery door" in leg for leg in described["legs"])


# ---------- gated mutations ----------


def test_add_landmark_connects_route_graph_and_flags_review() -> None:
    tools = session()
    result = tools.add_landmark("Cafe", "destination", room_id="gallery")
    assert result["committed"] is True
    assert tools.scene["review"]["status"] == "needs-review"
    new_id = result["landmarkId"]
    route = tools.compute_route("entrance", new_id)
    assert route.distance > 0
    added = next(item for item in tools.scene["landmarks"] if item["id"] == new_id)
    assert added["evidence"]["label"]["method"] == "human"
    assert added["evidence"]["label"]["note"] == "test edit"


def test_door_accessibility_cascade_reports_severed_routes() -> None:
    tools = session()
    result = tools.set_door_accessibility("gallery-door", False)
    assert result["accessibleEdgesDisabled"] == 1
    assert "Gallery" in result["destinationsWithoutStepFreeRoute"]
    assert "warning" in result
    with pytest.raises(ToolError, match="No step-free route"):
        tools.compute_route("entrance", "gallery-mark")


def test_invalid_mutation_is_rejected_and_scene_unchanged() -> None:
    tools = session()
    before = tools.scene
    with pytest.raises(ToolError, match="landmark_type must be one of"):
        tools.add_landmark("Thing", "statue", room_id="lobby")
    with pytest.raises(ToolError, match="Specify which room"):
        tools.add_landmark("Cafe", "destination", room_id="basement")
    assert tools.scene == before
    assert not tools.mutations


# ---------- /ask endpoint with fakes ----------


class FakeTranscriber:
    def transcribe(self, audio_url: str, run_id: str) -> Transcript:
        return Transcript(
            text="add a cafe in the gallery",
            words=[WordTiming("add", 0.0, 0.2, 0.95)],
            run_id="gb_stt",
            manifest_hash="hash-stt",
        )


class MutatingFakeAgent:
    def __init__(self) -> None:
        self.last_history: list[dict] | None = None

    def answer(
        self, scene_session: SceneSession, question: str, history: list[dict] | None = None
    ) -> str:
        self.last_history = history
        scene_session.add_landmark("Cafe", "destination", room_id="gallery")
        return "I added the cafe to the gallery. It is marked for review."


class FakeNarrator:
    def narrate(self, script: str, run_id: str, parent: Any = None) -> Narration:
        return Narration(
            script=script,
            audio_bytes=b"RIFFfakewav",
            audio_url=None,
            media_type="audio/wav",
            run_id="gb_tts",
            manifest_hash="hash-tts",
            duration=2.5,
        )


def voice_client(tmp_path: Path) -> TestClient:
    settings = Settings(
        storage_backend="local", local_data_dir=tmp_path, max_upload_bytes=1024
    )
    return TestClient(
        create_app(
            settings=settings,
            extractor=FixtureExtractor(),
            transcriber=FakeTranscriber(),
            narrator=FakeNarrator(),
            voice_agent=MutatingFakeAgent(),
        )
    )


def extracted_run(client: TestClient) -> dict[str, Any]:
    run = create_run(client)
    response = client.post(f"/api/runs/{run['runId']}/extract")
    assert response.status_code == 200
    return response.json()


def test_ask_with_text_files_a_proposal_and_returns_audio(tmp_path: Path) -> None:
    with voice_client(tmp_path) as client:
        run = extracted_run(client)

        response = client.post(
            f"/api/runs/{run['runId']}/ask", data={"text": "add a cafe in the gallery"}
        )

        assert response.status_code == 200
        body = response.json()
        # A voice edit is a proposal like any other agent write: nothing is
        # live until a person approves it.
        assert body["sceneChanged"] is False
        assert body["sceneVersion"] == 1
        assert body["mutations"][0]["kind"] == "add-landmark"
        assert body["proposals"][0]["status"] == "pending"
        assert body["proposals"][0]["description"].startswith('Add destination "Cafe"')
        assert body["audio"]["manifestHash"] == "hash-tts"

        scene = client.get(f"/api/runs/{run['runId']}/scene").json()
        assert all(item["label"] != "Cafe" for item in scene["landmarks"])
        ledger = client.get(f"/api/runs/{run['runId']}/review").json()
        assert [item["status"] for item in ledger["proposals"]] == ["pending"]
        assert ledger["proposals"][0]["reason"] == "add a cafe in the gallery"

        audio = client.get(body["audio"]["url"])
        assert audio.status_code == 200
        assert audio.content == b"RIFFfakewav"


def test_ask_passes_history_and_narrate_endpoint_works(tmp_path: Path) -> None:
    agent = MutatingFakeAgent()
    settings = Settings(
        storage_backend="local", local_data_dir=tmp_path, max_upload_bytes=1024
    )
    with TestClient(
        create_app(
            settings=settings,
            extractor=FixtureExtractor(),
            narrator=FakeNarrator(),
            voice_agent=agent,
        )
    ) as client:
        run = extracted_run(client)
        turns = [{"question": "where is the gallery?", "answer": "8 metres ahead."}]
        response = client.post(
            f"/api/runs/{run['runId']}/ask",
            data={"text": "and from there?", "history": json.dumps(turns)},
        )
        assert response.status_code == 200
        assert agent.last_history == turns

        narrated = client.post(
            f"/api/runs/{run['runId']}/narrate", json={"text": "Route to the gallery."}
        )
        assert narrated.status_code == 200
        assert narrated.json()["audio"]["manifestHash"] == "hash-tts"


def test_ask_without_scene_returns_conflict(tmp_path: Path) -> None:
    with voice_client(tmp_path) as client:
        run = create_run(client)
        response = client.post(f"/api/runs/{run['runId']}/ask", data={"text": "hello"})
        assert response.status_code == 409


def test_ask_requires_question(tmp_path: Path) -> None:
    with voice_client(tmp_path) as client:
        run = extracted_run(client)
        response = client.post(f"/api/runs/{run['runId']}/ask")
        assert response.status_code == 422


def test_ask_rejects_tiny_recording(tmp_path: Path) -> None:
    with voice_client(tmp_path) as client:
        run = extracted_run(client)
        response = client.post(
            f"/api/runs/{run['runId']}/ask",
            files={"audio": ("q.webm", b"tiny", "audio/webm")},
        )
        assert response.status_code == 422
        assert "too short" in response.json()["detail"]


def test_ask_without_agent_returns_503(tmp_path: Path) -> None:
    settings = Settings(
        storage_backend="local", local_data_dir=tmp_path, max_upload_bytes=1024
    )
    with TestClient(
        create_app(
            settings=settings,
            extractor=FixtureExtractor(),
            voice_agent=DisabledVoiceAgent(),
        )
    ) as client:
        run = extracted_run(client)
        response = client.post(f"/api/runs/{run['runId']}/ask", data={"text": "route please"})
        assert response.status_code == 503


def test_demo_runs_are_isolated_and_ready_to_ask(tmp_path: Path) -> None:
    with voice_client(tmp_path) as client:
        first = client.post("/api/runs/demo").json()
        second = client.post("/api/runs/demo").json()
        assert first["runId"].startswith("run_demo_")
        assert first["status"] == "review-required"
        assert first["runId"] != second["runId"]

        answer = client.post(f"/api/runs/{first['runId']}/ask", data={"text": "add a cafe"})
        assert answer.status_code == 200
        assert answer.json()["proposals"][0]["status"] == "pending"
        assert client.get(f"/api/runs/{second['runId']}/review").json()["proposals"] == []

        # The other visitor's demo copy is untouched by the first one's edit.
        other_scene = client.get(f"/api/runs/{second['runId']}/scene").json()
        assert all(item["label"] != "Cafe" for item in other_scene["landmarks"])


def test_voice_edit_goes_through_review_then_publication(tmp_path: Path) -> None:
    with voice_client(tmp_path) as client:
        run = extracted_run(client)
        asked = client.post(f"/api/runs/{run['runId']}/ask", data={"text": "add a cafe"}).json()
        proposal_id = asked["proposals"][0]["id"]

        # The venue accepts the report: it lands on the working scene and the
        # run asks for a deliberate publish step, naming the change.
        accepted = client.post(f"/api/runs/{run['runId']}/proposals/{proposal_id}/approve")
        assert accepted.status_code == 200
        assert any(item["label"] == "Cafe" for item in accepted.json()["scene"]["landmarks"])

        blocked = client.post(
            f"/api/runs/{run['runId']}/approve", json={"resolved_issue_ids": []}
        )
        assert blocked.status_code == 409

        approved = client.post(
            f"/api/runs/{run['runId']}/approve",
            json={"resolved_issue_ids": ["confirm-door", f"proposal-{proposal_id}"]},
        )
        assert approved.status_code == 200
        scene = client.get(f"/api/runs/{run['runId']}/scene").json()
        assert scene["review"]["status"] == "approved"
        assert any(item["label"] == "Cafe" for item in scene["landmarks"])
