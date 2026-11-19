import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { Camera } from "../src/protocol";
import { machine } from "./machine";
import type { Simulation } from "./physics";

const width = 760;
const height = 520;
const thumbnailScale = 0.5;

/** Half the overhead camera's view in metres, centred on the table origin. */
export const overheadHalfExtent = { x: 0.304, y: 0.208 };
const overheadPxPerMm = width / (overheadHalfExtent.x * 2000);

type Vec3 = [number, number, number];
function orthographic(halfX: number, halfY: number, position: Vec3, up: Vec3, target: Vec3) {
  const camera = new THREE.OrthographicCamera(-halfX, halfX, halfY, -halfY, 0.01, 4);
  camera.position.set(...position);
  camera.up.set(...up);
  camera.lookAt(...target);
  return camera;
}

export type FieldPose = { pos: Float64Array; mat: Float64Array };

export function fieldPose(sim: Simulation): FieldPose {
  return { pos: sim.data.geom_xpos.slice(), mat: sim.data.geom_xmat.slice() };
}

// MuJoCo geom types for the shapes used in the field. Its cylinders and capsules
// point along local Z, while the corresponding Three.js meshes point along Y.
function geometry(type: number, a: number, b: number, c: number) {
  switch (type) {
    case 2: // mjGEOM_SPHERE
      return new THREE.SphereGeometry(a, 24, 16);
    case 3: // mjGEOM_CAPSULE
      return new THREE.CapsuleGeometry(a, b * 2, 8, 20).rotateX(Math.PI / 2);
    case 5: // mjGEOM_CYLINDER
      return new THREE.CylinderGeometry(a, a, b * 2, 32).rotateX(Math.PI / 2);
    default:
      return new THREE.BoxGeometry(a * 2, b * 2, c * 2);
  }
}

export class FieldView {
  private readonly scene = new THREE.Scene();
  private readonly renderer = new THREE.WebGLRenderer({ antialias: true });
  private readonly cameras: Record<Camera, THREE.OrthographicCamera> = {
    overhead: orthographic(overheadHalfExtent.x, overheadHalfExtent.y, [0, 0, 0.8], [0, 1, 0], [0, 0, 0]),
    side: orthographic(
      overheadHalfExtent.x,
      overheadHalfExtent.y,
      [0, -0.65, 0.23],
      [0, 0, 1],
      [0, 0, 0.105],
    ),
    inspection: orthographic(
      0.076,
      0.052,
      [machine.loadX, -0.62, 0.095],
      [0, 0, 1],
      [machine.loadX, machine.loadY, 0.039],
    ),
  };
  private readonly rotation = new THREE.Matrix4();
  private readonly rotation3 = new THREE.Matrix3();
  private readonly meshes: THREE.Mesh[] = [];
  private readonly output = document.createElement("canvas");
  private readonly pen: CanvasRenderingContext2D;
  private readonly thumbnailCanvas = document.createElement("canvas");
  /** The simulation tick the meshes currently show, or -1 after drawing a perspective frame. */
  private posedTick = -1;

  private readonly perspective = new THREE.PerspectiveCamera(39, width / height, 0.02, 4);
  private readonly armLinks: THREE.Mesh[] = [];
  private readonly orbit: OrbitControls;
  private readonly previewPen: CanvasRenderingContext2D;
  private previewPose?: FieldPose;

