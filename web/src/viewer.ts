import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { TriMesh } from './mesh/types';

export interface ViewPart { mesh: TriMesh; silhouette: [number, number][][] }

/** H3C build plate (mm). */
export const BED = { x: 330, y: 320 };

const PALETTE = [0xf5a524, 0x4cc38a, 0x5b9cf5, 0xe5484d, 0xb48ef0, 0x3ec7c7];

/**
 * Three.js preview, Z-up like the STL/printer coordinate system.
 * Touch: one finger orbits, pinch zooms, two fingers pan (OrbitControls
 * DOLLY_PAN). Mouse: left orbit, wheel zoom, right/shift-drag pan.
 */
export class Viewer {
  readonly renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(40, 1, 0.5, 5000);
  private controls: OrbitControls;
  private parts = new THREE.Group();
  private tray = new THREE.Group();
  private needsRender = true;
  /** Pixels at the bottom covered by the bottom sheet; the view is re-centred above it. */
  private bottomInset = 0;

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x1b1f24);
    host.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.touchAction = 'none';

    THREE.Object3D.DEFAULT_UP.set(0, 0, 1);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(220, -320, 260);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.screenSpacePanning = true;
    this.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    this.controls.maxDistance = 2500;
    this.controls.minDistance = 10;
    this.controls.addEventListener('change', () => (this.needsRender = true));

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x333344, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(150, -200, 400);
    this.scene.add(sun);

    this.scene.add(this.makeBed());
    this.scene.add(this.parts);
    this.scene.add(this.tray);

    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    const loop = () => {
      this.controls.update();
      if (this.needsRender) {
        this.renderer.render(this.scene, this.camera);
        this.needsRender = false;
      }
      requestAnimationFrame(loop);
    };
    loop();
  }

  private makeBed(): THREE.Object3D {
    const g = new THREE.Group();
    const plate = new THREE.Mesh(
      new THREE.PlaneGeometry(BED.x, BED.y),
      new THREE.MeshStandardMaterial({ color: 0x2a3038, roughness: 0.9 }),
    );
    plate.position.z = -0.05;
    g.add(plate);
    const grid = new THREE.GridHelper(Math.max(BED.x, BED.y), Math.max(BED.x, BED.y) / 10, 0x3d4652, 0x323a44);
    grid.rotation.x = Math.PI / 2;
    g.add(grid);
    return g;
  }

  private resize() {
    const w = this.host.clientWidth || 1, h = this.host.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    if (this.bottomInset > 0 && this.bottomInset < h * 0.8) {
      // Render the lower part of a taller virtual frame so the optical centre
      // sits in the middle of the area not hidden by the sheet.
      this.camera.setViewOffset(w, h + this.bottomInset, 0, this.bottomInset, w, h);
    } else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
    this.needsRender = true;
  }

  /** Replace displayed parts; lays them out in a row, each with its outline on the bed. */
  setParts(list: ViewPart[], reframe = true) {
    this.parts.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      (m.material as THREE.Material | undefined)?.dispose();
    });
    this.parts.clear();
    const gap = 12;
    const items = list.map((part, i) => {
      const color = PALETTE[i % PALETTE.length];
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(part.mesh.positions, 3));
      geo.computeVertexNormals();
      geo.computeBoundingBox();
      const group = new THREE.Group();
      group.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.05, flatShading: true })));
      // Top-down outline, drawn just above the bed.
      const pts: number[] = [];
      for (const loop of part.silhouette)
        for (let j = 0; j < loop.length; j++) {
          const a = loop[j], b = loop[(j + 1) % loop.length];
          pts.push(a[0], a[1], 0.15, b[0], b[1], 0.15);
        }
      const lineGeo = new THREE.BufferGeometry();
      lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      group.add(new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({ color: 0xffffff })));
      return { group, box: geo.boundingBox! };
    });
    const total = items.reduce((s, it) => s + (it.box.max.x - it.box.min.x), 0) + gap * Math.max(0, items.length - 1);
    let x = -total / 2;
    for (const it of items) {
      const w = it.box.max.x - it.box.min.x;
      it.group.position.x = x - it.box.min.x;
      x += w + gap;
      this.parts.add(it.group);
    }
    if (reframe) this.frame();
    this.needsRender = true;
  }

  private clear(group: THREE.Group) {
    group.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      (m.material as THREE.Material | undefined)?.dispose();
    });
    group.clear();
  }

  /**
   * Show a generated tray with the parts sitting in their pockets (or pass
   * null to go back to the loose-parts view).
   */
  setTray(tray: { mesh: TriMesh; placements: { partId: number; x: number; y: number; z: number }[] } | null, parts: (ViewPart & { partId: number })[] = [], showParts = true) {
    this.clear(this.tray);
    this.parts.visible = !tray;
    if (tray) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(tray.mesh.positions, 3));
      geo.computeVertexNormals();
      this.tray.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x8a94a3, roughness: 0.8, flatShading: true })));
      if (showParts)
        tray.placements.forEach((pl) => {
          const i = parts.findIndex((p) => p.partId === pl.partId);
          if (i < 0) return;
          const g = new THREE.BufferGeometry();
          g.setAttribute('position', new THREE.BufferAttribute(parts[i].mesh.positions, 3));
          g.computeVertexNormals();
          const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: PALETTE[i % PALETTE.length], roughness: 0.55, flatShading: true }));
          m.position.set(pl.x, pl.y, pl.z);
          this.tray.add(m);
        });
    }
    this.frame();
  }

  setBottomInset(px: number) {
    if (px === this.bottomInset) return;
    this.bottomInset = px;
    this.resize();
  }

  /** Fit the camera to the parts (or the bed when empty). */
  frame() {
    const box = new THREE.Box3().setFromObject(this.tray.children.length ? this.tray : this.parts);
    if (box.isEmpty()) box.set(new THREE.Vector3(-BED.x / 2, -BED.y / 2, 0), new THREE.Vector3(BED.x / 2, BED.y / 2, 10));
    const c = box.getCenter(new THREE.Vector3());
    const r = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 30);
    const vHalf = (this.camera.fov * Math.PI) / 360;
    const hHalf = Math.atan(Math.tan(vHalf) * this.camera.aspect);
    const visible = 1 - this.bottomInset / Math.max(1, this.host.clientHeight);
    const half = Math.min(hHalf, Math.atan(Math.tan(vHalf) * Math.max(0.2, visible)));
    const dist = (r / Math.sin(half)) * 1.15;
    const dir = new THREE.Vector3(0.45, -0.65, 0.6).normalize();
    this.camera.position.copy(c).addScaledVector(dir, dist);
    this.controls.target.copy(c);
    this.controls.update();
    this.needsRender = true;
  }
}

