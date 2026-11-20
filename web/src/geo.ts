// Geography helpers shared with the legacy globe.js (same frame: x east at lon 90, y north, z at lon 0).
export type V3 = [number, number, number];
export const rad = Math.PI / 180;
export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
export const smooth = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
export const dot = (a: V3 | number[], b: V3 | number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3 | number[], b: V3 | number[]): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const unit = (v: number[]): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
export function direction(lat: number, lon: number): V3 {
  const p = lat * rad, l = lon * rad;
  return [Math.cos(p) * Math.sin(l), Math.sin(p), Math.cos(p) * Math.cos(l)];
}
export function latLon(n: number[]): [number, number] {
  return [Math.asin(clamp(n[1], -1, 1)) / rad, Math.atan2(n[0], n[2]) / rad];
}
export function slerp(a: V3, b: V3, t: number): V3 {
  const angle = Math.acos(clamp(dot(a, b), -1, 1));
  if (angle < 1e-4) return a;
  const p = Math.sin((1 - t) * angle) / Math.sin(angle), q = Math.sin(t * angle) / Math.sin(angle);
  return [a[0] * p + b[0] * q, a[1] * p + b[1] * q, a[2] * p + b[2] * q];
}

// Trackball and basis update copied from globe.js so dragging feels identical.
export type Basis = number[]; // rows: screen right, up, toward viewer (in globe coords)
export function homeBasis(lat = 45, lon = 28): Basis {
  const forward = direction(lat, lon);
  const right = unit(cross([0, 1, 0], forward));
  return [right, cross(forward, right), forward].flat();
}
export function trackball(x: number, y: number, s: { x: number; y: number; r: number }): V3 {
  const right = (x - s.x) / s.r, up = (s.y - y) / s.r;
  const d = right * right + up * up;
  const depth = d < .81 ? Math.sqrt(1 - d) : .19 / Math.sqrt(d - .62);
  return unit([right, up, depth]);
}
export function turn(camera: Basis, from: V3, to: V3): Basis {
  const [x, y, z, w] = (() => {
    const c = cross(to, from), v = [c[0], c[1], c[2], 1 + dot(from, to)];
    const l = Math.hypot(...v);
    return v.map(k => k / l);
  })();
  const right = [1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y)];
  const up = [2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x)];
  const fwd = [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)];
  return [right, up, fwd].flatMap(([a, b, c]) => [0, 1, 2].map(i => a * camera[i] + b * camera[i + 3] + c * camera[i + 6]));
}
export function orthonormal(b: Basis): Basis {
  const r = unit(b.slice(0, 3)), f0 = b.slice(6, 9);
  const u = unit(cross(f0, r)), f = cross(r, u);
  return [...r, ...u, ...f];
}

// Equirectangular float grid (row 0 = north pole).
export class Grid {
  constructor(public w: number, public h: number, public data: Float32Array) {}
  sample(lat: number, lon: number) {
    const { w, h, data } = this;
    const x = (lon + 180) / 360 * w - .5, y = clamp((90 - lat) / 180 * h - .5, 0, h - 1.001);
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    const xa = ((x0 % w) + w) % w, xb = (xa + 1) % w, y1 = Math.min(h - 1, y0 + 1);
    const top = data[y0 * w + xa] * (1 - fx) + data[y0 * w + xb] * fx;
    const bot = data[y1 * w + xa] * (1 - fx) + data[y1 * w + xb] * fx;
    return top * (1 - fy) + bot * fy;
  }
  at(n: number[]) { const [la, lo] = latLon(n); return this.sample(la, lo); }
}

export function boxBlur(src: Float32Array, w: number, h: number, r: number, passes = 3) {
  let a = src.slice(), b = new Float32Array(a.length);
  const k = 2 * r + 1;
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) { // horizontal, wraps around the date line
      let s = 0;
      for (let i = -r; i <= r; i++) s += a[y * w + ((i + w) % w)];
      for (let x = 0; x < w; x++) {
        b[y * w + x] = s / k;
        s += a[y * w + ((x + r + 1) % w)] - a[y * w + ((x - r + w) % w)];
      }
    }
    for (let x = 0; x < w; x++) { // vertical, clamps at the poles
      let s = 0;
      for (let i = -r; i <= r; i++) s += b[clamp(i, 0, h - 1) * w + x];
      for (let y = 0; y < h; y++) {
        a[y * w + x] = s / k;
        s += b[clamp(y + r + 1, 0, h - 1) * w + x] - b[clamp(y - r, 0, h - 1) * w + x];
      }
    }
  }
  return a;
}

export function landMask(w = 1024, h = 512): Float32Array {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#fff";
  for (const ring of window.RouteLand || []) {
    ctx.beginPath();
    ring.forEach(([lon, lat], i) => {
      const x = (lon + 180) * w / 360, y = (90 - lat) * h / 180;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.closePath(); ctx.fill();
  }
  ctx.fillRect(0, h * (1 - 12 / 180), w, h); // Antarctica cap
  const px = ctx.getImageData(0, 0, w, h).data, out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = px[i * 4] / 255;
  return out;
}

export function elevationGrid(): Float32Array {
  const src = window.RouteElevation, out = new Float32Array(1024 * 512);
  for (let i = 0; i < out.length; i++) out[i] = (src?.[i] || 0) / 255;
  return out;
}

// Tiny deterministic value noise on the unit sphere (replaces Blender's noise.noise).
const perm = new Uint8Array(512);
{
  let s = 1337;
  const p = [...Array(256).keys()];
  for (let i = 255; i > 0; i--) { s = (s * 16807) % 2147483647; const j = s % (i + 1); [p[i], p[j]] = [p[j], p[i]]; }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
}
const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
function grad(h: number, x: number, y: number, z: number) {
  const u = h < 8 ? x : y, v = h < 4 ? y : (h === 12 || h === 14 ? x : z);
  return ((h & 1) ? -u : u) + ((h & 2) ? -v : v);
}
export function noise3(x: number, y: number, z: number) {
  const X = Math.floor(x) & 255, Y = Math.floor(y) & 255, Z = Math.floor(z) & 255;
  x -= Math.floor(x); y -= Math.floor(y); z -= Math.floor(z);
  const u = fade(x), v = fade(y), w = fade(z);
  const A = perm[X] + Y, AA = perm[A] + Z, AB = perm[A + 1] + Z, B = perm[X + 1] + Y, BA = perm[B] + Z, BB = perm[B + 1] + Z;
  const l = (a: number, b: number, t: number) => a + t * (b - a);
  return l(l(l(grad(perm[AA] & 15, x, y, z), grad(perm[BA] & 15, x - 1, y, z), u),
    l(grad(perm[AB] & 15, x, y - 1, z), grad(perm[BB] & 15, x - 1, y - 1, z), u), v),
    l(l(grad(perm[AA + 1] & 15, x, y, z - 1), grad(perm[BA + 1] & 15, x - 1, y, z - 1), u),
      l(grad(perm[AB + 1] & 15, x, y - 1, z - 1), grad(perm[BB + 1] & 15, x - 1, y - 1, z - 1), u), v), w);
}

export function mulberry(seed: number) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
