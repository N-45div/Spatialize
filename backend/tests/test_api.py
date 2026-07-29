from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from spatialize_api.app import create_app
from spatialize_api.config import Settings
from spatialize_api.extractors import DisabledVisionExtractor
from spatialize_api.models import StoredAsset


def evidence(confidence: float = 0.95) -> dict[str, Any]:
    return {"confidence": confidence, "method": "model"}


def entity_evidence(confidence: float = 0.95) -> dict[str, Any]:
    return {"label": evidence(confidence), "geometry": evidence(confidence)}


def valid_scene(run_id: str) -> dict[str, Any]:
    return {
        "schemaVersion": "1.1",
        "id": "test-venue",
        "name": "Test venue",
        "units": "meters",
        "sourceAsset": "replaced-by-workflow",
        "sourceSha256": "0" * 64,
        "dimensions": {"width": 10, "depth": 5, "ceilingHeight": 3},
        "sourceTransform": {
            "widthPixels": 1000,
            "heightPixels": 500,
            "metersPerPixel": [0.01, 0.01],
            "origin": [0, 0],
            "xAxis": "right",
            "zAxis": "down",
        },
        "extraction": {
            "runId": run_id,
            "provider": "fixture",
            "model": "fixture-v1",
            "completedAt": datetime.now(UTC).isoformat(),
        },
        "rooms": [
            {
                "id": "lobby",
                "label": "Lobby",
                "polygon": [[0, 0], [5, 0], [5, 5], [0, 5]],
                "confidence": 0.98,
                "category": "public",
                "evidence": entity_evidence(0.98),
            },
            {
                "id": "gallery",
                "label": "Gallery",
                "polygon": [[5, 0], [10, 0], [10, 5], [5, 5]],
                "confidence": 0.96,
                "category": "public",
                "evidence": entity_evidence(0.96),
            },
        ],
        "doors": [
            {
                "id": "gallery-door",
                "label": "Gallery door",
                "position": [5, 2.5],
                "width": 1.2,
                "rotation": 1.5708,
                "connects": ["lobby", "gallery"],
                "accessible": True,
                "confidence": 0.82,
                "evidence": {
                    "position": evidence(0.82),
                    "width": evidence(0.8),
                    "connectivity": evidence(0.9),
                },
            }
        ],
        "landmarks": [
            {
                "id": "entrance",
                "label": "Entrance",
                "type": "entrance",
                "position": [1, 2.5],
                "confidence": 0.99,
                "evidence": entity_evidence(0.99),
            },
            {
                "id": "gallery-mark",
                "label": "Gallery",
                "type": "destination",
                "position": [9, 2.5],
                "confidence": 0.96,
                "evidence": entity_evidence(0.96),
            },
        ],
        "routeGraph": {
            "nodes": [
                {"id": "n0", "position": [1, 2.5], "roomId": "lobby", "landmarkId": "entrance"},
                {"id": "n1", "position": [9, 2.5], "roomId": "gallery", "landmarkId": "gallery-mark"},
            ],
            "edges": [
                {
                    "from": "n0",
                    "to": "n1",
                    "distance": 8,
                    "accessible": True,
                    "doorId": "gallery-door",
                }
            ],
        },
        "review": {
            "status": "needs-review",
            "issues": [{"id": "confirm-door", "message": "Confirm gallery door", "severity": "medium"}],
        },
    }


class FixtureExtractor:
    async def extract(self, run_id: str, source: StoredAsset, content: bytes) -> dict[str, Any]:
        assert source.sha256
        assert content.startswith(b"\x89PNG")
        return valid_scene(run_id)


class InvalidExtractor:
    async def extract(self, run_id: str, source: StoredAsset, content: bytes) -> dict[str, Any]:
        del run_id, source, content
        return {"schemaVersion": "1.1"}


def png_bytes() -> bytes:
    return b"\x89PNG\r\n\x1a\n" + b"spatialize-plan"


def client(tmp_path: Path, extractor: Any) -> TestClient:
    settings = Settings(
        storage_backend="local",
        local_data_dir=tmp_path,
        max_upload_bytes=1024,
    )
    return TestClient(create_app(settings=settings, extractor=extractor))


def create_run(test_client: TestClient) -> dict[str, Any]:
    response = test_client.post(
        "/api/runs",
        files={"plan": ("plan.png", png_bytes(), "image/png")},
    )
    assert response.status_code == 201
    return response.json()


def test_upload_hashes_and_persists_source(tmp_path: Path) -> None:
    with client(tmp_path, DisabledVisionExtractor()) as test_client:
        run = create_run(test_client)

        assert run["status"] == "source-stored"
        assert run["source"]["sha256"]
        assert (tmp_path / run["source"]["key"]).read_bytes() == png_bytes()
        assert (tmp_path / f"run-index/{run['runId']}.json").exists()


def test_upload_rejects_spoofed_content_type(tmp_path: Path) -> None:
    with client(tmp_path, DisabledVisionExtractor()) as test_client:
        response = test_client.post(
            "/api/runs",
            files={"plan": ("plan.pdf", png_bytes(), "application/pdf")},
        )

        assert response.status_code == 422
        assert "does not match" in response.json()["detail"]


def test_disabled_extractor_preserves_source_run(tmp_path: Path) -> None:
    with client(tmp_path, DisabledVisionExtractor()) as test_client:
        run = create_run(test_client)

        response = test_client.post(f"/api/runs/{run['runId']}/extract")

        assert response.status_code == 503
        stored = test_client.get(f"/api/runs/{run['runId']}").json()
        assert stored["status"] == "source-stored"
        assert stored["source"]["sha256"] == run["source"]["sha256"]


def test_valid_scene_requires_review_then_approval(tmp_path: Path) -> None:
    with client(tmp_path, FixtureExtractor()) as test_client:
        run = create_run(test_client)

        extracted = test_client.post(f"/api/runs/{run['runId']}/extract")
        assert extracted.status_code == 200
        assert extracted.json()["status"] == "review-required"
        assert extracted.json()["candidateScene"]["sha256"]

        unresolved = test_client.post(
            f"/api/runs/{run['runId']}/approve",
            json={"resolved_issue_ids": []},
        )
        assert unresolved.status_code == 409

        approved = test_client.post(
            f"/api/runs/{run['runId']}/approve",
            json={"resolved_issue_ids": ["confirm-door"]},
        )
        assert approved.status_code == 200
        assert approved.json()["status"] == "approved"
        assert approved.json()["approvedScene"]["sha256"]


def test_invalid_extraction_is_never_persisted_as_a_scene(tmp_path: Path) -> None:
    with client(tmp_path, InvalidExtractor()) as test_client:
        run = create_run(test_client)

        response = test_client.post(f"/api/runs/{run['runId']}/extract")

        assert response.status_code == 422
        stored = test_client.get(f"/api/runs/{run['runId']}").json()
        assert stored["status"] == "failed"
        assert stored["candidateScene"] is None
