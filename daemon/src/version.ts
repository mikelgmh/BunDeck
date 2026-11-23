// Fuente única de versión: root package.json (canónica).
// En binario compilado la versión se HORNEA con --define en el build
// (ver daemon/scripts/build.mjs): `bun build --compile` no propaga el env
// del build al binario, así que sin --define reportaría el package.json
// previo al bump de semantic-release y el updater haría rollback.
// En dev se lee en vivo. LIBREDECK_VERSION en runtime la sobrescribe
// en ambos casos (útil para overrides puntuales, no para el build).
import rootPkg from "../../package.json";

export function getVersion(): string {
  const env = process.env.LIBREDECK_VERSION;
  if (env) return env;
  const v = (rootPkg as { version?: string } | undefined)?.version;
  return v || "dev";
}
