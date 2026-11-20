import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import propsUrl from "../assets/props.glb?inline";
import charsUrl from "../assets/characters.glb?inline";

export type Props = Record<string, THREE.Object3D>;

function dataUrlToBuffer(url: string) {
  const b64 = url.slice(url.indexOf(",") + 1);
  const bin = atob(b64), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

export async function loadProps(): Promise<Props> {
  const [props, chars] = await Promise.all([parseGlb(propsUrl), parseGlb(charsUrl)]);
  return { ...props, ...chars };
}

function parseGlb(url: string): Promise<Props> {
  return new Promise((resolve, reject) => {
    // The WebView CSP has connect-src 'none': GLTFLoader's ImageBitmapLoader fetches blob: URLs and is blocked.
    // Hiding createImageBitmap while the parser is constructed makes it fall back to <img> (img-src allows blob:).
    const w = window as any, bitmap = w.createImageBitmap;
    w.createImageBitmap = undefined;
    try { parseWith(url, resolve, reject); } finally { w.createImageBitmap = bitmap; }
  });
}

function parseWith(url: string, resolve: (p: Props) => void, reject: (e: unknown) => void) {
  {
    new GLTFLoader().parse(dataUrlToBuffer(url), "", gltf => {
      const out: Props = {};
      for (const child of [...gltf.scene.children]) {
        child.position.set(0, 0, 0);
        child.traverse(o => {
          const m = o as THREE.Mesh;
          if (m.isMesh) {
            m.castShadow = true; m.receiveShadow = true;
            const mat = m.material as THREE.MeshStandardMaterial;
            if (mat && mat.isMeshStandardMaterial) { mat.roughness = Math.max(.45, mat.roughness); mat.envMapIntensity = .6; }
          }
        });
        out[child.name] = child;
      }
      resolve(out);
    }, reject);
  }
}

/** Re-centre on the ground (y = 0), centred in x/z, scaled to the given height. */
export function normalize(obj: THREE.Object3D, height: number, by: "height" | "size" = "height") {
  obj.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(obj), size = box.getSize(new THREE.Vector3());
  const k = height / (by === "height" ? size.y : Math.max(size.x, size.y, size.z));
  const wrap = new THREE.Group();
  obj.position.set(-(box.min.x + box.max.x) / 2 * k, -box.min.y * k, -(box.min.z + box.max.z) / 2 * k);
  obj.scale.multiplyScalar(k); // keep the root's own scale (characters.glb roots carry one)
  wrap.add(obj);
  return wrap;
}

/** Bake a multi-material prop into one vertex-coloured geometry (for instancing). */
export function bake(obj: THREE.Object3D, height: number) {
  obj.updateMatrixWorld(true);
  const parts: THREE.BufferGeometry[] = [];
  const inv = new THREE.Matrix4().copy(obj.matrixWorld).invert();
  obj.traverse(o => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    let g = m.geometry.clone();
    g = g.index ? g.toNonIndexed() : g;
    for (const k of Object.keys(g.attributes)) if (k !== "position" && k !== "normal") g.deleteAttribute(k);
    g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld));
    const c = ((m.material as THREE.MeshStandardMaterial).color || new THREE.Color(1, 1, 1));
    const n = g.attributes.position.count, arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) arr.set([c.r, c.g, c.b], i * 3);
    g.setAttribute("color", new THREE.BufferAttribute(arr, 3));
    parts.push(g);
  });
  const geo = mergeGeometries(parts)!;
  geo.computeBoundingBox();
  const b = geo.boundingBox!, k = height / (b.max.y - b.min.y);
  geo.translate(-(b.min.x + b.max.x) / 2, -b.min.y, -(b.min.z + b.max.z) / 2);
  geo.scale(k, k, k);
  return geo;
}

/** Merge a static multi-mesh prop (already normalized) into one draw call: vertex colours, one shared material. */
const flatMat = new Map<string, THREE.MeshStandardMaterial>();
export function flatten(wrap: THREE.Object3D, roughness = .72) {
  wrap.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(wrap.matrixWorld).invert();
  const parts: THREE.BufferGeometry[] = [];
  wrap.traverse(o => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    let g = m.geometry.clone();
    g = g.index ? g.toNonIndexed() : g;
    for (const k of Object.keys(g.attributes)) if (k !== "position" && k !== "normal") g.deleteAttribute(k);
    g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld));
    const mat = m.material as THREE.MeshStandardMaterial;
    const c = (mat.color || new THREE.Color(1, 1, 1)).clone();
    if (mat.emissive) c.add(mat.emissive.clone().multiplyScalar(.6 * (mat.emissiveIntensity ?? 1)));
    const n = g.attributes.position.count, arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) arr.set([Math.min(c.r, 1.4), Math.min(c.g, 1.4), Math.min(c.b, 1.4)], i * 3);
    g.setAttribute("color", new THREE.BufferAttribute(arr, 3));
    parts.push(g);
  });
  const key = String(roughness);
  if (!flatMat.has(key)) flatMat.set(key, new THREE.MeshStandardMaterial({ vertexColors: true, roughness, metalness: 0 }));
  const mesh = new THREE.Mesh(mergeGeometries(parts)!, flatMat.get(key));
  mesh.castShadow = true; mesh.receiveShadow = true;
  const out = new THREE.Group(); out.add(mesh);
  return out;
}
