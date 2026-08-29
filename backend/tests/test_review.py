import copy
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from spatialize_api.app import create_app
from spatialize_api.config import Settings
from tests.test_api import FixtureExtractor, create_run, png_bytes


def client(tmp_path: Path, **overrides: Any) -> TestClient:
    settings = Settings(
        storage_backend="local",
        local_data_dir=tmp_path,
        max_upload_bytes=1024,
        **overrides,
    )
    return TestClient(create_app(settings=settings, extractor=FixtureExtractor()))


def extracted_run(test_client: TestClient) -> tuple[dict[str, Any], dict[str, Any]]:
    run = create_run(test_client)
    run = test_client.post(f"/api/runs/{run['runId']}/extract").json()
    scene = test_client.get(f"/api/runs/{run['runId']}/scene").json()
    return run, scene


def blocked_door_scene(scene: dict[str, Any]) -> dict[str, Any]:
    """The gallery door becomes a barrier, and the edge through it follows."""
    candidate = copy.deepcopy(scene)
    candidate["doors"][0]["accessible"] = False
    for edge in candidate["routeGraph"]["edges"]:
        if edge.get("doorId") == "gallery-door":
            edge["accessible"] = False
    return candidate


def proposal_body(scene: dict[str, Any], run: dict[str, Any], proposal_id: str = "prop_0001") -> dict[str, Any]:
    return {
        "id": proposal_id,
        "description": 'Mark "Gallery door" as not step-free',
        "reason": "there is a 15 cm step here now",
        "mutation": {"kind": "set-door-accessible", "doorId": "gallery-door", "accessible": False},
        "baseSceneVersion": run["sceneVersion"],
        "candidateScene": blocked_door_scene(scene),
    }


def test_valid_proposal_is_stored_pending_with_server_computed_impact(tmp_path: Path) -> None:
    with client(tmp_path) as test_client:
        run, scene = extracted_run(test_client)

        response = test_client.post(f"/api/runs/{run['runId']}/proposals", json=proposal_body(scene, run))

        assert response.status_code == 201
        proposal = response.json()
        assert proposal["status"] == "pending"
        # The impact is computed here, not trusted from the client.
        assert proposal["impact"]["lostStepFree"] == ["Gallery"]
        assert proposal["impact"]["newlyBlockedDoors"] == ["Gallery door"]
        assert proposal["candidateScene"]["sha256"]


def test_proposal_that_fails_topology_is_refused_and_not_stored(tmp_path: Path) -> None:
    with client(tmp_path) as test_client:
        run, scene = extracted_run(test_client)
        body = proposal_body(scene, run)
        # Door blocked, but the route edge through it still claims to be accessible.
        body["candidateScene"]["routeGraph"]["edges"][0]["accessible"] = True

        response = test_client.post(f"/api/runs/{run['runId']}/proposals", json=body)

        assert response.status_code == 422
        assert "inaccessible door" in response.json()["detail"]
        assert test_client.get(f"/api/runs/{run['runId']}/review").json()["proposals"] == []


def test_proposal_for_a_different_venue_is_refused(tmp_path: Path) -> None:
    with client(tmp_path) as test_client:
        run, scene = extracted_run(test_client)
        body = proposal_body(scene, run)
        body["candidateScene"]["sourceSha256"] = "f" * 64

        response = test_client.post(f"/api/runs/{run['runId']}/proposals", json=body)

        assert response.status_code == 422
        assert "not a revision of this venue" in response.json()["detail"]


def test_proposal_is_idempotent_on_its_id(tmp_path: Path) -> None:
    with client(tmp_path) as test_client:
        run, scene = extracted_run(test_client)
        body = proposal_body(scene, run)

        first = test_client.post(f"/api/runs/{run['runId']}/proposals", json=body).json()
        second = test_client.post(f"/api/runs/{run['runId']}/proposals", json=body).json()

        assert first == second
        assert len(test_client.get(f"/api/runs/{run['runId']}/review").json()["proposals"]) == 1


def test_approval_creates_a_new_scene_version(tmp_path: Path) -> None:
    with client(tmp_path) as test_client:
        run, scene = extracted_run(test_client)
        test_client.post(f"/api/runs/{run['runId']}/proposals", json=proposal_body(scene, run))

        response = test_client.post(f"/api/runs/{run['runId']}/proposals/prop_0001/approve")

        assert response.status_code == 200
        assert response.json()["proposal"]["status"] == "approved"
        assert response.json()["run"]["sceneVersion"] == run["sceneVersion"] + 1
        live = test_client.get(f"/api/runs/{run['runId']}/scene").json()
        assert live["doors"][0]["accessible"] is False


