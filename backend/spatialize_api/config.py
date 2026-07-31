from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import AliasChoices, Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = BACKEND_ROOT.parent
DEFAULT_LOCAL_DATA_DIR = BACKEND_ROOT / ".local-data"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=REPOSITORY_ROOT / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
        populate_by_name=True,
    )

    storage_backend: Literal["local", "b2"] = Field(
        "local",
        validation_alias=AliasChoices("SPATIALIZE_STORAGE_BACKEND", "storage_backend"),
    )
    local_data_dir: Path = Field(
        DEFAULT_LOCAL_DATA_DIR,
        validation_alias=AliasChoices("SPATIALIZE_LOCAL_DATA_DIR", "local_data_dir"),
    )
    max_upload_bytes: int = Field(
        20 * 1024 * 1024,
        gt=0,
        validation_alias=AliasChoices("SPATIALIZE_MAX_UPLOAD_BYTES", "max_upload_bytes"),
    )
    b2_key_id: str | None = Field(None, validation_alias="B2_KEY_ID")
    b2_app_key: str | None = Field(None, validation_alias="B2_APP_KEY")
    b2_bucket: str | None = Field(None, validation_alias="B2_BUCKET")
    b2_region: str | None = Field(None, validation_alias="B2_REGION")

    gemini_api_key: str | None = Field(None, validation_alias="GEMINI_API_KEY")
    assemblyai_api_key: str | None = Field(None, validation_alias="ASSEMBLYAI_API_KEY")
    openrouter_api_key: str | None = Field(None, validation_alias="OPENROUTER_API_KEY")
    openrouter_model: str = Field(
        "openai/gpt-4o-mini",
        validation_alias=AliasChoices("SPATIALIZE_OPENROUTER_MODEL", "openrouter_model"),
    )
    gemini_agent_model: str = Field(
        "gemini-flash-latest",
        validation_alias=AliasChoices("SPATIALIZE_GEMINI_AGENT_MODEL", "gemini_agent_model"),
    )
    gemini_vision_model: str = Field(
        "gemini-flash-latest",
        validation_alias=AliasChoices("SPATIALIZE_GEMINI_VISION_MODEL", "gemini_vision_model"),
    )
    gemini_tts_model: str = Field(
        "gemini-2.5-flash-preview-tts",
        validation_alias=AliasChoices("SPATIALIZE_GEMINI_TTS_MODEL", "gemini_tts_model"),
    )
    tts_voice: str = Field(
        "Sulafat", validation_alias=AliasChoices("SPATIALIZE_TTS_VOICE", "tts_voice")
    )
    tts_style: str = Field(
        "Speak as a warm, friendly venue guide — natural, unhurried, and clear",
        validation_alias=AliasChoices("SPATIALIZE_TTS_STYLE", "tts_style"),
    )
    kokoro_model_dir: Path | None = Field(
        BACKEND_ROOT / ".models",
        validation_alias=AliasChoices("SPATIALIZE_KOKORO_MODEL_DIR", "kokoro_model_dir"),
    )
    kokoro_voice: str = Field(
        "af_heart", validation_alias=AliasChoices("SPATIALIZE_KOKORO_VOICE", "kokoro_voice")
    )
    sarvam_api_key: str | None = Field(None, validation_alias="SARVAM_API_KEY")
    sarvam_voice: str = Field(
        "ritu", validation_alias=AliasChoices("SPATIALIZE_SARVAM_VOICE", "sarvam_voice")
    )
    stt_model: str = Field(
        "universal-3-5-pro", validation_alias=AliasChoices("SPATIALIZE_STT_MODEL", "stt_model")
    )
    stt_min_confidence: float = Field(
        0.5,
        ge=0,
        le=1,
        validation_alias=AliasChoices("SPATIALIZE_STT_MIN_CONFIDENCE", "stt_min_confidence"),
    )
    agent_max_tool_rounds: int = Field(
        12,
        gt=0,
        validation_alias=AliasChoices("SPATIALIZE_AGENT_MAX_TOOL_ROUNDS", "agent_max_tool_rounds"),
    )
    gemini_requests_per_minute: int = Field(
        4,
        ge=0,
        validation_alias=AliasChoices("SPATIALIZE_GEMINI_RPM", "gemini_requests_per_minute"),
    )
    extraction_max_iterations: int = Field(
        3,
        gt=0,
        validation_alias=AliasChoices(
            "SPATIALIZE_EXTRACTION_MAX_ITERATIONS", "extraction_max_iterations"
        ),
    )
    max_voice_upload_bytes: int = Field(
        8 * 1024 * 1024,
        gt=0,
        validation_alias=AliasChoices("SPATIALIZE_MAX_VOICE_UPLOAD_BYTES", "max_voice_upload_bytes"),
    )
    static_dir: Path | None = Field(
        None, validation_alias=AliasChoices("SPATIALIZE_STATIC_DIR", "static_dir")
    )

    @model_validator(mode="after")
    def require_b2_configuration(self) -> "Settings":
        if self.storage_backend == "b2":
            missing = [
                name
                for name, value in {
                    "B2_KEY_ID": self.b2_key_id,
                    "B2_APP_KEY": self.b2_app_key,
                    "B2_BUCKET": self.b2_bucket,
                    "B2_REGION": self.b2_region,
                }.items()
                if not value
            ]
            if missing:
                raise ValueError(f"Missing B2 configuration: {', '.join(missing)}")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
