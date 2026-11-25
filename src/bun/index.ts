import { BrowserWindow, ApplicationMenu, Updater, Utils } from "electrobun/bun";
import Electrobun from "electrobun/bun";
import { startSpotifyLoginPolling } from "./spotify-login";
import { startLauncherServer } from "./launcher-server";
import { spawn, spawnSync, type ChildProcess } from "child_process";
import { existsSync, appendFileSync } from "fs";
import path from "path";

/**
 * ROL DEL HOST: Electrobun es dev-only para el ciclo de vida del daemon.
 * En producción/instalado el dueño canónico es el launcher Rust
 * (launcher/src/main.rs + monitor.rs: ensure_daemon_spawned /
 * shutdown_daemon, tray en launcher/src/tray.rs). Este host NO spawnea el
 * daemon en prod (ver shouldHostManageDaemon) para evitar doble daemon y
 * duplicar iconos; solo lo supervisa en dev (`electrobun dev`).
 */

const DEV_MODE = process.env.DEV_MODE === "true" || process.env.NODE_ENV !== "production";

function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { console.log(msg); } catch {}
  try {
    const root = path.join(import.meta.dir, "..", "..");
    appendFileSync(path.join(root, "electrobun-debug.log"), line);
  } catch {}
  try {
    appendFileSync("C:\\Temp\\electrobun.log", line);
  } catch {}
  try {
    appendFileSync(path.join(process.cwd(), "electrobun-debug.log"), line);
  } catch {}
}
// Env canónico BUNDECK_* con fallback deprecated LIBREDECK_* (tests e
// instalaciones antiguas aún usan el prefijo viejo).
function envCompat(name: string): string | undefined {
  return process.env[`BUNDECK_${name}`] ?? process.env[`LIBREDECK_${name}`];
}
if (import.meta.main) {
  if (envCompat('HOST_TEST') !== '1') {
  log(`[electrobun] main.ts loaded cwd=${process.cwd()} execPath=${process.execPath} dir=${import.meta.dir} DEV=${DEV_MODE} isMain=${import.meta.main}`);
}
}

const API_PORT = Number(process.env.PORT || 3001);
const FRONTEND_PORT = Number(process.env.FRONTEND_PORT || 3002);
const WS_PORT = Number(process.env.WS_PORT || 3003);
// API de control solo-localhost para el launcher GPUI (abrir ventana, updates).
const HOST_PORT = Number(process.env.HOST_PORT || 3031);

let daemonProcess: ChildProcess | null = null;
// Front Astro en dev (electrobun dev lo levanta; en prod no existe).
let frontendProcess: ChildProcess | null = null;
// URL real del panel (4321 en dev si Astro responde, si no 3002/views).
let dashboardUrl = `http://localhost:${FRONTEND_PORT}`;
// Guardia de apagado (before-quit veta la primera vez, limpia y reintenta).
let quitting = false;

