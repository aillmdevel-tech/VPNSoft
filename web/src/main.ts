import { create3d } from "./globe";
import { sound } from "./sound";

// Swap the legacy WebGL1 globe for the Three.js scene, keeping the exact RouteGlobe API.
// Falls back to globe.js when WebGL2 is missing or the 3D scene fails to start.
(() => {
  const legacy = window.RouteGlobe;
  if (!legacy || /[?&]legacy\b/.test(location.search)) return;
  const probe = document.createElement("canvas");
  const ok = !!probe.getContext("webgl2");
  window.RouteGlobe3D = { sound, supported: ok };
  window.RouteSound = sound;
  if (!ok) return;
  const create = legacy.create;
  legacy.create = (element: HTMLCanvasElement, markers: HTMLCanvasElement, placeActors: any, now?: () => Date) => {
    try {
      const api = create3d(element, markers, placeActors, now);
      document.documentElement.classList.add("globe3d");
      return api;
    } catch (err) {
      console.warn("globe3d fallback", err);
      const fresh = element.cloneNode(false) as HTMLCanvasElement;
      element.replaceWith(fresh);
      return create(fresh, markers, placeActors, now);
    }
  };
})();
