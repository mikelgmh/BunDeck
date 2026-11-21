#!/usr/bin/env bun

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { spawn as bunSpawn, SpawnOptions } from 'bun';
import { spawn as nodeSpawn } from 'node:child_process';
import {
  buildApiBase,
  buildWsUrl,
  daemonLogPath,
  normalizePort,
  parseHealth,
  pickLatestDaemonExe,
  pidFilePath,
  resolveDataDir,
  DEFAULT_API_PORT,
  DEFAULT_WS_PORT,
} from './cli-utils';

const program = new Command();

// Opciones globales: el puerto API se propaga a todos los comandos.
program
  .option('-p, --port <port>', 'Puerto para la API HTTP', String(DEFAULT_API_PORT))
  .option('-w, --ws-port <port>', 'Puerto para WebSocket', String(DEFAULT_WS_PORT))
  .option('--data-dir <dir>', 'Directorio de datos (por defecto: resolución automática)')
  .option('-v, --verbose', 'Salida detallada de diagnóstico');

const DAEMON_PATH = '../daemon';
const DATA_PATH = '../data';
const SHUTDOWN_ENDPOINT = '/api/v1/admin/shutdown';

// Utilidades
const verboseLog = (...args: any[]) => {
  try {
    if (program.opts().verbose) console.log(chalk.gray('[verbose]'), ...args);
  } catch {
    // program.opts() puede fallar antes del parse; ignorar
  }
};

const getDataDir = (cmdOptions?: { dataDir?: string }): string => {
  const globalDataDir = (() => {
    try {
      return program.opts().dataDir as string | undefined;
    } catch {
      return undefined;
    }
  })();
  const chosen = cmdOptions?.dataDir ?? globalDataDir;
  if (chosen) return chosen;
  return process.env.LIBREDECK_DATA_DIR || resolveDataDir();
};

const getApiBase = (cmdOptions?: { port?: string | number }): string => {
  const globalPort = (() => {
    try {
      return program.opts().port as string | undefined;
    } catch {
      return undefined;
    }
  })();
  // El --port del comando tiene prioridad; si no, el global; si no, 3001.
  const port = cmdOptions?.port ?? globalPort ?? DEFAULT_API_PORT;
  return buildApiBase(port);
};

const getWsUrl = (cmdOptions?: { wsPort?: string | number }): string => {
  const globalWs = (() => {
    try {
      return program.opts().wsPort as string | undefined;
    } catch {
      return undefined;
    }
  })();
  const port = cmdOptions?.wsPort ?? globalWs ?? DEFAULT_WS_PORT;
  return buildWsUrl(port);
};

const apiRequest = async (endpoint: string, options: RequestInit = {}, cmdOptions?: { port?: string | number }) => {
  const base = getApiBase(cmdOptions);
  try {
    const response = await fetch(`${base}${endpoint}`, {
      headers: {
        'Content-Type': 'application/json',
        ...options.headers
      },
      ...options
    });

    if (!response.ok) {
      throw new Error(`API Error: ${response.status} ${response.statusText}`);
    }

    return await response.json();
  } catch (error) {
    throw new Error(`Failed to connect to LibreDeck daemon. Is it running?`);
  }
};

const runCommand = async (command: string, args: string[] = [], options: SpawnOptions = {}): Promise<number> => {
  const proc = bunSpawn({
    cmd: [command, ...args],
    stdio: ['inherit', 'inherit', 'inherit'],
    ...options
  });

  await proc.exited;
  return proc.exitCode || 0;
};

const isProcessRunning = async (port: number, cmdOptions?: { port?: string | number }): Promise<boolean> => {
  try {
    verboseLog(`Checking if daemon is running on port ${port}...`);
    const base = getApiBase(cmdOptions ?? { port });
    const response = await fetch(`${base}/health`);
    verboseLog(`Health check response status: ${response.status}`);
    return response.ok;
  } catch (error) {
    verboseLog(`Health check failed: ${(error as Error).message}`);
    return false;
  }
};