async function isDaemonRunning(): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${API_PORT}/health`, { signal: AbortSignal.timeout(800) } as any);
    return res.ok;
  } catch {
    return false;
  }
}

function findProjectRoot(): string {
  const candidates = [
    process.cwd(),
    path.join(import.meta.dir, "..", ".."),
    path.join(import.meta.dir, "..", "..", ".."),
    path.join(import.meta.dir, "..", "..", "..", ".."),
    path.join(import.meta.dir, "..", "..", "..", "..", ".."),
    path.join(import.meta.dir, "..", "..", "..", "..", "..", ".."),
    "C:\\Users\\mikel\\OneDrive\\Documents\\GitHub\\libredeck",
  ];
  for (const c of candidates) {
    const p = path.join(c, "daemon", "src", "server.ts");
    const q = path.join(c, "electrobun.config.ts");
    if (existsSync(p) || existsSync(q)) return path.resolve(c);
  }
  return path.join(import.meta.dir, "..", "..");
}

/**
 * ¿Debe el host spawnear/supervisar el daemon? En prod el dueño es el
 * launcher Rust: el host no spawnea para evitar doble daemon. Solo dev
 * (o override explícito) lo gestiona.
 * - BUNDECK_HOST_MANAGE_DAEMON=1 fuerza, =0 lo prohíbe (LIBREDECK_* deprecated vale igual).
 * - BUNDECK_MANAGED=1 lo pone el launcher al spawnear (nunca duplicar).
 */
export function shouldHostManageDaemon(
  env: NodeJS.ProcessEnv = process.env,
  devMode: boolean = DEV_MODE,
): boolean {
  const hostManage = env.BUNDECK_HOST_MANAGE_DAEMON ?? env.LIBREDECK_HOST_MANAGE_DAEMON;
  if (hostManage === "1") return true;
  if (hostManage === "0") return false;
  if ((env.BUNDECK_MANAGED ?? env.LIBREDECK_MANAGED) === "1") return false;
  return devMode;
}

async function spawnDaemon(): Promise<void> {
  if (await isDaemonRunning()) {
    log(`[electrobun] Daemon ya corre en :${API_PORT}, no spawneo`);
    return;
  }
  if (!shouldHostManageDaemon()) {
    // Prod/instalado: el launcher Rust es el dueño del ciclo de vida
    // (ensure_daemon_spawned en launcher/src/monitor.rs). No spawnear para
    // evitar doble daemon; el launcher lo levanta si hace falta.
    log(`[electrobun] Prod: no spawneo daemon (dueño: launcher Rust). Usa el launcher o bun run dev:daemon`);
    return;
  }
  log(`[electrobun] Spawneando daemon... API:${API_PORT} WS:${WS_PORT} Frontend:${FRONTEND_PORT}`);

  const projectRoot = findProjectRoot();
  const daemonEntry = path.join(projectRoot, "daemon", "src", "server.ts");
  if (!existsSync(daemonEntry)) {
    log(`[electrobun] No encuentro daemon entry: ${daemonEntry} (cwd=${process.cwd()} root=${projectRoot} dir=${import.meta.dir})`);
    return;
  }
  // Host bun: electrobun's bun es dist-win-x64/bun.exe, no tiene los nativos del proyecto.
  // Usar el bun del host si existe, sino fallback a "bun" del PATH
  const hostBun = existsSync("C:\\Users\\mikel\\.bun\\bin\\bun.exe")
    ? "C:\\Users\\mikel\\.bun\\bin\\bun.exe"
    : process.env.BUN_PATH || "bun";
  log(`[electrobun] hostBun=${hostBun} projectRoot=${projectRoot} daemonEntry=${daemonEntry}`);

  try {
    if (DEV_MODE) {
      // Dev (electrobun dev): igual que `bun run dev:daemon` (watch + sin
      // frontend embebido; la UI la sirve Astro en :4321). LAN explícita para
      // QR/móvil (daemon por defecto solo loopback).
      const daemonDir = path.join(projectRoot, "daemon");
      daemonProcess = spawn(hostBun, ["run", "--watch", "src/server.ts"], {
        cwd: daemonDir,
        env: { ...process.env, DEV_MODE: "true", BUNDECK_BIND_LAN: process.env.BUNDECK_BIND_LAN ?? process.env.LIBREDECK_BIND_LAN ?? "1", LIBREDECK_BIND_LAN: process.env.BUNDECK_BIND_LAN ?? process.env.LIBREDECK_BIND_LAN ?? "1" },
        stdio: "inherit",
        shell: false,
        detached: false,
        windowsHide: true,
      });
    } else {
      daemonProcess = spawn(hostBun, ["run", "daemon/src/server.ts"], {
        cwd: projectRoot,
        env: { ...process.env, DEV_MODE: "false" },
        stdio: "inherit",
        shell: false,
        detached: false,
        windowsHide: true,
      });
    }
    daemonProcess.on("error", (e) => console.error("[electrobun] spawn error", e));
    daemonProcess.on("exit", (code) => console.log(`[electrobun] daemon exit code=${code}`));

    // Esperar a que esté listo
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 500));
      if (await isDaemonRunning()) {
        console.log("[electrobun] Daemon listo");
        return;
      }
    }
    console.warn("[electrobun] Daemon no respondió a /health tras 10s");
  } catch (e) {
    console.error("[electrobun] spawnDaemon failed", e);
  }
}

async function isFrontendRunning(): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:4321`, { method: "HEAD", signal: AbortSignal.timeout(1500) } as any);
    return res.ok;
  } catch {
    return false;
  }
}

