/**
 * Rutas de sistema: test, /config, assets, logs, settings, windows,
 * system/metrics, version (+check 501), devices/streamdeck y network/ips.
 */
import { getSystemMetricsScript } from '../scripts/system-metrics.ps1';
import { streamDeckDriver } from '../hw-driver/streamdeck-driver';
import { getVersion } from '../version';
import { jsonResponse } from './http-helpers';
import type { ApiHandler } from './types';

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

  // Assets endpoints
  if (path === '/api/v1/assets') {
    if (method === 'POST') {
      // TODO: Implement file upload
      return jsonResponse({ error: 'Asset upload not implemented yet' }, 501);
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

      const proc = Bun.spawn({
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

      const proc = Bun.spawn({
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
      try {
        const powershellScript = getSystemMetricsScript();

        const proc = Bun.spawn({
          cmd: ['powershell.exe', '-Command', powershellScript],
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

            // Check if we got an error response
            if (metrics.error) {
              // Return mock data as fallback
              const mockMetrics = {
                cpu: {
                  usage: Math.random() * 100,
                  temperature: 45 + Math.random() * 30,
                },
                ram: {
                  total: 16,
                  used: 8 + Math.random() * 8,
                  usage: Math.random() * 100,
                },
                gpu: {
                  usage: Math.random() * 100,
                  temperature: 40 + Math.random() * 20,
                },
                timestamp: new Date().toISOString(),
              };

              return jsonResponse(mockMetrics);
            }

            return jsonResponse(metrics);
          } catch (parseError) {
            return jsonResponse({ error: 'Failed to parse system metrics' }, 500);
          }
        } else {
          // Return mock data as fallback
          const mockMetrics = {
            cpu: {
              usage: Math.random() * 100,
              temperature: 45 + Math.random() * 30,
            },
            ram: {
              total: 16,
              used: 8 + Math.random() * 8,
              usage: Math.random() * 100,
            },
            gpu: {
              usage: Math.random() * 100,
              temperature: 40 + Math.random() * 20,
            },
            timestamp: new Date().toISOString(),
          };

          return jsonResponse(mockMetrics);
        }
      } catch (error) {
        // Final fallback to mock data
        const mockMetrics = {
          cpu: {
            usage: Math.random() * 100,
            temperature: 45 + Math.random() * 30,
          },
          ram: {
            total: 16,
            used: 8 + Math.random() * 8,
            usage: Math.random() * 100,
          },
          gpu: {
            usage: Math.random() * 100,
            temperature: 40 + Math.random() * 20,
          },
          timestamp: new Date().toISOString(),
        };

        return jsonResponse(mockMetrics);
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
          console.log('🎛️ StreamDeck connected successfully, checking for current page...');

          // Update with current page if available (initializeButtons is already called in connect())
          const currentProfile = db.getCurrentProfile();
          console.log('🎛️ Current profile:', currentProfile);

          if (currentProfile) {
            const currentPage = db.getCurrentPage(currentProfile.id);
            console.log('🎛️ Current page:', currentPage);

            if (currentPage) {
              console.log('🎛️ Updating StreamDeck with current page:', currentPage.id);
              await streamDeckDriver.updateFromPage(currentPage.id);
            } else {
              console.log('🎛️ No current page found');
            }
          } else {
            console.log('🎛️ No current profile found');
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
      return jsonResponse({
        isConnected: streamDeckDriver.isConnected(),
        connectedDevice: streamDeckDriver.getConnectedDevice(),
        keyCount: streamDeckDriver.getKeyCount(),
        grid: streamDeckDriver.getGridGeometry(),
      });
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
        // pageId manda; si no viene, el driver usa current.page_id.
        const { DatabaseService: DB } = await import('../db');
        const target = pageId ?? new DB().getSetting('current.page_id');
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
