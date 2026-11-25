// Fuente única de versión: root package.json (canónica).
// En binario compilado la versión se HORNEA con --define en el build
// (ver cli/scripts/build.mjs): `bun build --compile` no propaga el env
// del build al binario. En dev se lee en vivo. BUNDECK_VERSION en
// runtime la sobrescribe en ambos casos (LIBREDECK_VERSION deprecated vale igual).
import rootPkg from "../../package.json";

export function getVersion(): string {
  const env = process.env.BUNDECK_VERSION || process.env.LIBREDECK_VERSION;
  if (env) return env;
  const v = (rootPkg as { version?: string } | undefined)?.version;
  return v || "dev";
}