// `electrobun dev` también levanta el front (Astro). web usa npm, no bun
// (convención del repo); en Windows npm es npm.cmd y hace falta shell.
async function spawnFrontend(): Promise<void> {
  if (!DEV_MODE) return;
  if (await isFrontendRunning()) {
    log(`[electrobun] Front ya corre en :4321, no spawneo`);
    return;
  }
  const projectRoot = findProjectRoot();
  const webDir = path.join(projectRoot, "web");
  if (!existsSync(path.join(webDir, "package.json"))) {
    log(`[electrobun] No encuentro web/: ${webDir}`);
    return;
  }
  log(`[electrobun] Spawneando front (Astro dev en ${webDir})...`);
  try {
    frontendProcess = spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "dev"], {
      cwd: webDir,
      env: { ...process.env },
      stdio: "inherit",
      shell: process.platform === "win32",
      detached: false,
      windowsHide: true,
    });
    frontendProcess.on("error", (e) => console.error("[electrobun] spawn front error", e));
    frontendProcess.on("exit", (code) => console.log(`[electrobun] front exit code=${code}`));

    for (let i = 0; i < 90; i++) {
      await new Promise(r => setTimeout(r, 1000));
      if (await isFrontendRunning()) {
        console.log("[electrobun] Front listo en :4321");
        return;
      }
      if (i % 10 === 9) log(`[electrobun] esperando front... (${i + 1}s)`);
    }
    console.warn("[electrobun] Front no respondió en :4321 tras 90s (sigo con fallback)");
  } catch (e) {
    console.error("[electrobun] spawnFrontend failed", e);
  }
}

function killTree(child: ChildProcess | null, label: string) {
  if (!child || child.exitCode !== null) return;
  try { child.kill(); } catch {}
  // En Windows, npm.cmd deja nietos (npm -> node/astro) que kill() no alcanza:
  // taskkill /T mata el árbol completo.
  if (process.platform === "win32" && typeof child.pid === "number") {
    try {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true } as any);
    } catch {}
  }
  log(`[electrobun] ${label} detenido`);
}

// Apagado ordenado: front (dev) + daemon (siempre, lo hayamos spawneado o no:
// el tray "Salir" debe cerrar el daemon). Nunca bloquea más de ~6s.
export interface ShutdownDeps {
  fetchFn: (url: string, init?: any) => Promise<unknown>;
  killChild: (child: ChildProcess | null, label: string) => void;
  takeDaemon: () => ChildProcess | null;
  takeFrontend: () => ChildProcess | null;
  apiPort: number;
}

export async function shutdownAll(deps?: Partial<ShutdownDeps>): Promise<void> {
  const {
    fetchFn = fetch,
    killChild = killTree,
    takeDaemon = () => {
      const c = daemonProcess;
      daemonProcess = null;
      return c;
    },
    takeFrontend = () => {
      const c = frontendProcess;
      frontendProcess = null;
      return c;
    },
    apiPort = API_PORT,
  } = deps ?? {};
  // 1. Front Astro (solo existe si lo spawneamos nosotros en dev)
  killChild(takeFrontend(), "front");
  // 2. Daemon: vía su propio endpoint (responde al instante, muere en ~2s;
  // funciona aunque lo hubiera arrancado el usuario por su cuenta)...
  try {
    await fetchFn(`http://localhost:${apiPort}/api/v1/admin/shutdown`, {
      method: "POST",
      signal: AbortSignal.timeout(2000),
    } as any);
    log("[electrobun] shutdown del daemon solicitado por API");
  } catch {
    // Sin daemon a la escucha: nada que apagar por API
  }
  // ...y kill directo al hijo por si el endpoint no bastó.
  killChild(takeDaemon(), "daemon");
}

