/**
 * Build del CLI con la versión horneada en el binario.
 * Mismo motivo que daemon/scripts/build.mjs: `bun build --compile` no
 * propaga process.env del build al binario, así que BUNDECK_VERSION
 * (y LIBREDECK_VERSION por compat) se inyecta con --define. Sin esto,
 * `sdctl update` compararía con una versión
 * obsoleta (package.json previo al bump de semantic-release).
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const cliDir = join(dir, "..");
const rootPkg = JSON.parse(readFileSync(join(cliDir, "..", "package.json"), "utf8"));
const version = process.env.BUNDECK_VERSION || process.env.LIBREDECK_VERSION || rootPkg.version;

const args = [
  "build",
  "--compile",
  "src/cli.ts",
  "--outfile",
  "bundeck-cli",
  "--define",
  `process.env.BUNDECK_VERSION="${version}"`,
  "--define",
  `process.env.LIBREDECK_VERSION="${version}"`,
];

console.log(`📌 cli ${version}`);
const r = spawnSync("bun", args, { cwd: cliDir, stdio: "inherit", env: process.env });
process.exit(r.status ?? 1);
