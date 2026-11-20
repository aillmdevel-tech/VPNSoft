import { defineConfig } from "vite";
import { resolve } from "node:path";

const here = import.meta.dirname;
// One classic script for file:// WebViews: no modules, no fetch, assets inlined as base64.
export default defineConfig({
  assetsInclude: ["**/*.glb"],
  build: {
    outDir: resolve(here, "../android/assets/journey"),
    emptyOutDir: false,
    assetsInlineLimit: 100_000_000,
    target: "es2020",
    minify: true,
    sourcemap: false,
    lib: { entry: resolve(here, "src/main.ts"), name: "RouteGlobe3DBundle", formats: ["iife"], fileName: () => "globe3d.js" },
  },
});
