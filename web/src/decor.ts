import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { Terrain, OCEAN_R, SEA } from "./terrain";
import { direction, mulberry, slerp, V3 } from "./geo";
import { Props, bake, flatten, normalize } from "./props";
import { Glows } from "./particles";

const V = (a: number[]) => new THREE.Vector3(a[0], a[1], a[2]);
const UP = new THREE.Vector3(0, 1, 0);

/** Orient an object on the sphere: local +Y along the normal, `facing` axis along the tangent `f`. */
export function orient(obj: THREE.Object3D, n: THREE.Vector3, f: THREE.Vector3, r: number, facing: "x" | "z" = "z") {
  const y = n.clone().normalize();
  const t = f.clone().addScaledVector(y, -f.dot(y));
  if (t.lengthSq() < 1e-8) t.set(1, 0, 0).addScaledVector(y, -y.x);
  t.normalize();
  const m = new THREE.Matrix4();
  if (facing === "z") { const x = new THREE.Vector3().crossVectors(y, t); m.makeBasis(x, y, t); }
  else { const z = new THREE.Vector3().crossVectors(t, y); m.makeBasis(t, y, z); }
  obj.quaternion.setFromRotationMatrix(m);
  obj.position.copy(y).multiplyScalar(r);
}
export const north = (n: THREE.Vector3) => UP.clone().addScaledVector(n, -n.y).normalize();

export interface Tree { n: THREE.Vector3; r: number; s: number; yaw: number; kind: number; down: number; tilt: THREE.Vector3 | null; lift: number }

export class Decor {
  group = new THREE.Group();      // spins with the planet
  clouds = new THREE.Group();     // lags behind fast spins
  trees: Tree[] = [];
  treeMeshes: THREE.InstancedMesh[] = [];
  cities: Record<string, THREE.Object3D> = {};
  prince: THREE.Object3D;          // carrier: placed/oriented by globe.ts, holds every hero
  princeParts: Record<string, THREE.Object3D> = {};
  heroes: Record<string, THREE.Object3D> = {};
  hero = "prince"; heroPop = -1e9;
  plane: THREE.Object3D; boats: { obj: THREE.Object3D; c: V3; r: number; speed: number; t: number }[] = [];
  balloon: THREE.Object3D; whale: THREE.Object3D; volcano: THREE.Object3D;
  cloudList: { obj: THREE.Object3D; lat: number; lon: number; alt: number; speed: number; scale: number; seed: number; dark: number; pop: number }[] = [];
  cloudGeo: THREE.BufferGeometry;
  cloudMat: THREE.MeshStandardMaterial;
  stormMat: THREE.MeshStandardMaterial;
  lights: THREE.Points;
  aurora: THREE.Mesh;
  ring: THREE.Mesh;
  thread: THREE.InstancedMesh;
  meteorModel: THREE.Object3D;
  uniforms: { uTime: { value: number }; uSun: { value: THREE.Vector3 } };
  private treeDirty = true;