async function checkAppUpdate() {
  try {
    const info = await Updater.getLocalInfo();
    if (info.channel !== "stable") return { updateAvailable: false, updateReady: false };
    const res = await Updater.checkForUpdate();
    if (!res.updateAvailable) return { updateAvailable: false, updateReady: false };
    if (res.version && info.version && res.version === info.version) return { updateAvailable: false, updateReady: false };
    return { updateAvailable: true, updateReady: false, version: res.version };
  } catch {
    return { updateAvailable: false, updateReady: false };
  }
}

async function applyAppUpdate() {
  try {
    await Updater.downloadUpdate();
    const ready = Updater.updateInfo?.()?.updateReady ?? false;
    if (!ready) return { ok: false };
    await new Promise(r => setTimeout(r, 1000));
    await Updater.applyUpdate();
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

const LAUNCHER_EXE = process.platform === "win32" ? "bundeck-launcher.exe" : "bundeck-launcher";

/**
 * Localiza el binario del launcher GPUI (ventana de estado):
 * 1) override BUNDECK_LAUNCHER (o LIBREDECK_LAUNCHER deprecated), 2) junto al host (instalado),
 * 3) launcher/target/{release,debug} en dev. null si no existe.
 */
export function findLauncherBinary(envBin: string | undefined = process.env.BUNDECK_LAUNCHER || process.env.LIBREDECK_LAUNCHER): string | null {
  if (envBin && existsSync(envBin)) return envBin;
  const nextToHost = path.join(path.dirname(process.execPath), LAUNCHER_EXE);
  if (existsSync(nextToHost)) return nextToHost;
  const root = findProjectRoot();
  for (const profile of ["release", "debug"]) {
    const c = path.join(root, "launcher", "target", profile, LAUNCHER_EXE);
    if (existsSync(c)) return c;
  }
  return null;
}

export interface LauncherDeps {
  binary: string | null;
  spawnFn: (bin: string) => unknown;
  onLog: (msg: string) => void;
}

/**
 * Lanza la ventanita GPUI en detached. Devuelve true si se lanzó: el caller
 * debe entonces saltarse la BrowserWindow de Electrobun (el launcher es la
 * UI de entrada y ofrece "Abrir panel").
 */
export function spawnLauncher(deps?: Partial<LauncherDeps>): boolean {
  const {
    binary = findLauncherBinary(),
    spawnFn = (bin: string) =>
      (spawn(bin, [], { detached: true, stdio: "ignore", shell: false, windowsHide: true } as any).unref?.() as unknown),
    onLog = log,
  } = deps ?? {};
  if (!binary) return false;
  try {
    spawnFn(binary);
    onLog(`[electrobun] Launcher GPUI lanzado (${binary}), se omite BrowserWindow`);
    return true;
  } catch (e) {
    onLog(`[electrobun] No se pudo lanzar el launcher GPUI: ${e}`);
    return false;
  }
}

let dashboardWin: any = null;

/**
 * Abre (o reutiliza) la BrowserWindow del dashboard. La usa main() y la
 * expone la Launcher API (__launcher/open-window) para la ventanita GPUI.
 */
export function openDashboardWindow(targetUrl: string): { opened: boolean; url?: string; reason?: string } {
  if (dashboardWin) return { opened: false, url: targetUrl, reason: "already-open" };
  const trackClose = (w: any) => {
    dashboardWin = w;
    try {
      // @ts-ignore
      w.on?.("close", () => {
        if (dashboardWin === w) dashboardWin = null;
        console.log("[electrobun] Ventana cerrada — daemon sigue en LAN");
      });
    } catch { /* noop */ }
  };
  try {
    const win = new BrowserWindow({
      title: "BunDeck",
      url: targetUrl,
      // Frameless: la barra nativa se sustituye por <TitleBar/> (web).
      // El drag funciona con la clase .electrobun-webkit-app-region-drag.
      titleBarStyle: "hidden",
      frame: { width: 1280, height: 800, x: 100, y: 100 },
    });
    trackClose(win);
    console.log(`[electrobun] Ventana creada OK url=${targetUrl}`);
    return { opened: true, url: targetUrl };
  } catch (e) {
    console.error("[electrobun] Error creando ventana con", targetUrl, e);
    try {
      const fallback = new BrowserWindow({
        title: "BunDeck",
        url: "views://mainview/index.html",
        titleBarStyle: "hidden",
        frame: { width: 1280, height: 800, x: 100, y: 100 },
      });
      trackClose(fallback);
      console.log("[electrobun] Ventana fallback views:// creada");
      return { opened: true, url: "views://mainview/index.html" };
    } catch (e2) {
      console.error("[electrobun] Fallback también falló:", e2);
      return { opened: false, url: targetUrl, reason: String(e2) };
    }
  }
}

async function main() {
  log(`[electrobun] main() DEV:${DEV_MODE} cwd:${process.cwd()} execPath:${process.execPath} dir=${import.meta.dir}`);

  await spawnDaemon();
  await spawnFrontend();

  // Ventanita GPUI como puerta de entrada: si se lanza, Electrobun no abre
  // su BrowserWindow (evita duplicar ventanas; menú/updater siguen, y el
  // tray es del launcher: ver launcher/src/tray.rs).
  const launcherActive = spawnLauncher();

  // Pequeña espera
  await new Promise(r => setTimeout(r, 500));

  try {
    ApplicationMenu.setApplicationMenu([
      {
        label: "BunDeck",
        submenu: [
          { label: "Abrir en navegador", click: () => Utils.openExternal(dashboardUrl) },
          { type: "separator" },
          { role: "quit", label: "Salir" },
        ],
      },
      {
        label: "Editar",
        submenu: [
          { role: "undo" }, { role: "redo" }, { type: "separator" },
          { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" },
        ],
      },
      {
        label: "Ayuda",
        submenu: [
          {
            label: "Buscar actualizaciones",
            click: async () => {
              const res: any = await checkAppUpdate();
              if (res.updateAvailable) {
                const ok = await applyAppUpdate();
                console.log("[electrobun] update", res, ok);
              } else {
                console.log("[electrobun] No hay actualizaciones");
              }
            },
          },
          { label: "Abrir DevTools", role: "toggleDevTools" },
        ],
      },
    ]);
  } catch (e) {
    console.error("[electrobun] Error menu:", e);
  }

  // Ventana híbrida: en dev electrobun, priorizar views:// si no hay astro dev
  // Si daemon sirve http://localhost:3002, usar ese (LAN). Si no, fallback views://
  let targetUrl = `http://localhost:${FRONTEND_PORT}`;
  if (DEV_MODE) {
    try {
      const res = await fetch("http://localhost:4321", { method: "HEAD", signal: AbortSignal.timeout(500) } as any);
      if (res.ok) targetUrl = "http://localhost:4321";
    } catch {}
  }

  // Probar si targetUrl responde, si no, usar views:// (incluso en DEV, para fallback offline)
  let useViewsFallback = false;
  try {
    const res = await fetch(targetUrl, { method: "HEAD", signal: AbortSignal.timeout(800) } as any);
    if (!res.ok) useViewsFallback = true;
  } catch {
    useViewsFallback = true;
  }
  if (useViewsFallback) {
    log(`[electrobun] target ${targetUrl} no responde, fallback a views://`);
    targetUrl = "views://mainview/index.html";
  }
  dashboardUrl = targetUrl;

  console.log(`[electrobun] Creando ventana → ${targetUrl}`);

  // Sin tray propio: la bandeja es propiedad del launcher GPUI (ver
  // launcher/src/tray.rs). Clic en el icono -> abre la ventanita del
  // launcher; su menú ("Abrir panel"/"Salir") gobierna a distancia vía
  // la Launcher API (__launcher/*) de este host.

  if (launcherActive) {
    log("[electrobun] Ventana Electrobun omitida: el launcher GPUI es la UI de entrada");
  } else {
    openDashboardWindow(targetUrl);
  }

  // API de control para el launcher GPUI (panel de control).
  // Solo 127.0.0.1; si el puerto está ocupado (otro host), se sigue sin ella.
  // También la usa <TitleBar/> (web) para min/max/close de la ventana frameless.
  try {
    startLauncherServer(
      {
        openWindow: () => openDashboardWindow(dashboardUrl),
        checkUpdate: checkAppUpdate,
        applyUpdate: applyAppUpdate,
        windowMinimize: () => {
          try { dashboardWin?.minimize?.(); } catch { /* noop */ }
        },
        windowToggleMaximize: () => {
          try {
            if (!dashboardWin) return { maximized: false };
            if (dashboardWin.isMaximized?.()) {
              dashboardWin.unmaximize?.();
              return { maximized: false };
            }
            dashboardWin.maximize?.();
            return { maximized: true };
          } catch {
            return { maximized: false };
          }
        },
        windowClose: () => {
          try { dashboardWin?.close?.(); } catch { /* noop */ }
        },
        windowIsMaximized: () => {
          try { return !!dashboardWin?.isMaximized?.(); } catch { return false; }
        },
      },
      HOST_PORT,
    );
    log(`[electrobun] Launcher API en 127.0.0.1:${HOST_PORT}`);
  } catch (e) {
    log(`[electrobun] No se pudo abrir la Launcher API (:${HOST_PORT}): ${e}`);
  }

  process.on("SIGINT", async () => {
    quitting = true; // el exit posterior ya no se veta (ya limpiamos aquí)
    await shutdownAll();
    process.exit(0);
  });
  process.on("beforeExit", () => {
    killTree(daemonProcess, "daemon");
    daemonProcess = null;
    killTree(frontendProcess, "front");
    frontendProcess = null;
  });

  // Apagado ordenado en TODAS las vías de salida (tray "Salir", menú quit,
  // cierre nativo): veta el primer before-quit, limpia y reintenta.
  // quitting queda en true hasta salir: el segundo quit() ya no se veta.
  (Electrobun as any).events?.on?.("before-quit", (e: any) => {
    if (quitting) return; // segunda pasada: dejar salir
    quitting = true;
    try {
      e.response = { allow: false };
    } catch {}
    void shutdownAll()
      .catch((err) => console.error("[electrobun] shutdownAll failed", err))
      .finally(() => {
        Utils.quit();
      });
  });

  // Login de Spotify sin Client ID: el host pollea login-request y abre
  // la ventana del Web Player oficial para extraer el token en local.
  // No interfiere con tests (BUNDECK_HOST_TEST=1 —o LIBREDECK_HOST_TEST=1— no llega a main()).
  try {
    startSpotifyLoginPolling({ apiPort: API_PORT, BrowserWindowCtor: BrowserWindow as any, onLog: log });
  } catch (e) {
    console.error("[electrobun] Spotify polling no iniciado:", e);
  }

  console.log("[electrobun] Main listo, esperando...");
}

// Arranque incondicional: el launcher de Electrobun evalúa este fichero
// como módulo (import.meta.main === false) y si no se arranca main() la app
// se queda colgada sin ventana ni logs. Los tests ponen
// BUNDECK_HOST_TEST=1 (o LIBREDECK_HOST_TEST=1) e importan dinámicamente para no arrancar nada.
if (envCompat('HOST_TEST') !== '1') {
  main().catch(e => console.error("[electrobun] Fatal en main():", e));
}
