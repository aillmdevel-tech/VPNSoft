import * as THREE from "three";
import { Planet } from "./planet";
import { Decor, orient, north } from "./decor";
import { Terrain, SnowField, OCEAN_R } from "./terrain";
import { Bits, Glows } from "./particles";
import { sound } from "./sound";

export interface ToyCtx {
  planet: Planet; decor: Decor; terrain: Terrain; snow: SnowField;
  bits: Bits; hot: Bits; glows: Glows; local: THREE.Group;
  view(): { right: THREE.Vector3; up: THREE.Vector3; fwd: THREE.Vector3 };
  shake(a: number): void; wobble(a: number): void; flash(a: number): void;
  focus(n: THREE.Vector3, ms?: number): void;
  storm(k: number): void;
}
interface Effect { update(now: number, dt: number): boolean }

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const tangent = (n: THREE.Vector3) => {
  const t = new THREE.Vector3().crossVectors(n, Math.abs(n.y) > .9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0)).normalize();
  return t.applyAxisAngle(n, Math.random() * Math.PI * 2);
};
const DIRT = [0x8a5a35, 0xa96c38, 0x6d4a30, 0x79cf3a, 0x4c9f2e, 0xc98a4b];
const WATER = [0xe9fbff, 0xbfefff, 0x7fd8ff, 0xffffff];
const CONFETTI = [0xffc93c, 0xff6b5b, 0xc4f257, 0x4fd2ff, 0xb45cff, 0xffffff];

export class Toys {
  effects: Effect[] = [];
  private ringGeo = new THREE.RingGeometry(.8, 1, 48);
  constructor(public c: ToyCtx) {}
  get busy() { return this.effects.length > 0; }
  update(now: number, dt: number) {
    // Effects may spawn effects (impact -> shockwave, storm -> bolts): run a snapshot, keep the new ones.
    const running = this.effects; this.effects = [];
    const alive = running.filter(e => e.update(now, dt));
    this.effects = alive.concat(this.effects);
  }

  visiblePoint(spread = .45, land?: boolean) {
    const { fwd } = this.c.view();
    for (let i = 0; i < 40; i++) {
      const n = fwd.clone().multiplyScalar(Math.cos(spread * Math.sqrt(Math.random()))).addScaledVector(tangent(fwd), Math.sin(spread * Math.sqrt(Math.random()))).normalize();
      if (land === undefined || this.c.terrain.isLand([n.x, n.y, n.z]) === land) return n;
    }
    return fwd.clone();
  }

