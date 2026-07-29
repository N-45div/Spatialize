import hashlib
import json
from pathlib import Path
from typing import Protocol

import boto3

from .config import Settings
from .models import StoredAsset


class ObjectStore(Protocol):
    def put(
        self, key: str, data: bytes, content_type: str, metadata: dict[str, str] | None = None
    ) -> StoredAsset: ...
    def get(self, key: str) -> bytes: ...


class LocalObjectStore:
    def __init__(self, root: Path):
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, key: str) -> Path:
        path = (self.root / key).resolve()
        if self.root not in path.parents:
            raise ValueError("Object key escapes the local storage root")
        return path

    def put(
        self,
        key: str,
        data: bytes,
        content_type: str,
        metadata: dict[str, str] | None = None,
    ) -> StoredAsset:
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(f"{path.suffix}.tmp")
        temporary.write_bytes(data)
        temporary.replace(path)
        sha256 = hashlib.sha256(data).hexdigest()
        sidecar = {
            "contentType": content_type,
            "sha256": sha256,
            "metadata": metadata or {},
        }
        path.with_suffix(f"{path.suffix}.metadata.json").write_text(json.dumps(sidecar, indent=2))
        return StoredAsset(
            key=key,
            etag=sha256,
            sha256=sha256,
            content_type=content_type,
            size=len(data),
            uri=f"local://{key}",
        )

    def get(self, key: str) -> bytes:
        return self._path(key).read_bytes()


class B2ObjectStore:
    def __init__(self, settings: Settings):
        if not all((settings.b2_key_id, settings.b2_app_key, settings.b2_bucket, settings.b2_region)):
            raise ValueError("Complete B2 configuration is required")
        self.bucket = settings.b2_bucket
        self.client = boto3.client(
            "s3",
            endpoint_url=f"https://s3.{settings.b2_region}.backblazeb2.com",
            region_name=settings.b2_region,
            aws_access_key_id=settings.b2_key_id,
            aws_secret_access_key=settings.b2_app_key,
        )

    def put(
        self,
        key: str,
        data: bytes,
        content_type: str,
        metadata: dict[str, str] | None = None,
    ) -> StoredAsset:
        sha256 = hashlib.sha256(data).hexdigest()
        response = self.client.put_object(
            Bucket=self.bucket,
            Key=key,
            Body=data,
            ContentType=content_type,
            Metadata={"sha256": sha256, **(metadata or {})},
        )
        return StoredAsset(
            key=key,
            etag=response["ETag"].strip('"'),
            version_id=response.get("VersionId"),
            sha256=sha256,
            content_type=content_type,
            size=len(data),
            uri=f"b2://{self.bucket}/{key}",
        )

    def get(self, key: str) -> bytes:
        response = self.client.get_object(Bucket=self.bucket, Key=key)
        return response["Body"].read()


def build_object_store(settings: Settings) -> ObjectStore:
    if settings.storage_backend == "b2":
        return B2ObjectStore(settings)
    return LocalObjectStore(settings.local_data_dir)