  constructor(public terrain: Terrain, props: Props, uniforms: { uTime: { value: number }; uSun: { value: THREE.Vector3 } }) {
    this.uniforms = uniforms;
    const rnd = mulberry(11);
    // ---- trees ----
    const kinds = ["tree_round", "tree_pine", "tree_palm"].map(k => bake(props[k], 1));
    const treeMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .7 });
    const N = 14000, golden = Math.PI * (3 - Math.sqrt(5));
    const picks: Tree[] = [];
    for (let i = 0; i < N && picks.length < 900; i++) {
      const y = 1 - (i + .5) / N * 2, rr = Math.sqrt(1 - y * y), th = golden * i + rnd() * .3;
      const d: V3 = [Math.sin(th) * rr, y, Math.cos(th) * rr];
      const b = terrain.biome(d);
      if (b.s < .9 || b.h < SEA + .02 || Math.abs(b.lat) > 63 || b.polar || b.desert > .3 || b.e > .4) continue;
      const nz = b.n;
      if (nz < -.02 && rnd() < .75) continue;
      if (rnd() < .45) continue;
      const kind = Math.abs(b.lat) < 22 && b.shore > .05 ? 2 : (b.lat > 45 || b.e > .2 ? 1 : 0);
      picks.push({ n: V(d), r: b.h - .002, s: .028 + rnd() * .018, yaw: rnd() * 6.28, kind, down: 0, tilt: null, lift: 0 });
    }
    this.trees = picks;
    this.treeMeshes = kinds.map((g, k) => {
      const m = new THREE.InstancedMesh(g, treeMat, Math.max(1, picks.filter(t => t.kind === k).length));
      m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false;
      this.group.add(m); return m;
    });
    this.updateTrees(0);

    // ---- city dioramas ----
    const L = window.RouteGlobe?.locations || {};
    for (const key of Object.keys(L)) {
      const src = props["city_" + key];
      if (!src) continue;
      const obj = flatten(normalize(src.clone(true), .085, "size"));
      const n = V(direction(L[key].lat, L[key].lon));
      orient(obj, n, north(n).negate(), terrain.surface([n.x, n.y, n.z]) - .004);
      obj.userData.base = obj.scale.x;
      this.cities[key] = obj; this.group.add(obj);
    }

    // ---- prince ----
    // Heroes: the Prince plus Alex's characters (art/blender/build_characters.py). One is visible at a time.
    this.prince = new THREE.Group();
    const heroes: [string, string, number, "height" | "size"][] = [["prince", "prince", .36, "height"], ["bear", "char_bear", .3, "height"], ["pig", "char_pig", .3, "height"], ["rv", "char_rv", .3, "size"]];
    for (const [id, key, h, by] of heroes) {
      if (!props[key]) continue;
      const hero = normalize(props[key].clone(true), h, by);
      // Self-lit a little so every hero reads on any terrain and on the night side.
      hero.traverse(o => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        const mat = (m.material as THREE.MeshStandardMaterial).clone();
        if (mat.map) { mat.emissive = new THREE.Color(1, 1, 1); mat.emissiveMap = mat.map; mat.emissiveIntensity = .3; }
        else { mat.color.offsetHSL(0, .04, .06); mat.emissive = mat.color.clone(); mat.emissiveIntensity = .34; }
        mat.roughness = Math.min(mat.roughness, .6); mat.metalness = 0;
        m.material = mat; m.castShadow = true;
      });
      hero.traverse(o => { if (o.name.startsWith(id + "_") || o.name.startsWith("prince")) this.princeParts[o.name] = o; });
      hero.userData.rest = { p: hero.position.clone(), s: hero.scale.clone() };
      hero.visible = id === this.hero;
      this.heroes[id] = hero; this.prince.add(hero);
    }
    for (const o of Object.values(this.princeParts)) o.userData.rest = { p: o.position.clone(), r: o.rotation.clone(), s: o.scale.clone() };
    this.prince.visible = false;
    this.group.add(this.prince);

    // ---- vehicles ----
    this.plane = flatten(normalize(props.plane.clone(true), .075, "size")); this.group.add(this.plane);
    for (const [c, r, speed, t] of [[[40, -32], 7, .05, 0], [[35.2, 18.5], 2.2, .09, 2], [[43.3, 34.2], 1.4, .12, 4]] as [number[], number, number, number][]) {
      const obj = flatten(normalize(props.boat.clone(true), .045, "size"));
      this.group.add(obj); this.boats.push({ obj, c: direction(c[0], c[1]), r: r * Math.PI / 180, speed, t });
    }
    this.balloon = flatten(normalize(props.balloon.clone(true), .07)); this.group.add(this.balloon);
    this.whale = flatten(normalize(props.whale.clone(true), .065, "size")); this.whale.visible = false; this.group.add(this.whale);
    this.volcano = flatten(normalize(props.volcano.clone(true), .075));
    { const n = V(direction(37.75, 15)); orient(this.volcano, n, north(n).negate(), terrain.surface([n.x, n.y, n.z]) - .006); this.group.add(this.volcano); }
    this.meteorModel = normalize(props.meteor.clone(true), .045, "size");

    // ---- clouds: soft popcorn puffs ----
    const puffs: THREE.BufferGeometry[] = [];
    for (const [x, y, z, s] of [[-1, 0, 0, .62], [-.35, .18, .05, .82], [.35, .12, -.05, .75], [.95, -.02, .02, .55], [0, -.1, .3, .6], [.1, -.08, -.32, .58]]) {
      const g = new THREE.IcosahedronGeometry(s, 2); g.translate(x, y, z); puffs.push(g);
    }
    this.cloudGeo = mergeGeometries(puffs)!; this.cloudGeo.scale(1, .72, 1); this.cloudGeo.computeVertexNormals();
    this.cloudMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, emissive: 0xf2faff, emissiveIntensity: .42 });
    this.stormMat = new THREE.MeshStandardMaterial({ color: 0x6a7894, roughness: 1, emissive: 0x1a2236, emissiveIntensity: .3 });
    const cl: [number, number, number][] = [[58, -30, 1.1], [34, -52, .9], [12, 62, 1], [-8, -18, 1.2], [47, 150, .9], [-28, 80, 1.1], [66, 60, .8],
      [52, 5, .8], [30, 40, .9], [62, 100, 1], [20, -80, 1], [-40, -60, .9], [5, 120, 1], [-15, 30, .8], [40, -120, 1.1], [70, -150, .9]];
    cl.forEach(([lat, lon, scale], i) => {
      const obj = new THREE.Mesh(this.cloudGeo, this.cloudMat);
      obj.castShadow = true;
      this.clouds.add(obj);
      this.cloudList.push({ obj, lat, lon, alt: 1.055 + (i % 4) * .013, speed: .25 + (i % 3) * .12, scale: .068 * scale, seed: i * 1.7, dark: 0, pop: 0 });
    });

    // ---- night city lights ----
    const towns = [[40.7, -74], [34, -118.2], [19.4, -99.1], [-23.5, -46.6], [-34.6, -58.4], [51.5, -.1], [48.9, 2.3], [52.5, 13.4],
      [41.9, 12.5], [40.4, -3.7], [55.75, 37.6], [41, 29], [30, 31.2], [6.5, 3.4], [-26.2, 28], [25.2, 55.3], [28.6, 77.2], [19.1, 72.9],
      [13.75, 100.5], [1.35, 103.8], [39.9, 116.4], [31.2, 121.5], [35.7, 139.7], [37.6, 127], [-33.9, 151.2], [-6.2, 106.8],
      [43.65, -79.4], [41.9, -87.6], [59.3, 18.1], [50.45, 30.5], [54.69, 25.28], [47.38, 8.54], [42.7, 23.32], [47.01, 28.86]];
    const pts: number[] = [], seeds: number[] = [], sizes: number[] = [];
    for (const [lat, lon] of towns) {
      const d = direction(lat, lon); pts.push(...d.map(v => v * 1.03)); seeds.push(rnd()); sizes.push(.06);
      // windows of the suburbs: a cluster of small warm dots around each town
      for (let k = 0; k < 18; k++) {
        const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * 4.2;
        const u = direction(lat + r * Math.sin(a), lon + r * Math.cos(a) / Math.max(.3, Math.cos(lat * Math.PI / 180)));
        const b = terrain.biome(u);
        if (b.s < .6) continue;
        pts.push(...u.map(v => v * (b.h + .007))); seeds.push(rnd()); sizes.push(.012 + rnd() * .014);
      }
    }
    for (let i = 0; i < 5200 && seeds.length < 1100; i++) {
      const d: V3 = [rnd() * 2 - 1, rnd() * 1.6 - .7, rnd() * 2 - 1];
      const l = Math.hypot(...d); const u: V3 = [d[0] / l, d[1] / l, d[2] / l];
      const b = terrain.biome(u);
      if (b.s < .9 || b.polar || b.desert > .3 || b.e > .35 || Math.abs(b.lat) > 62) continue;
      pts.push(...u.map(v => v * (b.h + .006))); seeds.push(rnd()); sizes.push(.018 + rnd() * .018);
    }
    const lg = new THREE.BufferGeometry();
    lg.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    lg.setAttribute("seed", new THREE.Float32BufferAttribute(seeds, 1));
    lg.setAttribute("size", new THREE.Float32BufferAttribute(sizes, 1));
    this.lights = new THREE.Points(lg, new THREE.ShaderMaterial({
      uniforms: { uSunL: { value: new THREE.Vector3() }, uTime: uniforms.uTime, uScale: { value: 400 } },
      vertexShader: `attribute float seed; attribute float size; uniform vec3 uSunL; uniform float uTime; uniform float uScale; varying float vA;
        void main(){ vec3 n = normalize(position); float night = smoothstep(.08, -.22, dot(n, uSunL));
          vA = night * (.8 + .2 * sin(uTime * (1.5 + seed * 2.) + seed * 40.)) * step(.08, fract(seed * 7.3 + floor(uTime * .2 + seed * 3.) * .37));
          vec4 mv = modelViewMatrix * vec4(position, 1.); vec3 vn = normalize(normalMatrix * n);
          vA *= smoothstep(-.05, .25, dot(vn, normalize(-mv.xyz)));
          gl_PointSize = size * uScale / -mv.z; gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `varying float vA; void main(){ vec2 p = gl_PointCoord - .5; float d = length(p);
        float core = exp(-d * d * 90.), halo = smoothstep(.5, 0., d); halo *= halo;
        float a = (core * 1.6 + halo * .55) * vA;
        gl_FragColor = vec4(mix(vec3(1., .72, .32), vec3(1., .95, .75), core) * a * 1.8, a); }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    this.lights.frustumCulled = false;
    this.group.add(this.lights);

    // ---- aurora ribbons around both poles (night side only) ----
    const ag = new THREE.CylinderGeometry(.47, .44, .12, 128, 1, true);
    const auroraMat = new THREE.ShaderMaterial({
      uniforms: { uTime: uniforms.uTime },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }`,
      fragmentShader: `uniform float uTime; varying vec2 vUv;
        void main(){ float a = vUv.x * 6.2831; float wave = .5 + .5 * sin(a * 9. + uTime * .7 + sin(a * 3. - uTime * .4) * 2.);
          float curtain = smoothstep(0., .25, vUv.y) * (1. - vUv.y) * wave;
          vec3 c = mix(vec3(.2, 1., .55), vec3(.7, .35, 1.), vUv.y);
          gl_FragColor = vec4(c * curtain * .9, curtain); }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    this.aurora = new THREE.Group() as unknown as THREE.Mesh;
    for (const s of [1, -1]) {
      const m = new THREE.Mesh(ag, auroraMat);
      m.position.y = s * .96; if (s < 0) m.rotation.x = Math.PI;
      m.userData.pole = s;
      this.aurora.add(m);
    }
    this.group.add(this.aurora);

    // ---- chosen-city ring ----
    this.ring = new THREE.Mesh(new THREE.RingGeometry(.035, .05, 40), new THREE.MeshBasicMaterial({ color: 0xc4f257, transparent: true, opacity: .85, depthWrite: false, side: THREE.DoubleSide }));
    this.ring.visible = false; this.group.add(this.ring);

    // ---- travel thread: a dotted arc ----
    this.thread = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 8, 6), new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff3c4, emissiveIntensity: .6, roughness: .5 }), 46);
    this.thread.count = 0; this.thread.frustumCulled = false; this.group.add(this.thread);
  }

  markTrees() { this.treeDirty = true; }
  /** Swap the visible hero; returns false for an unknown id. */
  setHero(id: string, now: number) {
    if (!this.heroes[id]) return false;
    if (id === this.hero) return true;
    for (const [k, o] of Object.entries(this.heroes)) o.visible = k === id;
    this.hero = id; this.heroPop = now;
    return true;
  }

  updateTrees(now: number) {
    if (!this.treeDirty) return;
    this.treeDirty = false;
    const counts = [0, 0, 0], m = new THREE.Matrix4(), q = new THREE.Quaternion(), qy = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3();
    let busy = false;
    for (const t of this.trees) {
      let k = 1;
      if (t.down) {
        const a = now - t.down;
        k = a < 8 ? 0 : Math.min(1, (a - 8) / .6);
        if (k < 1) busy = true;
        if (k >= 1) t.down = 0;
        k = k < 1 ? k * (1 + .35 * Math.sin(k * Math.PI)) : 1; // springy regrow
      }
      q.setFromUnitVectors(UP, t.n);
      qy.setFromAxisAngle(UP, t.yaw);
      q.multiply(qy);
      if (t.tilt) { const tq = new THREE.Quaternion().setFromAxisAngle(t.tilt, Math.min(1.2, t.lift)); q.premultiply(tq); busy = true; }
      p.copy(t.n).multiplyScalar(t.r + (t.tilt ? t.lift * .02 : 0));
      s.setScalar(t.s * k);
      m.compose(p, q, s);
      this.treeMeshes[t.kind].setMatrixAt(counts[t.kind]++, m);
    }
    this.treeMeshes.forEach((mesh, i) => { mesh.count = counts[i]; mesh.instanceMatrix.needsUpdate = true; mesh.computeBoundingSphere(); });
    if (busy) this.treeDirty = true;
  }

  /** Knock trees within angular radius (radians) around n. */
  knockTrees(n: THREE.Vector3, radius: number, now: number, onTree?: (t: Tree) => void) {
    const c = Math.cos(radius);
    for (const t of this.trees) if (!t.down && t.n.dot(n) > c) { t.down = now; onTree?.(t); }
    this.treeDirty = true;
  }

  update(now: number, dt: number, still: boolean, sunLocal: THREE.Vector3, glows: Glows) {
    (this.lights.material as THREE.ShaderMaterial).uniforms.uSunL.value.copy(sunLocal);
    this.updateTrees(now);
    // aurora: only show the pole that is in night
    for (const m of this.aurora.children) {
      const pole = m.userData.pole as number;
      m.visible = sunLocal.y * pole < .25;
      m.rotation.y = now * .02 * pole;
    }
    const t = still ? 0 : now;
    // clouds drift eastwards and bob
    for (const c of this.cloudList) {
      const lat = c.lat + 2.5 * Math.sin(t * .05 + c.seed), lon = c.lon + t * c.speed;
      const n = V(direction(lat, lon));
      orient(c.obj, n, north(n), c.alt + .004 * Math.sin(t * .6 + c.seed));
      const pop = c.pop > 0 ? Math.max(0, 1 - (now - c.pop) / .35) : 0;
      const k = c.pop > 0 && now - c.pop > .35 ? Math.min(1, (now - c.pop - 6) / 1.2) : 1;
      c.obj.visible = k > 0;
      // storm clouds swell into a fat thundercloud and shrink back
      const swell = c.dark > now ? Math.min(1, (c.dark - now) / .6, 1 - (c.dark - now - 7.4) / .6) : 0;
      c.obj.scale.setScalar(c.scale * Math.max(.01, k) * (1 + .4 * pop) * (1 + .7 * Math.max(0, Math.min(1, swell))));
      if (k >= 1 && c.pop) c.pop = 0;
      (c.obj as THREE.Mesh).material = c.dark > now ? this.stormMat : this.cloudMat;
    }
    // plane on a tilted orbit with a contrail
    {
      const a = t * .16, tilt = .55;
      const p = new THREE.Vector3(Math.sin(a), Math.cos(a) * Math.sin(tilt), Math.cos(a) * Math.cos(tilt));
      const f = new THREE.Vector3(Math.cos(a), -Math.sin(a) * Math.sin(tilt), -Math.sin(a) * Math.cos(tilt));
      orient(this.plane, p, f, 1.27, "x");
      this.plane.rotateX(.25 * Math.sin(t * .9));
      if (!still && Math.random() < dt * 40) glows.spawn(this.plane.position.clone().addScaledVector(f, -.04), { life: 1.4, size: .022, color: 0xffffff, grow: 1.5 });
    }
    for (const b of this.boats) {
      const a = t * b.speed + b.t, c = V(b.c), e = new THREE.Vector3().crossVectors(UP, c).normalize(), nn = new THREE.Vector3().crossVectors(c, e);
      const n = c.clone().multiplyScalar(Math.cos(b.r)).addScaledVector(e, Math.sin(b.r) * Math.cos(a)).addScaledVector(nn, Math.sin(b.r) * Math.sin(a)).normalize();
      const f = e.clone().multiplyScalar(-Math.sin(a)).addScaledVector(nn, Math.cos(a));
      orient(b.obj, n, f, OCEAN_R - .002, "x");
      b.obj.rotateX(.08 * Math.sin(t * 2 + b.t));
      if (!still && Math.random() < dt * 8) glows.spawn(b.obj.position.clone().addScaledVector(f, -.025), { life: 1.1, size: .016, color: 0xe8fbff, grow: 1.2 });
    }
    {
      const n = V(direction(39 + 1.5 * Math.sin(t * .05), 33 + t * .4 % 360));
      orient(this.balloon, n, north(n), 1.12 + .012 * Math.sin(t * .8));
    }
  }

  setThread(from: V3 | null, to: V3 | null, progress: number, fade: number, now: number) {
    if (!from || !to || fade >= 1) { this.thread.count = 0; return; }
    const m = new THREE.Matrix4(), n = 46, shown = Math.round(n * progress);
    let k = 0;
    for (let i = 0; i < shown; i++) {
      const u = i / (n - 1), d = slerp(from, to, u), lift = 1.012 + .1 * Math.sin(Math.PI * u);
      const pulse = .0055 * (1 + .35 * Math.sin(now * 5 - i * .5)) * (1 - fade);
      m.compose(V(d).multiplyScalar(lift), new THREE.Quaternion(), new THREE.Vector3(pulse, pulse, pulse));
      this.thread.setMatrixAt(k++, m);
    }
    this.thread.count = k; this.thread.instanceMatrix.needsUpdate = true;
  }
}
