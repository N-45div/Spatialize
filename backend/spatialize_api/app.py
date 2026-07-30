import mimetypes
from dataclasses import asdict
from typing import Annotated
from uuid import uuid4

from fastapi import FastAPI, File, Form, HTTPException, Response, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from .agents.tools import SceneSession
from .agents.voice import AgentUnavailable, DisabledVoiceAgent, GeminiVoiceAgent, VoiceAgent
from .config import Settings, get_settings
from .extractors import DisabledVisionExtractor, ExtractorUnavailable, VisionExtractor
from .media import (
    Narrator,
    NarrationUnavailable,
    Transcriber,
    TranscriptUnavailable,
    build_genblaze_sink,
    build_narrator,
    build_transcriber,
)
from .models import RunRecord
from .storage import ObjectStore, build_object_store
from .workflow import RunService, SceneRejected, UploadRejected

JSON_TYPE = "application/json"

AUDIO_EXTENSIONS = {
    "audio/webm": ".webm",
    "video/webm": ".webm",
    "audio/mp4": ".m4a",
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/ogg": ".ogg",
}


class ApprovalRequest(BaseModel):
    resolved_issue_ids: set[str]


def _default_extractor(settings: Settings) -> VisionExtractor:
    if settings.gemini_api_key:
        from .agents.extraction import GeminiVisionExtractor

        return GeminiVisionExtractor(settings)
    return DisabledVisionExtractor()


def _default_agent(settings: Settings) -> VoiceAgent:
    if settings.gemini_api_key:
        return GeminiVoiceAgent(settings)
    return DisabledVoiceAgent()


