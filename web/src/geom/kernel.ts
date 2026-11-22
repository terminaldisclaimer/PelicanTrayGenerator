import Module, { type ManifoldToplevel } from 'manifold-3d';

let kernel: Promise<ManifoldToplevel> | null = null;

/**
 * Load the manifold-3d WASM kernel once. In the browser worker pass the
 * bundled .wasm URL; in Node (tests) the default loader finds it itself.
 */
export function initKernel(wasmUrl?: string): Promise<ManifoldToplevel> {
  kernel ??= Module(wasmUrl ? { locateFile: () => wasmUrl } : undefined).then((m) => {
    m.setup();
    return m;
  });
  return kernel;
}
