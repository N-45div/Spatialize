import json
from datetime import UTC, datetime
from importlib.resources import files
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from spatialize_api.access import check_access
from spatialize_api.access_agent import enrich_answer
from spatialize_api.access_geometry import footprint, segment_footprint_distance, validate_placement
from spatialize_api.access_models import AccessNotice, AccessQuestion, AccessState, Obstacle
from spatialize_api.access_repository import AccessRepository, ContentUnavailable
from spatialize_api.app import create_app
from spatialize_api.config import Settings


def fixtures():
    root = files("spatialize_api").joinpath("data")
    return json.loads(root.joinpath("demo_scene.json").read_text()), AccessState.model_validate_json(
        root.joinpath("access_demo.json").read_text()
    )


def test_evidence_verdicts_and_width_uncertainty():
    scene, state = fixtures()
    assert check_access(scene, state, "studio-mark", 800, 1)["verdict"] == "CLEAR"
    assert check_access(scene, state, "studio-mark", 1300, 1)["verdict"] == "BLOCKED"
    assert check_access(scene, state, "gallery-mark", 800, 1)["verdict"] == "BLOCKED"
    state.obstacles = []
    result = check_access(scene, state, "quiet-mark", 800, 1)
    assert result["verdict"] == "UNKNOWN"
    assert {s["id"] for s in result["evidence"]} == {"scene-v1", "source-venue", "source-visitor"}
    assert {c["value"] for c in result["claims"]} == {True, False}
    assert any("Sources disagree" in r["message"] for r in result["reasons"])
    assert any(
        r["message"] == "Visitor report: quiet-room threshold reports a step or access barrier; this claim is disputed"
        and r["sourceId"] == "source-visitor"
        for r in result["reasons"]
    )
    assert check_access(scene, state, "studio-mark", 800, 1)["verdict"] == "CLEAR"
    scene["doors"][1]["evidence"]["width"]["confidence"] = 0.5
    assert check_access(scene, state, "studio-mark", 1300, 1)["verdict"] == "UNKNOWN"


def test_notices_are_scoped_and_expire_at_end():
    scene, state = fixtures()
    state.obstacles = []
    state.notices = [
        AccessNotice(
            id="closure",
            entity_id="door-lobby-studio",
            title="Studio maintenance",
            starts_at="2026-10-03T10:00:00Z",
            ends_at="2026-10-03T11:00:00Z",
            source_id="source-venue",
        )
    ]
    assert (
        check_access(scene, state, "studio-mark", 800, 1, datetime(2026, 10, 3, 10, tzinfo=UTC))["verdict"]
        == "BLOCKED"
    )
    assert (
        check_access(scene, state, "gallery-mark", 800, 1, datetime(2026, 10, 3, 10, tzinfo=UTC))["verdict"]
        == "CLEAR"
    )
    assert (
        check_access(scene, state, "studio-mark", 800, 1, datetime(2026, 10, 3, 11, tzinfo=UTC))["verdict"]
        == "CLEAR"
    )
    state.notices[0].status = "unverified"
    assert (
        check_access(scene, state, "studio-mark", 800, 1, datetime(2026, 10, 3, 10, tzinfo=UTC))["verdict"]
        == "UNKNOWN"
    )


def test_corridor_checks_width_not_just_centerline():
    obstacle = Obstacle(
        id="box",
        label="Display",
        room_id="gallery",
        position=(5, 0.5),
        width=1,
        depth=0.4,
        source_id="source-layout",
        verified=True,
    )
    distance = segment_footprint_distance((0, 0), (10, 0), footprint(obstacle))
    assert distance == pytest.approx(0.3)
    assert distance < 0.8 / 2
    obstacle.rotation = 0.7
    assert segment_footprint_distance((0, 0), (10, 0), footprint(obstacle)) < 0.4


def test_invalid_and_overlapping_placements_are_rejected():
    scene, state = fixtures()
    obstacle = state.obstacles[0].model_copy(update={"position": (7.1, 2.7)})
    with pytest.raises(ValueError, match="footprint"):
        validate_placement(scene, obstacle, state.obstacles)
    obstacle = state.obstacles[0].model_copy(update={"id": "second"})
    with pytest.raises(ValueError, match="overlaps"):
        validate_placement(scene, obstacle, state.obstacles)


def make_client(tmp_path, **overrides):
    return TestClient(
        create_app(
            settings=Settings(
                _env_file=None,
                storage_backend="local",
                local_data_dir=tmp_path,
                sanity_project_id=None,
                openai_api_key=None,
                **overrides,
            )
        )
    )