  constructor(sim: Simulation, preview: HTMLCanvasElement) {
    const previewPen = preview.getContext("2d");
    if (!previewPen) throw new Error("Canvas 2D is unavailable.");
    this.previewPen = previewPen;
    this.perspective.up.set(0, 0, 1);
    this.perspective.position.set(0.64, -0.91, 0.72);
    this.orbit = new OrbitControls(this.perspective, preview);
    this.orbit.target.set(0, 0.06, 0.2);
    this.orbit.minDistance = 0.34;
    this.orbit.maxDistance = 2.45;
    this.orbit.maxPolarAngle = Math.PI * 0.49;
    this.orbit.update();
    this.orbit.saveState();
    this.orbit.addEventListener("change", () => {
      if (this.previewPose) this.drawPerspective(this.previewPose);
    });

    this.renderer.setSize(width, height);
    this.renderer.setClearColor(0x152327);
    this.output.width = width;
    this.output.height = height;
    const pen = this.output.getContext("2d");
    if (!pen) throw new Error("Canvas 2D is unavailable.");
    this.pen = pen;
    this.thumbnailCanvas.width = width * thumbnailScale;
    this.thumbnailCanvas.height = height * thumbnailScale;
    this.scene.add(new THREE.HemisphereLight(0xfff9df, 0x647b86, 2.1));
    const key = new THREE.DirectionalLight(0xfff5de, 2);
    key.position.set(-0.4, -0.5, 0.8);
    this.scene.add(key);

    for (let i = 0; i < sim.model.ngeom; i++) {
      const { geom_size: size, geom_rgba: rgba, geom_type: type, geom_group: group } = sim.model;
      const [a, b, c] = size.subarray(3 * i, 3 * i + 3);
      const alpha = rgba[4 * i + 3];
      const mesh = new THREE.Mesh(
        geometry(type[i], a, b, c),
        new THREE.MeshStandardMaterial({
          color: new THREE.Color(rgba[4 * i], rgba[4 * i + 1], rgba[4 * i + 2]),
          opacity: alpha,
          transparent: alpha < 1,
          depthWrite: alpha === 1,
          roughness: 0.86,
        }),
      );
      this.meshes.push(mesh);
      if (group[i] === 1) this.armLinks.push(mesh);
      this.scene.add(mesh);
    }

    const vertices: number[] = [];
    for (let index = -5; index <= 5; index++) {
      const x = index * 0.05;
      vertices.push(x, -0.2, 0.0002, x, 0.2, 0.0002);
    }
    for (let index = -4; index <= 4; index++) {
      const y = index * 0.05;
      vertices.push(-0.26, y, 0.0002, 0.26, y, 0.0002);
    }
    const grid = new THREE.BufferGeometry();
    grid.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
    this.scene.add(
      new THREE.LineSegments(
        grid,
        new THREE.LineBasicMaterial({ color: 0x91a7aa, transparent: true, opacity: 0.3 }),
      ),
    );
  }

  private applyPose({ pos, mat }: FieldPose) {
    for (const [i, mesh] of this.meshes.entries()) {
      mesh.position.fromArray(pos, i * 3);
      // MuJoCo matrices are row-major and Three.js reads column-major.
      this.rotation.setFromMatrix3(this.rotation3.fromArray(mat, i * 9).transpose());
      mesh.quaternion.setFromRotationMatrix(this.rotation);
    }
  }

  drawPerspective(pose: FieldPose) {
    this.previewPose = pose;
    this.posedTick = -1;
    this.applyPose(pose);
    for (const link of this.armLinks) link.visible = true;
    this.renderer.render(this.scene, this.perspective);
    this.previewPen.drawImage(this.renderer.domElement, 0, 0);
  }

  capture(sim: Simulation, camera: Camera) {
    if (this.posedTick !== sim.tick) {
      this.applyPose({ pos: sim.data.geom_xpos, mat: sim.data.geom_xmat });
      for (const link of this.armLinks) link.visible = false;
      this.posedTick = sim.tick;
    }
    this.renderer.render(this.scene, this.cameras[camera]);
    const pen = this.pen;
    pen.drawImage(this.renderer.domElement, 0, 0);
    pen.fillStyle = "#f0e8d6";
    pen.font = "bold 15px monospace";
    pen.fillText(`${camera.toUpperCase()}  /  TICK ${sim.tick}`, 17, 25);
    pen.fillText(camera === "overhead" ? "+X right  +Y up" : "+X right  +Z up", 17, 495);
    const inspection = camera === "inspection";
    pen.fillRect(644, 481, inspection ? 50 : 62.5, 2);
    pen.fillText(inspection ? "10 mm" : "50 mm", 650, 503);
    if (camera === "overhead") {
      for (let x = -200; x <= 200; x += 50) {
        pen.fillText(String(x), 365 + overheadPxPerMm * x, 49);
      }
      for (let y = -150; y <= 150; y += 50) {
        pen.fillText(String(y), 60, 265 - overheadPxPerMm * y);
      }
      const { width, height } = this.thumbnailCanvas;
      this.thumbnailCanvas.getContext("2d")?.drawImage(this.output, 0, 0, width, height);
    }
    return this.output.toDataURL("image/jpeg", 0.83);
  }

  /** A reduced copy of the latest overhead capture for run history cards. */
  thumbnail() {
    return this.thumbnailCanvas.toDataURL("image/jpeg", 0.8);
  }

  resetCamera() {
    this.orbit.reset();
  }

  dispose() {
    this.orbit.dispose();
    this.scene.traverse((object) => {
      if (object instanceof THREE.Mesh || object instanceof THREE.LineSegments) {
        object.geometry.dispose();
        object.material.dispose();
      }
    });
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}