/** Health-check con reintentos (sustituye los `sleep` fijos). */
const waitForHealthy = async (
  port: number,
  cmdOptions?: { port?: string | number },
  timeoutMs = 30000,
  intervalMs = 1000,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await isProcessRunning(port, cmdOptions)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
};

/** Espera a que el daemon DEJE de responder (útil tras shutdown). */
const waitForStopped = async (
  port: number,
  cmdOptions?: { port?: string | number },
  timeoutMs = 15000,
  intervalMs = 500,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!(await isProcessRunning(port, cmdOptions))) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
};

// Función para obtener el exe del daemon con la versión más alta
const getLatestDaemonExe = async (): Promise<string | null> => {
  const fs = await import('fs');
  const path = await import('path');
  const currentDir = path.dirname(process.execPath);

  verboseLog('Searching for daemon exe in dir:', currentDir);

  try {
    const files = fs.readdirSync(currentDir);
    verboseLog('All files in dir:', files);

    const selected = pickLatestDaemonExe(files);
    verboseLog('Selected exe:', selected);

    if (!selected) return null;
    return path.join(currentDir, selected);
  } catch (error) {
    verboseLog('Error finding latest daemon exe:', error);
    return null;
  }
};

const readPidFile = async (pidFile: string): Promise<number | null> => {
  try {
    const raw = (await Bun.file(pidFile).text()).trim();
    const pid = Number(raw);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return pid;
  } catch {
    return null;
  }
};

const removePidFile = async (pidFile: string): Promise<void> => {
  try {
    const fs = await import('fs');
    if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
  } catch {
    // best effort
  }
};

const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Mata por PID de forma dirigida (sin /IM a ciegas en Windows). */
const killByPid = async (pid: number): Promise<boolean> => {
  try {
    if (process.platform === 'win32') {
      // Primero intento graceful, luego forzado solo sobre ese PID.
      let code = await runCommand('taskkill', ['/PID', String(pid)]);
      if (code !== 0 || isPidAlive(pid)) {
        await new Promise((r) => setTimeout(r, 1000));
        if (isPidAlive(pid)) {
          code = await runCommand('taskkill', ['/F', '/PID', String(pid)]);
        }
      }
      await new Promise((r) => setTimeout(r, 500));
      return !isPidAlive(pid);
    }
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      return false;
    }
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (!isPidAlive(pid)) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      return false;
    }
    await new Promise((r) => setTimeout(r, 500));
    return !isPidAlive(pid);
  } catch {
    return false;
  }
};

// Comandos principales

