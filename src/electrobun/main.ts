import { BrowserWindow, ApplicationMenu, Updater, Utils } from "electrobun/bun";
import { spawn, type ChildProcess } from "child_process";
import { existsSync, appendFileSync } from "fs";
import path from "path";

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
log(`[electrobun] main.ts loaded cwd=${process.cwd()} execPath=${process.execPath} dir=${import.meta.dir} DEV=${DEV_MODE}`);

const API_PORT = Number(process.env.PORT || 3001);
const FRONTEND_PORT = Number(process.env.FRONTEND_PORT || 3002);
const WS_PORT = Number(process.env.WS_PORT || 3003);

let daemonProcess: ChildProcess | null = null;

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

async function spawnDaemon(): Promise<void> {
  if (await isDaemonRunning()) {
    log(`[electrobun] Daemon ya corre en :${API_PORT}, no spawneo`);
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
    daemonProcess = spawn(hostBun, ["run", "daemon/src/server.ts"], {
      cwd: projectRoot,
      env: { ...process.env, DEV_MODE: "false" },
      stdio: "inherit",
      shell: false,
      detached: false,
    });
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

async function main() {
  log(`[electrobun] main() DEV:${DEV_MODE} cwd:${process.cwd()} execPath:${process.execPath} dir=${import.meta.dir}`);

  await spawnDaemon();

  // Pequeña espera
  await new Promise(r => setTimeout(r, 500));

  try {
    ApplicationMenu.setApplicationMenu([
      {
        label: "LibreDeck",
        submenu: [
          { label: "Abrir en navegador", click: () => Utils.openExternal(`http://localhost:${FRONTEND_PORT}`) },
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

  console.log(`[electrobun] Creando ventana → ${targetUrl}`);

  try {
    const win = new BrowserWindow({
      title: "LibreDeck",
      url: targetUrl,
      titleBarStyle: "hidden",
      frame: { width: 1280, height: 800, x: 100, y: 100 },
    });
    console.log(`[electrobun] Ventana creada OK url=${targetUrl}`);
    // @ts-ignore
    win.on?.("close", () => console.log("[electrobun] Ventana cerrada — daemon sigue en LAN"));
  } catch (e) {
    console.error("[electrobun] Error creando ventana con", targetUrl, e);
    try {
      const fallback = new BrowserWindow({
        title: "LibreDeck",
        url: "views://mainview/index.html",
        titleBarStyle: "hidden",
        frame: { width: 1280, height: 800, x: 100, y: 100 },
      });
      console.log("[electrobun] Ventana fallback views:// creada");
    } catch (e2) {
      console.error("[electrobun] Fallback también falló:", e2);
    }
  }

  process.on("SIGINT", async () => {
    if (daemonProcess) daemonProcess.kill();
    process.exit(0);
  });
  process.on("beforeExit", () => {
    if (daemonProcess) daemonProcess.kill();
  });

  console.log("[electrobun] Main listo, esperando...");
}

main().catch(e => console.error("[electrobun] Fatal en main():", e));
