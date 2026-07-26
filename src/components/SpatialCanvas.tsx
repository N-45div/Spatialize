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

export function SpatialCanvas({
  scene,
  route
}: {
  scene: SpatialScene;
  route: Point[];
}) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!host.current) return;
    const container = host.current;
    const world = new THREE.Scene();
    world.background = new THREE.Color(0x0a1412);
    world.fog = new THREE.Fog(0x0a1412, 20, 42);

    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
    camera.position.set(18, 20, 22);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(7.5, 0, 6.5);
    controls.enableDamping = true;
    controls.maxPolarAngle = Math.PI / 2.05;

    world.add(new THREE.HemisphereLight(0xdfffea, 0x101511, 2.4));
    const sun = new THREE.DirectionalLight(0xfff3cf, 3.6);
    sun.position.set(-8, 18, 10);
    sun.castShadow = true;
    world.add(sun);

    const plinth = new THREE.Mesh(
      new THREE.BoxGeometry(17, 0.35, 15),
      new THREE.MeshStandardMaterial({ color: 0x17231f, roughness: 0.82 })
    );
    plinth.position.set(7.5, -0.25, 6.5);
    plinth.receiveShadow = true;
    world.add(plinth);

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
        const wall = new THREE.Mesh(
          new THREE.BoxGeometry(length, 0.7, 0.09),
          new THREE.MeshStandardMaterial({ color: 0xe6eadf, roughness: 0.6 })
        );
        wall.position.set((ax + bx) / 2, 0.45, (az + bz) / 2);
        wall.rotation.y = -Math.atan2(bz - az, bx - ax);
        wall.castShadow = true;
        world.add(wall);
      }
    });

    scene.landmarks.forEach((landmark) => {
      const [x, z] = landmark.position;
      const marker = new THREE.Mesh(
        landmark.type === "entrance"
          ? new THREE.CylinderGeometry(0.24, 0.36, 0.8, 6)
          : new THREE.CylinderGeometry(0.18, 0.18, 0.55, 20),
        new THREE.MeshStandardMaterial({
          color: landmark.type === "entrance" ? 0xffce6a : 0x8de6c1,
          emissive: landmark.type === "entrance" ? 0x4a2e00 : 0x0d4b37,
          emissiveIntensity: 0.45
        })
      );
      marker.position.set(x, 0.65, z);
      marker.castShadow = true;
      world.add(marker);
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
    }

    const grid = new THREE.GridHelper(40, 40, 0x355449, 0x1a2b25);
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

    let frame = 0;
    const animate = () => {
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
  }, [scene, route]);

  return <div className="spatial-canvas" ref={host} aria-label="Interactive 3D venue map" />;
}
