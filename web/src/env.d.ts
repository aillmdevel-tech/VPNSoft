declare module "*.glb?inline" { const src: string; export default src; }
interface Window {
  RouteGlobe: any;
  RouteLand: number[][][];
  RouteElevation: Uint8Array;
  RouteGlobe3D?: any;
  RouteSound?: any;
}