  // ---------- small taps ----------
  popLand(n: THREE.Vector3, now: number) {
    const r = this.c.terrain.surface([n.x, n.y, n.z]);
    for (let i = 0; i < 9; i++) {
      const v = n.clone().multiplyScalar(rand(.25, .45)).addScaledVector(tangent(n), rand(.05, .16));
      this.c.bits.spawn({ p: n.clone().multiplyScalar(r + .004), v, life: rand(.9, 1.4), size: rand(.004, .007), color: [0xff9ec7, 0xffe066, 0xffffff, 0xc4f257][i % 4], gravity: 1.6, bounce: .4 });
    }
    for (let i = 0; i < 6; i++) this.c.glows.spawn(n.clone().multiplyScalar(r + .01), { v: tangent(n).multiplyScalar(.12), life: .5, size: .03, color: 0xfff3b0 });
    this.c.wobble(.012); sound.play("pop");
    void now;
  }
  splash(n: THREE.Vector3, now: number, big = 1) {
    this.c.planet.ripple(n, now, .05 * big, .55 * big);
    for (let i = 0; i < 14 * big; i++) {
      const v = n.clone().multiplyScalar(rand(.25, .55) * Math.sqrt(big)).addScaledVector(tangent(n), rand(.03, .14) * big);
      this.c.bits.spawn({ p: n.clone().multiplyScalar(OCEAN_R + .003), v, life: rand(.6, 1.1), size: rand(.003, .006) * Math.sqrt(big), color: WATER[i % 4], gravity: 1.8, mode: "fall" });
    }
    sound.play("splash");
  }
  crater(n: THREE.Vector3, now: number, big = 1) {
    const land = this.c.terrain.isLand([n.x, n.y, n.z]);
    if (!land) { this.splash(n, now, 1.6 * big); this.c.wobble(.02 * big); return; }
    this.c.planet.crater(n, .035 * big, .014 * big, now, 9 + big);
    this.c.decor.knockTrees(n, .045 * big, now, t => this.treeChunks(t.n, t.r));
    this.debris(n, 18 * big, big);
    this.c.snow.erase([n.x, n.y, n.z], .05 * big);
    this.c.wobble(.025 * big); this.c.shake(.008 * big); sound.play(big > 1 ? "boom" : "stamp");
  }
  private treeChunks(n: THREE.Vector3, r: number) {
    for (let i = 0; i < 3; i++) this.c.bits.spawn({ p: n.clone().multiplyScalar(r + .02), v: n.clone().multiplyScalar(rand(.3, .6)).addScaledVector(tangent(n), rand(.1, .3)), life: rand(1.5, 2.5), size: rand(.005, .009), color: i ? 0x4c9f2e : 0x9a6438, gravity: 1.4 });
  }
  private debris(n: THREE.Vector3, count: number, big: number) {
    const r = this.c.terrain.surface([n.x, n.y, n.z]);
    for (let i = 0; i < count; i++) {
      const v = n.clone().multiplyScalar(rand(.35, .8) * Math.sqrt(big)).addScaledVector(tangent(n), rand(.08, .35) * Math.sqrt(big));
      this.c.bits.spawn({ p: n.clone().multiplyScalar(r + .006), v, life: rand(1.6, 3), size: rand(.004, .011) * Math.sqrt(big), color: DIRT[i % DIRT.length], gravity: 1.5, bounce: .3 });
    }
    for (let i = 0; i < 8 * big; i++) this.c.bits.spawn({ p: n.clone().multiplyScalar(r + .01), v: tangent(n).multiplyScalar(rand(.02, .08)), life: rand(1.5, 2.6), size: rand(.01, .02), color: 0xd9d2c5, mode: "float", gravity: .05, drag: 1.5, grow: 1.5 });
  }