// Start daemon
program
  .command('start')
  .description('Iniciar el daemon de LibreDeck')
  .option('-p, --port <port>', 'Puerto para la API HTTP', String(DEFAULT_API_PORT))
  .option('-w, --ws-port <port>', 'Puerto para WebSocket', String(DEFAULT_WS_PORT))
  .option('-d, --detach', 'Ejecutar en segundo plano')
  .option('--data-dir <dir>', 'Directorio de datos (pidfile y logs)')
  .option('--health-timeout <ms>', 'Timeout del health-check en ms', '30000')
  .action(async (options) => {
    const apiPort = normalizePort(options.port ?? program.opts().port, DEFAULT_API_PORT);
    const wsPort = normalizePort(options.wsPort ?? program.opts().wsPort, DEFAULT_WS_PORT);
    const dataDir = getDataDir(options);
    const healthTimeout = normalizePort(options.healthTimeout, 30000);

    // Verificar si ya está ejecutándose
    const isRunning = await isProcessRunning(apiPort, { port: apiPort });
    if (isRunning) {
      console.log(chalk.yellow('El daemon ya está ejecutándose'));
      return;
    }

    // Obtener el exe del daemon con la versión más alta
    const daemonExe = await getLatestDaemonExe();
    if (!daemonExe) {
      console.error(chalk.red('No se encontró el ejecutable del daemon'));
      process.exit(1);
    }

    console.log(chalk.blue(`🚀 Ejecutando daemon: ${daemonExe}`));

    // Configurar variables de entorno
    const env = {
      ...process.env,
      PORT: String(apiPort),
      WS_PORT: String(wsPort)
    };

    if (options.detach) {
      // Detached: spawn desacoplado + pidfile + logs a data/logs/daemon.log.
      // Se usa spawn detached multiplataforma (sin `cmd /c start /B` huérfano).
      const spinner = ora('Iniciando LibreDeck daemon (detached)...').start();
      try {
        const fs = await import('fs');
        const path = await import('path');
        fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
        const logPath = daemonLogPath(dataDir);
        const logFd = fs.openSync(logPath, 'a');

        const child = nodeSpawn(daemonExe, [], {
          detached: true,
          stdio: ['ignore', logFd, logFd],
          env,
          cwd: process.cwd(),
          windowsHide: true,
        });
        child.unref();
        // El hijo hereda su propio fd; cerramos el nuestro.
        try {
          fs.closeSync(logFd);
        } catch { /* noop */ }

        if (child.pid) {
          await Bun.write(pidFilePath(dataDir), String(child.pid));
          verboseLog(`PID ${child.pid} escrito en ${pidFilePath(dataDir)}, logs en ${logPath}`);
        }

        const isNowRunning = await waitForHealthy(apiPort, { port: apiPort }, healthTimeout);
        if (isNowRunning) {
          spinner.succeed(`LibreDeck daemon iniciado en http://localhost:${apiPort} (pidfile: ${pidFilePath(dataDir)})`);
        } else {
          spinner.fail('Error al iniciar el daemon - no responde al health check');
          console.log(`El daemon puede estar ejecutándose pero no responde. Revisa los logs en ${logPath}.`);
          process.exit(1);
        }
      } catch (error) {
        ora().fail(`Error al iniciar daemon: ${error}`);
        process.exit(1);
      }
    } else {
      // Foreground REAL: proceso atado a la terminal, stdio heredado, Ctrl+C limpio.
      console.log(chalk.green(`LibreDeck daemon en primer plano en http://localhost:${apiPort} (Ctrl+C para detener)`));
      const proc = bunSpawn({
        cmd: [daemonExe],
        env,
        stdio: ['inherit', 'inherit', 'inherit'],
        cwd: process.cwd(),
      });
      const onSigint = () => {
        try {
          proc.kill();
        } catch { /* noop */ }
      };
      process.on('SIGINT', onSigint);
      process.on('SIGTERM', onSigint);
      await proc.exited;
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigint);
      const code = proc.exitCode ?? 0;
      console.log(chalk.gray(`Daemon terminado (exit code ${code})`));
      process.exit(code);
    }
  });

// Stop daemon
program
  .command('stop')
  .description('Detener el daemon de LibreDeck')
  .option('--data-dir <dir>', 'Directorio de datos (donde está el pidfile)')
  .action(async (options) => {
    const spinner = ora('Deteniendo daemon...').start();
    const apiPort = normalizePort(program.opts().port, DEFAULT_API_PORT);
    const cmdOpts = { port: apiPort };
    const dataDir = getDataDir(options);
    const pidFile = pidFilePath(dataDir);

    try {
      // 1) Vía API (endpoint real)
      await apiRequest(SHUTDOWN_ENDPOINT, { method: 'POST' }, cmdOpts);
      const stopped = await waitForStopped(apiPort, cmdOpts, 15000);
      await removePidFile(pidFile);
      if (stopped) {
        spinner.succeed('Daemon detenido correctamente');
      } else {
        spinner.succeed('Shutdown aceptado por la API (el proceso puede tardar unos segundos en salir)');
      }
      return;
    } catch (error) {
      verboseLog('API shutdown failed, trying PID file...', error);
    }

    // 2) Fallback: pidfile (matado dirigido por PID, sin /IM a ciegas)
    const pid = await readPidFile(pidFile);
    if (pid !== null) {
      if (!isPidAlive(pid)) {
        await removePidFile(pidFile);
        spinner.succeed(`No hay proceso vivo con PID ${pid}; pidfile limpiado`);
        return;
      }
      const killed = await killByPid(pid);
      if (killed) {
        await removePidFile(pidFile);
        spinner.succeed(`Daemon detenido (PID ${pid})`);
        return;
      }
      spinner.fail(`No se pudo detener el proceso con PID ${pid}`);
      process.exit(1);
    }

    // 3) Último recurso: matar por nombre como antes
    try {
      if (process.platform === 'win32') {
        await runCommand('taskkill', ['/F', '/IM', 'libredeck-daemon.exe']);
        await runCommand('taskkill', ['/F', '/IM', 'libredeck-daemon*.exe']);
      } else {
        await runCommand('pkill', ['-f', 'libredeck-daemon']);
      }
      spinner.succeed('Daemon detenido por fuerza');
    } catch (killError) {
      verboseLog('Process kill failed:', killError);
      spinner.fail('No se pudo detener el daemon');
      process.exit(1);
    }
  });

