#!/usr/bin/env bun
// cli.ts — Solo definición de comandos. La lógica vive en:
//   client.ts  (DaemonClient: apiRequest, health, waitForHealthy/Stopped, plugin install/upload)
//   process.ts (getLatestDaemonExe, pidfile, killByPid, spawn detached/foreground)
//   cli-utils.ts (puertos por defecto, resolveDataDir, parseHealth, pid/log paths)

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import {
  apiRequest,
  discoverWsPort,
  followLogsLive,
  installPluginFromDirectory,
  installPluginFromUrl,
  selectPluginInstall,
  uploadPluginZip,
  isDaemonRunning,
  resolveApiBase,
  resolveWsUrl,
  waitForHealthy,
  waitForStopped,
  ENDPOINTS,
} from './client';
import {
  getLatestDaemonExe,
  isPidAlive,
  killByPid,
  readPidFile,
  removePidFile,
  runCommand,
  runForeground,
  spawnDetached,
} from './process';
import {
  daemonLogPath,
  normalizePort,
  parseHealth,
  pidFilePath,
  resolveDataDir,
  DEFAULT_API_PORT,
  DEFAULT_WS_PORT,
} from './cli-utils';
import { getVersion } from './version';

const program = new Command();

// Opciones globales: el puerto API se propaga a todos los comandos.
program
  .option('-p, --port <port>', 'Puerto para la API HTTP', String(DEFAULT_API_PORT))
  .option('-w, --ws-port <port>', 'Puerto para WebSocket', String(DEFAULT_WS_PORT))
  .option('--data-dir <dir>', 'Directorio de datos (por defecto: resolución automática)')
  .option('-v, --verbose', 'Salida detallada de diagnóstico');

const DATA_PATH = '../data';

// Utilidades de pegamento CLI (resuelven flags globales -> módulos)
const verboseLog = (...args: any[]) => {
  try {
    if (program.opts().verbose) console.log(chalk.gray('[verbose]'), ...args);
  } catch {
    // program.opts() puede fallar antes del parse; ignorar
  }
};
const logFn = (message: string) => verboseLog(message);

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
  return resolveApiBase(port);
};

const getApiPort = (cmdOptions?: { port?: string | number }): number => {
  const globalPort = (() => {
    try {
      return program.opts().port as string | undefined;
    } catch {
      return undefined;
    }
  })();
  return normalizePort(cmdOptions?.port ?? globalPort, DEFAULT_API_PORT);
};

const getWsPortFlag = (cmdOptions?: { wsPort?: string | number }): string | number | undefined => {
  try {
    return (cmdOptions?.wsPort ?? program.opts().wsPort) as string | undefined;
  } catch {
    return cmdOptions?.wsPort;
  }
};

// Start daemon
program
  .command('start')
  .description('Iniciar el daemon de BunDeck')
  .option('-p, --port <port>', 'Puerto para la API HTTP', String(DEFAULT_API_PORT))
  .option('-w, --ws-port <port>', 'Puerto para WebSocket', String(DEFAULT_WS_PORT))
  .option('-d, --detach', 'Ejecutar en segundo plano')
  .option('--data-dir <dir>', 'Directorio de datos (pidfile y logs)')
  .option('--health-timeout <ms>', 'Timeout del health-check en ms', '30000')
  .action(async (options) => {
    const apiPort = normalizePort(options.port ?? program.opts().port, DEFAULT_API_PORT);
    const wsPort = normalizePort(options.wsPort ?? getWsPortFlag(), DEFAULT_WS_PORT);
    const dataDir = getDataDir(options);
    const healthTimeout = normalizePort(options.healthTimeout, 30000);

    // Verificar si ya está ejecutándose
    const isRunning = await isDaemonRunning(apiPort, { log: logFn });
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
      const spinner = ora('Iniciando BunDeck daemon (detached)...').start();
      try {
        const { pidFile } = await spawnDetached(daemonExe, env, dataDir, { log: logFn });

        const isNowRunning = await waitForHealthy(apiPort, healthTimeout, 1000, { log: logFn });
        if (isNowRunning) {
          spinner.succeed(`BunDeck daemon iniciado en http://localhost:${apiPort} (pidfile: ${pidFile})`);
        } else {
          spinner.fail('Error al iniciar el daemon - no responde al health check');
          console.log(`El daemon puede estar ejecutándose pero no responde. Revisa los logs en ${daemonLogPath(dataDir)}.`);
          process.exit(1);
        }
      } catch (error) {
        ora().fail(`Error al iniciar daemon: ${error}`);
        process.exit(1);
      }
    } else {
      // Foreground REAL: proceso atado a la terminal, stdio heredado, Ctrl+C limpio.
      console.log(chalk.green(`BunDeck daemon en primer plano en http://localhost:${apiPort} (Ctrl+C para detener)`));
      const code = await runForeground(daemonExe, env);
      console.log(chalk.gray(`Daemon terminado (exit code ${code})`));
      process.exit(code);
    }
  });

