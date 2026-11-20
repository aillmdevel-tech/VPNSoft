import { Grid, boxBlur, clamp, elevationGrid, landMask, noise3, rad, smooth } from "./geo";

export const SEA = 1.0;
export const OCEAN_R = SEA + .008;
export const PAL = {
  deep: 0x1a7fe0, shallow: 0x4fd2ff, sand: 0xf2d27e, desert: 0xffb648, grass: 0x84d93f,
  meadow: 0xb4df45, forest: 0x5cb735, rock: 0xb08257, snow: 0xf5fbff,
};

export interface Biome { h: number; s: number; e: number; n: number; polar: boolean; desert: number; shore: number; lat: number; lon: number }

export class Terrain {
  W = 1024; H = 512;
  raw: Grid; soft: Grid; wide: Grid; elev: Grid;
  constructor() {
    const mask = landMask(this.W, this.H);
    this.raw = new Grid(this.W, this.H, mask);
    this.soft = new Grid(this.W, this.H, boxBlur(mask, this.W, this.H, 3));
    this.wide = new Grid(this.W, this.H, boxBlur(mask, this.W, this.H, 14));
    this.elev = new Grid(this.W, this.H, boxBlur(elevationGrid(), this.W, this.H, 2, 2));
  }
  biome(d: number[]): Biome {
    const lat = Math.asin(clamp(d[1], -1, 1)) / rad, lon = Math.atan2(d[0], d[2]) / rad;
    const s = smooth(.3, .7, this.soft.sample(lat, lon));
    const e = this.elev.sample(lat, lon);
    const n = noise3(d[0] * 6, d[1] * 6, d[2] * 6) * .5 + noise3(d[0] * 17 + 3, d[1] * 17, d[2] * 17) * .25;
    const h = SEA - .03 + s * (.058 + .1 * Math.pow(e, .8) + .006 * n);
    const polar = Math.abs(lat) > 66 || (lat > 58 && lon > -75 && lon < -10);
    const alat = Math.abs(lat);
    const arid = smooth(11, 19, alat) * (1 - smooth(30, 37, alat));
    const region = (lat > 0 && lon > -18 && lon < 62) || (lat < 0 && lon > 112 && lon < 150) || (lat > 0 && lon > -118 && lon < -100);
    const desert = region && !polar ? Math.min(1, arid * 1.4) * (1 - smooth(.2, .35, e)) : 0;
    const shore = 1 - smooth(SEA + .004, SEA + .018, h);
    return { h, s, e, n, polar, desert, shore, lat, lon };
  }
  /** Surface radius at a unit direction (ocean surface where the land is under water). */
  surface(d: number[]) {
    const lat = Math.asin(clamp(d[1], -1, 1)) / rad, lon = Math.atan2(d[0], d[2]) / rad;
    const s = smooth(.3, .7, this.soft.sample(lat, lon));
    const e = this.elev.sample(lat, lon);
    return Math.max(OCEAN_R, SEA - .03 + s * (.058 + .1 * Math.pow(e, .8)));
  }
  isLand(d: number[]) { return this.raw.at(d) > .5; }
}

// Seasonal snow cover (ported 1:1 from globe.js), plus melting extra snow from snowfall.
export class SnowField {
  width = 1024; height = 512;
  pixels = new Uint8Array(1024 * 512);
  base: Uint8Array | null = null;
  worn = false; revision = 0; private day = -1;
  update(date: Date) {
    const stamp = Math.floor(date.getTime() / 86400000);
    if (stamp === this.day) return;
    this.day = stamp;
    const { width, height, pixels } = this, E = window.RouteElevation;
    const winter = Math.cos(2 * Math.PI * (date.getTime() - Date.UTC(date.getUTCFullYear(), 0, 20)) / 31557600000);
    for (let y = 0; y < height; y++) {
      const lat = 90 - (y + .5) * 180 / height;
      const season = lat >= 0 ? winter : -winter;
      for (let x = 0; x < width; x++) {
        const lon = (x + .5) * 360 / width - 180;
        const inland = lat > 0 ? (4 * Math.cos((lon - 95) * rad * 2) - 2 * Math.cos(lon * rad)) : 0;
        const variation = 2 * Math.sin((lon + lat) * .17) + 1.6 * Math.cos((lon - lat) * .29);
        const plain = (Math.abs(lat) - 65 + 15 * season + inland + variation) / 6;
        const elevation = (E?.[y * width + x] || 0) * 32;
        const snowLine = Math.max(200, 5200 - 43 * Math.abs(lat) - (1 + season) * 1775 * Math.sin(Math.abs(lat) * rad) - inland * 38);
        const alpine = clamp((elevation - snowLine + 380) / 820, 0, 1);
        const depth = Math.max(plain, alpine * alpine * (3 - 2 * alpine));
        const fringe = .16 * Math.sin(lon * 1.4 + Math.sin(lat)) * Math.cos(lat * 1.9);
        pixels[y * width + x] = Math.round(255 * clamp(depth + fringe * 4 * clamp(depth, 0, 1) * (1 - clamp(depth, 0, 1)), 0, 1));
      }
    }
    this.base = pixels.slice(); this.worn = false; this.revision++;
  }
  /** Brushed snow settles back and extra snow melts back to the seasonal cover. */
  regrow(step: number) {
    if (!this.worn || !this.base) return false;
    const { pixels, base } = this;
    let left = false;
    for (let i = 0; i < pixels.length; i++) {
      const p = pixels[i], b = base[i];
      if (p === b) continue;
      pixels[i] = p < b ? Math.min(b, p + step) : Math.max(b, p - step);
      if (pixels[i] !== b) left = true;
    }
    this.worn = left; this.revision++;
    return true;
  }
  value(n: number[]) {
    const col = Math.floor((Math.atan2(n[0], n[2]) / (2 * Math.PI) + .5) * this.width) % this.width;
    const row = clamp(Math.floor((.5 - Math.asin(clamp(n[1], -1, 1)) / Math.PI) * this.height), 0, this.height - 1);
    return this.pixels[row * this.width + col];
  }
  private brush(n: number[], radius: number, fn: (i: number, d: number) => number) {
    const { width, height, pixels } = this;
    const lat = Math.asin(clamp(n[1], -1, 1)), lon = Math.atan2(n[0], n[2]);
    const cx = (lon / Math.PI + 1) * width / 2 - .5, cy = (.5 - lat / Math.PI) * height - .5;
    const ry = radius * height / Math.PI, rx = Math.min(width / 2, ry / Math.max(.025, Math.cos(lat)));
    let changed = false;
    for (let y = Math.max(0, Math.floor(cy - ry)); y <= Math.min(height - 1, Math.ceil(cy + ry)); y++) {
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
        const d = Math.hypot((x - cx) / rx, (y - cy) / ry);
        if (d >= 1) continue;
        const i = y * width + ((x % width) + width) % width;
        const next = fn(i, d);
        if (next !== pixels[i]) { pixels[i] = next; changed = true; }
      }
    }
    if (changed) { this.revision++; this.worn = true; }
    return changed;
  }
  erase(n: number[], radius: number) {
    return this.brush(n, radius, (i, d) => Math.min(this.pixels[i], Math.round(255 * clamp((d - .72) / .28, 0, 1))));
  }
  dust(n: number[], radius: number, amount: number) {
    return this.brush(n, radius, (i, d) => Math.min(255, this.pixels[i] + Math.round(amount * (1 - d * d))));
  }
}
