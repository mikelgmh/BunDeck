/**
 * open-launcher.ts — abre la ventanita de estado GPUI (launcher/) en modo dev.
 *
 * - Lanza el binario ya compilado (release > debug) en detached y sale con 0.
 * - Nunca rompe el flujo: si no hay binario, dice cómo compilarlo y sale con 0.
 * - No hace nada en CI, con NO_LAUNCHER=1, o en Linux sin display.
 * - Pensado para `bun run dev:launcher:open` dentro de `bun run dev` y dev.sh.
 */
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";

const root = path.join(import.meta.dir, "..");

function skipped(reason: string): void {
  console.log(`[launcher] omitido: ${reason}`);
}

const ci = process.env.CI === "true" || process.env.CI === "1";
if (ci) {
  skipped("CI=true");
  process.exit(0);
}
if (process.env.NO_LAUNCHER === "1") {
  skipped("NO_LAUNCHER=1");
  process.exit(0);
}
if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
  skipped("sin display en linux");
  process.exit(0);
}

const exe = process.platform === "win32" ? "libredeck-launcher.exe" : "libredeck-launcher";
const candidates = ["release", "debug"].map((p) =>
  path.join(root, "launcher", "target", p, exe),
);
const binary = candidates.find((c) => existsSync(c));

if (!binary) {
  console.log("[launcher] sin compilar: `cd launcher && cargo run --bin libredeck-launcher` para la primera vez (luego `bun run dev` ya la abre sola).");
  process.exit(0);
}

const child = spawn(binary, [], {
  detached: true,
  stdio: "ignore",
  windowsHide: true,
  // Modo dev: el launcher debe probar Astro (:4321) primero. `bun run dev`
  // no exporta DEV_MODE al proceso raíz, así que se propaga aquí por defecto.
  env: { ...process.env, DEV_MODE: process.env.DEV_MODE ?? "true" },
});
child.unref();
console.log(`[launcher] ventana de estado abierta (${binary})`);
process.exit(0);
