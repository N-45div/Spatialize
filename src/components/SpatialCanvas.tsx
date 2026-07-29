import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { Point, SpatialScene } from "../domain/spatial-scene";

const roomColors = {
  public: 0xd8e6c3,
  service: 0x6d7b74,
  circulation: 0xa8c7be,
  restricted: 0x695f59
};

function polygonShape(points: Point[]) {
  const shape = new THREE.Shape();
  points.forEach(([x, y], index) => index === 0 ? shape.moveTo(x, y) : shape.lineTo(x, y));
  shape.closePath();
  return shape;
}

function pointProjection(point: Point, start: Point, end: Point) {
  const dx = end[0] - start[0];
  const dz = end[1] - start[1];
  const lengthSquared = dx ** 2 + dz ** 2;
  const raw = lengthSquared === 0 ? 0 : ((point[0] - start[0]) * dx + (point[1] - start[1]) * dz) / lengthSquared;
  const t = Math.max(0, Math.min(1, raw));
  return {
    t,
    distance: Math.hypot(point[0] - (start[0] + t * dx), point[1] - (start[1] + t * dz))
  };
}

export function SpatialCanvas({
  scene,
  route,
  selectedId,
  mode
}: {
  scene: SpatialScene;
  route: Point[];
  selectedId: string;
  mode: "3d" | "2d";
}) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!host.current) return;
    const container = host.current;
    const world = new THREE.Scene();
    world.background = new THREE.Color(0x08110f);
    world.fog = new THREE.FogExp2(0x08110f, 0.027);

    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
    if (mode === "2d") camera.position.set(7.5, 29, 6.5);
    else camera.position.set(18, 20, 22);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(7.5, 0, 6.5);
    controls.enableDamping = true;
    controls.maxPolarAngle = Math.PI / 2.05;
    controls.enableRotate = mode === "3d";

    world.add(new THREE.HemisphereLight(0xdfffea, 0x101511, 2.4));
    const sun = new THREE.DirectionalLight(0xfff3cf, 3.6);
    sun.position.set(-8, 18, 10);
    sun.castShadow = true;
    world.add(sun);

    const plinth = new THREE.Mesh(
      new THREE.BoxGeometry(17.4, 0.4, 15.4),
      new THREE.MeshStandardMaterial({ color: 0x15231f, roughness: 0.72, metalness: 0.08 })
    );
    plinth.position.set(7.5, -0.25, 6.5);
    plinth.receiveShadow = true;
    world.add(plinth);

    const wallKeys = new Set<string>();
    scene.rooms.forEach((room) => {
      const geometry = new THREE.ExtrudeGeometry(polygonShape(room.polygon), {
        depth: room.category === "circulation" ? 0.12 : 0.2,
        bevelEnabled: true,
        bevelSize: 0.04,
        bevelThickness: 0.04
      });
      geometry.rotateX(Math.PI / 2);
      const mesh = new THREE.Mesh(
        geometry,
        new THREE.MeshStandardMaterial({
          color: roomColors[room.category],
          roughness: 0.72,
          transparent: room.category === "restricted",
          opacity: room.category === "restricted" ? 0.58 : 1
        })
      );
      mesh.receiveShadow = true;
      mesh.castShadow = true;
      world.add(mesh);

      const points = [...room.polygon, room.polygon[0]];
      for (let index = 0; index < points.length - 1; index++) {
        const [ax, az] = points[index];
        const [bx, bz] = points[index + 1];
        const length = Math.hypot(bx - ax, bz - az);
        const startKey = `${ax.toFixed(3)},${az.toFixed(3)}`;
        const endKey = `${bx.toFixed(3)},${bz.toFixed(3)}`;
        const wallKey = [startKey, endKey].sort().join("|");
        if (wallKeys.has(wallKey)) continue;
        wallKeys.add(wallKey);

        const cuts = scene.doors.flatMap((door) => {
          const projection = pointProjection(door.position, [ax, az], [bx, bz]);
          if (projection.distance > 0.08) return [];
          const half = door.width / (2 * length);
          return [{ start: Math.max(0, projection.t - half), end: Math.min(1, projection.t + half) }];
        }).sort((a, b) => a.start - b.start);

        const segments: { start: number; end: number }[] = [];
        let cursor = 0;
        cuts.forEach((cut) => {
          if (cut.start > cursor) segments.push({ start: cursor, end: cut.start });
          cursor = Math.max(cursor, cut.end);
        });
        if (cursor < 1) segments.push({ start: cursor, end: 1 });

        segments.forEach((segment) => {
          const segmentLength = length * (segment.end - segment.start);
          if (segmentLength < 0.05) return;
          const midpoint = (segment.start + segment.end) / 2;
          const wall = new THREE.Mesh(
            new THREE.BoxGeometry(segmentLength, 0.7, 0.09),
            new THREE.MeshStandardMaterial({ color: 0xe6eadf, roughness: 0.6 })
          );
          wall.position.set(ax + (bx - ax) * midpoint, 0.45, az + (bz - az) * midpoint);
          wall.rotation.y = -Math.atan2(bz - az, bx - ax);
          wall.castShadow = true;
          world.add(wall);
        });
      }
    });

    scene.doors.forEach((door) => {
      const threshold = new THREE.Mesh(
        new THREE.BoxGeometry(door.width, 0.035, 0.24),
        new THREE.MeshStandardMaterial({
          color: door.confidence < 0.85 ? 0xffc95c : 0x8de6c1,
          emissive: door.confidence < 0.85 ? 0x5c3500 : 0x0c3e2e,
          emissiveIntensity: 0.55
        })
      );
      threshold.position.set(door.position[0], 0.34, door.position[1]);
      threshold.rotation.y = -door.rotation;
      world.add(threshold);
    });

    const markerGroup = new THREE.Group();
    world.add(markerGroup);
    scene.landmarks.forEach((landmark) => {
      const [x, z] = landmark.position;
      const isSelected = landmark.id === selectedId;
      const marker = new THREE.Mesh(
        landmark.type === "entrance"
          ? new THREE.CylinderGeometry(0.24, 0.36, 0.8, 6)
          : new THREE.CylinderGeometry(isSelected ? 0.24 : 0.17, isSelected ? 0.24 : 0.17, isSelected ? 0.78 : 0.55, 24),
        new THREE.MeshStandardMaterial({
          color: isSelected ? 0xffcc62 : landmark.type === "entrance" ? 0xffce6a : 0x8de6c1,
          emissive: landmark.type === "entrance" ? 0x4a2e00 : 0x0d4b37,
          emissiveIntensity: isSelected ? 1.2 : 0.45
        })
      );
      marker.position.set(x, 0.65, z);
      marker.castShadow = true;
      marker.userData.baseY = marker.position.y;
      marker.userData.selected = isSelected;
      markerGroup.add(marker);

      if (isSelected) {
        const halo = new THREE.Mesh(
          new THREE.RingGeometry(0.46, 0.55, 40),
          new THREE.MeshBasicMaterial({ color: 0xffcc62, transparent: true, opacity: 0.72, side: THREE.DoubleSide })
        );
        halo.rotation.x = -Math.PI / 2;
        halo.position.set(x, 0.32, z);
        halo.userData.halo = true;
        markerGroup.add(halo);
      }
    });

    if (route.length > 1) {
      const curve = new THREE.CatmullRomCurve3(
        route.map(([x, z]) => new THREE.Vector3(x, 0.48, z)),
        false,
        "catmullrom",
        0.08
      );
      const path = new THREE.Mesh(
        new THREE.TubeGeometry(curve, Math.max(16, route.length * 8), 0.1, 12, false),
        new THREE.MeshStandardMaterial({
          color: 0xffc95c,
          emissive: 0xff9f1c,
          emissiveIntensity: 0.85
        })
      );
      world.add(path);

      route.slice(1, -1).forEach(([x, z], index) => {
        const waypoint = new THREE.Mesh(
          new THREE.SphereGeometry(0.14, 16, 16),
          new THREE.MeshBasicMaterial({ color: 0xffd878 })
        );
        waypoint.position.set(x, 0.5, z);
        waypoint.userData.waypoint = index;
        world.add(waypoint);
      });
    }

    const grid = new THREE.GridHelper(40, 40, 0x355449, 0x172923);
    const gridMaterials = Array.isArray(grid.material) ? grid.material : [grid.material];
    gridMaterials.forEach((material) => {
      material.transparent = true;
      material.opacity = 0.34;
    });
    grid.position.y = -0.05;
    world.add(grid);

    const resize = () => {
      const width = container.clientWidth;
      const height = container.clientHeight;
      renderer.setSize(width, height);
      camera.aspect = width / Math.max(height, 1);
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    resize();

    const clock = new THREE.Clock();
    let frame = 0;
    const animate = () => {
      const elapsed = clock.getElapsedTime();
      markerGroup.children.forEach((object) => {
        if (object.userData.selected) object.position.y = object.userData.baseY + Math.sin(elapsed * 2.4) * 0.08;
        if (object.userData.halo) {
          const pulse = 1 + Math.sin(elapsed * 2.4) * 0.12;
          object.scale.setScalar(pulse);
        }
      });
      world.traverse((object) => {
        if (typeof object.userData.waypoint === "number") {
          const pulse = 0.85 + Math.sin(elapsed * 3 - object.userData.waypoint) * 0.2;
          object.scale.setScalar(pulse);
        }
      });
      controls.update();
      renderer.render(world, camera);
      frame = requestAnimationFrame(animate);
    };
    animate();

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      world.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose();
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          materials.forEach((material) => material.dispose());
        }
      });
    };
  }, [scene, route, selectedId, mode]);

  return <div className="spatial-canvas" ref={host} aria-label="Interactive 3D venue map" />;
}
