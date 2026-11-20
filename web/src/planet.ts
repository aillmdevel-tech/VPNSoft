import * as THREE from "three";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import { Terrain, PAL, SEA, OCEAN_R, SnowField } from "./terrain";
import { smooth } from "./geo";

const col = (hex: number) => new THREE.Color(hex);
const UV_DIR = /* glsl */`
vec2 dirUV(vec3 d){ return vec2(atan(d.x, d.z) / 6.2831853 + .5, .5 - asin(clamp(d.y, -1., 1.)) / 3.1415927); }
`;

export interface Ripple { dir: THREE.Vector3; start: number; size: number; speed: number }

export class Planet {
  group = new THREE.Group();
  land: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  ocean: THREE.Mesh;
  atmosphere: THREE.Mesh;
  snowTex: THREE.DataTexture;
  base: Float32Array;      // undeformed radius per vertex
  dirs: Float32Array;      // unit direction per vertex
  colors0: Float32Array;   // undeformed colors
  uniforms = {
    uTime: { value: 0 },
    uSun: { value: new THREE.Vector3(0, 0, 1) },
    uRipples: { value: Array.from({ length: 8 }, () => new THREE.Vector4(0, 1, 0, -100)) },
    uRippleSize: { value: Array.from({ length: 8 }, () => new THREE.Vector2(.05, .1)) },
    uSnow: { value: null as THREE.Texture | null },
    uStorm: { value: 0 },
    uSunLocal: { value: new THREE.Vector3(0, 0, 1) },
  };
  private ripples: Ripple[] = [];
  private snowRevision = -1;

  constructor(public terrain: Terrain, public snow: SnowField, detail = 44) {
    // ---- land ----
    let geo: THREE.BufferGeometry = new THREE.IcosahedronGeometry(1, detail);
    geo.deleteAttribute("normal"); geo.deleteAttribute("uv");
    geo = mergeVertices(geo);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const count = pos.count;
    this.base = new Float32Array(count); this.dirs = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3), landAttr = new Float32Array(count);
    const c = new THREE.Color(), tmp = new THREE.Color();
    const C = Object.fromEntries(Object.entries(PAL).map(([k, v]) => [k, col(v)])) as Record<keyof typeof PAL, THREE.Color>;
    for (let i = 0; i < count; i++) {
      const v = new THREE.Vector3().fromBufferAttribute(pos, i).normalize();
      const b = terrain.biome([v.x, v.y, v.z]);
      this.base[i] = b.h; this.dirs.set([v.x, v.y, v.z], i * 3);
      pos.setXYZ(i, v.x * b.h, v.y * b.h, v.z * b.h);
      c.copy(C.grass);
      c.lerp(C.meadow, smooth(-.15, .35, b.n));
      c.lerp(C.forest, smooth(.05, .25, b.e) * .7);
      c.lerp(C.rock, smooth(.28, .45, b.e));
      c.lerp(C.snow, Math.max(smooth(.48, .6, b.e), b.polar ? 1 : 0));
      if (b.desert) c.lerp(C.desert, b.desert);
      if (!b.polar) c.lerp(C.sand, b.shore);
      // Soft value variation so large fields don't look flat.
      tmp.copy(c).multiplyScalar(1 + .06 * b.n);
      colors.set([tmp.r, tmp.g, tmp.b], i * 3);
      landAttr[i] = b.s;
    }
    this.colors0 = colors.slice();
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geo.setAttribute("landness", new THREE.BufferAttribute(landAttr, 1));
    geo.computeVertexNormals();

    this.snowTex = new THREE.DataTexture(snow.pixels, snow.width, snow.height, THREE.RedFormat, THREE.UnsignedByteType);
    this.snowTex.magFilter = this.snowTex.minFilter = THREE.LinearFilter;
    this.snowTex.wrapS = THREE.RepeatWrapping;
    this.uniforms.uSnow.value = this.snowTex;

