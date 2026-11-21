// Fuente única de versión: root package.json (canónica).
// `bun build --compile` incrusta el JSON en el binario (versión fijada en build);
// en dev se lee en vivo. LIBREDECK_VERSION la sobrescribe en ambos casos
// (la inyectan build.sh y CI en tiempo de build).
import rootPkg from "../../package.json";

export function getVersion(): string {
  const env = process.env.LIBREDECK_VERSION;
  if (env) return env;
  const v = (rootPkg as { version?: string } | undefined)?.version;
  return v || "dev";
}
