import * as THREE from "three";
import { EffectComposer, RenderPass, EffectPass, BloomEffect, ToneMappingEffect, ToneMappingMode } from "postprocessing";
import { Basis, V3, clamp, cross, direction, dot, homeBasis, latLon, orthonormal, slerp, trackball, turn, unit } from "./geo";
import { Terrain, SnowField, OCEAN_R } from "./terrain";
import { Planet } from "./planet";
import { Decor, orient, north } from "./decor";
import { Bits, Glows } from "./particles";
import { Toys } from "./toys";
import { loadProps } from "./props";
import { sound } from "./sound";

const S = { x: .5, y: .5, r: .43 };
const FOV = 22.6;
const calm = () => document.documentElement.classList.contains("still") || matchMedia("(prefers-reduced-motion: reduce)").matches;
const V = (a: number[]) => new THREE.Vector3(a[0], a[1], a[2]);

type Project = (lat: number, lon: number) => [number, number, number];
interface Stage { phase: string; place: string; prince: { lat: number; lon: number; lift: number } | null }

let shared: { terrain: Terrain } | null = null;

export function create3d(element: HTMLCanvasElement, markers: HTMLCanvasElement, placeActors: (p: Project, zoom: number) => void, now = () => new Date()) {
  const renderer = new THREE.WebGLRenderer({ canvas: element, alpha: true, antialias: false, powerPreference: "high-performance", premultipliedAlpha: true });
  if (!renderer.capabilities.isWebGL2) throw new Error("webgl2");
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  renderer.setPixelRatio(dpr);

  shared ||= { terrain: new Terrain() };
  const terrain = shared.terrain;
  const snow = new SnowField();
  snow.update(now());

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FOV, 1, .1, 30);
  const holder = new THREE.Group();   // squash & stretch (jelly)
  const globe = new THREE.Group();    // rotation from the trackball basis
  holder.add(globe); scene.add(holder);
  const planet = new Planet(terrain, snow);
  globe.add(planet.group);

  // Light: warm sun from the real solar direction + sky/ground fill.
  const sun = new THREE.DirectionalLight(0xfff2db, 3.1);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -1.4, right: 1.4, top: 1.4, bottom: -1.4, near: 3, far: 9 });
  sun.shadow.bias = -.0004; sun.shadow.normalBias = .012; sun.shadow.radius = 3;
  scene.add(sun, sun.target);
  // Sky fill follows the sun: bright cyan on the day side, deep navy on the night side.
  const hemi = new THREE.HemisphereLight(0xd8f7ff, 0x1d2b66, 1.6);
  scene.add(hemi);
  const fill = new THREE.DirectionalLight(0x9fe6ff, .35); // cool rim from behind-left
  fill.position.set(-3, 1, -2); scene.add(fill);

  // Post: bloom on highlights + AgX tone mapping, MSAA.
  let composer: EffectComposer | null = null;
  try {
    composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType, multisampling: Math.min(4, renderer.capabilities.maxSamples) });
    composer.addPass(new RenderPass(scene, camera));
    composer.addPass(new EffectPass(camera,
      new BloomEffect({ intensity: .55, luminanceThreshold: .78, luminanceSmoothing: .25, mipmapBlur: true, radius: .7 }),
      new ToneMappingEffect({ mode: ToneMappingMode.NEUTRAL })));
  } catch { composer = null; renderer.toneMapping = THREE.NeutralToneMapping; }

  // ---- particles & toys ----
  const surface = (d: number[]) => terrain.surface(d);
  const bits = new Bits(520, surface), hot = new Bits(220, surface);
  hot.mesh.material = new THREE.MeshBasicMaterial({ color: 0xffffff });
  hot.mesh.castShadow = false;
  const glows = new Glows(800);
  globe.add(bits.mesh, hot.mesh, glows.points);

  let basis: Basis = homeBasis(), zoom = 1;
  let decor: Decor | null = null;
  let shakeAmp = 0, flashAmp = 0, stormK = 0, stormTarget = 0;
  let wob = 0, wobV = 0;
  let focusAnim: { from: Basis; to: Basis; start: number; ms: number } | null = null;

  const view = () => ({ right: V(basis.slice(0, 3)), up: V(basis.slice(3, 6)), fwd: V(basis.slice(6, 9)) });
  const toys = new Toys({
    planet, get decor() { return decor!; }, terrain, snow, bits, hot, glows, local: globe, view,
    shake: (a: number) => { shakeAmp = Math.max(shakeAmp, a); },
    wobble: (a: number) => { if (!calm()) wobV += a * 40; },
    flash: (a: number) => { flashAmp = Math.max(flashAmp, a); },
    focus: (n: THREE.Vector3, ms = 700) => {
      const [lat, lon] = latLon([n.x, n.y, n.z]);
      focusAnim = { from: basis, to: homeBasis(clamp(lat, -60, 60), lon), start: performance.now(), ms };
    },
    storm: (k: number) => { stormTarget = k; },
  } as any);

  loadProps().then(props => {
    decor = new Decor(terrain, props, { uTime: planet.uniforms.uTime, uSun: planet.uniforms.uSun });
    globe.add(decor.group);
    scene.add(decor.clouds);
    decor.prince.visible = !!show.prince;
    schedule();
  }).catch(err => console.warn("props", err));

  // ---- camera framing ----
  let distance = 6;
  function frameCamera() {
    const tanA = 2 * S.r * zoom * Math.tan(FOV * Math.PI / 360);
    distance = 1 / Math.sin(Math.atan(tanA));
    camera.position.set(0, 0, distance);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
  }
  frameCamera();
  const glowScale = () => element.clientHeight * dpr / (2 * Math.tan(FOV * Math.PI / 360));

  function resize() {
    const w = element.clientWidth || 360, h = element.clientHeight || w;
    renderer.setSize(w, h, false);
    composer?.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
    (glows.points.material as THREE.ShaderMaterial).uniforms.uScale.value = glowScale();
    if (decor) (decor.lights.material as THREE.ShaderMaterial).uniforms.uScale.value = glowScale();
    schedule();
  }
  new ResizeObserver(resize).observe(element);

  function applyBasis() {
    const m = new THREE.Matrix4().set(
      basis[0], basis[1], basis[2], 0,
      basis[3], basis[4], basis[5], 0,
      basis[6], basis[7], basis[8], 0,
      0, 0, 0, 1);
    globe.quaternion.setFromRotationMatrix(m);
  }

  // ---- projection helpers (normalized scene coords, like globe.js) ----
  const tmp = new THREE.Vector3();
  function project(lat: number, lon: number): [number, number, number] {
    const d = direction(lat, lon);
    const r = terrain.surface(d);
    tmp.set(d[0] * r, d[1] * r, d[2] * r);
    globe.localToWorld(tmp);
    const z = dot(d, basis.slice(6, 9));
    tmp.project(camera);
    return [(tmp.x + 1) / 2, (1 - tmp.y) / 2, z];
  }
  const ray = new THREE.Raycaster();
  function worldAt(u: number, v: number): V3 | null {
    ray.setFromCamera(new THREE.Vector2(u * 2 - 1, 1 - v * 2), camera);
    const o = ray.ray.origin.clone(), d = ray.ray.direction;
    const inv = new THREE.Matrix4().copy(holder.matrixWorld).invert();
    o.applyMatrix4(inv);
    const b = o.dot(d), c = o.lengthSq() - 1, disc = b * b - c;
    if (disc < 0) return null;
    const p = o.addScaledVector(d, -b - Math.sqrt(disc));
    const q = globe.quaternion.clone().invert();
    p.applyQuaternion(q).normalize();
    return [p.x, p.y, p.z];
  }

  // ---- stage: phase, place, prince ----
  const show: Stage = { phase: "home", place: "", prince: null };
  let thread: { place: string; from: V3; to: V3; progress: number; fade: number } | null = null;
  let lastPhase = "home";
  function stage(next: Partial<Stage>) {
    Object.assign(show, next);
    const place = window.RouteGlobe.locations[show.place];
    if (show.phase === "home" || !place) {
      if (thread && !thread.fade) thread.fade = performance.now();
    } else if (!thread || thread.place !== show.place || thread.fade) {
      const to = direction(place.lat, place.lon);
      const from = thread && !thread.fade && thread.progress > .5 ? thread.to : (worldAt(S.x, S.y + S.r * zoom * .93) || direction(place.lat - 38, place.lon - 8));
      thread = { place: show.place, from, to, progress: calm() ? 1 : 0, fade: 0 };
    }
    if (show.phase !== lastPhase) {
      if (show.phase === "connected" && place && !calm()) {
        const n = V(direction(place.lat, place.lon));
        toys.confetti(n);
        const city = decor?.cities[show.place];
        if (city) city.userData.pop = performance.now();
      }
      if (show.phase === "travel" && !calm()) sound.play("whoosh");
      lastPhase = show.phase;
    }
    if (decor) decor.prince.visible = !!show.prince;
  }

  // ---- prince animation ----
  let princeLift = 0, princeVel = 0;
  function animatePrince(t: number, dt: number, still: boolean) {
    if (!decor || !show.prince) return;
    const P = decor.prince, parts = decor.princeParts;
    const n = V(direction(show.prince.lat, show.prince.lon));
    // Stand up toward the screen (sticker-like) so the Prince reads as a figure, not a hair dot from above.
    const camLocal = V(basis.slice(6, 9)), upLocal = V(basis.slice(3, 6));
    const stand = n.clone().multiplyScalar(.38).addScaledVector(upLocal, .62).normalize();
    const f = camLocal.clone().addScaledVector(stand, -camLocal.dot(stand));
    if (f.lengthSq() < 1e-6) f.copy(north(n).negate());
    const yaw = Math.sin(t * .4) * .25;
    f.normalize().applyAxisAngle(stand, .3 + (still ? 0 : yaw));
    const lift = show.prince.lift;
    princeVel = (lift - princeLift) / Math.max(dt, 1e-3); princeLift = lift;
    orient(P, stand, f, 0);
    P.position.copy(n).multiplyScalar(terrain.surface([n.x, n.y, n.z]) - .004 + lift * .12);
    const rest = (k: string) => parts[k]?.userData.rest;
    const set = (k: string, fn: (o: THREE.Object3D, r: any) => void) => { const o = parts[k], r = rest(k); if (o && r) { o.position.copy(r.p); o.rotation.copy(r.r); o.scale.copy(r.s); fn(o, r); } };
    const phase = show.phase, travel = phase === "travel", connected = phase === "connected";
    const air = Math.min(1, lift * 2);
    const sy = 1 + clamp(princeVel * .06, -.12, .12);
    const s = still ? 0 : 1;
    const breathe = Math.sin(t * 2.2) * .02 * s;
    const cheer = connected ? Math.max(0, Math.sin(t * 2.4)) ** 3 * s : 0;
    set("prince_hips", o => { o.position.y += cheer * .12 + breathe * .2; o.scale.set(2 - sy, sy, 2 - sy); o.rotation.x += (travel ? .18 : 0) * s; });
    set("prince_body", o => { o.scale.y *= 1 + breathe; });
    set("prince_head", o => { o.rotation.z += Math.sin(t * 1.3) * .08 * s; o.rotation.x += (travel ? -.12 : 0) + Math.sin(t * .9) * .04 * s; });
    set("prince_arm_l", o => { o.rotation.x += (Math.sin(t * 2.2) * .12 + air * -.8) * s; o.rotation.z += -cheer * 2.2 - air * .6 * s; });
    set("prince_arm_r", o => { o.rotation.x += (-Math.sin(t * 2.2) * .12 + air * -.8) * s; o.rotation.z += (travel ? 1.9 + Math.sin(t * 9) * .45 : cheer * 2.2) * s + air * .6 * s; });
    set("prince_leg_l", o => { o.rotation.x += air * .5 * s; });
    set("prince_leg_r", o => { o.rotation.x += -air * .35 * s; });
    const wind = clamp(spin * .6, 0, 1.2);
    for (let i = 0; i < 4; i++) set("prince_scarf" + i, o => { o.rotation.x += (Math.sin(t * 3.1 - i * .7) * .18 + air * .5 + wind * .4) * s; o.rotation.z += Math.sin(t * 2.3 - i * .9) * .12 * s; });
  }

  // ---- pins overlay (leader lines) ----
  const overlay = markers.getContext("2d")!;
  let cityButtons: HTMLButtonElement[] = [];
  function drawPins(point: Project) {
    const size = markers.width;
    overlay.clearRect(0, 0, size, markers.height);
    for (const button of cityButtons) {
      const place = window.RouteGlobe.locations[button.dataset.place!];
      if (!place) continue;
      const [x, y, depth] = point(place.lat, place.lon);
      button.hidden = depth < .09;
      if (button.hidden) continue;
      const selected = button.classList.contains("chosen");
      const clear = selected ? Math.sign(place.offset[0]) * .05 : 0;
      const labelX = clamp(x + place.offset[0] + clear, .13, .87), labelY = clamp(y + place.offset[1], .10, .78);
      button.style.left = 100 * labelX + "%"; button.style.top = 100 * labelY + "%";
      overlay.lineCap = "round";
      overlay.strokeStyle = "rgba(255,255,255,.95)"; overlay.lineWidth = 3;
      overlay.beginPath(); overlay.moveTo(x * size, y * size); overlay.lineTo(labelX * size, labelY * size); overlay.stroke();
      overlay.beginPath(); overlay.arc(x * size, y * size, 7, 0, Math.PI * 2);
      overlay.fillStyle = "#ffffff"; overlay.fill();
      overlay.beginPath(); overlay.arc(x * size, y * size, 4.6, 0, Math.PI * 2);
      overlay.fillStyle = selected ? "#76c81f" : "#ff6b5b"; overlay.fill();
    }
  }

  // ---- crab (DOM sprite kept from the old scene) ----
  const sceneEl = element.closest(".scene") as HTMLElement;
  const crab = sceneEl?.querySelector("#crab-anchor") as HTMLElement | null;
  let oceanSpot: [number, number] | null = null, crabShift = [0, 0];
  crab?.querySelector(".crab-body")?.addEventListener("animationiteration", (event: Event) => {
    if ((event as AnimationEvent).animationName !== "ocean-visit") return;
    crab.style.setProperty("--crab-cycle", (7 + Math.random() * 3).toFixed(1) + "s");
    crab.style.setProperty("--crab-pause", (Math.random() * 9).toFixed(1) + "s");
    crab.classList.add("crab-rest"); void crab.offsetWidth; crab.classList.remove("crab-rest");
    crabShift = [Math.floor(Math.random() * 10), Math.floor(Math.random() * 9)];
    oceanSpot = null; schedule();
  });
  function positionCrab(point: Project) {
    if (!crab) return;
    if (oceanSpot) {
      const [x, y, z] = point(...oceanSpot);
      if (z > .30 && x > .09 && x < .91 && y > .12 && y < .91) { crab.style.left = x * 100 + "%"; crab.style.top = y * 100 + "%"; return; }
      oceanSpot = null;
    }
    crab.hidden = true;
    const fwd = basis.slice(6, 9);
    for (let row = 0; row < 9; row++) for (let col = 0; col < 10; col++) {
      const u = .18 + ((col + 2 + crabShift[0]) % 10) * .07, v = .22 + ((row + 5 + crabShift[1]) % 9) * .07;
      const offsets = [[0, 0], [-.035, 0], [.035, 0], [0, -.027], [-.025, -.022], [.025, -.022]];
      if (!offsets.every(([dx, dy]) => { const n = worldAt(u + dx, v + dy); return n && dot(n, fwd) > .34 && terrain.raw.at(n) < .06; })) continue;
      const n = worldAt(u, v)!;
      oceanSpot = latLon(n);
      crab.style.left = u * 100 + "%"; crab.style.top = v * 100 + "%";
      crab.hidden = false; return;
    }
  }

  // ---- snow brushing (ported from globe.js) ----
  let cleaning = false, stroke: any = null, entry: any = null, exitTap: any = null, blockClick = false, lastTap: any = null;
  function setCleaning(on: boolean, u?: number, v?: number) {
    cleaning = on; stroke = null; exitTap = null; lastTap = null;
    entry = on ? { u, v } : null;
    sceneEl.classList.toggle("brushing-snow", on);
  }
  {
    const sweep = (e: PointerEvent) => {
      const box = sceneEl.getBoundingClientRect();
      const u = (e.clientX - box.left) / box.width, v = (e.clientY - box.top) / box.height;
      const steps = Math.ceil(Math.hypot(u - stroke.u, v - stroke.v) * 50) + 1;
      for (let i = 1; i <= steps; i++) {
        const n = worldAt(stroke.u + (u - stroke.u) * i / steps, stroke.v + (v - stroke.v) * i / steps);
        if (n && terrain.raw.at(n) > .5 && snow.erase(n, .073 / zoom)) {
          if (Math.random() < .25 && !calm()) bits.spawn({ p: V(n).multiplyScalar(terrain.surface(n) + .004), v: V(n).multiplyScalar(.25).add(new THREE.Vector3(Math.random() - .5, Math.random() - .5, Math.random() - .5).multiplyScalar(.15)), life: .9, size: .004, color: 0xffffff, gravity: 1.2, mode: "fall" });
        }
      }
      stroke.u = u; stroke.v = v; schedule();
    };
    for (const kind of ["pointerdown", "pointermove", "pointerup", "pointercancel", "lostpointercapture", "click", "dblclick"]) {
      sceneEl.addEventListener(kind, (e: any) => {
        if (e.target.closest("button") && !stroke) return;
        if (kind === "click" && blockClick) { e.stopImmediatePropagation(); blockClick = false; return; }
        if (!cleaning) return;
        e.stopImmediatePropagation(); if (e.cancelable) e.preventDefault();
        const box = sceneEl.getBoundingClientRect(), u = (e.clientX - box.left) / box.width, v = (e.clientY - box.top) / box.height;
        if (kind === "pointerdown" && e.button === 0 && !stroke) {
          if (!worldAt(u, v)) { exitTap = null; return; }
          stroke = { id: e.pointerId, u, v, x: e.clientX, y: e.clientY, moved: false };
          sceneEl.setPointerCapture(e.pointerId);
        } else if (stroke && stroke.id === e.pointerId) {
          if (kind === "pointermove" && (stroke.moved || Math.hypot(e.clientX - stroke.x, e.clientY - stroke.y) > 5)) { stroke.moved = true; exitTap = null; sweep(e); }
          if (kind === "pointerup") {
            if (!stroke.moved && worldAt(u, v) && box.width * Math.hypot(u - entry.u, v - entry.v) > 18) {
              if (exitTap && e.timeStamp - exitTap.time <= 420 && Math.hypot(e.clientX - exitTap.x, e.clientY - exitTap.y) <= 18) { setCleaning(false); blockClick = true; }
              else exitTap = { x: e.clientX, y: e.clientY, time: e.timeStamp };
            } else exitTap = null;
          }
          if (kind === "pointerup" || kind === "pointercancel" || kind === "lostpointercapture") stroke = null;
        }
      }, true);
    }
  }

  // ---- meteor sling: drag from the sky (outside the planet) toward it ----
  {
    let sling: { id: number; x: number; y: number; u: number; v: number; t: number; timer: number } | null = null;
    const inSky = (u: number, v: number) => Math.hypot(u - S.x, v - S.y) > S.r * zoom * 1.02;
    sceneEl.addEventListener("pointerdown", e => {
      if (cleaning || calm() || e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
      const box = sceneEl.getBoundingClientRect(), u = (e.clientX - box.left) / box.width, v = (e.clientY - box.top) / box.height;
      if (!inSky(u, v)) return;
      e.stopImmediatePropagation();
      sling = { id: e.pointerId, x: e.clientX, y: e.clientY, u, v, t: e.timeStamp, timer: window.setTimeout(() => {
        if (!sling) return;
        const target = worldAt(S.x + (sling.u - S.x) * .35, S.y + (sling.v - S.y) * .35);
        toys.meteor(target ? V(target) : undefined, new THREE.Vector2(sling.u - S.x, S.y - sling.v));
        sceneEl.classList.add("meteor-launched"); sling = null; schedule();
      }, 480) };
      try { sceneEl.setPointerCapture(e.pointerId); } catch {}
    }, true);
    const finish = (e: PointerEvent) => {
      if (!sling || e.pointerId !== sling.id) return;
      e.stopImmediatePropagation();
      clearTimeout(sling.timer);
      const box = sceneEl.getBoundingClientRect(), u = (e.clientX - box.left) / box.width, v = (e.clientY - box.top) / box.height;
      const du = u - sling.u, dv = v - sling.v;
      if (e.type === "pointerup" && Math.hypot(du, dv) * box.width > 24) {
        // aim where the swipe line passes closest to the planet centre
        const len = Math.hypot(du, dv), dx = du / len, dy = dv / len;
        const k = Math.max(0, (S.x - sling.u) * dx + (S.y - sling.v) * dy);
        let ax = sling.u + dx * k, ay = sling.v + dy * k;
        const off = Math.hypot(ax - S.x, ay - S.y), lim = S.r * zoom * .8;
        if (off > lim) { ax = S.x + (ax - S.x) * lim / off; ay = S.y + (ay - S.y) * lim / off; }
        const target = worldAt(ax, ay);
        toys.meteor(target ? V(target) : undefined, new THREE.Vector2(-dx, dy));
        schedule();
      }
      sling = null;
    };
    sceneEl.addEventListener("pointermove", e => { if (sling && e.pointerId === sling.id) e.stopImmediatePropagation(); }, true);
    sceneEl.addEventListener("pointerup", finish, true);
    sceneEl.addEventListener("pointercancel", finish, true);
  }

  // ---- taps ----
  const cloudRay = new THREE.Raycaster();
  function surfaceTap(u: number, v: number) {
    const time = performance.now() / 1000;
    if (decor && !calm()) {
      cloudRay.setFromCamera(new THREE.Vector2(u * 2 - 1, 1 - v * 2), camera);
      const hit = cloudRay.intersectObjects([...decor.cloudList.map(c => c.obj), decor.volcano], true)[0];
      if (hit) {
        let o: THREE.Object3D | null = hit.object;
        while (o && o !== decor.volcano) o = o.parent;
        if (o === decor.volcano) { toys.volcano(false); lastTap = null; schedule(); return; }
        const c = decor.cloudList.find(c => c.obj === hit.object);
        if (c) { c.dark > time ? toys.burstCloud(c, time) : (Math.random() < .5 ? toys.burstCloud(c, time) : toys.storm(c.obj.getWorldPosition(new THREE.Vector3()).applyQuaternion(globe.quaternion.clone().invert()).normalize())); lastTap = null; schedule(); return; }
      }
    }
    const n = worldAt(u, v);
    if (!n) { lastTap = null; return; }
    const width = markers.getBoundingClientRect().width;
    const crater = lastTap && time - lastTap.time <= .42 && lastTap.basis === basis && lastTap.zoom === zoom && width * Math.hypot(u - lastTap.u, v - lastTap.v) <= 18;
    const land = terrain.raw.at(n) >= .5;
    if (crater && land && snow.value(n) > 48) { setCleaning(true, u, v); return; }
    const vn = V(n);
    if (calm()) { if (!land) planet.ripple(vn, time, .05, .55); schedule(); lastTap = crater ? null : { u, v, time, basis, zoom }; return; }
    if (crater) toys.crater(vn, time);
    else if (land) toys.popLand(vn, time);
    else { toys.splash(vn, time); if (Math.random() < .18) setTimeout(() => toys.whale(vn), 500); }
    lastTap = crater ? null : { u, v, time, basis, zoom };
    schedule();
  }

  // ---- drag ----
  function beginDrag(x: number, y: number) {
    const start = basis;
    const ball = (u: number, v: number) => trackball(S.x + (u - S.x) / zoom, S.y + (v - S.y) / zoom, S);
    const from = ball(x, y);
    focusAnim = null;
    return (nx: number, ny: number) => { basis = orthonormal(turn(start, from, ball(nx, ny))); schedule(); };
  }

  // ---- loop ----
  let raf = 0, last = performance.now(), ready = false, spin = 0, prevFwd = basis.slice(6, 9), cloudQ = new THREE.Quaternion(), firstCloud = true;
  const clockSun = () => window.RouteGlobe.sunlight(now()) as V3;
  let sunLocal = V(clockSun()), sunStamp = 0;
  // Battery: when nothing is happening the ambient scene (clouds, boats, Prince idle) runs at ~30 fps.
  let lastInput = 0, lastDraw = 0, lively = true;
  function frame(ts: number) {
    raf = 0;
    if (!lively && ts - lastInput > 1500 && ts - lastDraw < 30) { raf = requestAnimationFrame(frame); return; }
    lastDraw = ts;
    const dt = Math.min(.05, (ts - last) / 1000); last = ts;
    const t = ts / 1000, still = calm();
    if (focusAnim) {
      const k = clamp((ts - focusAnim.start) / focusAnim.ms, 0, 1), e = k * k * (3 - 2 * k);
      const f = slerp(focusAnim.from.slice(6, 9) as V3, focusAnim.to.slice(6, 9) as V3, e);
      const r = unit(cross([0, 1, 0], f));
      basis = [...r, ...cross(f, r), ...f];
      if (k >= 1) focusAnim = null;
    }
    applyBasis();
    // angular speed for wind effects
    const f = basis.slice(6, 9);
    spin = spin * .85 + .15 * (Math.acos(clamp(dot(f, prevFwd), -1, 1)) / Math.max(dt, 1e-3));
    prevFwd = f;
    if (ts - sunStamp > 30000) { sunStamp = ts; sunLocal = V(clockSun()); snow.update(now()); }
    const sunWorld = sunLocal.clone().applyQuaternion(globe.quaternion);
    sun.position.copy(sunWorld).multiplyScalar(5);
    planet.uniforms.uSun.value.copy(sunWorld);
    planet.uniforms.uSunLocal.value.copy(sunLocal);
    hemi.position.copy(sunWorld);
    planet.uniforms.uTime.value = still ? 0 : t;
    // jelly spring
    if (!still) { wobV += (-wob * 160 - wobV * 9) * dt; wob += wobV * dt; } else { wob = wobV = 0; }
    holder.scale.set(1 + wob, 1 - wob, 1 + wob * .5);
    // shake & flash
    shakeAmp *= Math.exp(-dt * 7); flashAmp *= Math.exp(-dt * 9);
    stormK += (stormTarget - stormK) * Math.min(1, dt * 2);
    planet.uniforms.uStorm.value = stormK;
    camera.position.set((Math.random() - .5) * shakeAmp, (Math.random() - .5) * shakeAmp, distance);
    hemi.intensity = 1.6 + flashAmp * 2.5 - stormK * .25;
    sun.intensity = 3.1 - stormK * 1.1;
    // planet: snow texture, craters
    planet.syncSnow();
    planet.updateCraters(t);
    if (decor) {
      if (firstCloud || still) { cloudQ.copy(globe.quaternion); firstCloud = false; }
      else cloudQ.slerp(globe.quaternion, 1 - Math.exp(-dt * 5));
      decor.clouds.quaternion.copy(cloudQ);
      decor.clouds.scale.copy(holder.scale);
      decor.update(t, dt, still, sunLocal, glows);
      // chosen city ring + pop
      const place = window.RouteGlobe.locations[show.place];
      decor.ring.visible = !!place && show.phase !== "home";
      if (place) {
        const n = V(direction(place.lat, place.lon));
        orient(decor.ring, n, north(n), terrain.surface([n.x, n.y, n.z]) + .003);
        decor.ring.rotateX(-Math.PI / 2);
        const pulse = 1 + .15 * Math.sin(t * 4);
        decor.ring.scale.setScalar(show.phase === "connected" ? pulse : .8 + .2 * Math.sin(t * 8));
        (decor.ring.material as THREE.MeshBasicMaterial).color.set(show.phase === "connected" ? 0xc4f257 : 0xffc93c);
      }
      for (const [key, city] of Object.entries(decor.cities)) {
        const popAge = city.userData.pop ? (ts - city.userData.pop) / 1000 : 9;
        const k = popAge < .7 ? 1 + .45 * Math.sin(popAge / .7 * Math.PI) * (1 - popAge / .7) : 1;
        const sel = key === show.place ? 1.12 : 1;
        city.scale.setScalar(sel * k);
      }
      // travel thread
      if (thread) {
        if (!thread.fade) thread.progress = still ? 1 : Math.min(1, thread.progress + dt / 1.4);
        const fade = thread.fade ? (ts - thread.fade) / 600 : 0;
        decor.setThread(thread.from, thread.to, thread.progress, fade, t);
        if (fade >= 1) thread = null;
      } else decor.setThread(null, null, 0, 1, t);
      animatePrince(t, dt, still);
      // snow blown off by a hard spin
      if (!still && spin > 2.4 && Math.random() < dt * 30) {
        const fwd = V(basis.slice(6, 9));
        for (const pole of [1, -1]) {
          const n = new THREE.Vector3(Math.random() - .5, pole * 6, Math.random() - .5).normalize();
          if (n.dot(fwd) < .05 || snow.value([n.x, n.y, n.z]) < 60) continue;
          const tv = new THREE.Vector3().crossVectors(fwd, n).multiplyScalar(.4);
          bits.spawn({ p: n.clone().multiplyScalar(1.03), v: tv.addScaledVector(n, .2), life: 1.2, size: .005, color: 0xffffff, gravity: .3, mode: "fall", drag: .4 });
        }
      }
    }
    toys.update(t, dt);
    bits.update(dt); hot.update(dt); glows.update(dt);
    if (composer) composer.render(dt); else renderer.render(scene, camera);
    if (!ready) { ready = true; sceneEl?.classList.add("globe-ready"); }
    // DOM: actors, pins, crab, sky theme
    const point: Project = (lat, lon) => project(lat, lon);
    placeActors(point, zoom);
    drawPins(point);
    positionCrab(point);
    skyTheme();
    lively = toys.busy || bits.active || hot.active || glows.active || planet.deforming || !!focusAnim || !!(thread && thread.progress < 1) || spin > .05;
    const busy = !still || toys.busy || bits.active || hot.active || glows.active || planet.deforming || !!focusAnim || (thread && thread.progress < 1);
    if (busy && !document.hidden && element.isConnected) raf = requestAnimationFrame(frame);
  }
  function schedule() { lastInput = performance.now(); if (!raf) raf = requestAnimationFrame(frame); }

  // Light day + real night: the sky follows the sun above the place in focus.
  let lastSky = "";
  function skyTheme() {
    const place = window.RouteGlobe.locations[show.place] || { lat: 47, lon: 20 };
    const alt = dot(direction(place.lat, place.lon), [sunLocal.x, sunLocal.y, sunLocal.z]);
    const sky = alt > .1 ? "day" : alt > -.12 ? "dusk" : "night";
    if (sky !== lastSky) { lastSky = sky; document.documentElement.dataset.sky = sky; }
  }

  let clockTimer = 0;
  function syncClock() {
    clearTimeout(clockTimer);
    if (document.hidden || !element.isConnected) return;
    sunStamp = 0; schedule();
    clockTimer = window.setTimeout(syncClock, 60000 - Date.now() % 60000);
  }
  document.addEventListener("visibilitychange", syncClock);
  addEventListener("pageshow", syncClock);
  syncClock();
  setInterval(() => { if (!document.hidden && !cleaning && snow.regrow(5)) schedule(); }, 2000);
  new MutationObserver(schedule).observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  element.addEventListener("webglcontextlost", e => e.preventDefault());
  element.addEventListener("webglcontextrestored", () => schedule());
  resize();

  const api = {
    markers(buttons: HTMLButtonElement[]) { cityButtons = buttons; schedule(); },
    refresh: schedule, beginDrag, surfaceTap, stage,
    rotate(dx: number, dy: number) { beginDrag(S.x, S.y)(S.x + dx, S.y + dy); },
    getZoom() { return zoom; },
    setZoom(next: number) { zoom = clamp(next, 1, 2.6); frameCamera(); schedule(); },
    reset() { basis = homeBasis(); zoom = 1; frameCamera(); schedule(); },
    // New: physical toys for the toys bar.
    toy(kind: string) {
      if (calm()) return false;
      const k = kind as keyof Toys;
      if (kind === "meteor") toys.meteor();
      else if (kind === "storm") toys.storm();
      else if (kind === "tornado") toys.tornado();
      else if (kind === "snow") toys.snowfall();
      else if (kind === "volcano") toys.volcano(true);
      else if (kind === "whale") toys.whale();
      else return void k, false;
      schedule();
      return true;
    },
    sound,
  };
  window.RouteGlobe3D = Object.assign(window.RouteGlobe3D || {}, { active: api, debug: { scene, planet, toys, get decor() { return decor; } } });
  return api;
}

export { OCEAN_R };
