"""Speech-to-text and text-to-speech on the OpenAI audio models.

Both take an injectable client so they are tested without a network call.
Transcription works from the recording's bytes, so it needs no public URL for
the audio — which also means voice works in local storage mode.
"""

from __future__ import annotations

import hashlib
from typing import Any
from uuid import uuid4

from ..config import Settings
from .pipelines import Narration, Transcript, TranscriptUnavailable


def _client(settings: Settings, client: Any | None) -> Any:
    if client is not None:
        return client
    from openai import OpenAI

    return OpenAI(api_key=settings.openai_api_key, max_retries=2)


class OpenAITranscriber:
    """Batch transcription of the uploaded clip; no word timings, so confidence is 1.0."""

    def __init__(self, settings: Settings, client: Any | None = None):
        self._settings = settings
        self._client = client

    def transcribe(self, audio_url: str, run_id: str) -> Transcript:
        # The URL path exists for providers that fetch audio themselves; this
        # one is fed the bytes directly by the API layer.
        raise TranscriptUnavailable("OpenAI transcription takes the recording bytes, not a URL")

    def transcribe_bytes(self, data: bytes, content_type: str, run_id: str) -> Transcript:
        client = _client(self._settings, self._client)
        extension = {
            "audio/webm": "webm",
            "video/webm": "webm",
            "audio/mp4": "m4a",
            "audio/mpeg": "mp3",
            "audio/wav": "wav",
            "audio/x-wav": "wav",
            "audio/ogg": "ogg",
        }.get(content_type, "webm")
        result = client.audio.transcriptions.create(
            model=self._settings.openai_stt_model,
            file=(f"question.{extension}", data, content_type),
            response_format="json",
        )
        text = (getattr(result, "text", None) or "").strip()
        digest = hashlib.sha256(
            f"{self._settings.openai_stt_model}\n{hashlib.sha256(data).hexdigest()}\n{text}".encode()
        ).hexdigest()
        return Transcript(
            text=text,
            words=[],
            run_id=f"openai_stt_{uuid4().hex[:10]}",
            manifest_hash=digest,
        )


class OpenAINarrator:
    """Narration on gpt-4o-mini-tts; MP3 bytes, stored by the API layer like every other tier."""

    def __init__(self, settings: Settings, client: Any | None = None):
        self._settings = settings
        self._client = client

    def narrate(self, script: str, run_id: str, parent=None) -> Narration:
        client = _client(self._settings, self._client)
        response = client.audio.speech.create(
            model=self._settings.openai_tts_model,
            voice=self._settings.openai_tts_voice,
            input=script,
            instructions=self._settings.tts_style or None,
            response_format="mp3",
        )
        audio = response.content if hasattr(response, "content") else response.read()
        digest = hashlib.sha256(
            f"{self._settings.openai_tts_model}\n{self._settings.openai_tts_voice}\n{script}".encode()
        ).hexdigest()
        return Narration(
            script=script,
            audio_bytes=audio,
            audio_url=None,
            media_type="audio/mpeg",
            run_id=f"openai_tts_{uuid4().hex[:10]}",
            manifest_hash=digest,
            duration=None,
            provider="openai-tts",
            voice_label=f"{self._settings.openai_tts_voice} · OpenAI",
        )
