/**
 * Build del daemon con la versión horneada en el binario.
 *
 * `bun build --compile` NO propaga process.env del momento del build al
 * binario: sin --define, el ejecutable reportaría el package.json previo al
 * bump de semantic-release (CI construye ANTES de publicar la release) y el
 * updater haría rollback ("la API responde como vX, no como vY").
 * Por eso BUNDECK_VERSION (y LIBREDECK_VERSION por compat con binarios
 * antiguos) se inyecta con --define (reemplazo textual).
 * En dev (bun run src/server.ts) se sigue leyendo el env / package.json en vivo.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const daemonDir = join(dir, "..");
const rootPkg = JSON.parse(readFileSync(join(daemonDir, "..", "package.json"), "utf8"));
const version = process.env.BUNDECK_VERSION || process.env.LIBREDECK_VERSION || rootPkg.version;
const win = process.argv.includes("--win");

const args = ["build", "--compile"];
if (win) args.push("--windows-hide-console");
args.push(
  "src/server.ts",
  "--outfile",
  "bundeck-daemon",
  "--define",
  `process.env.BUNDECK_VERSION="${version}"`,
  "--define",
  `process.env.LIBREDECK_VERSION="${version}"`,
);

console.log(`📌 daemon ${version} (${win ? "win" : "unix"})`);
const r = spawnSync("bun", args, { cwd: daemonDir, stdio: "inherit", env: process.env });
process.exit(r.status ?? 1);