def test_approval_against_a_stale_base_version_conflicts(tmp_path: Path) -> None:
    with client(tmp_path) as test_client:
        run, scene = extracted_run(test_client)
        test_client.post(f"/api/runs/{run['runId']}/proposals", json=proposal_body(scene, run, "prop_a"))
        test_client.post(f"/api/runs/{run['runId']}/proposals", json=proposal_body(scene, run, "prop_b"))
        assert test_client.post(f"/api/runs/{run['runId']}/proposals/prop_a/approve").status_code == 200

        response = test_client.post(f"/api/runs/{run['runId']}/proposals/prop_b/approve")

        assert response.status_code == 409
        assert "now on version" in response.json()["detail"]


def test_declined_proposal_is_kept_not_deleted(tmp_path: Path) -> None:
    with client(tmp_path) as test_client:
        run, scene = extracted_run(test_client)
        test_client.post(f"/api/runs/{run['runId']}/proposals", json=proposal_body(scene, run))

        declined = test_client.post(f"/api/runs/{run['runId']}/proposals/prop_0001/decline")

        assert declined.status_code == 200
        assert declined.json()["status"] == "declined"
        ledger = test_client.get(f"/api/runs/{run['runId']}/review").json()
        assert [item["status"] for item in ledger["proposals"]] == ["declined"]
        assert ledger["proposals"][0]["reason"] == "there is a 15 cm step here now"
        # And the venue's scene is untouched.
        assert test_client.get(f"/api/runs/{run['runId']}/scene").json()["doors"][0]["accessible"] is True


def test_a_decided_proposal_cannot_be_decided_again(tmp_path: Path) -> None:
    with client(tmp_path) as test_client:
        run, scene = extracted_run(test_client)
        test_client.post(f"/api/runs/{run['runId']}/proposals", json=proposal_body(scene, run))
        test_client.post(f"/api/runs/{run['runId']}/proposals/prop_0001/decline")

        assert test_client.post(f"/api/runs/{run['runId']}/proposals/prop_0001/approve").status_code == 409


def test_ledger_survives_a_fresh_process(tmp_path: Path) -> None:
    with client(tmp_path) as first:
        run, scene = extracted_run(first)
        first.post(f"/api/runs/{run['runId']}/proposals", json=proposal_body(scene, run))
        first.post(f"/api/runs/{run['runId']}/proposals/prop_0001/decline")

    # A different app instance over the same store: nothing was held in memory.
    with client(tmp_path) as second:
        ledger = second.get(f"/api/runs/{run['runId']}/review").json()

        assert len(ledger["proposals"]) == 1
        assert ledger["proposals"][0]["status"] == "declined"


def test_audit_entries_append_and_deduplicate(tmp_path: Path) -> None:
    with client(tmp_path) as test_client:
        run, _ = extracted_run(test_client)
        entry = {
            "id": "call_1",
            "tool": "find_step_free_route",
            "args": {"to": "Gallery"},
            "outcome": "answered",
            "summary": "Gallery: 8 m",
            "at": "2026-08-27T12:00:00Z",
        }

        first = test_client.post(f"/api/runs/{run['runId']}/audit", json={"calls": [entry]})
        second = test_client.post(f"/api/runs/{run['runId']}/audit", json={"calls": [entry]})

        assert first.json() == {"recorded": 1}
        assert second.json() == {"recorded": 0}
        assert len(test_client.get(f"/api/runs/{run['runId']}/review").json()["calls"]) == 1


def test_venue_token_gates_decisions_when_set(tmp_path: Path) -> None:
    with client(tmp_path, venue_token="venue-secret") as test_client:
        run, scene = extracted_run(test_client)
        test_client.post(f"/api/runs/{run['runId']}/proposals", json=proposal_body(scene, run))

        anonymous = test_client.post(f"/api/runs/{run['runId']}/proposals/prop_0001/decline")
        venue = test_client.post(
            f"/api/runs/{run['runId']}/proposals/prop_0001/decline",
            headers={"X-Venue-Token": "venue-secret"},
        )

        assert anonymous.status_code == 403
        assert venue.status_code == 200
        assert png_bytes()  # keep the shared fixture import honest
