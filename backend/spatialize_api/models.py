from datetime import datetime
from math import hypot
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

Point = tuple[float, float]


def to_camel(value: str) -> str:
    first, *rest = value.split("_")
    return first + "".join(part.capitalize() for part in rest)


class ApiModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
    )


class Evidence(ApiModel):
    confidence: float = Field(ge=0, le=1)
    method: Literal["model", "human", "derived"]
    source_region: tuple[float, float, float, float] | None = None
    note: str | None = Field(None, max_length=240)

    @model_validator(mode="after")
    def validate_region(self) -> "Evidence":
        if self.source_region:
            x_min, y_min, x_max, y_max = self.source_region
            if not all(0 <= value <= 1 for value in self.source_region):
                raise ValueError("Source region values must be between zero and one")
            if x_min >= x_max or y_min >= y_max:
                raise ValueError("Source region must have ordered, non-zero bounds")
        return self


class EntityEvidence(ApiModel):
    label: Evidence
    geometry: Evidence


class Room(ApiModel):
    id: str
    label: str
    polygon: list[Point] = Field(min_length=3)
    elevation: float = 0
    confidence: float = Field(ge=0, le=1)
    category: Literal["public", "service", "circulation", "restricted"]
    evidence: EntityEvidence


class DoorEvidence(ApiModel):
    position: Evidence
    width: Evidence
    connectivity: Evidence


class Door(ApiModel):
    id: str
    label: str
    position: Point
    width: float = Field(gt=0, le=8)
    rotation: float
    connects: tuple[str, str]
    accessible: bool
    confidence: float = Field(ge=0, le=1)
    evidence: DoorEvidence


class Landmark(ApiModel):
    id: str
    label: str
    type: Literal["entrance", "elevator", "stairs", "restroom", "destination"]
    position: Point
    confidence: float = Field(ge=0, le=1)
    evidence: EntityEvidence


class RouteNode(ApiModel):
    id: str
    position: Point
    room_id: str
    landmark_id: str | None = None


class RouteEdge(ApiModel):
    from_node: str = Field(alias="from")
    to: str
    distance: float = Field(gt=0)
    accessible: bool
    door_id: str | None = None


class SceneDimensions(ApiModel):
    width: float = Field(gt=0)
    depth: float = Field(gt=0)
    ceiling_height: float = Field(gt=0)


class SourceTransform(ApiModel):
    width_pixels: int = Field(gt=0)
    height_pixels: int = Field(gt=0)
    meters_per_pixel: Point
    origin: Point
    x_axis: Literal["right"]
    z_axis: Literal["down"]


class Extraction(ApiModel):
    run_id: str
    provider: str
    model: str
    completed_at: datetime


class RouteGraph(ApiModel):
    nodes: list[RouteNode]
    edges: list[RouteEdge]


class ReviewIssue(ApiModel):
    id: str
    message: str
    severity: Literal["low", "medium", "high"]


class Review(ApiModel):
    status: Literal["needs-review", "approved"]
    issues: list[ReviewIssue]


def distance_to_segment(point: Point, start: Point, end: Point) -> float:
    delta_x, delta_z = end[0] - start[0], end[1] - start[1]
    length_squared = delta_x**2 + delta_z**2
    if length_squared == 0:
        return hypot(point[0] - start[0], point[1] - start[1])
    projection = max(
        0,
        min(
            1,
            ((point[0] - start[0]) * delta_x + (point[1] - start[1]) * delta_z) / length_squared,
        ),
    )
    return hypot(
        point[0] - (start[0] + projection * delta_x),
        point[1] - (start[1] + projection * delta_z),
    )


def distance_to_boundary(point: Point, polygon: list[Point]) -> float:
    return min(
        distance_to_segment(point, start, polygon[(index + 1) % len(polygon)])
        for index, start in enumerate(polygon)
    )


def point_in_polygon(point: Point, polygon: list[Point]) -> bool:
    if distance_to_boundary(point, polygon) <= 1e-6:
        return True
    inside = False
    x_value, z_value = point
    previous = polygon[-1]
    for current in polygon:
        if (current[1] > z_value) != (previous[1] > z_value):
            intersection = (previous[0] - current[0]) * (z_value - current[1]) / (
                previous[1] - current[1]
            ) + current[0]
            if x_value < intersection:
                inside = not inside
        previous = current
    return inside


