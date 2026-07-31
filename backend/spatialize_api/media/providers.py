"""Custom genblaze providers for capabilities the SDK does not ship.

GeminiTTSProvider fills the Google text-to-speech gap in genblaze's provider
matrix by wrapping the google-genai SDK in a SyncProvider, so narration audio
gets the same manifest provenance as every other generated asset.
"""

from __future__ import annotations

import tempfile
import wave
from pathlib import Path
from typing import Any

from genblaze_core import SyncProvider
from genblaze_core.models.asset import Asset

PCM_SAMPLE_RATE = 24_000
PCM_SAMPLE_WIDTH = 2


def pcm_to_wav_bytes(pcm: bytes) -> bytes:
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as handle:
        path = Path(handle.name)
    with wave.open(str(path), "wb") as writer:
        writer.setnchannels(1)
        writer.setsampwidth(PCM_SAMPLE_WIDTH)
        writer.setframerate(PCM_SAMPLE_RATE)
        writer.writeframes(pcm)
    data = path.read_bytes()
    path.unlink(missing_ok=True)
    return data


class KokoroTTSProvider(SyncProvider):
    """Self-hosted open-source TTS (Kokoro-82M, Apache 2.0) as a genblaze provider.

    No API, no key, no quota — synthesis happens in-process on CPU, and the
    output still carries a genblaze provenance manifest like any other step.
    """

    name = "kokoro-tts"
    _engine: Any = None

    def __init__(self, model_dir: Path, voice: str = "af_heart", **kwargs: Any):
        super().__init__(**kwargs)
        self._model_dir = model_dir
        self._voice = voice

    def _get_engine(self) -> Any:
        if KokoroTTSProvider._engine is None:
            from kokoro_onnx import Kokoro

            KokoroTTSProvider._engine = Kokoro(
                str(self._model_dir / "kokoro-v1.0.int8.onnx"),
                str(self._model_dir / "voices-v1.0.bin"),
            )
        return KokoroTTSProvider._engine

    def generate(self, step: Any, config: Any = None) -> Any:
        import numpy as np

        samples, sample_rate = self._get_engine().create(
            step.prompt, voice=self._voice, speed=1.0
        )
        pcm = (np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes()
        wav = pcm_to_wav_bytes(pcm)
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as handle:
            handle.write(wav)
            file_url = Path(handle.name).resolve().as_uri()
        step.assets.append(
            Asset(
                url=file_url,
                media_type="audio/wav",
                duration=len(samples) / sample_rate,
            )
        )
        return step


class GeminiTTSProvider(SyncProvider):
    name = "gemini-tts"

    def __init__(self, api_key: str, voice: str = "Kore", **kwargs: Any):
        super().__init__(**kwargs)
        self._api_key = api_key
        self._voice = voice
        self._client: Any = None

    def _get_client(self) -> Any:
        if self._client is None:
            from google import genai

            self._client = genai.Client(api_key=self._api_key)
        return self._client

    def generate(self, step: Any, config: Any = None) -> Any:
        from google.genai import types

        response = self._get_client().models.generate_content(
            model=step.model,
            contents=step.prompt,
            config=types.GenerateContentConfig(
                response_modalities=["AUDIO"],
                speech_config=types.SpeechConfig(
                    voice_config=types.VoiceConfig(
                        prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=self._voice)
                    )
                ),
            ),
        )
        pcm = response.candidates[0].content.parts[0].inline_data.data
        wav = pcm_to_wav_bytes(pcm)
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as handle:
            handle.write(wav)
            file_url = Path(handle.name).resolve().as_uri()
        step.assets.append(
            Asset(
                url=file_url,
                media_type="audio/wav",
                duration=len(pcm) / (PCM_SAMPLE_RATE * PCM_SAMPLE_WIDTH),
            )
        )
        return step