def create_app(
    settings: Settings | None = None,
    store: ObjectStore | None = None,
    extractor: VisionExtractor | None = None,
    transcriber: Transcriber | None = None,
    narrator: Narrator | None = None,
    voice_agent: VoiceAgent | None = None,
) -> FastAPI:
    active_settings = settings or get_settings()
    active_store = store or build_object_store(active_settings)
    service = RunService(
        active_store,
        extractor or _default_extractor(active_settings),
        active_settings.max_upload_bytes,
    )
    sink = build_genblaze_sink(active_settings)
    active_transcriber = transcriber or build_transcriber(active_settings, sink)
    active_narrator = narrator or build_narrator(active_settings, sink)
    active_agent = voice_agent or _default_agent(active_settings)

    app = FastAPI(title="Spatialize API", version="0.2.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/health")
    def health() -> dict[str, str | bool]:
        return {
            "status": "ok",
            "storage": active_settings.storage_backend,
            "stt": bool(active_settings.assemblyai_api_key),
            "agent": bool(active_settings.gemini_api_key),
        }

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

    @app.get("/api/runs/{run_id}/scene")
    def get_scene(run_id: str) -> Response:
        try:
            record = service.get_run(run_id)
            scene = service.active_scene(record)
        except SceneRejected as error:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
        except (KeyError, ValueError) as error:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Run not found") from error
        return Response(
            content=scene.model_dump_json(by_alias=True), media_type=JSON_TYPE
        )

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

    @app.post("/api/runs/{run_id}/ask")
    async def ask(
        run_id: str,
        audio: Annotated[UploadFile | None, File()] = None,
        text: Annotated[str | None, Form()] = None,
    ) -> dict:
        try:
            record = service.get_run(run_id)
            scene = service.active_scene(record)
        except SceneRejected as error:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(error)) from error
        except (KeyError, ValueError) as error:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Run not found") from error

        warnings: list[str] = []
        transcript_payload: dict | None = None
        question = (text or "").strip()

        if audio is not None:
            audio_bytes = await audio.read(active_settings.max_voice_upload_bytes + 1)
            if len(audio_bytes) > active_settings.max_voice_upload_bytes:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                    detail="Voice recording exceeds the upload limit",
                )
            if len(audio_bytes) < 1_000:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                    detail="The recording is empty or too short — please try again",
                )
            extension = AUDIO_EXTENSIONS.get(audio.content_type or "", ".webm")
            stored = active_store.put(
                f"runs/public/{record.created_at.date().isoformat()}/{record.run_id}"
                f"/voice/questions/{uuid4().hex[:10]}{extension}",
                audio_bytes,
                audio.content_type or "audio/webm",
                {"run-id": record.run_id, "artifact": "voice-question"},
            )
            audio_url = active_store.public_url(stored.key)
            if audio_url is None:
                if not question:
                    raise HTTPException(
                        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                        detail=(
                            "Speech-to-text needs B2 storage for audio URLs. "
                            "Send the question as text in local mode."
                        ),
                    )
                warnings.append("stt-skipped-local-storage")
            else:
                try:
                    transcript = active_transcriber.transcribe(audio_url, record.run_id)
                except TranscriptUnavailable as error:
                    if not question:
                        raise HTTPException(
                            status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(error)
                        ) from error
                    warnings.append("stt-unavailable")
                else:
                    transcript_payload = {
                        "text": transcript.text,
                        "words": [asdict(word) for word in transcript.words],
                        "meanConfidence": transcript.mean_confidence,
                        "manifestHash": transcript.manifest_hash,
                        "genblazeRunId": transcript.run_id,
                    }
                    if not transcript.text.strip():
                        raise HTTPException(
                            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                            detail="No speech was detected in the recording",
                        )
                    if transcript.mean_confidence < active_settings.stt_min_confidence:
                        return {
                            "status": "low-confidence",
                            "transcript": transcript_payload,
                            "answer": None,
                            "message": "I didn't catch that clearly — please repeat the question.",
                            "warnings": warnings,
                        }
                    question = question or transcript.text.strip()

        if not question:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="Provide a voice recording or a text question",
            )

        session = SceneSession(
            scene=scene.model_dump(by_alias=True, mode="json"), spoken_quote=question
        )
        try:
            script = active_agent.answer(session, question)
        except AgentUnavailable as error:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(error)
            ) from error

        scene_version = record.scene_version
        if session.mutations:
            try:
                record = service.save_scene_version(record, session.scene)
                scene_version = record.scene_version
            except Exception:
                warnings.append("scene-version-not-saved")

        audio_payload: dict | None = None
        try:
            narration = active_narrator.narrate(script, record.run_id)
        except NarrationUnavailable:
            warnings.append("tts-unavailable")
        except Exception:
            # A narration failure must never take the answer down with it;
            # the client falls back to captions + on-device speech.
            warnings.append("tts-failed")
        else:
            url = narration.audio_url
            if narration.audio_bytes is not None:
                answer_key = (
                    f"runs/public/{record.created_at.date().isoformat()}/{record.run_id}"
                    f"/voice/answers/{uuid4().hex[:10]}.wav"
                )
                active_store.put(
                    answer_key,
                    narration.audio_bytes,
                    narration.media_type,
                    {"run-id": record.run_id, "artifact": "voice-answer"},
                )
                url = active_store.public_url(answer_key) or f"/api/assets/{answer_key}"
            audio_payload = {
                "url": url,
                "mediaType": narration.media_type,
                "durationSeconds": narration.duration,
                "manifestHash": narration.manifest_hash,
                "genblazeRunId": narration.run_id,
            }

        return {
            "status": "ok",
            "question": question,
            "transcript": transcript_payload,
            "answer": {"script": script},
            "audio": audio_payload,
            "mutations": [asdict(mutation) for mutation in session.mutations],
            "sceneVersion": scene_version,
            "sceneChanged": bool(session.mutations),
            "warnings": warnings,
        }

    @app.get("/api/assets/{key:path}")
    def get_asset(key: str) -> Response:
        try:
            data = active_store.get(key)
        except (FileNotFoundError, KeyError, ValueError) as error:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Asset not found") from error
        media_type = mimetypes.guess_type(key)[0] or "application/octet-stream"
        return Response(content=data, media_type=media_type)

    if active_settings.static_dir and active_settings.static_dir.is_dir():
        from fastapi.staticfiles import StaticFiles

        app.mount(
            "/", StaticFiles(directory=active_settings.static_dir, html=True), name="web"
        )

    return app


app = create_app()
