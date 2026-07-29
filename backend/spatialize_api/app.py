from typing import Annotated

from fastapi import FastAPI, File, HTTPException, UploadFile, status
from pydantic import BaseModel

from .config import Settings, get_settings
from .extractors import DisabledVisionExtractor, ExtractorUnavailable, VisionExtractor
from .models import RunRecord
from .storage import ObjectStore, build_object_store
from .workflow import RunService, SceneRejected, UploadRejected


class ApprovalRequest(BaseModel):
    resolved_issue_ids: set[str]


def create_app(
    settings: Settings | None = None,
    store: ObjectStore | None = None,
    extractor: VisionExtractor | None = None,
) -> FastAPI:
    active_settings = settings or get_settings()
    service = RunService(
        store or build_object_store(active_settings),
        extractor or DisabledVisionExtractor(),
        active_settings.max_upload_bytes,
    )
    app = FastAPI(title="Spatialize API", version="0.1.0")

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok", "storage": active_settings.storage_backend}

    @app.post("/api/runs", response_model=RunRecord, status_code=status.HTTP_201_CREATED)
    async def create_run(
        plan: Annotated[UploadFile, File(description="A venue plan in PDF, PNG, JPEG, or WebP format")],
    ) -> RunRecord:
        data = await plan.read(active_settings.max_upload_bytes + 1)
        try:
            return service.create_run(plan.content_type, data)
        except UploadRejected as error:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(error)
            ) from error

    @app.get("/api/runs/{run_id}", response_model=RunRecord)
    def get_run(run_id: str) -> RunRecord:
        try:
            return service.get_run(run_id)
        except (KeyError, ValueError) as error:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Run not found") from error

    @app.post("/api/runs/{run_id}/extract", response_model=RunRecord)
    async def extract_run(run_id: str) -> RunRecord:
        try:
            record = service.get_run(run_id)
            return await service.extract(record)
        except ExtractorUnavailable as error:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(error)) from error
        except SceneRejected as error:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(error)
            ) from error
        except (KeyError, ValueError) as error:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Run not found") from error

    @app.post("/api/runs/{run_id}/approve", response_model=RunRecord)
    def approve_run(run_id: str, request: ApprovalRequest) -> RunRecord:
        try:
            record = service.get_run(run_id)
            return service.approve(record, request.resolved_issue_ids)
        except SceneRejected as error:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
        except (KeyError, ValueError) as error:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Run not found") from error

    return app


app = create_app()
