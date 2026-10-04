"""Conservative corridor screening; not a full manoeuvrability simulation."""

from math import cos, hypot, isfinite, sin

from .access_models import Obstacle


def footprint(obstacle: Obstacle):
    c, s = cos(obstacle.rotation), sin(obstacle.rotation)
    x, z = obstacle.position
    return [
        (x + c * u - s * v, z + s * u + c * v)
        for u, v in [
            (-obstacle.width / 2, -obstacle.depth / 2),
            (obstacle.width / 2, -obstacle.depth / 2),
            (obstacle.width / 2, obstacle.depth / 2),
            (-obstacle.width / 2, obstacle.depth / 2),
        ]
    ]


def point_segment_distance(p, a, b):
    dx, dz = b[0] - a[0], b[1] - a[1]
    length = dx * dx + dz * dz
    t = max(0, min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / length)) if length else 0
    return hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dz)


def inside(point, polygon):
    if any(
        point_segment_distance(point, a, polygon[(i + 1) % len(polygon)]) < 1e-8
        for i, a in enumerate(polygon)
    ):
        return True
    x, z = point
    result = False
    for i, (ax, az) in enumerate(polygon):
        bx, bz = polygon[(i + 1) % len(polygon)]
        if (az > z) != (bz > z) and x < (bx - ax) * (z - az) / (bz - az) + ax:
            result = not result
    return result


def segments_intersect(a, b, c, d):
    def cross(p, q, r):
        return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])

    values = cross(a, b, c), cross(a, b, d), cross(c, d, a), cross(c, d, b)
    if values[0] * values[1] < 0 and values[2] * values[3] < 0:
        return True
    return any(
        abs(v) < 1e-9 and point_segment_distance(p, u, w) < 1e-9
        for v, p, u, w in [
            (values[0], c, a, b),
            (values[1], d, a, b),
            (values[2], a, c, d),
            (values[3], b, c, d),
        ]
    )


def segment_footprint_distance(a, b, polygon):
    if inside(a, polygon) or inside(b, polygon):
        return 0
    distances = []
    for i, c in enumerate(polygon):
        d = polygon[(i + 1) % len(polygon)]
        if segments_intersect(a, b, c, d):
            return 0
        distances.extend(
            [
                point_segment_distance(a, c, d),
                point_segment_distance(b, c, d),
                point_segment_distance(c, a, b),
                point_segment_distance(d, a, b),
            ]
        )
    return min(distances)


def validate_placement(scene, obstacle, others):
    if not all(isfinite(v) for v in obstacle.position):
        raise ValueError("Obstacle coordinates must be finite")
    room = next((r for r in scene["rooms"] if r["id"] == obstacle.room_id), None)
    if not room:
        raise ValueError("Choose a room in this scene")
    corners = footprint(obstacle)
    if not all(inside(p, room["polygon"]) for p in corners):
        raise ValueError("The entire obstacle footprint must fit inside the selected room")
    # A concave room can contain all corners while a box crosses its boundary.
    for i, a in enumerate(corners):
        b = corners[(i + 1) % 4]
        for j, c in enumerate(room["polygon"]):
            d = room["polygon"][(j + 1) % len(room["polygon"])]
            if segments_intersect(a, b, c, d):
                raise ValueError("Obstacle touches or crosses a room boundary")
    for other in others:
        if other.id == obstacle.id:
            continue
        poly = footprint(other)
        if (
            any(inside(p, poly) for p in corners)
            or any(inside(p, corners) for p in poly)
            or any(
                segments_intersect(a, corners[(i + 1) % 4], b, poly[(j + 1) % 4])
                for i, a in enumerate(corners)
                for j, b in enumerate(poly)
            )
        ):
            raise ValueError(f"Obstacle overlaps {other.label}")