def move_body(snapshot, position=(13.5, 5.3)):
    return {
        "obstacleId": "gallery-trolley",
        "roomId": "gallery",
        "position": list(position),
        "reason": "Clear the gallery approach",
        "baseSceneVersion": snapshot["sceneVersion"],
        "baseAccessVersion": snapshot["version"],
    }


def test_review_publication_persistence_and_stale_proposals(tmp_path):
    with make_client(tmp_path) as client:
        run = client.post("/api/runs/demo").json()["runId"]
        path = f"/api/runs/{run}/access"
        snapshot = client.get(path).json()
        body = move_body(snapshot)
        preview = client.post(path + "/preview", json=body)
        assert preview.status_code == 200
        assert any(i["before"] == "BLOCKED" and i["after"] == "CLEAR" for i in preview.json()["impact"])
        assert client.get(path).json()["obstacles"][0]["position"] == [8, 2.7]
        first = client.post(path + "/proposals", json=body).json()
        second = client.post(path + "/proposals", json=body).json()
        approved = client.post(
            path + f"/proposals/{first['id']}/decision",
            json={"decision": "approve", "reason": "Checked placement"},
        )
        assert approved.status_code == 200
        assert approved.json()["version"] == 2
        assert (
            client.post(
                path + f"/proposals/{second['id']}/decision",
                json={"decision": "approve", "reason": "Checked placement"},
            ).status_code
            == 409
        )
        assert client.post(path + "/preview", json=body).status_code == 409
        assert (
            client.post(
                path + f"/proposals/{second['id']}/decision",
                json={"decision": "decline", "reason": "Stale proposal"},
            ).status_code
            == 200
        )
    with make_client(tmp_path) as client:
        after = client.get(path).json()
        assert after["obstacles"][0]["position"] == [13.5, 5.3]
        assert [p["status"] for p in after["proposals"]] == ["approved", "declined"]
        assert after["proposals"][1]["decisionReason"] == "Stale proposal"
        result = client.post(path + "/check", json={"destinationId": "gallery-mark"}).json()
        assert result["verdict"] == "CLEAR"
        assert result["accessVersion"] == 2


def test_reviewer_token_validation_and_run_isolation(tmp_path):
    with make_client(tmp_path, venue_token="reviewer-secret") as client:
        run = client.post("/api/runs/demo").json()["runId"]
        other = client.post("/api/runs/demo").json()["runId"]
        path = f"/api/runs/{run}/access"
        snapshot = client.get(path).json()
        bad = client.post(path + "/preview", json=move_body(snapshot, (7.1, 2.7)))
        assert bad.status_code == 422
        proposal = client.post(path + "/proposals", json=move_body(snapshot)).json()
        decision = {"decision": "approve", "reason": "Checked placement"}
        endpoint = path + f"/proposals/{proposal['id']}/decision"
        assert client.post(endpoint, json=decision).status_code == 403
        assert (
            client.post(endpoint, json=decision, headers={"X-Venue-Token": "reviewer-secret"}).status_code
            == 200
        )
        assert client.get(f"/api/runs/{other}/access").json()["version"] == 1
        assert client.get(f"/api/runs/{other}/access").json()["obstacles"][0]["position"] == [8, 2.7]


def test_missing_provider_is_explicit():
    settings = Settings(_env_file=None, sanity_project_id=None, openai_api_key=None)
    result = enrich_answer(settings, AccessQuestion(destination_id="studio-mark"), {"verdict": "UNKNOWN"})
    assert result["agentStatus"] == "not-configured"
    assert result["contextReads"] == []


def test_agent_records_real_mcp_calls_without_changing_verdict():
    settings = Settings(
        _env_file=None,
        openai_api_key="test",
        sanity_context_token="org-test",
        sanity_context_url="https://api.sanity.io/v1/context/organizations/org/mcp/access",
    )
    calls = []

    def create(**kwargs):
        calls.append(kwargs)
        return SimpleNamespace(
            output_text="Sources disagree about the threshold.",
            output=[
                SimpleNamespace(
                    type="mcp_call",
                    name="knowledge_base_read",
                    arguments="{}",
                    output="Both source claims",
                    error=None,
                )
            ],
        )

    client = SimpleNamespace(responses=SimpleNamespace(create=create))
    computed = {"verdict": "UNKNOWN"}
    result = enrich_answer(settings, AccessQuestion(destination_id="quiet-mark"), computed, client)
    assert computed == {"verdict": "UNKNOWN"}
    assert result["agentStatus"] == "connected"
    assert result["contextReads"][0]["tool"] == "knowledge_base_read"
    assert calls[0]["tools"][0]["authorization"] == "org-test"
    assert calls[0]["store"] is False


