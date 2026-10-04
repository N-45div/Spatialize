"""Versioned operational evidence, separate from the validated building geometry."""

from datetime import datetime
from typing import Literal

from pydantic import AwareDatetime, Field, model_validator

from .models import ApiModel, Point


class AccessSource(ApiModel):
    id: str
    title: str
    publisher: str
    url: str | None = None
    observed_at: AwareDatetime
    synthetic: bool = False
    body: str = Field(max_length=12000)


class AccessClaim(ApiModel):
    id: str
    entity_id: str
    property: Literal["step-free", "clear-width-mm"]
    value: bool | float
    source_id: str
    status: Literal["verified", "unverified", "disputed"]

    @model_validator(mode="after")
    def valid_value(self):
        if self.property == "step-free" and not isinstance(self.value, bool):
            raise ValueError("A step-free claim requires a boolean")
        if self.property == "clear-width-mm" and (isinstance(self.value, bool) or self.value <= 0):
            raise ValueError("Clear width requires a positive measurement in millimetres")
        return self


class AccessNotice(ApiModel):
    id: str
    entity_id: str
    title: str
    starts_at: AwareDatetime
    ends_at: AwareDatetime
    source_id: str
    status: Literal["verified", "unverified"] = "verified"

    @model_validator(mode="after")
    def ordered_dates(self):
        if self.ends_at <= self.starts_at:
            raise ValueError("Notice end must follow its start")
        return self


class Obstacle(ApiModel):
    id: str
    label: str = Field(min_length=1, max_length=80)
    room_id: str
    position: Point
    width: float = Field(gt=0, le=10, allow_inf_nan=False)
    depth: float = Field(gt=0, le=10, allow_inf_nan=False)
    rotation: float = Field(default=0, allow_inf_nan=False)
    source_id: str
    verified: bool = False


class ObstacleMove(ApiModel):
    obstacle_id: str
    room_id: str
    position: Point
    rotation: float = Field(default=0, allow_inf_nan=False)
    reason: str = Field(min_length=3, max_length=300)
    base_scene_version: int = Field(ge=0)
    base_access_version: int = Field(ge=1)


class AccessProposal(ApiModel):
    id: str
    move: ObstacleMove
    status: Literal["pending", "approved", "declined"] = "pending"
    proposed_at: datetime
    decided_at: datetime | None = None
    decision_reason: str | None = None
    resulting_version: int | None = None


class AccessState(ApiModel):
    venue_id: str
    version: int = 1
    sources: list[AccessSource] = Field(default_factory=list)
    claims: list[AccessClaim] = Field(default_factory=list)
    notices: list[AccessNotice] = Field(default_factory=list)
    obstacles: list[Obstacle] = Field(default_factory=list)
    proposals: list[AccessProposal] = Field(default_factory=list)


class AccessQuestion(ApiModel):
    question: str = Field(default="Can I reach this destination?", min_length=3, max_length=1200)
    destination_id: str
    clearance_mm: int = Field(default=800, ge=300, le=2500)
    use_agent: bool = False


class DecisionRequest(ApiModel):
    decision: Literal["approve", "decline"]
    reason: str = Field(min_length=3, max_length=300)
