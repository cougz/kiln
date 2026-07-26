import { Container } from "@cloudflare/containers";

/**
 * The CAD engine container (engine/): Python + geometry stack.
 * P0 ships trimesh-only (/healthz, /measure); P1 adds cadquery/OCCT,
 * rendering, and the verify suite behind the same binding.
 */
export class KilnEngine extends Container {
  defaultPort = 8000;
  enableInternet = false;
  // Builds take minutes; keep the instance warm between agent tool calls,
  // then scale to zero.
  sleepAfter = "10m";
}

export function buildContainerName(buildId: string): string {
  return `build-${buildId}`;
}