    const landMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .66, metalness: 0 });
    landMat.onBeforeCompile = sh => {
      Object.assign(sh.uniforms, { uSnow: this.uniforms.uSnow, uTime: this.uniforms.uTime, uStorm: this.uniforms.uStorm, uSunLocal: this.uniforms.uSunLocal });
      sh.vertexShader = sh.vertexShader
        .replace("#include <common>", "#include <common>\nattribute float landness;\nvarying float vLandness;\nvarying vec3 vDir;")
        .replace("#include <begin_vertex>", "#include <begin_vertex>\nvLandness = landness;\nvDir = normalize(position);");
      sh.fragmentShader = sh.fragmentShader
        .replace("#include <common>", "#include <common>\nuniform sampler2D uSnow;\nuniform float uStorm;\nuniform vec3 uSunLocal;\nvarying float vLandness;\nvarying vec3 vDir;\n" + UV_DIR)
        .replace("#include <color_fragment>", `#include <color_fragment>
          float snowAmt = texture2D(uSnow, dirUV(vDir)).r * smoothstep(.35, .8, vLandness);
          float grain = fract(sin(dot(floor(vDir * 380.), vec3(12.9898, 78.233, 37.719))) * 43758.5453);
          float cover = smoothstep(.08, .7, snowAmt + (grain - .5) * .12);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.05, 1.07, 1.1) * (.97 + .05 * grain), cover);
          diffuseColor.rgb *= 1. - uStorm * .18;`)
        .replace("#include <dithering_fragment>", `
          // Day/night: brighter day side, deep blue night side with a readable terminator.
          float dayK = smoothstep(-.16, .3, dot(normalize(vDir), uSunLocal));
          gl_FragColor.rgb *= mix(vec3(.3, .36, .66), vec3(1.07, 1.06, 1.02), dayK);
          #include <dithering_fragment>`);
    };
    this.land = new THREE.Mesh(geo, landMat);
    this.land.castShadow = true; this.land.receiveShadow = true;
    this.group.add(this.land);

    // ---- ocean ----
    const wide = new Uint8Array(terrain.W * terrain.H);
    for (let i = 0; i < wide.length; i++) wide[i] = Math.round(255 * terrain.wide.data[i]);
    const wideTex = new THREE.DataTexture(wide, terrain.W, terrain.H, THREE.RedFormat, THREE.UnsignedByteType);
    wideTex.magFilter = wideTex.minFilter = THREE.LinearFilter; wideTex.wrapS = THREE.RepeatWrapping; wideTex.needsUpdate = true;
    const oceanMat = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: .2, metalness: 0, clearcoat: .35, clearcoatRoughness: .2 });
    oceanMat.onBeforeCompile = sh => {
      Object.assign(sh.uniforms, { uWide: { value: wideTex }, uTime: this.uniforms.uTime, uRipples: this.uniforms.uRipples, uRippleSize: this.uniforms.uRippleSize, uStorm: this.uniforms.uStorm, uSunLocal: this.uniforms.uSunLocal });
      sh.vertexShader = sh.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vDir;")
        .replace("#include <begin_vertex>", "#include <begin_vertex>\nvDir = normalize(position);");
      sh.fragmentShader = sh.fragmentShader
        .replace("#include <common>", `#include <common>
          uniform sampler2D uWide; uniform float uTime; uniform float uStorm; uniform vec3 uSunLocal;
          uniform vec4 uRipples[8]; uniform vec2 uRippleSize[8];
          varying vec3 vDir;` + UV_DIR)
        .replace("#include <color_fragment>", `#include <color_fragment>
          float w = texture2D(uWide, dirUV(vDir)).r;
          float t = smoothstep(.02, .45, w);
          vec3 deep = vec3(${col(PAL.deep).toArray().map(v => v.toFixed(4)).join(",")});
          vec3 shallow = vec3(${col(PAL.shallow).toArray().map(v => v.toFixed(4)).join(",")});
          diffuseColor.rgb = mix(deep, shallow, t);
          // Caustic shimmer near the coast.
          vec3 q = vDir * 90.;
          float caust = sin(q.x + uTime * 1.3 + sin(q.y * 1.7 + uTime)) * sin(q.z * 1.2 - uTime * 1.1 + sin(q.x * .8));
          diffuseColor.rgb += vec3(.55, .9, 1.) * smoothstep(.55, 1., caust) * t * .22;
          // Foam line hugging the shore.
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.95, 1., 1.), smoothstep(.36, .5, w) * (1. - smoothstep(.5, .6, w)) * (.55 + .45 * sin(uTime * 2. + w * 40.)));
          float ring = 0.;
          for (int i = 0; i < 8; i++) {
            float age = uTime - uRipples[i].w;
            if (age < 0. || age > uRippleSize[i].y * 4.) continue;
            float d = acos(clamp(dot(vDir, uRipples[i].xyz), -1., 1.));
            float r = age * uRippleSize[i].x;
            float k = 1. - age / (uRippleSize[i].y * 4.);
            ring += (smoothstep(.006, 0., abs(d - r)) + .6 * smoothstep(.005, 0., abs(d - r * .62))) * k;
          }
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.97, 1., 1.), clamp(ring, 0., 1.) * .85);
          diffuseColor.rgb *= 1. - uStorm * .22;`)
        .replace("#include <dithering_fragment>", `
          // Day/night: brighter day side, deep blue night side with a readable terminator.
          float dayK = smoothstep(-.16, .3, dot(normalize(vDir), uSunLocal));
          gl_FragColor.rgb *= mix(vec3(.3, .36, .66), vec3(1.07, 1.06, 1.02), dayK);
          #include <dithering_fragment>`)
        .replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>
          vec3 wq = vDir * 140. + vec3(uTime * .6, uTime * .4, -uTime * .5);
          normal = normalize(normal + .045 * vec3(sin(wq.x + sin(wq.y)), sin(wq.y * 1.3 + sin(wq.z)), sin(wq.z * .9 + sin(wq.x))));`);
    };
    this.ocean = new THREE.Mesh(new THREE.SphereGeometry(OCEAN_R, 128, 80), oceanMat);
    this.ocean.receiveShadow = true;
    this.group.add(this.ocean);

    // ---- atmosphere (fresnel rim, warmer on the day side) ----
    const atmoMat = new THREE.ShaderMaterial({
      uniforms: { uSun: this.uniforms.uSun },
      vertexShader: `varying vec3 vN; varying vec3 vW; void main(){ vN = normalize(mat3(modelMatrix) * normal); vec4 w = modelMatrix * vec4(position,1.); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: `uniform vec3 uSun; varying vec3 vN; varying vec3 vW;
        void main(){
          vec3 v = normalize(cameraPosition - vW);
          float rim = pow(clamp(1. - abs(dot(v, vN)), 0., 1.), 2.2);
          float inner = smoothstep(.0, .35, dot(-v, vN));
          float day = smoothstep(-.35, .45, dot(vN, uSun));
          vec3 c = mix(vec3(.25, .45, 1.), vec3(.62, .93, 1.), day);
          float a = rim * inner * (.35 + .65 * day);
          gl_FragColor = vec4(c * a * 1.3, a);
        }`,
      side: THREE.BackSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.atmosphere = new THREE.Mesh(new THREE.SphereGeometry(1.11, 96, 48), atmoMat);
    this.atmosphere.renderOrder = -1;
    this.group.add(this.atmosphere);
  }

  ripple(dir: THREE.Vector3, now: number, size = .05, life = .6) {
    this.ripples.push({ dir: dir.clone().normalize(), start: now, size, speed: life });
    if (this.ripples.length > 8) this.ripples.shift();
    this.ripples.forEach((r, i) => {
      this.uniforms.uRipples.value[i].set(r.dir.x, r.dir.y, r.dir.z, r.start);
      this.uniforms.uRippleSize.value[i].set(r.size, r.speed);
    });
  }

  syncSnow() {
    if (this.snow.revision === this.snowRevision) return;
    this.snowRevision = this.snow.revision;
    this.snowTex.needsUpdate = true;
  }

  // ---- craters: vertex dents that heal over time ----
  private craters: { n: THREE.Vector3; r: number; depth: number; start: number; heal: number; idx: Int32Array; w: Float32Array }[] = [];
  crater(n: THREE.Vector3, r: number, depth: number, now: number, heal = 10) {
    const idx: number[] = [], w: number[] = [];
    const cosR = Math.cos(r * 1.5);
    for (let i = 0; i < this.base.length; i++) {
      const d = n.x * this.dirs[i * 3] + n.y * this.dirs[i * 3 + 1] + n.z * this.dirs[i * 3 + 2];
      if (d < cosR) continue;
      const a = Math.acos(Math.min(1, d)) / r;
      // Bowl with a raised rim.
      const bowl = a < 1 ? -((1 - a * a) ** 2) : 0;
      const rim = .35 * Math.exp(-((a - 1.05) ** 2) / .05);
      idx.push(i); w.push(bowl + rim);
    }
    this.craters.push({ n: n.clone(), r, depth, start: now, heal, idx: Int32Array.from(idx), w: Float32Array.from(w) });
    if (this.craters.length > 6) this.craters.shift();
  }
  get deforming() { return this.craters.length > 0; }
  updateCraters(now: number) {
    if (!this.craters.length) return;
    const pos = this.land.geometry.attributes.position as THREE.BufferAttribute;
    const color = this.land.geometry.attributes.color as THREE.BufferAttribute;
    const touched = new Set<number>();
    for (const c of this.craters) c.idx.forEach(i => touched.add(i));
    const offset = new Map<number, number>(), scorch = new Map<number, number>();
    this.craters = this.craters.filter(c => now - c.start < c.heal);
    for (const c of this.craters) {
      const t = (now - c.start) / c.heal;
      const grow = Math.min(1, (now - c.start) / .18);
      const k = grow * (1 - smooth(.35, 1, t));
      for (let j = 0; j < c.idx.length; j++) {
        const i = c.idx[j];
        offset.set(i, (offset.get(i) || 0) + c.w[j] * c.depth * k);
        if (c.w[j] < 0) scorch.set(i, Math.max(scorch.get(i) || 0, -c.w[j] * k));
      }
    }
    for (const i of touched) {
      const r = this.base[i] + (offset.get(i) || 0);
      pos.setXYZ(i, this.dirs[i * 3] * r, this.dirs[i * 3 + 1] * r, this.dirs[i * 3 + 2] * r);
      const s = scorch.get(i) || 0;
      color.setXYZ(i, this.colors0[i * 3] * (1 - .55 * s) + .18 * s, this.colors0[i * 3 + 1] * (1 - .62 * s) + .1 * s, this.colors0[i * 3 + 2] * (1 - .6 * s) + .06 * s);
    }
    pos.needsUpdate = true; color.needsUpdate = true;
    this.land.geometry.computeVertexNormals();
  }
}

export { SEA, OCEAN_R };
