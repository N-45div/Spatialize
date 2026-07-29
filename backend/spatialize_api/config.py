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
