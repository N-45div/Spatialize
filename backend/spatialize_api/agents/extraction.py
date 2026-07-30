"""Agentic floor-plan extraction.

A genblaze AgentLoop drives a Gemini vision step; the Pydantic topology gate
is the loop's Evaluator. Validation errors are fed back verbatim as the next
iteration's refinement prompt, and every attempt is parent-linked in the
manifest lineage.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
from datetime import UTC, datetime
from typing import Any

from genblaze_core import (
    AgentContext,
    AgentLoop,
    CallableEvaluator,
    EvaluationResult,
    Modality,
    Pipeline,
    SyncProvider,
)
from genblaze_core.models.asset import Asset
from pydantic import ValidationError

from ..config import Settings
from ..models import SpatialScene, StoredAsset

NOT_A_PLAN = "NOT_A_FLOOR_PLAN"

EXTRACTION_PROMPT = """You are a metric floor-plan interpreter. Analyze the attached venue plan
and return ONLY a JSON object with this exact shape (no markdown fences):

{
  "name": str,
  "dimensions": {"width": m, "depth": m, "ceilingHeight": m},
  "sourceTransform": {"widthPixels": int, "heightPixels": int,
                      "metersPerPixel": [x, z], "origin": [0, 0],
                      "xAxis": "right", "zAxis": "down"},
  "rooms": [{"id", "label", "polygon": [[x,z],...], "confidence": 0-1,
             "category": "public"|"service"|"circulation"|"restricted",
             "evidence": {"label": EV, "geometry": EV}}],
  "doors": [{"id", "label", "position": [x,z], "width": m, "rotation": rad,
             "connects": [roomId, roomId] (or "outside"), "accessible": bool,
             "confidence": 0-1,
             "evidence": {"position": EV, "width": EV, "connectivity": EV}}],
  "landmarks": [{"id", "label",
                 "type": "entrance"|"elevator"|"stairs"|"restroom"|"destination",
                 "position": [x,z], "confidence": 0-1,
                 "evidence": {"label": EV, "geometry": EV}}],
  "routeGraph": {"nodes": [{"id", "position": [x,z], "roomId",
                            "landmarkId"? }],
                 "edges": [{"from", "to", "distance": m, "accessible": bool,
                            "doorId"? }]},
  "review": {"status": "needs-review",
             "issues": [{"id", "message", "severity": "low"|"medium"|"high"}]}
}
where EV = {"confidence": 0-1, "method": "model", "sourceRegion": [xMin,yMin,xMax,yMax] in 0-1}

Topology rules that WILL be machine-validated — obey them exactly:
- All coordinates are metres; x right, z down; every point inside dimensions.
- Every door position must lie ON the boundary polyline of each room it connects
  (within 0.15 m).
- Every route edge distance must equal the euclidean distance between its nodes
  (within 10%).
- A route edge between different rooms must reference a doorId whose connects
  covers both rooms, and the straight segment between the nodes must pass within
  the door's half-width of the door position.
- Edges marked accessible must not use inaccessible doors.
- Every route node's position must lie inside its roomId polygon.
- There must be one landmark of type "entrance" with a route node
  (landmarkId set), and every destination landmark must be routable from it.
- Add review issues for anything you are unsure about (confidence < 0.85).

