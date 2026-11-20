import * as THREE from "three";

// Lightweight CPU particles in the planet's local frame (they spin with the globe).
// Bits: lit solid chunks (debris, droplets, lava, confetti, snow). Glows: additive sprites (fire, sparks, flashes).

export type Mode = "ballistic" | "float" | "fall" | "orbit";
export interface Spawn {
  p: THREE.Vector3; v?: THREE.Vector3; life?: number; size?: number; color?: THREE.ColorRepresentation;
  mode?: Mode; gravity?: number; drag?: number; bounce?: number; spin?: number; grow?: number; shape?: number;
}

const tmpM = new THREE.Matrix4(), tmpQ = new THREE.Quaternion(), tmpS = new THREE.Vector3(), tmpE = new THREE.Euler();

export class Bits {
  mesh: THREE.InstancedMesh;
  n = 0;
  private p: Float32Array; private v: Float32Array; private a: Float32Array; private life: Float32Array;
  private size: Float32Array; private mode: Uint8Array; private g: Float32Array; private drag: Float32Array;
  private bounce: Float32Array; private rot: Float32Array; private spin: Float32Array; private grow: Float32Array;
  constructor(public max: number, public surface: (d: number[]) => number, geometry?: THREE.BufferGeometry) {
    const geo = geometry || new THREE.IcosahedronGeometry(1, 0);
    const mat = new THREE.MeshStandardMaterial({ roughness: .7, metalness: 0, flatShading: true });
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.setColorAt(0, new THREE.Color(1, 1, 1));
    this.mesh.count = 0; this.mesh.frustumCulled = false; this.mesh.castShadow = true;
    this.p = new Float32Array(max * 3); this.v = new Float32Array(max * 3); this.a = new Float32Array(max);
    this.life = new Float32Array(max); this.size = new Float32Array(max); this.mode = new Uint8Array(max);
    this.g = new Float32Array(max); this.drag = new Float32Array(max); this.bounce = new Float32Array(max);
    this.rot = new Float32Array(max * 3); this.spin = new Float32Array(max); this.grow = new Float32Array(max);
  }
  spawn(s: Spawn) {
    let i = this.n;
    if (i >= this.max) { i = Math.floor(Math.random() * this.max); } else this.n++;
    this.p.set([s.p.x, s.p.y, s.p.z], i * 3);
    const v = s.v || new THREE.Vector3();
    this.v.set([v.x, v.y, v.z], i * 3);
    this.a[i] = 0; this.life[i] = s.life ?? 2; this.size[i] = s.size ?? .01;
    this.mode[i] = ["ballistic", "float", "fall", "orbit"].indexOf(s.mode || "ballistic");
    this.g[i] = s.gravity ?? 1.2; this.drag[i] = s.drag ?? .2; this.bounce[i] = s.bounce ?? .35;
    this.rot.set([Math.random() * 6, Math.random() * 6, Math.random() * 6], i * 3);
    this.spin[i] = s.spin ?? 6; this.grow[i] = s.grow ?? 0;
    this.mesh.setColorAt(i, new THREE.Color(s.color ?? 0xffffff));
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
  get active() { return this.n > 0; }
  update(dt: number) {
    const { p, v } = this;
    let w = 0;
    for (let i = 0; i < this.n; i++) {
      this.a[i] += dt;
      if (this.a[i] >= this.life[i]) continue;
      const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2], r = Math.hypot(x, y, z) || 1;
      const nx = x / r, ny = y / r, nz = z / r, m = this.mode[i];
      let vx = v[i * 3], vy = v[i * 3 + 1], vz = v[i * 3 + 2];
      if (m === 0 || m === 2) { vx -= nx * this.g[i] * dt; vy -= ny * this.g[i] * dt; vz -= nz * this.g[i] * dt; }
      if (m === 1) { vx += nx * this.g[i] * dt; vy += ny * this.g[i] * dt; vz += nz * this.g[i] * dt; }
      const k = Math.exp(-this.drag[i] * dt);
      vx *= k; vy *= k; vz *= k;
      let px = x + vx * dt, py = y + vy * dt, pz = z + vz * dt;
      if (m === 0 || m === 2) {
        const pr = Math.hypot(px, py, pz), d = [px / pr, py / pr, pz / pr], ground = this.surface(d) + this.size[i] * .6;
        if (pr < ground) {
          if (m === 2) { this.a[i] = this.life[i]; continue; }
          px = d[0] * ground; py = d[1] * ground; pz = d[2] * ground;
          const vr = vx * d[0] + vy * d[1] + vz * d[2];
          if (vr < 0) { vx -= (1 + this.bounce[i]) * vr * d[0]; vy -= (1 + this.bounce[i]) * vr * d[1]; vz -= (1 + this.bounce[i]) * vr * d[2]; }
          vx *= .7; vy *= .7; vz *= .7; this.spin[i] *= .6;
        }
      }
      // compact into slot w
      const j = w++;
      p[j * 3] = px; p[j * 3 + 1] = py; p[j * 3 + 2] = pz;
      v[j * 3] = vx; v[j * 3 + 1] = vy; v[j * 3 + 2] = vz;
      if (j !== i) {
        this.a[j] = this.a[i]; this.life[j] = this.life[i]; this.size[j] = this.size[i]; this.mode[j] = this.mode[i];
        this.g[j] = this.g[i]; this.drag[j] = this.drag[i]; this.bounce[j] = this.bounce[i]; this.spin[j] = this.spin[i]; this.grow[j] = this.grow[i];
        this.rot[j * 3] = this.rot[i * 3]; this.rot[j * 3 + 1] = this.rot[i * 3 + 1]; this.rot[j * 3 + 2] = this.rot[i * 3 + 2];
        const c = new THREE.Color(); this.mesh.getColorAt(i, c); this.mesh.setColorAt(j, c);
      }
      this.rot[j * 3] += this.spin[j] * dt; this.rot[j * 3 + 1] += this.spin[j] * dt * .7;
      const t = this.a[j] / this.life[j];
      const s = this.size[j] * (1 + this.grow[j] * t) * Math.min(1, (1 - t) * 5) * Math.min(1, this.a[j] * 20);
      tmpQ.setFromEuler(tmpE.set(this.rot[j * 3], this.rot[j * 3 + 1], this.rot[j * 3 + 2]));
      tmpM.compose(tmpS.set(px, py, pz), tmpQ, new THREE.Vector3(s, s, s));
      this.mesh.setMatrixAt(j, tmpM);
    }
    this.n = w; this.mesh.count = w;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

function glowTexture() {
  const c = document.createElement("canvas"); c.width = c.height = 64;
  const g = c.getContext("2d")!, r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, "rgba(255,255,255,1)"); r.addColorStop(.25, "rgba(255,255,255,.8)"); r.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = r; g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

export class Glows {
  points: THREE.Points;
  n = 0;
  private pos: Float32Array; private col: Float32Array; private sz: Float32Array; private al: Float32Array;
  private v: Float32Array; private age: Float32Array; private life: Float32Array; private size0: Float32Array; private grow: Float32Array; private rise: Float32Array;
  private c0: Float32Array;
  constructor(public max: number) {
    this.pos = new Float32Array(max * 3); this.col = new Float32Array(max * 3); this.sz = new Float32Array(max); this.al = new Float32Array(max);
    this.v = new Float32Array(max * 3); this.age = new Float32Array(max); this.life = new Float32Array(max); this.size0 = new Float32Array(max);
    this.grow = new Float32Array(max); this.rise = new Float32Array(max); this.c0 = new Float32Array(max * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute("color", new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute("size", new THREE.BufferAttribute(this.sz, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute("alpha", new THREE.BufferAttribute(this.al, 1).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: glowTexture() }, uScale: { value: 400 } },
      vertexShader: `attribute float size; attribute float alpha; varying vec3 vC; varying float vA;
        uniform float uScale;
        void main(){ vC = color; vA = alpha; vec4 mv = modelViewMatrix * vec4(position,1.); gl_PointSize = size * uScale / -mv.z; gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `uniform sampler2D uMap; varying vec3 vC; varying float vA;
        void main(){ float a = texture2D(uMap, gl_PointCoord).r * vA; gl_FragColor = vec4(vC * a, a); }`,
      vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    geo.setDrawRange(0, 0);
  }
  spawn(p: THREE.Vector3, o: { v?: THREE.Vector3; life?: number; size?: number; color?: THREE.ColorRepresentation; grow?: number; rise?: number } = {}) {
    let i = this.n; if (i >= this.max) i = Math.floor(Math.random() * this.max); else this.n++;
    this.pos.set([p.x, p.y, p.z], i * 3);
    const v = o.v || new THREE.Vector3(); this.v.set([v.x, v.y, v.z], i * 3);
    const c = new THREE.Color(o.color ?? 0xffe9a0); this.c0.set([c.r, c.g, c.b], i * 3);
    this.age[i] = 0; this.life[i] = o.life ?? .6; this.size0[i] = o.size ?? .04; this.grow[i] = o.grow ?? 0; this.rise[i] = o.rise ?? 0;
  }
  get active() { return this.n > 0; }
  update(dt: number) {
    let w = 0;
    for (let i = 0; i < this.n; i++) {
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) continue;
      const j = w++;
      const x = this.pos[i * 3], y = this.pos[i * 3 + 1], z = this.pos[i * 3 + 2], r = Math.hypot(x, y, z) || 1;
      const k = this.rise[i] * dt;
      const vx = this.v[i * 3] + x / r * k, vy = this.v[i * 3 + 1] + y / r * k, vz = this.v[i * 3 + 2] + z / r * k;
      this.pos[j * 3] = x + vx * dt; this.pos[j * 3 + 1] = y + vy * dt; this.pos[j * 3 + 2] = z + vz * dt;
      const damp = Math.exp(-1.5 * dt);
      this.v[j * 3] = vx * damp; this.v[j * 3 + 1] = vy * damp; this.v[j * 3 + 2] = vz * damp;
      if (j !== i) {
        this.age[j] = this.age[i]; this.life[j] = this.life[i]; this.size0[j] = this.size0[i]; this.grow[j] = this.grow[i]; this.rise[j] = this.rise[i];
        this.c0[j * 3] = this.c0[i * 3]; this.c0[j * 3 + 1] = this.c0[i * 3 + 1]; this.c0[j * 3 + 2] = this.c0[i * 3 + 2];
      }
      const t = this.age[j] / this.life[j];
      this.sz[j] = this.size0[j] * (1 + this.grow[j] * t);
      this.al[j] = (1 - t) * Math.min(1, this.age[j] * 30);
      this.col[j * 3] = this.c0[j * 3]; this.col[j * 3 + 1] = this.c0[j * 3 + 1] * (1 - .35 * t); this.col[j * 3 + 2] = this.c0[j * 3 + 2] * (1 - .6 * t);
    }
    this.n = w;
    const g = this.points.geometry;
    g.setDrawRange(0, w);
    for (const k of ["position", "color", "size", "alpha"]) (g.attributes[k] as THREE.BufferAttribute).needsUpdate = true;
  }
}
