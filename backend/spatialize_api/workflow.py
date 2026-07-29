import json
from datetime import UTC, datetime
from uuid import uuid4

from pydantic import ValidationError

from .extractors import ExtractorUnavailable, VisionExtractor
from .models import RunRecord, SpatialScene
from .storage import ObjectStore


class RunNotFound(KeyError):
    pass


class UploadRejected(ValueError):
    pass


class SceneRejected(ValueError):
    pass


def detect_media_type(data: bytes) -> tuple[str, str] | None:
    if data.startswith(b"%PDF"):
        return "application/pdf", ".pdf"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png", ".png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg", ".jpg"
    if len(data) >= 12 and data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "image/webp", ".webp"
    return None


class RunService:
    def __init__(self, store: ObjectStore, extractor: VisionExtractor, max_upload_bytes: int):
        self.store = store
        self.extractor = extractor
        self.max_upload_bytes = max_upload_bytes

    def _prefix(self, run_id: str, created_at: datetime) -> str:
        return f"runs/public/{created_at.date().isoformat()}/{run_id}"

    def _record_key(self, run_id: str, created_at: datetime) -> str:
        return f"{self._prefix(run_id, created_at)}/run.json"

    def _save_record(self, record: RunRecord) -> None:
        data = record.model_dump_json(by_alias=True, indent=2).encode()
        self.store.put(
            self._record_key(record.run_id, record.created_at),
            data,
            "application/json",
            {"run-id": record.run_id, "artifact": "run-record"},
        )

    def _save_locator(self, record: RunRecord) -> None:
        data = json.dumps({"recordKey": self._record_key(record.run_id, record.created_at)}).encode()
        self.store.put(
            f"run-index/{record.run_id}.json",
            data,
            "application/json",
            {"run-id": record.run_id, "artifact": "run-locator"},
        )

    def create_run(self, declared_type: str | None, data: bytes) -> RunRecord:
        if not data:
            raise UploadRejected("The uploaded plan is empty")
        if len(data) > self.max_upload_bytes:
            raise UploadRejected(f"Plan exceeds the {self.max_upload_bytes}-byte upload limit")
        detected = detect_media_type(data)
        if not detected:
            raise UploadRejected("Plan must be a PDF, PNG, JPEG, or WebP file")
        content_type, extension = detected
        if declared_type and declared_type != content_type:
            raise UploadRejected(f"Declared content type {declared_type!r} does not match {content_type!r}")

        now = datetime.now(UTC)
        run_id = f"run_{uuid4().hex[:12]}"
        prefix = self._prefix(run_id, now)
        source = self.store.put(
            f"{prefix}/source/plan{extension}",
            data,
            content_type,
            {"run-id": run_id, "artifact": "source-plan"},
        )
        record = RunRecord(
            run_id=run_id,
            status="source-stored",
            created_at=now,
            updated_at=now,
            source=source,
        )
        self._save_record(record)
        self._save_locator(record)
        return record

    def get_run(self, run_id: str) -> RunRecord:
        try:
            locator = json.loads(self.store.get(f"run-index/{run_id}.json"))
            data = self.store.get(locator["recordKey"])
        except (FileNotFoundError, KeyError, json.JSONDecodeError) as error:
            raise RunNotFound(run_id) from error
        return RunRecord.model_validate_json(data)

    async def extract(self, record: RunRecord) -> RunRecord:
        record.status = "extracting"
        record.updated_at = datetime.now(UTC)
        self._save_record(record)
        content = self.store.get(record.source.key)
        try:
            candidate = await self.extractor.extract(record.run_id, record.source, content)
            candidate["sourceAsset"] = record.source.uri
            candidate["sourceSha256"] = record.source.sha256
            scene = SpatialScene.model_validate(candidate)
        except ExtractorUnavailable as error:
            record.status = "source-stored"
            record.error = str(error)
            record.updated_at = datetime.now(UTC)
            self._save_record(record)
            raise
        except ValidationError as error:
            record.status = "failed"
            record.error = "Extractor returned an invalid spatial scene"
            record.updated_at = datetime.now(UTC)
            self._save_record(record)
            raise SceneRejected(str(error)) from error

        scene_bytes = scene.model_dump_json(by_alias=True, indent=2).encode()
        prefix = self._prefix(record.run_id, record.created_at)
        record.candidate_scene = self.store.put(
            f"{prefix}/scene/candidate.json",
            scene_bytes,
            "application/json",
            {"run-id": record.run_id, "artifact": "candidate-scene"},
        )
        record.status = "review-required"
        record.error = None
        record.updated_at = datetime.now(UTC)
        self._save_record(record)
        return record

    def approve(self, record: RunRecord, resolved_issue_ids: set[str]) -> RunRecord:
        if not record.candidate_scene:
            raise SceneRejected("Run has no candidate scene to approve")
        scene = SpatialScene.model_validate_json(self.store.get(record.candidate_scene.key))
        outstanding = {issue.id for issue in scene.review.issues} - resolved_issue_ids
        if outstanding:
            raise SceneRejected(f"Resolve review issues before approval: {', '.join(sorted(outstanding))}")

        scene.review.status = "approved"
        scene.review.issues = []
        data = scene.model_dump_json(by_alias=True, indent=2).encode()
        prefix = self._prefix(record.run_id, record.created_at)
        record.approved_scene = self.store.put(
            f"{prefix}/scene/approved.json",
            data,
            "application/json",
            {"run-id": record.run_id, "artifact": "approved-scene"},
        )
        record.status = "approved"
        record.updated_at = datetime.now(UTC)
        self._save_record(record)
        return record