let thumbRenderer: THREE.WebGLRenderer | null = null;

/** Render a small picture of a posed part (on a patch of bed) as a PNG data URL. */
export function renderThumbnail(mesh: TriMesh, px = 192, color = PALETTE[0]): string {
  thumbRenderer ??= new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  thumbRenderer.setSize(px, px, false);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x333344, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(150, -200, 400);
  scene.add(sun);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.05, flatShading: true });
  scene.add(new THREE.Mesh(geo, mat));
  const r = geo.boundingSphere!.radius, c = geo.boundingSphere!.center;
  const bedGeo = new THREE.CircleGeometry(r * 1.25, 48);
  const bedMat = new THREE.MeshBasicMaterial({ color: 0x3a424d });
  const bed = new THREE.Mesh(bedGeo, bedMat);
  bed.position.set(c.x, c.y, -0.05);
  scene.add(bed);
  const cam = new THREE.PerspectiveCamera(30, 1, 0.5, 5000);
  cam.up.set(0, 0, 1);
  cam.position.copy(c).addScaledVector(new THREE.Vector3(0.45, -0.65, 0.6).normalize(), (r / Math.sin((15 * Math.PI) / 180)) * 1.1);
  cam.lookAt(c);
  thumbRenderer.render(scene, cam);
  const url = thumbRenderer.domElement.toDataURL('image/png');
  geo.dispose(); mat.dispose(); bedGeo.dispose(); bedMat.dispose();
  return url;
}
