import { useCallback, useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Settings, SolveResult } from '../types';
import type { TriMesh } from '../lib/cad/manifold';
import { REG } from '../lib/cad/profile';

export interface PreviewProps {
  result: SolveResult | null;
  settings: Settings;
  meshes: Map<string, TriMesh>;
  exploded: number;
  selected: string | null;
  onSelect: (id: string | null) => void;
  /** Bumping this re-frames the camera; sign chooses top-down or isometric. */
  frameRequest: { n: number; mode: 'iso' | 'top' };
}

const PALETTE = [0x4c8dff, 0x35c88a, 0xf0a02b, 0xd05fd0, 0x33bcd6, 0xe0605f, 0x8d7bff, 0x8fbf3f];

export function Preview({ result, settings, meshes, exploded, selected, onSelect, frameRequest }: PreviewProps) {
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<THREE.Scene>();
  const camera = useRef<THREE.PerspectiveCamera>();
  const renderer = useRef<THREE.WebGLRenderer>();
  const controls = useRef<OrbitControls>();
  const content = useRef<THREE.Group>();
  const framed = useRef(false);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  // One-time scene setup.
  useEffect(() => {
    const el = host.current!;
    const sc = new THREE.Scene();
    sc.background = new THREE.Color(0x11141a);

    const cam = new THREE.PerspectiveCamera(45, 1, 1, 8000);
    cam.up.set(0, 0, 1);
    cam.position.set(500, -520, 420);

    const rd = new THREE.WebGLRenderer({ antialias: true });
    rd.setPixelRatio(Math.min(devicePixelRatio, 2));
    el.appendChild(rd.domElement);

    const ct = new OrbitControls(cam, rd.domElement);
    ct.enableDamping = true;

    sc.add(new THREE.AmbientLight(0xffffff, 0.55));
    const key = new THREE.DirectionalLight(0xffffff, 1.1);
    key.position.set(0.4, -0.8, 1);
    sc.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.35);
    fill.position.set(-0.7, 0.5, 0.3);
    sc.add(fill);

    const group = new THREE.Group();
    sc.add(group);

    scene.current = sc;
    camera.current = cam;
    renderer.current = rd;
    controls.current = ct;
    content.current = group;

    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const click = (ev: MouseEvent) => {
      const r = rd.domElement.getBoundingClientRect();
      ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, cam);
      const hit = ray.intersectObjects(group.children, true).find((h) => h.object.userData.trayId);
      onSelectRef.current(hit ? (hit.object.userData.trayId as string) : null);
    };
    rd.domElement.addEventListener('click', click);

    const resize = () => {
      const w = el.clientWidth || 1;
      const h = el.clientHeight || 1;
      cam.aspect = w / h;
      cam.updateProjectionMatrix();
      rd.setSize(w, h, false);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);

    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      ct.update();
      rd.render(sc, cam);
    };
    tick();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      rd.domElement.removeEventListener('click', click);
      ct.dispose();
      rd.dispose();
      el.removeChild(rd.domElement);
    };
  }, []);

  const frame = useCallback((mode: 'iso' | 'top') => {
    const cam = camera.current;
    const ct = controls.current;
    if (!cam || !ct) return;
    const { cutoutLength: L, cutoutWidth: W, cutoutDepth: D } = settings;
    ct.target.set(L / 2, W / 2, D / 2);
    const span = Math.max(L, W, D);
    if (mode === 'top') cam.position.set(L / 2, W / 2 - 0.001, D / 2 + span * 1.7);
    else cam.position.set(L / 2 + span * 0.9, W / 2 - span * 1.1, D / 2 + span * 0.85);
    cam.updateProjectionMatrix();
    ct.update();
  }, [settings]);

  // Rebuild the scene contents whenever the solve, geometry or explode changes.
  useEffect(() => {
    const group = content.current;
    if (!group) return;
    for (const child of [...group.children]) {
      group.remove(child);
      child.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose();
      });
    }

    const { cutoutLength: L, cutoutWidth: W, cutoutDepth: D } = settings;

    // Case cutout outline, drawn around the origin at the case floor.
    const box = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(L, W, D));
    const helper = new THREE.Box3Helper(box, new THREE.Color(0x5a6472));
    group.add(helper);

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(L, W),
      new THREE.MeshBasicMaterial({ color: 0x1a1f28, side: THREE.DoubleSide }),
    );
    floor.position.set(L / 2, W / 2, -0.2);
    group.add(floor);

    if (result) {
      const gap = exploded * (Math.max(20, D * 0.25));
      for (const tray of result.trays) {
        const mesh = meshes.get(tray.id);
        const x = settings.caseFit + tray.cellX * settings.gridPitch + REG.cellGap / 2;
        const y = settings.caseFit + tray.cellY * settings.gridPitch + REG.cellGap / 2;
        const z = tray.z + tray.layer * gap;
        // Colour per tray so neighbours in a layer stay readable; layers are
        // already separated in Z.
        const colour = PALETTE[result.trays.indexOf(tray) % PALETTE.length];
        const isSel = selected === tray.id;

        let obj: THREE.Object3D;
        if (mesh) {
          const g = new THREE.BufferGeometry();
          g.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
          g.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
          g.computeVertexNormals();
          obj = new THREE.Mesh(
            g,
            new THREE.MeshStandardMaterial({
              color: isSel ? 0xffffff : colour,
              emissive: isSel ? 0x333333 : 0x000000,
              roughness: 0.55,
              metalness: 0.05,
              flatShading: false,
            }),
          );
        } else {
          // Geometry not built yet: show the footprint envelope.
          const g = new THREE.BoxGeometry(tray.sizeX, tray.sizeY, tray.height);
          obj = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: colour, transparent: true, opacity: 0.35 }));
          obj.position.set(tray.sizeX / 2, tray.sizeY / 2, tray.height / 2);
          const wrap = new THREE.Group();
          wrap.add(obj);
          obj = wrap;
        }
        obj.position.x += x;
        obj.position.y += y;
        obj.position.z += z;
        obj.traverse((o) => { o.userData.trayId = tray.id; });
        obj.userData.trayId = tray.id;
        group.add(obj);
      }
    }

    if (!framed.current) {
      frame('iso');
      framed.current = true;
    }
  }, [result, settings, meshes, exploded, selected, frame]);

  useEffect(() => {
    if (frameRequest.n > 0) frame(frameRequest.mode);
  }, [frameRequest, frame]);

  return <div className="preview" ref={host} />;
}