// Stop daemon
program
  .command('stop')
  .description('Detener el daemon de BunDeck')
  .option('--data-dir <dir>', 'Directorio de datos (donde está el pidfile)')
  .action(async (options) => {
    const spinner = ora('Deteniendo daemon...').start();
    const apiPort = getApiPort();
    const dataDir = getDataDir(options);
    const pidFile = pidFilePath(dataDir);

    try {
      // 1) Vía API (endpoint real)
      await apiRequest(ENDPOINTS.shutdown, { method: 'POST' }, apiPort);
      const stopped = await waitForStopped(apiPort, 15000, 500, { log: logFn });
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
      const apiPort = getApiPort();
      const apiBase = getApiBase();
      const health = await apiRequest(ENDPOINTS.health, {}, apiPort);
      const parsed = parseHealth(health);
      spinner.succeed('Daemon ejecutándose correctamente');

      // Puerto WS: del /health, si no de /config, si no del flag --ws-port.
      const wsPort = parsed.wsPort ?? (await discoverWsPort(apiBase, getWsPortFlag()));
      console.log(chalk.green('✓ Estado: Online'));
      console.log(chalk.blue(`📡 API: http://localhost:${apiPort}`));
      console.log(chalk.blue(`🔌 WebSocket: ${resolveWsUrl(wsPort)}`));
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
      const data = await apiRequest(ENDPOINTS.plugins, {}, getApiPort());

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
  .description('Instalar un plugin desde URL (git o ZIP), archivo .zip local o carpeta local')
  .option('-f, --force', 'Sobrescribir si ya existe')
  .option('--ref <ref>', 'Rama/tag/commit (solo URL git)')
  .action(async (pluginPath: string, options) => {
    const spinner = ora(`Instalando plugin desde ${pluginPath}...`).start();

    try {
      const apiBase = getApiBase();
      const plan = selectPluginInstall(pluginPath);

      if (plan.kind === 'git-url' || plan.kind === 'zip-url') {
        const result = await installPluginFromUrl(apiBase, plan.url, {
          sourceType: plan.sourceType,
          ref: options.ref,
          force: !!options.force,
        });
        spinner.succeed(`Plugin instalado: ${result.pluginId ?? plan.url}`);
      } else if (plan.kind === 'zip-file') {
        const result = await uploadPluginZip(apiBase, plan.path, !!options.force);
        spinner.succeed(`Plugin instalado: ${result.pluginId ?? plan.path}`);
      } else {
        const { resolve } = await import('path');
        const absDir = resolve(process.cwd(), plan.path);
        const result = await installPluginFromDirectory(apiBase, absDir, !!options.force);
        spinner.succeed(`Plugin instalado: ${result.pluginId ?? absDir}`);
      }
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
      const profiles = await apiRequest(ENDPOINTS.profiles, {}, getApiPort());

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
      const profile = await apiRequest(ENDPOINTS.profiles, {
        method: 'POST',
        body: JSON.stringify({ name })
      }, getApiPort());

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
      const apiPort = getApiPort();
      const profile = await apiRequest(`${ENDPOINTS.profiles}/${profileId}`, {}, apiPort);

      // También obtener páginas y botones
      const pages = await apiRequest(`${ENDPOINTS.pages}?profileId=${profileId}`, {}, apiPort);
      const exportData = { profile, pages };

      for (const page of pages) {
        const buttons = await apiRequest(`${ENDPOINTS.buttons}?pageId=${page.id}`, {}, apiPort);
        page.buttons = buttons;
      }

      await Bun.write(options.output, JSON.stringify(exportData, null, 2));
      spinner.succeed(`Perfil exportado a ${options.output}`);
    } catch (error) {
      spinner.fail(`Error exportando perfil: ${error}`);
    }
  });

const printLogLine = (log: any) => {
  const time = new Date(log.ts).toLocaleTimeString();
  let levelColor = chalk.white;

  switch (log.level) {
    case 'error': levelColor = chalk.red; break;
    case 'warn': levelColor = chalk.yellow; break;
    case 'info': levelColor = chalk.blue; break;
  }

  console.log(`${chalk.gray(time)} ${levelColor(String(log.level).toUpperCase())} ${log.message}`);
};

// Logs
program
  .command('logs')
  .description('Mostrar logs del daemon')
  .option('-f, --follow', 'Seguir logs en tiempo real')
  .option('-l, --level <level>', 'Filtrar por nivel (info, warn, error)')
  .option('-n, --lines <number>', 'Número de líneas', '50')
  .action(async (options) => {
    try {
      const apiPort = getApiPort();
      const params = new URLSearchParams();
      if (options.level) params.set('level', options.level);
      if (options.lines) params.set('limit', options.lines);

      const logs = await apiRequest(`${ENDPOINTS.logs}?${params.toString()}`, {}, apiPort);

      console.log(chalk.bold('📋 Logs de BunDeck:\n'));

      logs.forEach(printLogLine);

      if (options.follow) {
        // Tiempo real por WS (topic 'logs'); si falla, polling cada 2s.
        const wsPort = await discoverWsPort(`http://localhost:${apiPort}`, undefined).catch(() => undefined);
        let stopLive: (() => void) | null = null;
        if (wsPort) {
          try {
            stopLive = await followLogsLive(wsPort, (log: any) => {
              if (!options.level || log.level === options.level) printLogLine(log);
            });
            console.log(chalk.gray('\nSiguiendo logs en tiempo real (WS, Ctrl+C para salir)...'));
          } catch {
            stopLive = null;
          }
        }
        if (!stopLive) {
          console.log(chalk.gray('\nSiguiendo logs (polling cada 2s, Ctrl+C para salir)...'));
        } else {
          const cleanup = () => { try { stopLive?.(); } catch {} process.exit(0); };
          process.on('SIGINT', cleanup);
          process.on('SIGTERM', cleanup);
          await new Promise(() => {});
          return;
        }
        const seen = new Set(logs.map((log: any) => log.id ?? `${log.ts}-${log.message}`));
        const timer = setInterval(async () => {
          try {
            const fresh = await apiRequest(`${ENDPOINTS.logs}?${params.toString()}`, {}, apiPort);
            for (const log of fresh) {
              const key = log.id ?? `${log.ts}-${log.message}`;
              if (!seen.has(key)) {
                seen.add(key);
                printLogLine(log);
              }
            }
          } catch {
            // Reintentar en el siguiente tick sin cortar el follow
          }
        }, 2000);
        process.on('SIGINT', () => {
          clearInterval(timer);
          process.exit(0);
        });
        await new Promise(() => {});
      }
    } catch (error) {
      console.error(chalk.red(`Error: ${error}`));
    }
  });

// Update (manifiesto versionado + sha256; gestionadas -> launcher)
program
  .command('update')
  .description('Comprobar y aplicar actualizaciones de BunDeck')
  .option('--check', 'Solo comprobar, sin descargar')
  .option('--channel <channel>', 'Canal de updates (solo "stable" en v1)', 'stable')
  .action(async (options) => {
    const spinner = ora('Buscando actualizaciones...').start();
    try {
      const { checkForUpdate, downloadStandaloneDaemon, isManagedInstall } = await import('./update');
      if (options.channel !== 'stable') {
        spinner.fail(`Canal "${options.channel}" no soportado (solo "stable" en v1)`);
        process.exit(1);
      }
      const check = await checkForUpdate();
      if (!check) {
        const { getVersion: gv } = await import('./version');
        spinner.succeed(`BunDeck está al día (v${gv()})`);
        return;
      }
      spinner.succeed(`Nueva versión: v${check.current} → v${check.latest}`);
      console.log(chalk.gray(`Notas: ${check.notesUrl}`));
      console.log(chalk.gray(`Bundle: ${check.asset.bundle} (${(check.asset.size / 1_048_576).toFixed(1)} MB)`));
      if (options.check) return;

      if (isManagedInstall()) {
        console.log(chalk.yellow('Instalación gestionada por el launcher:'));
        console.log('  Abre el launcher → ACTUALIZACIÓN → Descargar → Aplicar ahora.');
        console.log('  El launcher verifica sha256+firma, respalda la DB y revierte si falla.');
        return;
      }

      // Standalone: descarga verificada a fichero versionado; se aplica al reiniciar.
      const dl = ora(`Descargando daemon v${check.latest}...`).start();
      const dest = await downloadStandaloneDaemon(check, (got, total) => {
        dl.text = total
          ? `Descargando daemon v${check.latest}... ${(100 * got / total).toFixed(0)}%`
          : `Descargando daemon v${check.latest}... ${(got / 1_048_576).toFixed(1)} MB`;
      });
      dl.succeed(`Daemon v${check.latest} listo: ${dest}`);
      console.log(chalk.green('Reinicia el daemon para aplicar (stop + start). Tu DB y plugins se conservan.'));
    } catch (error) {
      spinner.fail(`Update falló: ${error}`);
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
  .description('BunDeck CLI - Herramientas de línea de comandos para BunDeck')
  .version(getVersion());

// Parse command line arguments
program.parse(process.argv);

// Si no se proporciona comando, mostrar ayuda
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