def mcp_client(*calls, text="Both claims stay on record."):
    output = [
        SimpleNamespace(type="mcp_call", name=name, arguments="{}", output="entry", error=error)
        for name, error in calls
    ]
    return SimpleNamespace(
        responses=SimpleNamespace(create=lambda **_kwargs: SimpleNamespace(output_text=text, output=output))
    )


def test_agent_needs_a_real_knowledge_base_read_but_survives_a_recovered_failure():
    settings = Settings(
        _env_file=None,
        openai_api_key="test",
        sanity_context_token="org-test",
        sanity_context_url="https://api.sanity.io/v1/context/organizations/org/mcp/access",
    )
    question = AccessQuestion(destination_id="quiet-mark")
    outline_only = enrich_answer(settings, question, {}, mcp_client(("initial_context", None)))
    assert outline_only["agentStatus"] == "unavailable"
    assert outline_only["agentSummary"] is None
    recovered = enrich_answer(
        settings,
        question,
        {},
        mcp_client(
            ("initial_context", None),
            ("knowledge_base_read", "Unknown entry path"),
            ("knowledge_base_read", None),
        ),
    )
    assert recovered["agentStatus"] == "connected"
    assert [r["successful"] for r in recovered["contextReads"]] == [True, False, True]
    silent = enrich_answer(settings, question, {}, mcp_client(("knowledge_base_read", None), text=" "))
    assert silent["agentStatus"] == "unavailable"


def test_scene_version_change_invalidates_move(tmp_path):
    with make_client(tmp_path) as client:
        run = client.post("/api/runs/demo").json()
        path = f"/api/runs/{run['runId']}/access"
        snapshot = client.get(path).json()
        proposal = client.post(path + "/proposals", json=move_body(snapshot)).json()
        geometry = client.post(
            f"/api/runs/{run['runId']}/proposals",
            json={
                "id": "prop_geometry",
                "baseSceneVersion": 1,
                "mutation": {
                    "kind": "set-door-accessible",
                    "doorId": "door-lobby-gallery",
                    "accessible": False,
                    "reason": "New step",
                },
            },
        )
        assert geometry.status_code == 201
        assert client.post(f"/api/runs/{run['runId']}/proposals/prop_geometry/approve").status_code == 200
        assert (
            client.post(
                path + f"/proposals/{proposal['id']}/decision",
                json={"decision": "approve", "reason": "Checked placement"},
            ).status_code
            == 409
        )


def test_live_content_failure_never_substitutes_fixture_data(tmp_path, monkeypatch):
    from spatialize_api import access_repository

    def unavailable(*_args, **_kwargs):
        raise ContentUnavailable("Sanity is unavailable; no fixture evidence was substituted")

    monkeypatch.setattr(access_repository.AccessRepository, "query", unavailable)
    settings = Settings(
        _env_file=None,
        storage_backend="local",
        local_data_dir=tmp_path,
        sanity_project_id="demo1234",
        sanity_api_token="test",
        openai_api_key=None,
    )
    with TestClient(create_app(settings=settings)) as client:
        run = client.post("/api/runs/demo").json()["runId"]
        response = client.get(f"/api/runs/{run}/access")
        assert response.status_code == 503
        assert "no fixture" in response.json()["detail"]
        assert not (tmp_path / "access" / f"{run}.json").exists()


def test_sanity_publication_has_revision_guard_and_structured_inspection_fields(monkeypatch):
    settings = Settings(_env_file=None, sanity_project_id="demo1234", sanity_api_token="test")
    repository = AccessRepository(settings, None)
    _, state = fixtures()
    mutations = []
    monkeypatch.setattr(repository, "mutate", lambda batch: mutations.extend(batch))
    repository.save(SimpleNamespace(run_id="run_test", scene_version=3), state, "revision-before")
    patch = mutations[-1]["patch"]
    assert patch["ifRevisionID"] == "revision-before"
    assert patch["set"]["sceneVersion"] == 3
    assert patch["set"]["publishedObstacles"][0]["position"] == [8, 2.7]
    assert patch["set"]["publishedObstacles"][0]["_key"] == "gallery-trolley"
    assert AccessState.model_validate_json(patch["set"]["stateJson"]).version == 1


def test_provider_failure_does_not_expose_credentials():
    settings = Settings(
        _env_file=None,
        openai_api_key="test",
        sanity_context_token="org-secret",
        sanity_context_url="https://api.sanity.io/v1/context/organizations/org/mcp/access",
    )

    def fail(**_kwargs):
        raise RuntimeError("Authorization: org-secret")

    result = enrich_answer(
        settings,
        AccessQuestion(destination_id="quiet-mark"),
        {"verdict": "UNKNOWN"},
        SimpleNamespace(responses=SimpleNamespace(create=fail)),
    )
    assert result["agentStatus"] == "unavailable"
    assert "org-secret" not in json.dumps(result)