If the image is not a floor plan, return exactly: {"error": "NOT_A_FLOOR_PLAN"}"""


class ExtractionFailed(ValueError):
    pass


def _text_asset(step: Any, text: str) -> Any:
    digest = hashlib.sha256(text.encode()).hexdigest()
    step.assets.append(
        Asset(
            url=f"text:{digest}",
            media_type="application/json",
            sha256=digest,
            metadata={"text": text},
        )
    )
    return step


class GeminiVisionStep(SyncProvider):
    name = "gemini-vision-extract"

    def __init__(self, api_key: str, image: bytes, mime_type: str, **kwargs: Any):
        super().__init__(**kwargs)
        self._api_key = api_key
        self._image = image
        self._mime_type = mime_type

    def generate(self, step: Any, config: Any = None) -> Any:
        from google import genai
        from google.genai import types

        client = genai.Client(api_key=self._api_key)
        response = client.models.generate_content(
            model=step.model,
            contents=[
                types.Part.from_bytes(data=self._image, mime_type=self._mime_type),
                step.prompt,
            ],
            config=types.GenerateContentConfig(
                response_mime_type="application/json", temperature=0.1
            ),
        )
        return _text_asset(step, response.text or "")


class OpenRouterVisionStep(SyncProvider):
    name = "openrouter-vision-extract"

    def __init__(self, api_key: str, image: bytes, mime_type: str, **kwargs: Any):
        super().__init__(**kwargs)
        self._api_key = api_key
        self._image = image
        self._mime_type = mime_type

    def generate(self, step: Any, config: Any = None) -> Any:
        import base64

        from openai import OpenAI

        client = OpenAI(api_key=self._api_key, base_url="https://openrouter.ai/api/v1")
        data_uri = f"data:{self._mime_type};base64,{base64.b64encode(self._image).decode()}"
        response = client.chat.completions.create(
            model=step.model,
            temperature=0.1,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "image_url", "image_url": {"url": data_uri}},
                        {"type": "text", "text": step.prompt},
                    ],
                }
            ],
        )
        text = response.choices[0].message.content or ""
        if text.startswith("```"):
            text = text.strip("`").removeprefix("json").strip()
        return _text_asset(step, text)


def _candidate_from_result(result: Any, run_id: str, source: StoredAsset, model: str) -> dict:
    step = result.run.steps[-1]
    if not step.assets:
        detail = getattr(step, "error", None) or "the vision step produced no output"
        raise ExtractionFailed(f"Extraction step failed: {detail}")
    raw = step.assets[0].metadata["text"]
    candidate = json.loads(raw)
    if candidate.get("error") == NOT_A_PLAN:
        raise ExtractionFailed("The uploaded file does not look like a floor plan")
    candidate["schemaVersion"] = "1.1"
    candidate["units"] = "meters"
    candidate.setdefault("id", f"venue-{run_id}")
    candidate["sourceAsset"] = source.uri
    candidate["sourceSha256"] = source.sha256
    candidate["extraction"] = {
        "runId": run_id,
        "provider": "google",
        "model": model,
        "completedAt": datetime.now(UTC).isoformat(),
    }
    # Recompute the pixel scale from the model's own dimensions so scale
    # mismatch can never be the reason an otherwise good extraction fails.
    transform = candidate.get("sourceTransform")
    dimensions = candidate.get("dimensions")
    if transform and dimensions and transform.get("widthPixels") and transform.get("heightPixels"):
        transform["metersPerPixel"] = [
            dimensions["width"] / transform["widthPixels"],
            dimensions["depth"] / transform["heightPixels"],
        ]
        transform["origin"] = [0, 0]
    return candidate


class GeminiVisionExtractor:
    """Drop-in VisionExtractor: agentic extraction with validator feedback."""

    def __init__(self, settings: Settings):
        self._settings = settings

    async def extract(self, run_id: str, source: StoredAsset, content: bytes) -> dict[str, Any]:
        return await asyncio.to_thread(self._extract_sync, run_id, source, content)

    def _extract_sync(self, run_id: str, source: StoredAsset, content: bytes) -> dict[str, Any]:
        settings = self._settings
        if settings.openrouter_api_key:
            model = settings.openrouter_model

            def make_step() -> SyncProvider:
                return OpenRouterVisionStep(
                    settings.openrouter_api_key or "", content, source.content_type
                )
        else:
            model = settings.gemini_vision_model

            def make_step() -> SyncProvider:
                return GeminiVisionStep(
                    settings.gemini_api_key or "", content, source.content_type
                )

        def factory(ctx: AgentContext) -> Pipeline:
            prompt = EXTRACTION_PROMPT
            if ctx.last_evaluation and ctx.last_evaluation.feedback:
                prompt += (
                    "\n\nYour previous attempt FAILED machine validation with these"
                    f" errors — fix every one of them:\n{ctx.last_evaluation.feedback}"
                )
            return Pipeline(f"extract-{run_id}-iter-{ctx.iteration}", project_id="spatialize").step(
                make_step(),
                model=model,
                prompt=prompt,
                modality=Modality.TEXT,
            )

        def judge(result: Any) -> EvaluationResult:
            try:
                candidate = _candidate_from_result(result, run_id, source, model)
                SpatialScene.model_validate(candidate)
            except ExtractionFailed as error:
                return EvaluationResult(passed=False, score=0.0, feedback=str(error))
            except json.JSONDecodeError as error:
                return EvaluationResult(
                    passed=False, score=0.0, feedback=f"Response was not valid JSON: {error}"
                )
            except ValidationError as error:
                issues = "\n".join(
                    f"- {'.'.join(str(p) for p in issue['loc'])}: {issue['msg']}"
                    for issue in error.errors()[:12]
                )
                return EvaluationResult(passed=False, score=0.3, feedback=issues)
            return EvaluationResult(passed=True, score=1.0)

        loop = AgentLoop(
            factory,
            CallableEvaluator(judge),
            max_iterations=settings.extraction_max_iterations,
        )
        outcome = loop.run()
        final = outcome.iterations[-1].result
        return _candidate_from_result(final, run_id, source, model)
