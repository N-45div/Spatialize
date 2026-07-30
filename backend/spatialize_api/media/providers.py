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