// Status
program
  .command('status')
  .description('Mostrar el estado del daemon')
  .action(async () => {
    const spinner = ora('Verificando estado...').start();

    try {
      const apiPort = normalizePort(program.opts().port, DEFAULT_API_PORT);
      const wsPortOpt = (() => {
        try {
          return program.opts().wsPort as string | undefined;
        } catch {
          return undefined;
        }
      })();
      const health = await apiRequest('/health', {}, { port: apiPort });
      const parsed = parseHealth(health);
      spinner.succeed('Daemon ejecutándose correctamente');

      const wsPort = parsed.wsPort ?? normalizePort(wsPortOpt, DEFAULT_WS_PORT);
      console.log(chalk.green('✓ Estado: Online'));
      console.log(chalk.blue(`📡 API: http://localhost:${apiPort}`));
      console.log(chalk.blue(`🔌 WebSocket: ${buildWsUrl(wsPort)}`));
      if (parsed.version) {
        console.log(chalk.gray(`🏷️ Versión: ${parsed.version}`));
      }
      if (parsed.timestamp) {
        console.log(chalk.gray(`🕒 Uptime: ${new Date(parsed.timestamp).toLocaleString()}`));
      }

      if (typeof parsed.wsClients === 'number') {
        console.log(chalk.blue(`👥 Clientes conectados: ${parsed.wsClients}`));
      }
    } catch (error) {
      spinner.fail('Daemon no disponible');
      console.log(chalk.red('✗ Estado: Offline'));
    }
  });

// Plugin management
const pluginCommand = program.command('plugin');

pluginCommand
  .command('list')
  .description('Listar plugins instalados')
  .action(async () => {
    try {
      const data = await apiRequest('/plugins');

      console.log(chalk.bold('\n📦 Plugins Instalados:'));

      if (data.installed && data.installed.length > 0) {
        data.installed.forEach((plugin: any) => {
          const status = plugin.enabled ? chalk.green('●') : chalk.red('○');
          console.log(`${status} ${plugin.name} v${plugin.version}`);
        });
      } else {
        console.log(chalk.gray('No hay plugins instalados'));
      }

      console.log(chalk.bold('\n🔧 Plugins Cargados:'));

      if (data.loaded && data.loaded.length > 0) {
        data.loaded.forEach((plugin: any) => {
          console.log(`${chalk.green('●')} ${plugin.manifest.name}`);
        });
      } else {
        console.log(chalk.gray('No hay plugins cargados'));
      }
    } catch (error) {
      console.error(chalk.red(`Error: ${error}`));
    }
  });

pluginCommand
  .command('install <path>')
  .description('Instalar un plugin desde archivo ZIP o carpeta')
  .action(async (pluginPath: string) => {
    const spinner = ora(`Instalando plugin desde ${pluginPath}...`).start();

    try {
      // TODO: Implementar instalación de plugins
      spinner.fail('Instalación de plugins no implementada aún');
    } catch (error) {
      spinner.fail(`Error instalando plugin: ${error}`);
    }
  });

// Profile management
const profileCommand = program.command('profile');

