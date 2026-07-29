from typing import Any, Protocol

from .models import StoredAsset


class ExtractorUnavailable(RuntimeError):
    pass


class VisionExtractor(Protocol):
    async def extract(self, run_id: str, source: StoredAsset, content: bytes) -> dict[str, Any]: ...


class DisabledVisionExtractor:
    async def extract(self, run_id: str, source: StoredAsset, content: bytes) -> dict[str, Any]:
        del run_id, source, content
        raise ExtractorUnavailable(
            "No vision extractor is configured. The source is safely stored and can be processed when a provider is enabled."
        )
