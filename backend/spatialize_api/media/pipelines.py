"""Genblaze pipeline services: speech-to-text and provenance-covered narration."""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol
from urllib.parse import urlparse
from urllib.request import url2pathname

from genblaze_core import Modality, ObjectStorageSink, Pipeline

from ..config import Settings
from .providers import GeminiTTSProvider


class TranscriptUnavailable(RuntimeError):
    pass


class NarrationUnavailable(RuntimeError):
    pass


@dataclass
class WordTiming:
    word: str
    start: float
    end: float
    confidence: float | None


@dataclass
class Transcript:
    text: str
    words: list[WordTiming]
    run_id: str
    manifest_hash: str

    @property
    def mean_confidence(self) -> float:
        scored = [w.confidence for w in self.words if w.confidence is not None]
        return sum(scored) / len(scored) if scored else 1.0


@dataclass
class Narration:
    script: str
    audio_bytes: bytes | None
    audio_url: str | None
    media_type: str
    run_id: str
    manifest_hash: str
    duration: float | None = None
    provider: str = "gemini-tts"
    warnings: list[str] = field(default_factory=list)


class Transcriber(Protocol):
    def transcribe(self, audio_url: str, run_id: str) -> Transcript: ...


class Narrator(Protocol):
    def narrate(self, script: str, run_id: str, parent=None) -> Narration: ...


class DisabledTranscriber:
    def transcribe(self, audio_url: str, run_id: str) -> Transcript:
        raise TranscriptUnavailable(
            "Speech-to-text is not configured. Set ASSEMBLYAI_API_KEY, or send the question as text."
        )


class DisabledNarrator:
    def narrate(self, script: str, run_id: str, parent=None) -> Narration:
        raise NarrationUnavailable(
            "Text-to-speech is not configured. Set GEMINI_API_KEY to enable generated narration."
        )


class AssemblyAITranscriber:
    """AssemblyAI STT through a genblaze pipeline: hash-verified transcript + word timings."""

    def __init__(self, api_key: str, model: str, sink: ObjectStorageSink | None):
        self._api_key = api_key
        self._model = model
        self._sink = sink

    def transcribe(self, audio_url: str, run_id: str) -> Transcript:
        from genblaze_assemblyai import AssemblyAIProvider

        result = (
            Pipeline(f"voice-question-{run_id}", project_id="spatialize")
            .step(
                AssemblyAIProvider(api_key=self._api_key),
                model=self._model,
                prompt=audio_url,
                modality=Modality.TEXT,
            )
            .run(sink=self._sink, timeout=300, max_retries=1, raise_on_failure=True)
        )
        step = result.run.steps[0]
        asset = step.assets[0]
        words = [
            WordTiming(word=w.word, start=w.start, end=w.end, confidence=w.confidence)
            for w in (asset.audio.word_timings if asset.audio else [])
        ]
        return Transcript(
            text=asset.metadata.get("text", ""),
            words=words,
            run_id=result.run.run_id,
            manifest_hash=result.manifest.canonical_hash,
        )


class GenblazeNarrator:
    """Gemini TTS through a genblaze pipeline, manifest-linked to its parent run."""

    def __init__(self, settings: Settings, sink: ObjectStorageSink | None):
        self._settings = settings
        self._sink = sink

    def narrate(self, script: str, run_id: str, parent=None) -> Narration:
        try:
            return self._narrate_once(script, run_id, parent)
        except Exception:
            # TTS previews throw transient 500s/429s; one retry rescues most.
            time.sleep(2)
            return self._narrate_once(script, run_id, parent)

    def _narrate_once(self, script: str, run_id: str, parent=None) -> Narration:
        provider = GeminiTTSProvider(
            api_key=self._settings.gemini_api_key or "",
            voice=self._settings.tts_voice,
        )
        pipeline = Pipeline(f"route-narration-{run_id}", project_id="spatialize")
        if parent is not None:
            pipeline = pipeline.from_result(parent)
        styled = f"{self._settings.tts_style}: {script}" if self._settings.tts_style else script
        result = pipeline.step(
            provider,
            model=self._settings.gemini_tts_model,
            prompt=styled,
            modality=Modality.AUDIO,
        ).run(sink=self._sink, timeout=120, raise_on_failure=True)

        asset = result.run.steps[0].assets[0]
        audio_bytes: bytes | None = None
        audio_url: str | None = None
        parsed = urlparse(asset.url)
        if parsed.scheme == "file":
            path = Path(url2pathname(parsed.path))
            audio_bytes = path.read_bytes()
            path.unlink(missing_ok=True)
        else:
            audio_url = asset.url
        return Narration(
            script=script,
            audio_bytes=audio_bytes,
            audio_url=audio_url,
            media_type=asset.media_type or "audio/wav",
            run_id=result.run.run_id,
            manifest_hash=result.manifest.canonical_hash,
            duration=asset.duration,
        )


def build_transcriber(settings: Settings, sink: ObjectStorageSink | None) -> Transcriber:
    if settings.assemblyai_api_key:
        return AssemblyAITranscriber(settings.assemblyai_api_key, settings.stt_model, sink)
    return DisabledTranscriber()


def build_narrator(settings: Settings, sink: ObjectStorageSink | None) -> Narrator:
    if settings.gemini_api_key:
        return GenblazeNarrator(settings, sink)
    return DisabledNarrator()