profileCommand
  .command('list')
  .description('Listar perfiles')
  .action(async () => {
    try {
      const profiles = await apiRequest('/profiles');

      console.log(chalk.bold('\n👤 Perfiles:'));

      if (profiles.length > 0) {
        profiles.forEach((profile: any) => {
          console.log(`• ${profile.name} (${profile.id})`);
          console.log(`  Creado: ${new Date(profile.created_at).toLocaleString()}`);
        });
      } else {
        console.log(chalk.gray('No hay perfiles creados'));
      }
    } catch (error) {
      console.error(chalk.red(`Error: ${error}`));
    }
  });

profileCommand
  .command('create <name>')
  .description('Crear un nuevo perfil')
  .action(async (name: string) => {
    const spinner = ora(`Creando perfil "${name}"...`).start();

    try {
      const profile = await apiRequest('/profiles', {
        method: 'POST',
        body: JSON.stringify({ name })
      });

      spinner.succeed(`Perfil "${name}" creado con ID: ${profile.id}`);
    } catch (error) {
      spinner.fail(`Error creando perfil: ${error}`);
    }
  });

profileCommand
  .command('export <profileId>')
  .description('Exportar perfil a JSON')
  .option('-o, --output <file>', 'Archivo de salida', `profile-${Date.now()}.json`)
  .action(async (profileId: string, options) => {
    const spinner = ora('Exportando perfil...').start();

    try {
      const profile = await apiRequest(`/profiles/${profileId}`);

      // También obtener páginas y botones
      const pages = await apiRequest(`/pages?profileId=${profileId}`);
      const exportData = { profile, pages };

      for (const page of pages) {
        const buttons = await apiRequest(`/buttons?pageId=${page.id}`);
        page.buttons = buttons;
      }

      await Bun.write(options.output, JSON.stringify(exportData, null, 2));
      spinner.succeed(`Perfil exportado a ${options.output}`);
    } catch (error) {
      spinner.fail(`Error exportando perfil: ${error}`);
    }
  });

// Logs
program
  .command('logs')
  .description('Mostrar logs del daemon')
  .option('-f, --follow', 'Seguir logs en tiempo real')
  .option('-l, --level <level>', 'Filtrar por nivel (info, warn, error)')
  .option('-n, --lines <number>', 'Número de líneas', '50')
  .action(async (options) => {
    try {
      const params = new URLSearchParams();
      if (options.level) params.set('level', options.level);
      if (options.lines) params.set('limit', options.lines);

      const logs = await apiRequest(`/logs?${params.toString()}`);

      console.log(chalk.bold('📋 Logs de LibreDeck:\n'));

      logs.forEach((log: any) => {
        const time = new Date(log.ts).toLocaleTimeString();
        let levelColor = chalk.white;

        switch (log.level) {
          case 'error': levelColor = chalk.red; break;
          case 'warn': levelColor = chalk.yellow; break;
          case 'info': levelColor = chalk.blue; break;
        }

        console.log(`${chalk.gray(time)} ${levelColor(log.level.toUpperCase())} ${log.message}`);
      });

      if (options.follow) {
        console.log(chalk.gray('\nSiguiendo logs... (Ctrl+C para salir)'));
        // TODO: Implementar seguimiento en tiempo real vía WebSocket
      }
    } catch (error) {
      console.error(chalk.red(`Error: ${error}`));
    }
  });

