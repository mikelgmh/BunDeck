/**
 * Rutas de sistema: test, /config, assets, logs, settings, windows,
 * system/metrics, version (+check 501), devices/streamdeck y network/ips.
 */
import { getSystemMetricsScript } from '../scripts/system-metrics.ps1';
import { streamDeckDriver } from '../hw-driver/streamdeck-driver';
import {
  getConflictProcessesCached,
  closeConflictProcesses,
} from '../hw-driver/streamdeck-conflict';
import { getVersion } from '../version';
import { jsonResponse } from './http-helpers';
import type { ApiHandler } from './types';

/** Degradado honesto: nulls + motivo, nunca datos aleatorios. */
function honestDegraded(reason: string) {
  return {
    cpu: { usage: null, temperature: null },
    ram: { total: null, used: null, usage: null },
    gpu: { usage: null, temperature: null },
    fans: [],
    voltages: [],
    degraded: true,
    reason,
    hint: 'CPU temp / fans / voltajes requieren LibreHardwareMonitor u OpenHardwareMonitor con driver (PawnIO/WinRing0) y admin, igual que el plugin LHM de Macro-Deck. GPU NVIDIA funciona con nvidia-smi sin admin.',
    timestamp: new Date().toISOString(),
  };
}

async function runCmd(cmd: string[]): Promise<{ exitCode: number; stdout: string }> {
  try {
    const proc = Bun.spawn({ windowsHide: true,  cmd, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    return { exitCode: proc.exitCode, stdout };
  } catch {
    return { exitCode: 1, stdout: '' };
  }
}

/** CPU % en Unix con doble muestra de node:os (200 ms). */
async function unixCpuUsage(sampleMs = 200): Promise<number | null> {
  try {
    const { cpus } = await import('node:os');
    const snap = () =>
      cpus().map((c) => {
        const t = c.times;
        return { idle: t.idle, total: t.user + t.nice + t.sys + t.idle + t.irq };
      });
    const a = snap();
    await new Promise((r) => setTimeout(r, sampleMs));
    const b = snap();
    let idle = 0;
    let total = 0;
    for (let i = 0; i < a.length; i++) {
      idle += b[i].idle - a[i].idle;
      total += b[i].total - a[i].total;
    }
    if (total <= 0) return null;
    return Math.round(((1 - idle / total) * 100) * 10) / 10;
  } catch {
    return null;
  }
}

async function unixCpuTemp(): Promise<{ value: number | null; source: string | null }> {
  // 1) /sys/class/thermal (Raspberry/Intel x86 laptops)
  try {
    const { readFile, readdir } = await import('node:fs/promises');
    const zones = await readdir('/sys/class/thermal').catch(() => [] as string[]);
    const vals: number[] = [];
    for (const z of zones.filter((z) => z.startsWith('thermal_zone'))) {
      try {
        const raw = await readFile(`/sys/class/thermal/${z}/temp`, 'utf8');
        const v = Number(raw.trim());
        if (Number.isFinite(v)) vals.push(v > 1000 ? v / 1000 : v);
      } catch {}
    }
    if (vals.length > 0) return { value: Math.round(Math.max(...vals) * 10) / 10, source: 'sys-thermal-zone' };
  } catch {}
  // 2) hwmon
  try {
    const { readFile, readdir } = await import('node:fs/promises');
    const hws = await readdir('/sys/class/hwmon').catch(() => [] as string[]);
    const vals: number[] = [];
    for (const h of hws) {
      for (let i = 1; i <= 5; i++) {
        try {
          const raw = await readFile(`/sys/class/hwmon/${h}/temp${i}_input`, 'utf8');
          const v = Number(raw.trim()) / 1000;
          if (Number.isFinite(v) && v > -50 && v < 150) vals.push(v);
        } catch {}
      }
    }
    if (vals.length > 0) return { value: Math.round(Math.max(...vals) * 10) / 10, source: 'sys-hwmon' };
  } catch {}
  // 3) `sensors -j` (lm-sensors)
  try {
    const out = await runCmd(['sensors', '-j']);
    if (out.exitCode === 0 && out.stdout.trim().startsWith('{')) {
      const data = JSON.parse(out.stdout);
      const vals: number[] = [];
      const walk = (o: any) => {
        if (!o || typeof o !== 'object') return;
        for (const [k, v] of Object.entries(o)) {
          if (/temp\d*_input/i.test(k) && typeof v === 'number' && v > -50 && v < 150) vals.push(v);
          else walk(v);
        }
      };
      walk(data);
      if (vals.length > 0) return { value: Math.round(Math.max(...vals) * 10) / 10, source: 'lm-sensors' };
    }
  } catch {}
  return { value: null, source: null };
}

async function unixGpu(): Promise<{ usage: number | null; temperature: number | null; source: string | null }> {
  // NVIDIA (Linux): uso + temp sin admin
  try {
    const out = await runCmd(['nvidia-smi', '--query-gpu=utilization.gpu,temperature.gpu', '--format=csv,noheader,nounits']);
    if (out.exitCode === 0 && out.stdout.trim()) {
      const [u, t] = out.stdout.trim().split('\n')[0].split(',').map((s) => Number(s.trim()));
      return {
        usage: Number.isFinite(u) ? u : null,
        temperature: Number.isFinite(t) ? t : null,
        source: 'nvidia-smi',
      };
    }
  } catch {}
  // AMD (Linux): rocm-smi
  try {
    const out = await runCmd(['rocm-smi', '--showtemp', '--showuse']);
    const tm = out.stdout.match(/Temperature[^0-9]*([\d.]+)\s*c/i);
    const um = out.stdout.match(/GPU use[^0-9]*([\d.]+)\s*%/i);
    const t = tm ? Number(tm[1]) : NaN;
    const u = um ? Number(um[1]) : NaN;
    if (out.exitCode === 0 && (Number.isFinite(t) || Number.isFinite(u))) {
      return {
        usage: Number.isFinite(u) ? u : null,
        temperature: Number.isFinite(t) ? t : null,
        source: 'rocm-smi',
      };
    }
  } catch {}
  return { usage: null, temperature: null, source: null };
}

/** Recolector Unix (Linux/macOS): CPU/RAM siempre, temps donde el SO lo permite sin driver. */
async function collectNativeUnixMetrics(): Promise<any> {
  const os = await import('node:os');
  const totalGB = Math.round((os.totalmem() / 1024 / 1024 / 1024) * 10) / 10;
  const freeGB = Math.round((os.freemem() / 1024 / 1024 / 1024) * 10) / 10;
  const usedGB = Math.round((totalGB - freeGB) * 10) / 10;
  const cpuUsage = await unixCpuUsage();
  const { value: cpuTemp, source: cpuTempSource } = await unixCpuTemp();
  const gpu = await unixGpu();
  return {
    cpu: { usage: cpuUsage, temperature: cpuTemp },
    ram: {
      total: totalGB,
      used: usedGB,
      usage: totalGB > 0 ? Math.round((usedGB / totalGB) * 1000) / 10 : null,
    },
    gpu: { usage: gpu.usage, temperature: gpu.temperature },
    fans: [],
    voltages: [],
    sources: { cpuTemp: cpuTempSource, gpuUsage: gpu.source, gpuTemp: gpu.source, hardware: null },
    timestamp: new Date().toISOString(),
  };
}

/**
 * Fase 2 (paridad LHM): si el usuario tiene LibreHardwareMonitor con
 * Remote Web Server (http://localhost:8085/data.json), fusionar sus
 * sensores (CPU temp por núcleo, GPU, fans, voltajes) sobre lo nativo.
 * Nunca bloquea más de ~1.5 s y nunca falla la respuesta base.
 */
async function enrichWithLhmRemote(base: any): Promise<any> {
  const mergeFromLhmJson = (lhm: any) => {
    try {
      const temps: number[] = [];
      const fans: Array<{ name: string; value: number; unit: string }> = [];
      const voltages: Array<{ name: string; value: number; unit: string }> = [];
      let gpuTemp: number | null = null;
      let gpuLoad: number | null = null;
      const walk = (node: any) => {
        if (!node || typeof node !== 'object') return;
        if (node.Type === 'Temperature' && typeof node.Value === 'string') {
          const v = Number(String(node.Value).replace(/[^0-9.\-]/g, ''));
          if (Number.isFinite(v) && v > -50 && v < 150) {
            temps.push(v);
            if (/gpu/i.test(String(node.Name ?? '') + String(node.Text ?? '')) && gpuTemp == null) gpuTemp = v;
          }
        }
        if (node.Type === 'Load' && /gpu/i.test(String(node.Text ?? '') + String(node.Name ?? ''))) {
          const v = Number(String(node.Value ?? '').replace(/[^0-9.\-]/g, ''));
          if (Number.isFinite(v) && v >= 0 && v <= 100 && gpuLoad == null) gpuLoad = v;
        }
        if (node.Type === 'Fan' && typeof node.Value === 'string') {
          const v = Number(String(node.Value).replace(/[^0-9.\-]/g, ''));
          if (Number.isFinite(v) && fans.length < 8) fans.push({ name: String(node.Text ?? node.Name ?? 'Fan'), value: Math.round(v), unit: 'RPM' });
        }
        if (node.Type === 'Voltage' && typeof node.Value === 'string') {
          const v = Number(String(node.Value).replace(/[^0-9.\-]/g, ''));
          if (Number.isFinite(v) && voltages.length < 8) voltages.push({ name: String(node.Text ?? node.Name ?? 'V'), value: Math.round(v * 1000) / 1000, unit: 'V' });
        }
        if (Array.isArray(node.Children)) node.Children.forEach(walk);
      };
      walk(lhm);
      const out = { ...base };
      if (base?.cpu?.temperature == null && temps.length > 0) {
        out.cpu = { ...base.cpu, temperature: Math.round(Math.max(...temps) * 10) / 10 };
        out.sources = { ...base.sources, cpuTemp: 'lhm-remote' };
      }
      if (base?.gpu?.temperature == null && gpuTemp != null) {
        out.gpu = { ...out.gpu, temperature: gpuTemp };
        out.sources = { ...out.sources, gpuTemp: 'lhm-remote' };
      }
      if (base?.gpu?.usage == null && gpuLoad != null) {
        out.gpu = { ...out.gpu, usage: gpuLoad };
        out.sources = { ...out.sources, gpuUsage: 'lhm-remote' };
      }
      if ((base?.fans?.length ?? 0) === 0 && fans.length > 0) out.fans = fans;
      if ((base?.voltages?.length ?? 0) === 0 && voltages.length > 0) out.voltages = voltages;
      return out;
    } catch {
      return base;
    }
  };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    try {
      const res = await fetch('http://localhost:8085/data.json', { signal: ctrl.signal });
      if (res.ok) {
        const lhm = await res.json();
        return mergeFromLhmJson(lhm);
      }
    } finally {
      clearTimeout(t);
    }
  } catch {}
  return base;
}

/** Caché del endpoint /system/metrics: el script PowerShell tarda ~1s
 * (Get-Counter con SampleInterval 1) y cada widget dinámico lo sondea cada
 * 2-5s. Sin caché, N botones = N powershell.exe solapados "a lo loco".
 * Con caché de 3s + deduplicación in-flight, como máximo hay 1
 * powershell vivo cada 3s, y además con windowsHide no flashea ventana. */
let metricsCache: { ts: number; data: any; status: number } | null = null;
let metricsInFlight: Promise<{ data: any; status: number }> | null = null;
const METRICS_TTL_MS = 3000;

export const handleSystem: ApiHandler = async (_req, { url, method, path, db, services }) => {
  // Test endpoint for connectivity
  if (path === '/api/v1/test') {
    if (method === 'GET') {
      return jsonResponse({
        status: 'ok',
        message: 'Daemon is running',
        timestamp: Date.now(),
      });
    }
  }

  // Config endpoint for frontend — usa puertos centralizados (config.ts)
  if (path === '/config') {
    if (method === 'GET') {
      const { WS_PORT, API_PORT, FRONTEND_PORT } = await import('../config');
      const config: any = {
        wsPort: WS_PORT,
        apiPort: API_PORT,
        frontendPort: FRONTEND_PORT,
      };
      return jsonResponse(config);
    }
  }

  // Assets endpoints (imágenes de tecla: POST multipart + DELETE por url)
  if (path === '/api/v1/assets') {
    if (method === 'POST') {
      const { handleKeyImageUpload } = await import('../http/key-images');
      return handleKeyImageUpload(_req, db);
    }
    if (method === 'DELETE') {
      const { handleKeyImageDelete } = await import('../http/key-images');
      return handleKeyImageDelete(_req);
    }
  }

  // Logs endpoints
  if (path === '/api/v1/logs') {
    if (method === 'GET') {
      const limit = parseInt(url.searchParams.get('limit') || '100');
      const level = url.searchParams.get('level') || undefined;

      const logs = db.getLogs(limit, level);
      return jsonResponse(logs);
    }
  }

  // Settings endpoints
  if (path === '/api/v1/settings') {
    if (method === 'GET') {
      const key = url.searchParams.get('key');
      if (key) {
        const value = db.getSetting(key);
        return jsonResponse({ key, value });
      }
      // TODO: Return all settings (needs implementation in DB)
      return jsonResponse({});
    }

    if (method === 'POST') {
      const body = await _req.json();
      const { key, value } = body;

      if (!key || value === undefined) {
        return jsonResponse({ error: 'key and value required' }, 400);
      }

      db.setSetting(key, value);
      return jsonResponse({ key, value });
    }
  }

  // Windows monitoring endpoints
  if (path === '/api/v1/windows/active') {
    if (method === 'GET') {
      // Obtener la ventana activa actual usando PowerShell
      const powershellScript = `
        try {
          $code = @"
            [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
            [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);
            [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
"@
            $win32 = Add-Type -MemberDefinition $code -Name Win32 -Namespace "" -PassThru

            $hwnd = $win32::GetForegroundWindow()
            if ($hwnd -ne 0) {
              $processId = 0
              $win32::GetWindowThreadProcessId($hwnd, [ref]$processId)

              $process = $null
              $processName = "Unknown"
              $executablePath = "Unknown"

              try {
                $process = Get-Process -Id $processId -ErrorAction Stop
                $processName = $process.Name
                $executablePath = $process.Path
              } catch {
                $processName = "Unknown"
                $executablePath = "Unknown"
              }

              $titleBuilder = New-Object System.Text.StringBuilder 256
              $win32::GetWindowText($hwnd, $titleBuilder, $titleBuilder.Capacity) | Out-Null

              $windowTitle = $titleBuilder.ToString().Trim()
              if (-not $windowTitle) {
                $windowTitle = "Untitled"
              }

              @{
                hwnd = $hwnd.ToString()
                title = $windowTitle
                processId = $processId
                processName = $processName
                executablePath = $executablePath
              } | ConvertTo-Json -Compress
            } else {
              @{ error = "No active window found" } | ConvertTo-Json -Compress
            }
          } catch {
            @{ error = $_.Exception.Message } | ConvertTo-Json -Compress
          }
        `.trim();

      const proc = Bun.spawn({ windowsHide: true, 
        cmd: ['powershell.exe', '-Command', powershellScript],
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const output = await new Response(proc.stdout).text();
      const error = await new Response(proc.stderr).text();

      await proc.exited;

      if (proc.exitCode === 0 && output.trim()) {
        try {
          // Extract JSON from output (PowerShell might output extra lines)
          const lines = output
            .trim()
            .split('\n')
            .filter((line) => line.trim());
          const jsonLine = lines.find((line) => line.trim().startsWith('{') || line.trim().startsWith('@{'));

          if (jsonLine) {
            const windowInfo = JSON.parse(jsonLine.trim());
            return jsonResponse(windowInfo);
          } else {
            console.error('No JSON found in PowerShell output for active window');
            return jsonResponse({ error: 'No JSON found in PowerShell output' }, 500);
          }
        } catch (parseError) {
          console.error('Failed to parse window info JSON:', parseError);
          return jsonResponse({ error: 'Failed to parse window info' }, 500);
        }
      } else {
        console.error('PowerShell execution failed for active window');
        return jsonResponse({ error: 'Failed to get active window' }, 500);
      }
    }
  }
  if (path === '/api/v1/windows/list') {
    if (method === 'GET') {
      // Obtener lista de todas las ventanas visibles usando PowerShell
      const powershellScript = `
        try {
          Add-Type @"
              using System;
              using System.Runtime.InteropServices;
              using System.Collections.Generic;

              public class WindowInfo {
                  public IntPtr HWnd { get; set; }
                  public string Title { get; set; }
                  public uint ProcessId { get; set; }
                  public string ProcessName { get; set; }
                  public string ExecutablePath { get; set; }
              }

              public class Win32 {
                  [DllImport("user32.dll")]
                  public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

                  [DllImport("user32.dll")]
                  public static extern int GetWindowText(IntPtr hWnd, string lpString, int nMaxCount);

                  [DllImport("user32.dll")]
                  public static extern bool IsWindowVisible(IntPtr hWnd);

                  [DllImport("user32.dll")]
                  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

                  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
              }
"@

            $windows = New-Object System.Collections.Generic.List[PSObject]

            $callback = {
              param($hwnd, $lParam)

              try {
                if ([Win32]::IsWindowVisible($hwnd)) {
                  $title = New-Object -TypeName "System.Text.StringBuilder" -ArgumentList 256
                  [Win32]::GetWindowText($hwnd, $title, $title.Capacity) | Out-Null

                  if ($title.Length -gt 0) {
                    $processId = 0
                    [Win32]::GetWindowThreadProcessId($hwnd, [ref]$processId)

                    $process = $null
                    try {
                      $process = Get-Process -Id $processId -ErrorAction Stop
                    } catch {
                      # Process might have ended, skip this window
                      return $true
                    }

                    $windows.Add(@{
                      hwnd = $hwnd.ToString()
                      title = $title.ToString()
                      processId = $processId
                      processName = $process.Name
                      executablePath = $process.Path
                    })
                  }
                }
              } catch {
                # Skip problematic windows
              }

              return $true
            }

            [Win32]::EnumWindows($callback, 0) | Out-Null

            # Return JSON array
            $windows | ConvertTo-Json -Compress
          } catch {
            @{ error = $_.Exception.Message } | ConvertTo-Json
          }
        `.trim();

      const proc = Bun.spawn({ windowsHide: true, 
        cmd: ['powershell.exe', '-Command', powershellScript],
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const output = await new Response(proc.stdout).text();
      const error = await new Response(proc.stderr).text();

      await proc.exited;

      if (proc.exitCode === 0 && output.trim()) {
        try {
          const windows = JSON.parse(output.trim());
          return jsonResponse(windows);
        } catch (parseError) {
          return jsonResponse({ error: 'Failed to parse windows list' }, 500);
        }
      } else {
        // Return mock data as fallback
        const mockWindows = [
          {
            hwnd: '12345678',
            title: 'Visual Studio Code',
            processId: 1234,
            processName: 'Code',
            executablePath: 'C:\\Users\\Mikel\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe',
          },
          {
            hwnd: '87654321',
            title: 'Google Chrome',
            processId: 5678,
            processName: 'chrome',
            executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          },
          {
            hwnd: '11223344',
            title: 'Bloc de notas',
            processId: 9999,
            processName: 'notepad',
            executablePath: 'C:\\Windows\\System32\\notepad.exe',
          },
        ];

        return jsonResponse(mockWindows);
      }
    }
  }

  if (path === '/api/v1/windows/watcher') {
    if (method === 'POST') {
      const body = await _req.json();
      const { action, rules, defaultProfileId } = body;

      // El listener profile-switch debe registrarse una sola vez (antes se
      // duplicaba en cada 'start' y el perfil cambiaba N veces).
      const ensureSwitchListener = () => {
        const w: any = services.windowWatcher;
        if (!w.__ldSwitchBound) {
          w.__ldSwitchBound = true;
          services.windowWatcher.on('profile-switch', (profileId: string, _window: any) => {
            // Update current profile in database and window watcher
            db.setCurrentProfile(profileId);
            services.windowWatcher.setCurrentProfile(profileId);
            services.wsManager?.broadcast('profile.navigate', { profileId }, 'profiles');
          });
        }
      };

      if (action === 'start' && rules) {
        services.windowWatcher.updateRules(rules);
        if (defaultProfileId !== undefined) services.windowWatcher.setDefaultProfile(defaultProfileId ?? null);

        // Connect window watcher events to WebSocket for profile switching
        ensureSwitchListener();

        services.windowWatcher.startWatching(rules);
        return jsonResponse({ status: 'started' });
      } else if (action === 'stop') {
        services.windowWatcher.stopWatching();
        return jsonResponse({ status: 'stopped' });
      } else if (action === 'update' && rules) {
        services.windowWatcher.updateRules(rules);
        if (defaultProfileId !== undefined) services.windowWatcher.setDefaultProfile(defaultProfileId ?? null);
        return jsonResponse({ status: 'updated' });
      }
    }

    if (method === 'GET') {
      return jsonResponse({
        isActive: services.windowWatcher.isActive(),
      });
    }
  }

  if (path === '/api/v1/system/metrics') {
    if (method === 'GET') {
      // Deduplicación: si hay caché fresca, servirla sin spawnear nada.
      if (metricsCache && Date.now() - metricsCache.ts < METRICS_TTL_MS) {
        return jsonResponse(metricsCache.data, metricsCache.status);
      }
      if (metricsInFlight) {
        try {
          const r = await metricsInFlight;
          return jsonResponse(r.data, r.status);
        } catch {
          // cae al recolector de abajo
        }
      }
      const collect = (async (): Promise<{ data: any; status: number }> => {
      try {
        // Linux/macOS: recolector nativo (el .ps1 es solo Windows).
        if (process.platform !== 'win32') {
          const native = await collectNativeUnixMetrics();
          // Enriquecer con LHM Remote Web Server si el usuario lo tiene
          // (http://localhost:8085/data.json) — igual que el plugin LHM de Macro-Deck.
          const enriched = await enrichWithLhmRemote(native);
          return { data: enriched, status: 200 };
        }
        const powershellScript = getSystemMetricsScript();

        const proc = Bun.spawn({ windowsHide: true,
          cmd: ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', powershellScript],
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        // Set a timeout for the PowerShell execution
        const timeout = setTimeout(() => {
          proc.kill();
        }, 10000); // 10 second timeout

        const output = await new Response(proc.stdout).text();
        const error = await new Response(proc.stderr).text();

        await proc.exited;
        clearTimeout(timeout);

        if (proc.exitCode === 0 && output.trim()) {
          try {
            const metrics = JSON.parse(output.trim());

            // El script ya devuelve nulls honestos cuando no hay sensor;
            // nunca inventar datos aleatorios (antes se devolvía mock).
            if (metrics.error && metrics.cpu?.usage == null && metrics.ram?.usage == null) {
              return {
                data: { ...honestDegraded('No se pudieron leer métricas del sistema: ' + String(metrics.error).slice(0, 200)) },
                status: 503,
              };
            }

            const enriched = await enrichWithLhmRemote(metrics);
            return { data: enriched, status: 200 };
          } catch (parseError) {
            return { data: { error: 'Failed to parse system metrics' }, status: 500 };
          }
        } else {
          // Fallo de PowerShell: degradado honesto, sin datos inventados.
          return { data: { ...honestDegraded('PowerShell no devolvió métricas' + (error ? ': ' + String(error).slice(0, 200) : '')) }, status: 503 };
        }
      } catch (error) {
        return { data: { ...honestDegraded(String((error as Error)?.message ?? error).slice(0, 200)) }, status: 503 };
      }
      })();
      metricsInFlight = collect;
      try {
        const result = await collect;
        // Solo cachear éxitos (200): los 503 con nulls no deben congelarse 3s.
        if (result.status === 200) metricsCache = { ts: Date.now(), data: result.data, status: result.status };
        return jsonResponse(result.data, result.status);
      } finally {
        if (metricsInFlight === collect) metricsInFlight = null;
      }
    }
  }

  // Version endpoint (solo lectura). Fuente única: root package.json
  // (incrustado en el binario en build) con override LIBREDECK_VERSION.
  if (path === '/api/v1/version') {
    if (method === 'GET') {
      return jsonResponse({
        version: getVersion(),
        channel: 'stable',
        buildDate: new Date().toISOString(),
      });
    }
  }

  // Preparación para update gestionado (launcher): best-effort, siempre ok.
  // Hoy: WAL checkpoint para que el backup sea consistente; el apagado
  // ordenado lo hace POST /api/v1/admin/shutdown.
  if (path === '/api/v1/admin/prepare-update') {
    if (method === 'POST') {
      try {
        (db as unknown as { checkpoint?: () => void })?.checkpoint?.();
      } catch {
        // best-effort: no bloquear el update por esto
      }
      return jsonResponse({ ok: true });
    }
  }

  // Deprecated: update flow moved to the launcher (ver UPDATE_SYSTEM.md).
  // Kept as 501 so old clients fail loudly instead of hanging.
  if (path === '/api/v1/version/check') {
    if (method === 'GET') {
      return jsonResponse(
        { error: 'Gone', message: 'Version check is managed by the launcher updater, not the daemon API.' },
        501
      );
    }
  }

  // StreamDeck devices endpoints
  if (path === '/api/v1/devices/streamdeck') {
    if (method === 'GET') {
      try {
        const devices = await streamDeckDriver.listDevices();
        return jsonResponse(devices);
      } catch (error) {
        console.error('Failed to list StreamDeck devices:', error);
        return jsonResponse({ error: 'Failed to list StreamDeck devices' }, 500);
      }
    }
  }

  // IPs LAN del host (el QR del panel necesita la IP LAN, no localhost,
  // y el WebRTC del navegador ya no la expone: Chrome devuelve .local por privacidad)
  if (path === '/api/v1/network/ips') {
    if (method === 'GET') {
      try {
        const { networkInterfaces } = await import('os');
        const nets = networkInterfaces();
        const ips: string[] = [];
        for (const addrs of Object.values(nets)) {
          for (const a of addrs || []) {
            if (a.family === 'IPv4' && !a.internal) ips.push(a.address);
          }
        }
        return jsonResponse({ ips });
      } catch (error) {
        console.error('Failed to list network interfaces:', error);
        return jsonResponse({ error: 'Failed to list network interfaces' }, 500);
      }
    }
  }

  if (path === '/api/v1/devices/streamdeck/connect') {
    if (method === 'POST') {
      try {
        const body = await _req.json();
        const { devicePath } = body;

        const success = await streamDeckDriver.connect(devicePath);

        if (success) {
          console.log('🎛️ StreamDeck connected successfully, restoring hardware session...');

          // El driver restaura su propia sesión (device_sessions) al conectar.
          // Solo como fallback (sesión vacía) se usa la vista global.
          const view = streamDeckDriver.getSessionView();
          console.log('🎛️ Hardware session view:', view);

          if (!view.pageId) {
            const currentProfile = db.getCurrentProfile();
            console.log('🎛️ Current profile (fallback):', currentProfile);

            if (currentProfile) {
              const currentPage = db.getCurrentPage(currentProfile.id);
              console.log('🎛️ Current page (fallback):', currentPage);

              if (currentPage) {
                console.log('🎛️ Updating StreamDeck with fallback page:', currentPage.id);
                await streamDeckDriver.updateFromPage(currentPage.id);
              } else {
                console.log('🎛️ No current page found');
              }
            } else {
              console.log('🎛️ No current profile found');
            }
          }
        }

        return jsonResponse({ success, connectedDevice: streamDeckDriver.getConnectedDevice() });
      } catch (error) {
        console.error('Failed to connect to StreamDeck:', error);
        return jsonResponse({ error: 'Failed to connect to StreamDeck' }, 500);
      }
    }
  }

  if (path === '/api/v1/devices/streamdeck/disconnect') {
    if (method === 'POST') {
      try {
        await streamDeckDriver.disconnect();
        return jsonResponse({ success: true });
      } catch (error) {
        console.error('Failed to disconnect StreamDeck:', error);
        return jsonResponse({ error: 'Failed to disconnect StreamDeck' }, 500);
      }
    }
  }

  if (path === '/api/v1/devices/streamdeck/status') {
    if (method === 'GET') {
      const grid = streamDeckDriver.getGridGeometry();
      const { guessDeckModel } = await import('../devices');
      let conflictProcesses: Array<{ name: string; pid: number | null }> = [];
      try {
        conflictProcesses = await getConflictProcessesCached();
      } catch {
        conflictProcesses = [];
      }
      // Heurístico HID: la app oficial suele dejar el HID ocupado aunque el
      // proceso ya muriera (o al revés). Si no estamos conectados y el HID
      // no lista nada, se marca como pista adicional — nunca como prueba.
      let hidBusyHint = false;
      try {
        if (!streamDeckDriver.isConnected()) {
          const devs = await streamDeckDriver.listDevices();
          hidBusyHint = devs.length === 0;
        }
      } catch {
        hidBusyHint = false;
      }
      const detected = conflictProcesses.length > 0;
      return jsonResponse({
        isConnected: streamDeckDriver.isConnected(),
        connectedDevice: streamDeckDriver.getConnectedDevice(),
        keyCount: streamDeckDriver.getKeyCount(),
        grid,
        modelGuess: guessDeckModel(grid),
        conflict: {
          detected,
          processes: conflictProcesses,
          hidBusyHint,
          reason: detected ? (hidBusyHint ? 'both' : 'process') : hidBusyHint ? 'hid-busy' : 'none',
        },
      });
    }
  }

  // Cierra la app oficial de Elgato (solo allowlist interna, nunca PIDs
  // arbitrarios desde el cliente). La UI lo usa desde el diálogo bloqueante.
  if (path === '/api/v1/devices/streamdeck/close-official') {
    if (method === 'POST') {
      try {
        const { closed, remaining } = await closeConflictProcesses();
        return jsonResponse({ closed, remaining, detected: remaining.length > 0 });
      } catch (error) {
        console.error('Failed to close official StreamDeck app:', error);
        return jsonResponse({ error: 'Failed to close official StreamDeck app' }, 500);
      }
    }
  }

  if (path === '/api/v1/devices/streamdeck/test') {
    if (method === 'POST') {
      try {
        await streamDeckDriver.testStreamDeck();
        return jsonResponse({ success: true });
      } catch (error) {
        console.error('Failed to test StreamDeck:', error);
        return jsonResponse({ error: 'Failed to test StreamDeck' }, 500);
      }
    }
  }

  if (path === '/api/v1/devices/streamdeck/update-buttons') {
    if (method === 'POST') {
      try {
        const { buttonStates, pageId } = ((await _req.json()) as any) ?? {};

        console.log('🎛️ Received button states for update:', buttonStates);

        // No bloquear: el repintado completo va en segundo plano.
        // La sesión propia del HW manda: el editor no puede cambiar la vista
        // del deck físico empujando su pageId (esa era la vía por la que
        // navegar en el navegador movía el Stream Deck). Si piden otra
        // página distinta de la sesión, se refresca la sesión actual.
        const { DatabaseService: DB } = await import('../db');
        let sessionPage: string | null = null;
        try {
          sessionPage = streamDeckDriver.getSessionView().pageId;
        } catch { sessionPage = null; }
        if (sessionPage && pageId && pageId !== sessionPage) {
          console.log(`🎛️ Ignorando pageId del editor (${pageId}): el HW muestra su sesión (${sessionPage})`);
        }
        const target = sessionPage ?? pageId ?? new DB().getSetting('current.page_id');
        if (streamDeckDriver.isConnected() && target && target !== 'null' && target !== '') {
          streamDeckDriver.scheduleUpdateFromPage(target);
        } else if (streamDeckDriver.isConnected()) {
          // Sin página conocida, delegar al path legacy en background.
          streamDeckDriver.updateButtons(buttonStates, pageId).catch((e) =>
            console.error('Failed to update StreamDeck buttons:', e)
          );
        }
        return jsonResponse({ success: true, scheduled: true });
      } catch (error) {
        console.error('Failed to update StreamDeck buttons:', error);
        return jsonResponse({ error: 'Failed to update StreamDeck buttons' }, 500);
      }
    }
  }

  return null;
};