  // ---------- meteor ----------
  meteor(target?: THREE.Vector3, from?: THREE.Vector2) {
    dispatchEvent(new CustomEvent("route-toy", { detail: "meteor" }));
    const n = (target || this.visiblePoint(.5)).clone().normalize();
    const { right, up, fwd } = this.c.view();
    const dir2 = from ? from.clone().normalize() : new THREE.Vector2(rand(.4, 1) * (Math.random() < .5 ? -1 : 1), 1).normalize();
    const surface = this.c.terrain.surface([n.x, n.y, n.z]);
    const end = n.clone().multiplyScalar(surface);
    const start = end.clone().addScaledVector(right, dir2.x * 1.6).addScaledVector(up, dir2.y * 1.6).addScaledVector(fwd, .9);
    const rock = this.c.decor.meteorModel.clone(true);
    this.c.local.add(rock);
    let t0 = -1, hitDone = false;
    const dur = .85;
    sound.play("whoosh");
    this.effects.push({
      update: (now, dt) => {
        if (t0 < 0) t0 = now;
        const t = Math.min(1, (now - t0) / dur), e = t * t * (1.6 - .6 * t);
        const p = start.clone().lerp(end, e);
        rock.position.copy(p); rock.rotation.x += dt * 9; rock.rotation.y += dt * 6;
        const back = start.clone().sub(end).normalize();
        for (let i = 0; i < 4; i++) this.c.glows.spawn(p.clone().addScaledVector(back, .012 * i + rand(0, .01)), { life: rand(.25, .5), size: rand(.03, .06), color: i % 2 ? 0xffb347 : 0xffe9a0, v: back.clone().multiplyScalar(.1) });
        if (Math.random() < .6) this.c.bits.spawn({ p: p.clone().addScaledVector(back, .03), v: back.clone().multiplyScalar(.05), life: 1.2, size: .008, color: 0x8c8378, mode: "float", gravity: 0, drag: 2, grow: 1.6 });
        // popcorn: clip a cloud on the way
        for (const c of this.c.decor.cloudList) {
          if (c.pop) continue;
          const cp = c.obj.getWorldPosition(new THREE.Vector3());
          this.c.local.worldToLocal(cp);
          if (cp.distanceTo(p) < c.scale * 1.3) this.burstCloud(c, now);
        }
        if (t >= 1 && !hitDone) {
          hitDone = true; this.c.local.remove(rock);
          this.impact(n, now);
          return false;
        }
        return true;
      },
    });
  }
  private impact(n: THREE.Vector3, now: number) {
    const land = this.c.terrain.isLand([n.x, n.y, n.z]);
    const r = this.c.terrain.surface([n.x, n.y, n.z]);
    const p = n.clone().multiplyScalar(r + .01);
    this.c.glows.spawn(p, { life: .45, size: .45, color: 0xfff4c2, grow: .8 });
    for (let i = 0; i < 18; i++) this.c.glows.spawn(p, { v: tangent(n).multiplyScalar(rand(.3, .7)).addScaledVector(n, rand(.1, .4)), life: rand(.3, .7), size: rand(.03, .06), color: 0xffc46b });
    this.shockwave(n, r, now, land ? 0xfff0cf : 0xe6fbff);
    this.c.shake(.03); this.c.wobble(.06); this.c.flash(.6);
    sound.play("boom");
    if (land) {
      this.c.planet.crater(n, .075, .03, now, 10);
      this.c.decor.knockTrees(n, .12, now, t => this.treeChunks(t.n, t.r));
      this.debris(n, 46, 2);
      this.c.snow.erase([n.x, n.y, n.z], .12);
      for (let i = 0; i < 10; i++) this.c.hot.spawn({ p: p.clone(), v: n.clone().multiplyScalar(rand(.3, .6)).addScaledVector(tangent(n), rand(.1, .3)), life: rand(.8, 1.6), size: rand(.004, .008), color: 0xff7a1f, gravity: 1.5 });
      const vol = this.c.decor.volcano.position.clone().normalize();
      if (vol.dot(n) > Math.cos(.15)) setTimeout(() => this.volcano(false), 400);
    } else {
      this.c.planet.ripple(n, now, .14, 1.2);
      setTimeout(() => this.c.planet.ripple(n, now + .25, .1, 1.4), 0);
      for (let i = 0; i < 60; i++) {
        const v = n.clone().multiplyScalar(rand(.5, 1)).addScaledVector(tangent(n), rand(.05, .35));
        this.c.bits.spawn({ p: n.clone().multiplyScalar(OCEAN_R + .004), v, life: rand(.8, 1.6), size: rand(.004, .009), color: WATER[i % 4], gravity: 1.6, mode: "fall" });
      }
      sound.play("splash");
      if (Math.random() < .5) setTimeout(() => this.whale(n.clone().addScaledVector(tangent(n), .06).normalize()), 900);
    }
  }
  private shockwave(n: THREE.Vector3, r: number, now0: number, color: number) {
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: .9, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
    const ring = new THREE.Mesh(this.ringGeo, mat);
    const holder = new THREE.Object3D(); holder.add(ring); ring.rotation.x = -Math.PI / 2;
    orient(holder, n, north(n), r + .004);
    this.c.local.add(holder);
    let t0 = -1;
    this.effects.push({
      update: now => {
        if (t0 < 0) t0 = now;
        const t = (now - t0) / .9;
        if (t >= 1) { this.c.local.remove(holder); mat.dispose(); return false; }
        ring.scale.setScalar(.02 + .24 * Math.pow(t, .6));
        mat.opacity = .9 * (1 - t);
        return true;
      },
    });
    void now0;
  }