class SpatialScene(ApiModel):
    schema_version: Literal["1.1"]
    id: str
    name: str
    units: Literal["meters"]
    source_asset: str
    source_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    dimensions: SceneDimensions
    source_transform: SourceTransform
    extraction: Extraction
    rooms: list[Room]
    doors: list[Door]
    landmarks: list[Landmark]
    route_graph: RouteGraph
    review: Review

    @model_validator(mode="after")
    def validate_topology(self) -> "SpatialScene":
        rooms = {room.id: room for room in self.rooms}
        doors = {door.id: door for door in self.doors}
        nodes = {node.id: node for node in self.route_graph.nodes}
        if (
            len(rooms) != len(self.rooms)
            or len(doors) != len(self.doors)
            or len(nodes) != len(self.route_graph.nodes)
        ):
            raise ValueError("Room, door, and route node IDs must be unique")

        for room in self.rooms:
            for x_value, z_value in room.polygon:
                if not (0 <= x_value <= self.dimensions.width and 0 <= z_value <= self.dimensions.depth):
                    raise ValueError(f'Room "{room.id}" is outside scene dimensions')

        for door in self.doors:
            unknown = [room_id for room_id in door.connects if room_id != "outside" and room_id not in rooms]
            if unknown:
                raise ValueError(f'Door "{door.id}" references unknown rooms: {unknown}')
            for room_id in door.connects:
                room = rooms.get(room_id)
                if room and distance_to_boundary(door.position, room.polygon) > 0.15:
                    raise ValueError(f'Door "{door.id}" is not on the boundary of "{room_id}"')

        for node in self.route_graph.nodes:
            if node.room_id not in rooms:
                raise ValueError(f'Route node "{node.id}" references an unknown room')
            if not point_in_polygon(node.position, rooms[node.room_id].polygon):
                raise ValueError(f'Route node "{node.id}" lies outside its declared room')

        for landmark in self.landmarks:
            x_value, z_value = landmark.position
            if not (0 <= x_value <= self.dimensions.width and 0 <= z_value <= self.dimensions.depth):
                raise ValueError(f'Landmark "{landmark.id}" is outside scene dimensions')

        scale_x, scale_z = self.source_transform.meters_per_pixel
        expected_x = self.dimensions.width / self.source_transform.width_pixels
        expected_z = self.dimensions.depth / self.source_transform.height_pixels
        if abs(scale_x - expected_x) > expected_x * 0.01 or abs(scale_z - expected_z) > expected_z * 0.01:
            raise ValueError("Source transform scale does not match scene dimensions")

        for edge in self.route_graph.edges:
            start, end = nodes.get(edge.from_node), nodes.get(edge.to)
            if not start or not end:
                raise ValueError("Route edge references an unknown node")
            measured = hypot(end.position[0] - start.position[0], end.position[1] - start.position[1])
            if abs(measured - edge.distance) > max(0.35, measured * 0.1):
                raise ValueError("Route distance does not match node geometry")
            if start.room_id != end.room_id:
                door = doors.get(edge.door_id or "")
                if not door:
                    raise ValueError("Cross-room route edge must reference a door")
                if not {start.room_id, end.room_id}.issubset(set(door.connects)):
                    raise ValueError("Door does not connect the route edge rooms")
                if distance_to_segment(door.position, start.position, end.position) > max(
                    0.4, door.width / 2
                ):
                    raise ValueError("Route edge does not pass through its referenced door")
                if edge.accessible and not door.accessible:
                    raise ValueError("Accessible route cannot use an inaccessible door")
        return self


class StoredAsset(ApiModel):
    key: str
    etag: str
    version_id: str | None = None
    sha256: str
    content_type: str
    size: int
    uri: str


class RunRecord(ApiModel):
    run_id: str
    status: Literal["source-stored", "extracting", "review-required", "approved", "failed"]
    created_at: datetime
    updated_at: datetime
    source: StoredAsset
    candidate_scene: StoredAsset | None = None
    approved_scene: StoredAsset | None = None
    error: str | None = None