// Update
program
  .command('update')
  .description('Check for updates and update LibreDeck daemon')
  .action(async () => {
    const spinner = ora('Checking for updates...').start();

    try {
      const currentVersion = require('../../package.json').version;
      const response = await fetch('https://api.github.com/repos/mikelgmh/libredeck/releases/latest');

      if (!response.ok) {
        throw new Error('Failed to fetch latest release');
      }

      const release = await response.json();
      const latestVersion = release.tag_name.replace('v', '');

      if (latestVersion > currentVersion) {
        spinner.text = `Updating daemon to v${latestVersion}...`;

        // Find assets for daemon on current platform
        const platform = process.platform;
        const arch = process.arch;
        const platformName = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'darwin' : 'linux';
        const assetExt = platform === 'win32' ? '.exe' : '';

        console.log(`Current version: ${currentVersion}, Latest version: ${latestVersion}`);
        console.log(`Platform: ${process.platform}, Arch: ${process.arch}`);
        console.log('Available assets:', release.assets.map((a: any) => a.name));

        const asset = release.assets.find((a: any) => {
          const isDaemon = a.name.includes('libredeck-daemon');
          const isX64 = a.name.includes('x64');
          const hasExe = a.name.endsWith('.exe');
          return isDaemon && isX64 && hasExe;
        });

        console.log('Found asset:', asset ? asset.name : 'NONE');

        if (!asset) {
          throw new Error(`No daemon asset found for ${platformName}-${arch}`);
        }

        // Download to a versioned file
        const downloadResponse = await fetch(asset.browser_download_url);
        const buffer = await downloadResponse.arrayBuffer();

        const fs = await import('fs');
        const path = await import('path');
        const currentDir = path.dirname(process.execPath);

        // Extract version from asset name (e.g., libredeck-daemon-v1.3.0-windows-x64.exe -> v1.3.0)
        const versionMatch = asset.name.match(/libredeck-daemon-v([0-9]+\.[0-9]+\.[0-9]+)/);
        const assetVersion = versionMatch ? versionMatch[1] : latestVersion;

        const newDaemonPath = path.join(currentDir, `libredeck-daemon-v${assetVersion}${assetExt}`);

        // Write new daemon executable
        fs.writeFileSync(newDaemonPath, Buffer.from(buffer));

        spinner.succeed(`Downloaded daemon v${latestVersion}!`);

        // The update will be applied on next restart
        spinner.succeed(`Daemon updated to v${latestVersion}! The update will be applied when you restart the application.`);
      } else {
        spinner.succeed('LibreDeck is up to date');
      }
    } catch (error) {
      spinner.fail(`Update failed: ${error}`);
      process.exit(1);
    }
  });

// Development tools
const devCommand = program.command('dev');

devCommand
  .command('create-plugin <pluginId>')
  .description('Crear scaffold de plugin')
  .action(async (pluginId: string) => {
    const spinner = ora(`Creando plugin ${pluginId}...`).start();

    try {
      const pluginDir = `${DATA_PATH}/plugins/${pluginId}`;

      // Crear directorio
      await runCommand('mkdir', ['-p', pluginDir]);

      // Crear manifest.json
      const manifest = {
        id: pluginId,
        name: pluginId,
        version: '0.1.0',
        permissions: ['emitEvent'],
        actions: [
          {
            id: 'hello',
            name: 'Saludar',
            schema: {
              type: 'object',
              properties: {
                message: { type: 'string', default: 'Hola!' }
              }
            }
          }
        ]
      };

      await Bun.write(`${pluginDir}/manifest.json`, JSON.stringify(manifest, null, 2));

      // Crear main.js
      const mainJs = `// ${pluginId} Plugin
export function register(api) {
  console.log('Plugin ${pluginId} loaded');
  
  api.onAction('hello', async ({ args }) => {
    const message = args.message || 'Hola desde ${pluginId}!';
    api.emitEvent('log', { message });
    return { success: true, message };
  });
}

export function unload() {
  console.log('Plugin ${pluginId} unloaded');
}
`;

      await Bun.write(`${pluginDir}/main.js`, mainJs);

      // Crear README
      const readme = `# ${pluginId} Plugin

Descripción del plugin.

## Instalación

\`\`\`bash
sdctl plugin install ${pluginDir}
\`\`\`

## Uso

Este plugin añade las siguientes acciones:

- **hello**: Muestra un saludo
`;

      await Bun.write(`${pluginDir}/README.md`, readme);

      spinner.succeed(`Plugin ${pluginId} creado en ${pluginDir}`);
    } catch (error) {
      spinner.fail(`Error creando plugin: ${error}`);
    }
  });

// Main CLI setup
program
  .name('libredeck-cli')
  .description('LibreDeck CLI - Herramientas de línea de comandos para LibreDeck')
  .version('0.1.0');

// Parse command line arguments
program.parse(process.argv);

// Si no se proporciona comando, mostrar ayuda
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