  // ---------- clouds, storm, rainbow ----------
  burstCloud(c: Decor["cloudList"][number], now: number) {
    c.pop = now;
    const p = this.c.local.worldToLocal(c.obj.getWorldPosition(new THREE.Vector3()));
    const n = p.clone().normalize();
    for (let i = 0; i < 26; i++) this.c.bits.spawn({ p: p.clone().addScaledVector(tangent(n), rand(0, c.scale)), v: tangent(n).multiplyScalar(rand(.05, .25)).addScaledVector(n, rand(-.05, .15)), life: rand(1.6, 2.6), size: rand(.006, .013), color: 0xffffff, gravity: .6, mode: "fall", drag: .8 });
    sound.play("pop");
  }
  nearestCloud(n: THREE.Vector3) {
    let best = this.c.decor.cloudList[0], bd = -2;
    for (const c of this.c.decor.cloudList) {
      if (c.pop) continue;
      const p = this.c.local.worldToLocal(c.obj.getWorldPosition(new THREE.Vector3())).normalize();
      const d = p.dot(n);
      if (d > bd) { bd = d; best = c; }
    }
    return best;
  }
  storm(n?: THREE.Vector3) {
    // pick a visible cloud off-centre so the Prince does not hide it
    const fwd = this.c.view().fwd;
    const seen = this.c.decor.cloudList.filter(c => !c.pop && c.dark < performance.now() / 1000 && this.c.local.worldToLocal(c.obj.getWorldPosition(new THREE.Vector3())).normalize().dot(fwd) > .55);
    const cloud = n ? this.nearestCloud(n) : seen.length ? seen[Math.floor(Math.random() * seen.length)] : this.nearestCloud(fwd);
    let t0 = -1, nextBolt = 0, rainbow = false;
    const dur = 8;
    this.c.storm(1);
    this.effects.push({
      update: (now, dt) => {
        if (t0 < 0) { t0 = now; cloud.dark = now + dur; nextBolt = now + .6; }
        const age = now - t0;
        const p = this.c.local.worldToLocal(cloud.obj.getWorldPosition(new THREE.Vector3()));
        const cn = p.clone().normalize();
        if (age < dur) {
          for (let i = 0; i < Math.ceil(dt * 160); i++) {
            const q = p.clone().addScaledVector(tangent(cn), rand(0, cloud.scale * 1.3)).addScaledVector(cn, -cloud.scale * .3);
            this.c.bits.spawn({ p: q, v: cn.clone().multiplyScalar(-.35), life: 1.2, size: .0045, color: 0x6fb8ff, mode: "fall", gravity: .9, drag: .2, spin: 0 });
          }
          if (now > nextBolt) { nextBolt = now + rand(.5, 1.3); this.bolt(p, cn); }
        } else if (!rainbow) {
          rainbow = true; this.c.storm(0); this.rainbow(cn);
        }
        return age < dur + .1;
      },
    });
  }
  private bolt(p: THREE.Vector3, n: THREE.Vector3) {
    const pts: THREE.Vector3[] = [];
    const ground = this.c.terrain.surface([n.x, n.y, n.z]);
    const top = p.length() - .01, steps = 9, side = tangent(n);
    for (let i = 0; i <= steps; i++) {
      const k = i / steps;
      pts.push(n.clone().multiplyScalar(top + (ground - top) * k).addScaledVector(side, (Math.random() - .5) * .025 * (i && i < steps ? 1 : 0)).addScaledVector(tangent(n), (Math.random() - .5) * .012));
    }
    const path = new THREE.CurvePath<THREE.Vector3>();
    for (let i = 0; i < steps; i++) path.add(new THREE.LineCurve3(pts[i], pts[i + 1]));
    const geo = new THREE.TubeGeometry(path as unknown as THREE.Curve<THREE.Vector3>, steps * 2, .0035, 5, false);
    const line = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xfff6b0, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.c.local.add(line);
    for (const q of pts) this.c.glows.spawn(q, { life: .2, size: .035, color: 0xe8f0ff });
    this.c.glows.spawn(pts[steps], { life: .35, size: .12, color: 0xfff6c8 });
    this.c.flash(.45);
    setTimeout(() => sound.play("thunder"), 120);
    let t0 = -1;
    this.effects.push({ update: now => { if (t0 < 0) t0 = now; const live = now - t0 < .18; if (!live) { this.c.local.remove(line); geo.dispose(); } return live; } });
  }
  rainbow(n: THREE.Vector3) {
    const geo = new THREE.TorusGeometry(.09, .009, 8, 48, Math.PI);
    const mat = new THREE.ShaderMaterial({
      uniforms: { uA: { value: 0 } },
      vertexShader: `varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }`,
      fragmentShader: `uniform float uA; varying vec3 vP;
        void main(){ float r = (length(vP.xy) - .081) / .018; r = clamp(r, 0., 1.);
          vec3 c = clamp(abs(mod(r * 5.2 + vec3(0., 4., 2.), 6.) - 3.) - 1., 0., 1.);
          gl_FragColor = vec4(mix(vec3(1.), c, .85) * uA, uA * .8); }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const arc = new THREE.Mesh(geo, mat), holder = new THREE.Object3D();
    holder.add(arc);
    orient(holder, n, tangent(n), this.c.terrain.surface([n.x, n.y, n.z]));
    this.c.local.add(holder);
    sound.play("chime");
    let t0 = -1;
    this.effects.push({
      update: now => {
        if (t0 < 0) t0 = now;
        const t = (now - t0) / 7;
        mat.uniforms.uA.value = Math.min(1, t * 6) * Math.min(1, (1 - t) * 4);
        if (t >= 1) { this.c.local.remove(holder); geo.dispose(); mat.dispose(); return false; }
        return true;
      },
    });
  }

  // ---------- tornado ----------
  tornado(n0?: THREE.Vector3) {
    let n = (n0 || this.visiblePoint(.35, true)).clone();
    const pts = Array.from({ length: 12 }, (_, i) => new THREE.Vector2(.004 + .045 * Math.pow(i / 11, 1.6), i / 11 * .2));
    const geo = new THREE.LatheGeometry(pts, 24);
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTime: this.c.planet.uniforms.uTime, uA: { value: 0 } },
      vertexShader: `varying vec2 vUv; uniform float uTime; void main(){ vUv = uv; vec3 p = position; float h = p.y / .2; p.x += sin(uTime * 4. + h * 5.) * .01 * h; p.z += cos(uTime * 3.5 + h * 4.) * .01 * h; gl_Position = projectionMatrix * modelViewMatrix * vec4(p,1.); }`,
      fragmentShader: `varying vec2 vUv; uniform float uTime; uniform float uA;
        void main(){ float s = .5 + .5 * sin((vUv.x * 6.2831 * 3. + vUv.y * 14.) - uTime * 14.);
          float a = (.35 + .45 * s) * smoothstep(0., .15, vUv.y) * uA;
          gl_FragColor = vec4(mix(vec3(.75, .78, .82), vec3(1.), s) * a, a); }`,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
    });
    const funnel = new THREE.Mesh(geo, mat), holder = new THREE.Object3D();
    holder.add(funnel); this.c.local.add(holder);
    let heading = tangent(n), t0 = -1, last = 0;
    const dur = 8;
    sound.play("wind");
    this.effects.push({
      update: (now, dt) => {
        if (t0 < 0) { t0 = now; last = now; }
        const age = now - t0;
        heading.applyAxisAngle(n, (Math.random() - .5) * dt * 3);
        n = n.addScaledVector(heading, dt * .05).normalize();
        heading.addScaledVector(n, -heading.dot(n)).normalize();
        const r = this.c.terrain.surface([n.x, n.y, n.z]);
        orient(holder, n, heading, r - .002);
        funnel.rotation.y += dt * 8;
        mat.uniforms.uA.value = Math.min(1, age * 2) * Math.min(1, (dur - age) * 1.5);
        // pull trees in, spin them up, drop them
        for (const t of this.c.decor.trees) {
          if (t.down) continue;
          const d = t.n.dot(n);
          if (d > Math.cos(.06)) {
            t.tilt = t.tilt || new THREE.Vector3().crossVectors(t.n, n).normalize();
            t.lift += dt * 2.5;
            if (t.lift > 1.2) { t.down = now; t.tilt = null; t.lift = 0; this.treeChunks(t.n, t.r + .05); }
            this.c.decor.markTrees();
          }
        }
        if (Math.random() < dt * 30) this.c.bits.spawn({ p: n.clone().multiplyScalar(r + .01), v: heading.clone().cross(n).multiplyScalar(.12).addScaledVector(n, .08), life: 1, size: .005, color: DIRT[Math.floor(Math.random() * 3)], mode: "float", gravity: .1, drag: .6 });
        if (now - last > 2) { last = now; sound.play("wind"); }
        if (age > dur) {
          this.c.local.remove(holder); geo.dispose(); mat.dispose();
          for (const t of this.c.decor.trees) if (t.tilt) { t.tilt = null; t.lift = 0; }
          this.c.decor.markTrees();
          return false;
        }
        return true;
      },
    });
  }

  // ---------- snowfall ----------
  snowfall() {
    let t0 = -1, lastDust = 0;
    const dur = 9;
    sound.play("snow");
    this.effects.push({
      update: (now, dt) => {
        if (t0 < 0) t0 = now;
        const age = now - t0;
        const { fwd } = this.c.view();
        if (age < dur) {
          for (let i = 0; i < Math.ceil(dt * 90); i++) {
            const n = fwd.clone().multiplyScalar(Math.cos(rand(0, .75))).addScaledVector(tangent(fwd), rand(0, .7)).normalize();
            this.c.bits.spawn({ p: n.clone().multiplyScalar(1.24), v: tangent(n).multiplyScalar(.02), life: 6, size: rand(.003, .0055), color: 0xffffff, mode: "fall", gravity: .12, drag: 2.2, spin: 2 });
          }
          if (now - lastDust > .12) {
            lastDust = now;
            const n = this.visiblePoint(.6, true);
            this.c.snow.dust([n.x, n.y, n.z], .06, 70);
          }
          if (Math.random() < dt * .8) sound.play("snow");
        }
        return age < dur;
      },
    });
  }

  // ---------- volcano ----------
  volcano(focus = true) {
    const v = this.c.decor.volcano;
    const n = v.position.clone().normalize();
    const top = n.clone().multiplyScalar(v.position.length() + .05);
    if (focus) this.c.focus(n, 700);
    let t0 = -1;
    const dur = 4.5;
    setTimeout(() => sound.play("erupt"), focus ? 650 : 0);
    this.effects.push({
      update: (now, dt) => {
        if (t0 < 0) t0 = now + (focus ? .7 : 0);
        const age = now - t0;
        if (age < 0) return true;
        if (age < dur) {
          for (let i = 0; i < Math.ceil(dt * 50); i++) {
            const vv = n.clone().multiplyScalar(rand(.35, .7)).addScaledVector(tangent(n), rand(.02, .18));
            this.c.hot.spawn({ p: top.clone(), v: vv, life: rand(1, 1.8), size: rand(.004, .008), color: [0xff6a1f, 0xffa630, 0xffd36b][i % 3], gravity: 1.4, bounce: .1 });
          }
          if (Math.random() < dt * 20) this.c.bits.spawn({ p: top.clone(), v: n.clone().multiplyScalar(.05).addScaledVector(tangent(n), .02), life: rand(2, 3.5), size: rand(.012, .02), color: 0x8e8a86, mode: "float", gravity: .02, drag: .9, grow: 2 });
          if (Math.random() < dt * 25) this.c.glows.spawn(top, { life: .4, size: .09, color: 0xffa040 });
          if (Math.random() < dt * 3) this.c.shake(.006);
        }
        return age < dur;
      },
    });
    this.c.wobble(.02);
  }

  // ---------- whale ----------
  whale(n0?: THREE.Vector3) {
    const n = (n0 || this.visiblePoint(.45, false)).clone().normalize();
    if (this.c.terrain.isLand([n.x, n.y, n.z])) return;
    const w = this.c.decor.whale, f = tangent(n);
    let t0 = -1, s1 = false, s2 = false;
    sound.play("whale");
    this.effects.push({
      update: now => {
        if (t0 < 0) t0 = now;
        const t = (now - t0) / 1.8;
        if (t >= 1) { w.visible = false; return false; }
        w.visible = true;
        const along = (t - .5) * .1;
        const p = n.clone().addScaledVector(f, along).normalize();
        const h = OCEAN_R - .025 + .075 * Math.sin(Math.PI * t);
        orient(w, p, f, h, "x");
        w.rotateZ(-Math.cos(Math.PI * t) * .9);
        if (!s1 && t > .08) { s1 = true; this.splash(n.clone().addScaledVector(f, -.045).normalize(), now, 1.2); }
        if (!s2 && t > .9) { s2 = true; this.splash(n.clone().addScaledVector(f, .045).normalize(), now, 1.5); }
        return true;
      },
    });
  }

  // ---------- celebration on connect ----------
  confetti(n: THREE.Vector3) {
    const r = this.c.terrain.surface([n.x, n.y, n.z]) + .05;
    for (let i = 0; i < 70; i++) {
      const v = n.clone().multiplyScalar(rand(.3, .7)).addScaledVector(tangent(n), rand(.05, .3));
      this.c.bits.spawn({ p: n.clone().multiplyScalar(r), v, life: rand(1.6, 2.6), size: rand(.004, .007), color: CONFETTI[i % CONFETTI.length], gravity: .9, drag: 1.2, spin: 12 });
    }
    for (let i = 0; i < 12; i++) this.c.glows.spawn(n.clone().multiplyScalar(r), { v: tangent(n).multiplyScalar(rand(.1, .4)).addScaledVector(n, .2), life: .8, size: .04, color: 0xfff3b0 });
    sound.play("chime");
  }
}
