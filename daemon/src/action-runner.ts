import { v4 as uuidv4 } from 'uuid';
import { PluginLoader } from './plugin-loader';
import { DatabaseService } from './db';
import {
  MultimediaPlugin,
  ShellPlugin,
  HttpPlugin,
  UtilityPlugin,
  HotkeyPlugin,
  TypeTextPlugin,
  OpenAppPlugin,
  PagePlugin,
  BrowserPlugin,
  PCVitalsPlugin,
  ObsPlugin,
  HomeAssistantPlugin,
  SpotifyPlugin,
  DiscordPlugin,
  TwitchPlugin,
  YoutubePlugin,
  SoundboardPlugin,
  VoicemodPlugin,
  VoicemeeterPlugin,
  ShadowplayPlugin,
  WebcamPlugin,
  PhotoshopPlugin,
  PremierePlugin,
  DavinciPlugin,
  BlenderPlugin,
  MidiOscPlugin,
  SteamPlugin,
  MinecraftPlugin,
  HueExtraPlugin,
  GoveePlugin,
  AudioMixerPlugin,
  WindowManagerPlugin,
  MeetingsPlugin,
  SlackPlugin,
  CalendarPlugin,
  TimerPlugin,
  ClipboardPlugin,
  MultiactionPlugin,
  ProfileAutoPlugin,
  WeatherPlugin,
  EmailPlugin,
  FlowControlPlugin,
  type NativePlugin
} from './plugins';
import { PluginSandbox } from './plugin-system/sandbox';
import { isSafeModeEnabled, isGatedActionType } from './e2e-safe';
import { VariableStore } from './variables/store';
import {
  FlowEngine,
  FlowStore,
  AutomationManager,
  buttonDataToNodes,
  legacyActionToNode,
  type Automation,
  type FlowContext,
  type FlowNode,
  type FlowScript,
  type FlowVar,
  type PressType,
} from './flow';

export interface ActionDescriptor {
  id?: string;
  type: string;
  name?: string;
  parameters?: Record<string, any>;
  cooldown?: number;
  timeout?: number;
}

export interface ActionContext {
  buttonId?: string;
  pageId?: string;
  profileId?: string;
  userId?: string;
  timestamp: number;
  pressType?: 'short' | 'long' | 'double' | 'triple' | 'touch-start' | 'touch-end';
}

export interface ActionResult {
  success: boolean;
  result?: any;
  error?: string;
  duration: number;
}

interface PressActionLeaf {
  actionType: string;
  actionId: string | null;
  success: boolean;
  error?: string;
}

/**
 * Aplana (nodos, resultados) del motor a hojas ejecutables para press logs.
 * Recorre sequence/if/switch/repeat/script/parallel; las hojas `action`
 * conservan su type, y set-var/toggle-var/log se mapean a sus `local.*`
 * originales. Los `wait` estructurales no generan fila. Sin `parameters`:
 * nunca salen de aquí hacia la BD.
 */
function flattenPressActionLeaves(
  nodes: FlowNode[],
  results: Array<{ kind: string; type?: string; success: boolean; error?: string; result?: any }>,
): PressActionLeaf[] {
  const out: PressActionLeaf[] = [];
  const push = (node: any, r: any) => {
    if (!r || typeof r !== 'object') return;
    if (r.kind === 'action' || node?.kind === 'action') {
      const t = String(node?.type ?? r?.type ?? '');
      if (t) out.push({ actionType: t, actionId: node?.id ?? null, success: r.success !== false, error: r.error });
      return;
    }
    if (node?.kind === 'set-var') {
      out.push({ actionType: 'local.set-var', actionId: node?.id ?? null, success: r.success !== false, error: (r as any).error });
      return;
    }
    if (node?.kind === 'toggle-var') {
      out.push({ actionType: 'local.toggle-var', actionId: node?.id ?? null, success: r.success !== false, error: (r as any).error });
      return;
    }
    if (node?.kind === 'log') {
      out.push({ actionType: 'local.toast', actionId: node?.id ?? null, success: r.success !== false, error: (r as any).error });
      return;
    }
    if (node?.kind === 'wait') return; // retardo estructural, no acción
    // Contenedores: sequence/if/switch/repeat/script/parallel.
    const subResults: any[] = Array.isArray(r?.result?.results)
      ? r.result.results
      : Array.isArray(r?.result?.branches)
        ? (r.result.branches as Array<{ results?: any[] }>).flatMap((b) => b?.results ?? [])
        : [];
    const subNodes: any[] = Array.isArray(node?.nodes)
      ? node.nodes
      : Array.isArray(node?.branches)
        ? (node.branches as any[][]).flat()
        : [];
    if (!subResults.length) return;
    subResults.forEach((sub, i) => push(subNodes[i], sub));
  };
  results.forEach((r, i) => push((nodes as any[])[i], r));
  return out;
}

export class ActionRunner {
  private pluginLoader: PluginLoader;
  private db: DatabaseService;
  private runningActions: Map<string, Promise<ActionResult>> = new Map();
  private actionHandlers: Map<string, Function> = new Map();
  private lastExecution: Map<string, number> = new Map();
  private nativePlugins: NativePlugin[] = [];
  private sandbox = new PluginSandbox();
  private varStore: VariableStore;
  private flowStore: FlowStore;
  private flowEngine: FlowEngine;
  private automationManager: AutomationManager;
  private altIndex = new Map<string, number>();
  private flowsReady = false;

  constructor(pluginLoader: PluginLoader) {
    this.pluginLoader = pluginLoader;
    this.db = new DatabaseService();
    // Conectar loader -> runner para plugins externos (evita doble registro) — opcional para tests con mock
    if (typeof (this.pluginLoader as any).setActionCallbacks === 'function') {
      (this.pluginLoader as any).setActionCallbacks(
        (fullId: string, handler: Function) => this.registerAction(fullId, handler),
        (fullId: string) => this.actionHandlers.delete(fullId)
      );
    }
    this.flowStore = new FlowStore(this.db);
    this.flowEngine = new FlowEngine({
      executeAction: (a, c) => this.executeAction(a as ActionDescriptor, c as ActionContext),
      getVar: (name) => this.getFlowVar(name) ?? undefined,
      setVar: (name, value) => this.setFlowVar(name, value),
      listVars: () => this.listFlowVars(),
      getScript: (id) => this.flowStore.getScript(id),
      log: (level, message, meta) => { this.db.addLog({ level, message, meta, ts: Date.now() }); },
      emit: (event, payload) => this.emitFlowEvent(event, payload),
    });
    this.automationManager = new AutomationManager({
      execute: (nodes, ctx, opts) => this.runFlowNodes('automation', opts?.runLabel ?? 'automation', nodes, ctx, opts),
      log: (level, message, meta) => { this.db.addLog({ level, message, meta, ts: Date.now() }); },
      emit: (event, payload) => this.emitFlowEvent(event, payload),
    });
    this.loadNativePlugins();
    this.varStore = new VariableStore(this.db);
    this.setupBuiltInActions();
  }

  /** Emite un evento de flujos por WS (best-effort, sin WS en tests). */
  private emitFlowEvent(event: string, payload: any): void {
    try {
      (globalThis as any).__libredeckWs?.broadcast?.(event, payload);
    } catch { /* sin WS: mejor esfuerzo */ }
  }

  /** Contexto por plugin: log + ajustes generales namespaced (plugin.<id>.<key>). */
  private makePluginContext(pluginId: string) {
    return {
      log: (level: string, message: string, meta?: any) => {
        this.db.addLog({ level, message, meta, ts: Date.now() });
      },
      getSetting: (key: string): string | null => {
        return this.db.getSetting(`plugin.${pluginId}.${key}`);
      },
      setSetting: (key: string, value: string): void => {
        this.db.setSetting(`plugin.${pluginId}.${key}`, String(value));
      },
      deleteSetting: (key: string): void => {
        this.db.deleteSetting(`plugin.${pluginId}.${key}`);
      },
    };
  }

  private loadNativePlugins() {
    console.log('🔌 Loading native plugins...');

    // Load all native plugins (cada uno con su contexto y ajustes propios)
    const multimediaPlugin = new MultimediaPlugin(this.makePluginContext('multimedia'));
    const shellPlugin = new ShellPlugin(this.makePluginContext('shell'));
    const httpPlugin = new HttpPlugin(this.makePluginContext('http'));
    const utilityPlugin = new UtilityPlugin(this.makePluginContext('utility'));
    const hotkeyPlugin = new HotkeyPlugin(this.makePluginContext('hotkey'));
    const typeTextPlugin = new TypeTextPlugin(this.makePluginContext('type-text'));
    const openAppPlugin = new OpenAppPlugin(this.makePluginContext('open-app'));
    const pagePlugin = new PagePlugin(this.makePluginContext('page'));
    const browserPlugin = new BrowserPlugin(this.makePluginContext('browser'));
    const pcVitalsPlugin = new PCVitalsPlugin(this.makePluginContext('pc-vitals'));
    const obsPlugin = new ObsPlugin(this.makePluginContext('obs'));
    const homeAssistantPlugin = new HomeAssistantPlugin(this.makePluginContext('homeassistant'));
    const spotifyPlugin = new SpotifyPlugin(this.makePluginContext('spotify'));
    const discordPlugin = new DiscordPlugin(this.makePluginContext('discord'));
    const twitchPlugin = new TwitchPlugin(this.makePluginContext('twitch'));
    const youtubePlugin = new YoutubePlugin(this.makePluginContext('youtube'));
    const soundboardPlugin = new SoundboardPlugin(this.makePluginContext('soundboard'));
    const voicemodPlugin = new VoicemodPlugin(this.makePluginContext('voicemod'));
    const voicemeeterPlugin = new VoicemeeterPlugin(this.makePluginContext('voicemeeter'));
    const shadowplayPlugin = new ShadowplayPlugin(this.makePluginContext('shadowplay'));
    const webcamPlugin = new WebcamPlugin(this.makePluginContext('webcam'));
    const photoshopPlugin = new PhotoshopPlugin(this.makePluginContext('photoshop'));
    const premierePlugin = new PremierePlugin(this.makePluginContext('premiere'));
    const davinciPlugin = new DavinciPlugin(this.makePluginContext('davinci'));
    const blenderPlugin = new BlenderPlugin(this.makePluginContext('blender'));
    const midiOscPlugin = new MidiOscPlugin(this.makePluginContext('midi-osc'));
    const steamPlugin = new SteamPlugin(this.makePluginContext('steam'));
    const minecraftPlugin = new MinecraftPlugin(this.makePluginContext('minecraft'));
    const hueExtraPlugin = new HueExtraPlugin(this.makePluginContext('hue-extra'));
    const goveePlugin = new GoveePlugin(this.makePluginContext('govee'));
    const audioMixerPlugin = new AudioMixerPlugin(this.makePluginContext('audio-mixer'));
    const windowManagerPlugin = new WindowManagerPlugin(this.makePluginContext('window-manager'));
    const meetingsPlugin = new MeetingsPlugin(this.makePluginContext('meetings'));
    const slackPlugin = new SlackPlugin(this.makePluginContext('slack'));
    const calendarPlugin = new CalendarPlugin(this.makePluginContext('calendar'));
    const timerPlugin = new TimerPlugin(this.makePluginContext('timer'));
    const clipboardPlugin = new ClipboardPlugin(this.makePluginContext('clipboard'));
    const flowPlugin = new FlowControlPlugin(this.makePluginContext('flow'));
    const multiactionPlugin = new MultiactionPlugin(this.makePluginContext('multiaction'));
    const profileAutoPlugin = new ProfileAutoPlugin(this.makePluginContext('profile-auto'));
    const weatherPlugin = new WeatherPlugin(this.makePluginContext('weather'));
    const emailPlugin = new EmailPlugin(this.makePluginContext('email'));

    // Set action executor for utility plugin
    utilityPlugin.setActionExecutor(this.executeAction.bind(this));
    // Set action executor for multiaction plugin (usa el ActionRunner existente)
    multiactionPlugin.setActionExecutor(this.executeAction.bind(this));
    // Variables del motor de flujos para las primitivas flow.set-var/toggle-var/get-var
    flowPlugin.setVarHooks({
      getVar: (name) => this.getFlowVar(name) ?? undefined,
      setVar: (name, value) => this.setFlowVar(name, value),
    });

    this.nativePlugins.push(
      multimediaPlugin,
      shellPlugin,
      httpPlugin,
      utilityPlugin,
      hotkeyPlugin,
      typeTextPlugin,
      openAppPlugin,
      pagePlugin,
      browserPlugin,
      pcVitalsPlugin,
      obsPlugin,
      homeAssistantPlugin,
      spotifyPlugin,
      discordPlugin,
      twitchPlugin,
      youtubePlugin,
      soundboardPlugin,
      voicemodPlugin,
      voicemeeterPlugin,
      shadowplayPlugin,
      webcamPlugin,
      photoshopPlugin,
      premierePlugin,
      davinciPlugin,
      blenderPlugin,
      midiOscPlugin,
      steamPlugin,
      minecraftPlugin,
      hueExtraPlugin,
      goveePlugin,
      audioMixerPlugin,
      windowManagerPlugin,
      meetingsPlugin,
      slackPlugin,
      calendarPlugin,
      timerPlugin,
      clipboardPlugin,
      flowPlugin,
      multiactionPlugin,
      profileAutoPlugin,
      weatherPlugin,
      emailPlugin
    );

    // Register all action handlers from native plugins
    for (const plugin of this.nativePlugins) {
      const manifest = plugin.getManifest();
      const handlers = plugin.getActionHandlers();

      for (const [actionType, handler] of handlers.entries()) {
        this.registerAction(`${manifest.id}.${actionType}`, handler);
      }

      console.log(`✓ Loaded native plugin: ${manifest.name} v${manifest.version}`);
    }
  }

  private setupBuiltInActions() {
    // Acciones locales (grupo «Lógica»): compat con el motor web
    // (useKeyEngine) y la allowlist remota. Operan sobre el scope global
    // del servicio daemon de variables.
    this.registerAction('local.set-var', async (params: any) => {
      const name = String(params?.name ?? '').trim();
      if (!name) throw new Error('Elige una variable');
      this.varStore.require(name);
      const value = params?.value !== undefined
        ? params.value
        : this.varStore.evalExpr(String(params?.expr ?? ''));
      const def = await this.varStore.set(name, value, { source: 'action:local.set-var' });
      return { name: def.name, value: def.value };
    });
    this.registerAction('local.toggle-var', async (params: any) => {
      const name = String(params?.name ?? '').trim();
      if (!name) throw new Error('Elige una variable');
      const def = await this.varStore.toggle(name, { source: 'action:local.toggle-var' });
      return { name: def.name, value: def.value };
    });
    this.registerAction('local.toast', async (params: any) => {
      const text = this.varStore.render(String(params?.text ?? '')) || '(mensaje vacío)';
      this.db.addLog({ level: 'info', message: `Toast: ${text}`, meta: { params }, ts: Date.now() });
      return { message: text };
    });
  }

  /** Acceso al store de variables (tests / API / flujos). */
  public getVariableStore(): VariableStore {
    return this.varStore;
  }

  public registerAction(actionType: string, handler: Function): void {
    this.actionHandlers.set(actionType, handler);
    console.log(`✓ Registered action handler: ${actionType}`);
  }

  public async executeAction(
    action: ActionDescriptor,
    context: ActionContext
  ): Promise<ActionResult> {
    const actionId = action.id || uuidv4();
    const startTime = Date.now();

    // Modo seguro E2E (ver e2e-safe.ts): bajo la suite Playwright las
    // acciones con efectos fuera de la app (ventanas, teclas, shell,
    // sonido, red…) son no-ops logueados. Punto único de filtrado: aquí
    // confluyen /actions/execute, /buttons/press (motor de flujos),
    // pulsos MCP/remotos y los pasos anidados de utility.macro/multiaction.
    // Se responde éxito con `skipped` para no romper secuencias ni tests.
    if (isGatedActionType(action.type) && isSafeModeEnabled(this.db)) {
      const duration = Date.now() - startTime;
      try {
        this.db.addLog({
          level: 'info',
          message: `Action omitida (modo seguro e2e): ${action.type}`,
          meta: { action: { type: action.type }, context, safeMode: true },
          ts: Date.now(),
        });
      } catch { /* mejor esfuerzo: la omisión ya está decidida */ }
      return {
        success: true,
        result: { skipped: 'e2e-safe-mode', type: action.type },
        duration,
      };
    }

    try {
      // Check cooldown
      if (action.cooldown && this.isOnCooldown(actionId, action.cooldown)) {
        return {
          success: false,
          error: 'Action is on cooldown',
          duration: 0
        };
      }

      // Check if already running (prevent double execution)
      if (this.runningActions.has(actionId)) {
        return {
          success: false,
          error: 'Action is already running',
          duration: 0
        };
      }

      // Log action start (se omite en polling silencioso: los botones
      // dinámicos ejecutan cada 500 ms y cada ejecución escribía 2 filas en
      // SQLite + broadcasts WS → 348k filas / 120 MB de spam).
      if (!(context as any)?.quiet) {
        this.db.addLog({
          level: 'info',
          message: `Action started: ${action.type}`,
          meta: { action, context },
          ts: startTime
        });
      }

      // Create execution promise
      const executionPromise = this.doExecuteAction(action, context);
      this.runningActions.set(actionId, executionPromise);

      // Execute with timeout
      const result = await this.executeWithTimeout(
        executionPromise,
        action.timeout || 30000 // 30s default timeout
      );

      const duration = Date.now() - startTime;

      // Update last execution time
      this.lastExecution.set(actionId, startTime);

      // Log result (se omite en polling silencioso; los errores siempre).
      if (!(context as any)?.quiet) {
        this.db.addLog({
          level: result.success ? 'info' : 'error',
          message: `Action ${result.success ? 'completed' : 'failed'}: ${action.type}`,
          meta: { action, context, result, duration },
          ts: Date.now()
        });
      } else if (!result.success) {
        this.db.addLog({
          level: 'error',
          message: `Action failed: ${action.type}`,
          meta: { action, context, result, duration },
          ts: Date.now()
        });
      }

      return {
        ...result,
        duration
      };

    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      this.db.addLog({
        level: 'error',
        message: `Action error: ${action.type} - ${errorMessage}`,
        meta: { action, context, error: errorMessage },
        ts: Date.now()
      });

      return {
        success: false,
        error: errorMessage,
        duration
      };
    } finally {
      this.runningActions.delete(actionId);
    }
  }

  private async doExecuteAction(
    action: ActionDescriptor,
    context: ActionContext
  ): Promise<ActionResult> {
    let handler = this.actionHandlers.get(action.type);

    // Fallback for plugin.action format - try base action type
    if (!handler && action.type.includes('.')) {
      const baseType = action.type.split('.')[1];
      handler = this.actionHandlers.get(baseType);
    }

    if (!handler) {
      throw new Error(`Unknown action type: ${action.type}`);
    }

    const result = await handler(this.interpolateParams(action.parameters || {}), context);

    return {
      success: true,
      result,
      duration: 0 // Will be set by caller
    };
  }

  /**
   * Sustituye {{vars.x}} en parámetros string con las variables conocidas;
   * deja intacto lo desconocido (Jinja de HA, literales, …). Best-effort:
   * ante cualquier fallo devuelve los parámetros originales.
   */
  private interpolateParams(parameters: any): any {
    if (!parameters || typeof parameters !== 'object') return parameters;
    try {
      const out: any = Array.isArray(parameters) ? [...parameters] : { ...parameters };
      for (const k of Object.keys(out)) {
        if (k === 'pageId' || k === 'page_id') continue;
        if (typeof out[k] === 'string' && out[k].includes('{{')) {
          try { out[k] = this.varStore.renderLenient(out[k]); } catch { /* original */ }
        }
      }
      return out;
    } catch {
      return parameters;
    }
  }

  private async executeWithTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number
  ): Promise<T> {
    // El timer se limpia al resolver: antes sobrevivía 30 s por CADA
    // ejecución (también el polling silencioso cada 500 ms) y acumulaba
    // decenas de miles de handles en daemons de larga vida.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Action timeout')), timeoutMs);
      });
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private isOnCooldown(actionId: string, cooldownMs: number): boolean {
    const lastExecution = this.lastExecution.get(actionId);
    if (!lastExecution) return false;

    return (Date.now() - lastExecution) < cooldownMs;
  }

  // Built-in action implementations

  // Public methods for management

  public getRunningActions(): string[] {
    return Array.from(this.runningActions.keys());
  }

  public getNativePlugins(): NativePlugin[] {
    return this.nativePlugins;
  }

  public async cancelAction(actionId: string): Promise<boolean> {
    const runningAction = this.runningActions.get(actionId);
    if (!runningAction) {
      return false;
    }

    // TODO: Implement action cancellation
    this.runningActions.delete(actionId);

    this.db.addLog({
      level: 'info',
      message: `Action cancelled: ${actionId}`,
      meta: { actionId },
      ts: Date.now()
    });

    return true;
  }

  public getActionStats(): any {
    return {
      running: this.runningActions.size,
      registered: this.actionHandlers.size,
      lastExecutions: Object.fromEntries(this.lastExecution)
    };
  }

  // ================= Motor de flujos =================

  /** Arranque del motor: runs interrumpidos, variables semilla, timers y reglas de tecla. */
  public async initFlows(): Promise<void> {
    if (this.flowsReady) return;
    this.flowsReady = true;
    try {
      const interrupted = this.flowStore.markInterruptedRuns();
      if (interrupted > 0) {
        this.db.addLog({ level: 'info', message: `Flows interrumpidos por reinicio: ${interrupted}`, meta: {}, ts: Date.now() });
      }
    } catch { /* mejor esfuerzo */ }
    // Semilla compatible con el cliente (useVars.defaultVars) si no hay nada.
    try {
      if (this.flowStore.listVars().length === 0) {
        this.flowStore.setVar({ name: 'contador', type: 'num', value: 0 });
        this.flowStore.setVar({ name: 'micSilenciado', type: 'bool', value: false });
        this.flowStore.setVar({ name: 'modoDirecto', type: 'txt', value: 'charla' });
      }
    } catch { /* mejor esfuerzo */ }
    try {
      this.automationManager.startGlobal(this.safeListAutomations());
    } catch { /* mejor esfuerzo */ }
    try {
      this.resyncButtonAutomations();
    } catch { /* mejor esfuerzo */ }
    // Restaurar rotación `alt` persistida (mode 'alt' por tecla).
    try {
      const all = this.db.getAllSettings();
      for (const [k, v] of Object.entries(all ?? {})) {
        if (k.startsWith('flow.alt.')) {
          const n = parseInt(v, 10);
          if (Number.isFinite(n)) this.altIndex.set(k.slice('flow.alt.'.length), n);
        }
      }
    } catch { /* mejor esfuerzo */ }
  }

  private safeListAutomations(): Automation[] {
    try {
      return this.flowStore.listAutomations().filter((a) => a && a.enabled !== false);
    } catch { return []; }
  }

  /** Ejecuta nodos con registro persistente de run + timeout/cancelación. */
  public async runFlowNodes(
    kind: string,
    label: string,
    nodes: FlowNode[],
    ctx: FlowContext,
    opts: { timeout?: number; canExecute?: (type: string) => boolean } = {},
  ): Promise<{ success: boolean; runId: string; cancelled: boolean; results: any[]; error?: string; duration: number }> {
    const runId = uuidv4();
    const started = Date.now();
    try {
      this.flowStore.createRun({ id: runId, kind, label, status: 'running', started_at: started });
    } catch { /* mejor esfuerzo */ }
    const fullCtx: FlowContext = { ...ctx, timestamp: ctx.timestamp ?? Date.now() };
    let res: { success: boolean; runId: string; cancelled: boolean; results: any[]; error?: string; duration: number };
    try {
      res = await this.flowEngine.execute(nodes, fullCtx, { runId, runLabel: label, timeout: opts.timeout, canExecute: opts.canExecute });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res = { success: false, runId, cancelled: false, results: [], error: message, duration: Date.now() - started };
    }
    try {
      this.flowStore.finishRun(runId, {
        status: res.cancelled ? 'cancelled' : res.success ? 'finished' : 'error',
        finished_at: Date.now(),
        error: (res as any).error,
      });
    } catch { /* mejor esfuerzo */ }
    return res;
  }

  /** Ejecuta un script guardado (con inputs) o nodos ad-hoc. */
  public async executeFlow(
    input: { scriptId: string; inputs?: Record<string, any>; outputVar?: string } | { nodes: FlowNode[] },
    ctx: FlowContext,
    opts: { timeout?: number; canExecute?: (type: string) => boolean } = {},
  ): Promise<{ success: boolean; runId: string; cancelled: boolean; results: any[]; error?: string; duration: number }> {
    let nodes: FlowNode[];
    let label = 'flow';
    if ('scriptId' in input) {
      nodes = [{ kind: 'script', scriptId: input.scriptId, inputs: input.inputs ?? {}, outputVar: input.outputVar }];
      label = `script:${input.scriptId}`;
    } else {
      nodes = input.nodes;
    }
    return this.runFlowNodes('flow', label, nodes, ctx, opts);
  }

  /**
   * Ejecuta una tecla del dashboard/HW como flujo: acciones base según `mode`
   * (seq/par/alt) + reglas `when` del pressType. Es el camino canónico tanto
   * para la web como para `hw-driver/streamdeck-driver.ts`, con o sin UI.
   */
  public async executeButtonFlow(
    button: { id?: string; page_id?: string; pageId?: string; position?: number; data?: any } | any,
    ctx: ActionContext,
    opts: { canExecute?: (type: string) => boolean } = {},
  ): Promise<{ success: boolean; runId: string; cancelled: boolean; results: any[]; error?: string; duration: number; empty?: boolean }> {
    const data = button?.data ?? button ?? {};
    const pressType = this.normalizePressType((ctx as any)?.pressType) ?? 'short';
    const buttonId = button?.id ?? (ctx as any)?.buttonId;
    const pageId = button?.page_id ?? button?.pageId ?? (ctx as any)?.pageId;
    const position = button?.position ?? (ctx as any)?.position;
    const fullCtx: FlowContext = {
      ...(ctx as any),
      buttonId, pageId, position,
      pressType, trigger: pressType,
      source: (ctx as any)?.source ?? 'button',
      timestamp: (ctx as any)?.timestamp ?? Date.now(),
    };
    const { nodes, hasContent, mode } = buttonDataToNodes(data, pressType);
    let finalNodes = nodes;
    if (mode === 'alt' && pressType === 'short') {
      // `pressActions.click` manda si tiene contenido (espejo de `actions[]`).
      const rawClick = (data as any)?.pressActions?.click
      const actions = Array.isArray(rawClick) && rawClick.length
        ? rawClick
        : (Array.isArray(data?.actions) ? data.actions : []);
      if (!actions.length) {
        return { success: true, runId: uuidv4(), cancelled: false, results: [], duration: 0, empty: true };
      }
      const key = `${pageId ?? ''}:${position ?? ''}`;
      const i = this.altIndex.get(key) ?? 0;
      finalNodes = [legacyActionToNode(actions[i % actions.length])];
      this.altIndex.set(key, i + 1);
      try {
        this.db.setSetting(`flow.alt.${key}`, String(i + 1));
      } catch { /* mejor esfuerzo */ }
    }
    if (!hasContent || finalNodes.length === 0) {
      return { success: true, runId: uuidv4(), cancelled: false, results: [], duration: 0, empty: true };
    }
    const res = await this.runFlowNodes('button', `button:${buttonId ?? '?'}:${pressType}`, finalNodes, fullCtx, opts);
    this.writePressLogs(button, fullCtx, finalNodes, res);
    return res;
  }

  /** ¿Registrar logs por pulsación? (`logs.press_enabled`, por defecto sí). */
  private pressLogsEnabled(): boolean {
    try {
      return this.db.getSetting('logs.press_enabled') !== 'false';
    } catch { return true; }
  }

  /** deviceId desde el contexto + deviceName de `devices`/`device_sessions`. */
  private resolvePressDevice(ctx: any): { deviceId: string | null; deviceName: string | null } {
    const raw = ctx?.deviceId ?? ctx?.device_id ?? ctx?.clientId ?? null;
    const deviceId = raw === null || raw === undefined ? null : String(raw);
    let deviceName: string | null = null;
    if (deviceId) {
      try {
        deviceName = this.db.getDevice(deviceId)?.name
          ?? this.db.getDeviceSession(deviceId)?.name ?? null;
      } catch { /* mejor esfuerzo */ }
    }
    return { deviceId, deviceName };
  }

  /**
   * Escribe una fila por (pulsación × acción hoja) con el mismo runId.
   * Best-effort total (try/catch): nunca rompe la ejecución. No escribe si
   * el botón está vacío, si el contexto es `quiet` (polling silencioso) o si
   * `logs.press_enabled` es 'false'. NUNCA persiste `parameters` (secretos).
   */
  private writePressLogs(
    button: any, ctx: FlowContext, nodes: FlowNode[],
    res: { runId: string; duration: number; results: Array<{ kind: string; type?: string; success: boolean; error?: string; result?: any }> },
  ): void {
    try {
      if (!nodes.length || !res?.results?.length) return;
      if ((ctx as any)?.quiet) return;
      if (!this.pressLogsEnabled()) return;
      const leaves = flattenPressActionLeaves(nodes, res.results);
      if (!leaves.length) return;
      const { deviceId, deviceName } = this.resolvePressDevice(ctx);
      let profileId: string | null = (ctx as any)?.profileId ?? null;
      const pageId: string | null = (ctx as any)?.pageId ?? button?.page_id ?? button?.pageId ?? null;
      if (!profileId && pageId) {
        try { profileId = this.db.getPage(pageId)?.profile_id ?? null; }
        catch { /* sin página: null */ }
      }
      const ts = Date.now();
      const pressType = (ctx as any)?.pressType ?? 'short';
      const source = (ctx as any)?.source ?? 'button';
      const buttonId = String(button?.id ?? (ctx as any)?.buttonId ?? '');
      if (!buttonId) return;
      const position = button?.position ?? (ctx as any)?.position ?? null;
      const rows = leaves.map((leaf, i) => ({
        ts, buttonId, pageId, profileId, position,
        pressType, deviceId, deviceName, source,
        actionType: leaf.actionType, actionIndex: i,
        actionId: leaf.actionId, runId: res.runId,
        success: leaf.success,
        error: typeof leaf.error === 'string' ? leaf.error.slice(0, 500) : null,
        durationMs: res.duration ?? null,
        meta: { pressType, source },
      }));
      const tx = (this.db as any)?.transaction?.bind(this.db);
      if (typeof tx === 'function') {
        tx(() => { for (const row of rows) this.db.addPressLog(row); });
      } else {
        for (const row of rows) this.db.addPressLog(row);
      }
      // Resumen por pulsación en `logs` (una fila): la vía HW y la web dejan
      // el mismo rastro en el menú Registros, con nivel error si algo falló.
      try {
        const ok = leaves.filter((l) => l.success).length;
        const failed = leaves.length - ok;
        const firstErr = leaves.find((l) => !l.success)?.error;
        this.db.addLog({
          level: failed > 0 ? 'error' : 'info',
          message: failed > 0
            ? `Botón ${buttonId} (${source}/${pressType}): ${failed}/${leaves.length} acciones fallaron${firstErr ? `: ${firstErr}` : ''}`
            : `Botón ${buttonId} (${source}/${pressType}): pulsación ejecutada (${ok}/${leaves.length} acciones ok)`,
          meta: { buttonId, pageId, pressType, source, runId: res.runId, ok, failed },
          ts: Date.now(),
        });
      } catch { /* mejor esfuerzo */ }
      // Poda oportunista (retención configurable, best-effort).
      try {
        const keepMax = Number(this.db.getSetting('logs.press_keep_max') ?? '10000');
        const keepDays = Number(this.db.getSetting('logs.press_keep_days') ?? '30');
        if (Number.isFinite(keepMax) || Number.isFinite(keepDays)) {
          this.db.prunePressLogs(keepMax, keepDays);
        }
      } catch { /* mejor esfuerzo */ }
    } catch { /* mejor esfuerzo: el press ya se ejecutó */ }
  }

  private normalizePressType(v: unknown): PressType | null {
    return v === 'short' || v === 'long' || v === 'double' || v === 'triple' || v === 'touch-start' || v === 'touch-end'
      ? v : v === 'press' || v === 'click' ? 'short' : null;
  }

  /** Cancela una ejecución de flujo en curso. */
  public cancelFlow(runId: string): boolean {
    const ok = this.flowEngine.cancel(runId);
    if (ok) {
      try {
        this.flowStore.finishRun(runId, { status: 'cancelled', finished_at: Date.now() });
        this.db.addLog({ level: 'info', message: `Flow cancelado: ${runId}`, meta: { runId }, ts: Date.now() });
        this.emitFlowEvent('flow.finished', { runId, cancelled: true, timestamp: Date.now() });
      } catch { /* mejor esfuerzo */ }
    }
    return ok;
  }

  public getFlowRunning(): string[] {
    return this.flowEngine.getRunning();
  }

  public getFlowStats(): any {
    let scripts = 0, automations = 0, vars = 0;
    try {
      scripts = this.flowStore.listScripts().length;
      automations = this.flowStore.listAutomations().length;
      vars = this.flowStore.listVars().length;
    } catch { /* memoria */ }
    return {
      running: this.flowEngine.getRunning().length,
      scripts,
      automations,
      vars,
      persistent: this.flowStore.persistent,
    };
  }

  // ---- Variables globales ----

  public listFlowVars(): FlowVar[] {
    try { return this.flowStore.listVars(); } catch { return []; }
  }

  public getFlowVar(name: string): FlowVar | null {
    try { return this.flowStore.getVar(name); } catch { return null; }
  }

  /** Asigna una variable global (crea num/bool/txt según el valor si es nueva). */
  public setFlowVar(name: string, value: any): boolean {
    const clean = String(name ?? '').trim();
    if (!clean) throw new Error('Nombre de variable vacío');
    const existing = this.getFlowVar(clean);
    const type = existing?.type ?? (typeof value === 'number' ? 'num' : typeof value === 'boolean' ? 'bool' : 'txt');
    const coerced = type === 'num'
      ? (Number.isFinite(Number(value)) ? Number(value) : 0)
      : type === 'bool'
        ? (value === true || value === 'true' || value === '1' || (typeof value === 'number' && value !== 0))
        : String(value ?? '');
    const changed = !existing || existing.value !== coerced;
    try {
      this.flowStore.setVar({ name: clean, type, value: coerced });
    } catch (e) {
      throw e instanceof Error ? e : new Error('No se pudo guardar la variable');
    }
    if (changed) {
      this.db.addLog({ level: 'info', message: `Variable ${clean} = ${JSON.stringify(coerced)}`, meta: { var: clean }, ts: Date.now() });
      this.emitFlowEvent('var.changed', { name: clean, value: coerced, type, timestamp: Date.now() });
      try {
        this.automationManager.handleVariableChange(clean, this.safeListAutomations());
      } catch { /* mejor esfuerzo */ }
    }
    return changed;
  }

  public deleteFlowVar(name: string): void {
    try { this.flowStore.deleteVar(name); } catch { /* mejor esfuerzo */ }
    this.emitFlowEvent('var.changed', { name, deleted: true, timestamp: Date.now() });
  }

  // ---- Scripts reutilizables ----

  public listFlowScripts(): FlowScript[] {
    try { return this.flowStore.listScripts(); } catch { return []; }
  }

  public saveFlowScript(s: { id?: string; name: string; inputs?: string[]; timeout?: number; nodes: FlowNode[] }): FlowScript {
    if (!s || !Array.isArray(s.nodes)) throw new Error('Script sin nodos');
    const full: FlowScript = {
      id: s.id ?? uuidv4(),
      name: String(s.name ?? 'Sin nombre'),
      inputs: Array.isArray(s.inputs) ? s.inputs : [],
      timeout: typeof s.timeout === 'number' ? s.timeout : undefined,
      nodes: s.nodes,
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    const prev = this.flowStore.getScript(full.id);
    if (prev) full.created_at = (prev as any).created_at ?? full.created_at;
    this.flowStore.saveScript(full);
    this.db.addLog({ level: 'info', message: `Script guardado: ${full.name}`, meta: { scriptId: full.id }, ts: Date.now() });
    return full;
  }

  public deleteFlowScript(id: string): void {
    this.flowStore.deleteScript(id);
  }

  // ---- Automatizaciones globales ----

  public listAutomations(): Automation[] {
    try { return this.flowStore.listAutomations(); } catch { return []; }
  }

  public saveAutomation(a: { id?: string; name: string; enabled?: boolean; trigger: any; scriptId?: string; nodes?: FlowNode[]; inputs?: any }): Automation {
    if (!a || !a.trigger || typeof a.trigger.kind !== 'string') throw new Error('Automatización sin trigger válido');
    const kind = a.trigger.kind;
    if (!['event', 'timer', 'var', 'load'].includes(kind)) throw new Error(`Trigger no soportado: ${kind}`);
    if (kind === 'timer') {
      const s = Math.max(1, Math.round(Number(a.trigger.everySec) || 0));
      if (!(s >= 1 && s <= 86400)) throw new Error('everySec debe estar entre 1 y 86400');
    }
    if (kind === 'var' && !a.trigger.varName) throw new Error('Trigger var sin varName');
    if (kind === 'event' && !a.trigger.event) throw new Error('Trigger event sin event');
    const full: Automation = {
      id: a.id ?? uuidv4(),
      name: String(a.name ?? 'Sin nombre'),
      enabled: a.enabled !== false,
      trigger: a.trigger,
      scriptId: a.scriptId,
      nodes: a.nodes,
      inputs: a.inputs,
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    const prev = this.flowStore.getAutomation(full.id);
    if (prev) full.created_at = (prev as any).created_at ?? full.created_at;
    this.flowStore.saveAutomation(full);
    this.automationManager.reload(this.safeListAutomations());
    this.db.addLog({ level: 'info', message: `Automatización guardada: ${full.name}`, meta: { automationId: full.id }, ts: Date.now() });
    return full;
  }

  public deleteAutomation(id: string): void {
    this.flowStore.deleteAutomation(id);
    this.automationManager.reload(this.safeListAutomations());
  }

  /** Dispara automatizaciones `event` manualmente (API/UI). */
  public emitAutomationEvent(event: string, payload: any = {}): void {
    try {
      this.automationManager.handleEvent(event, payload, this.safeListAutomations());
    } catch { /* mejor esfuerzo */ }
  }

  /** Ejecuta reglas `load` de la página (al abrirla). */
  public handlePageLoad(pageId: string): void {
    try {
      this.automationManager.handlePageLoad(pageId, this.safeListAutomations());
    } catch { /* mejor esfuerzo */ }
  }

  private resyncTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Versión diferida de `resyncButtonAutomations` para el camino caliente
   * (POST/PUT/DELETE/reorder de botones): una ráfaga de ediciones seguidas
   * (arrastrar una acción, mover/resize en libre, swaps) colapsa en UN solo
   * reescaneo en vez de uno síncrono por escritura que retrase la respuesta
   * HTTP. El estado persistido ya está al día; el resync solo reconstruye
   * timers de reglas en memoria, así que diferirlo es seguro.
   */
  public scheduleResyncButtonAutomations(delayMs: number = 250): void {
    if (this.resyncTimer) return; // ya hay una programada: coalesca
    this.resyncTimer = setTimeout(() => {
      this.resyncTimer = null;
      try {
        this.resyncButtonAutomations();
      } catch { /* mejor esfuerzo */ }
    }, Math.max(0, delayMs));
  }

  /** Releer todas las teclas y sincronizar reglas load/timer/var. */
  public resyncButtonAutomations(): void {
    const buttons: Array<{ id: string; page_id: string; position: number; data: any }> = [];
    try {
      for (const profile of this.db.getProfiles() ?? []) {
        for (const page of this.db.getPagesByProfile(profile.id) ?? []) {
          for (const b of this.db.getButtonsByPage(page.id) ?? []) {
            buttons.push({ id: b.id, page_id: (b as any).page_id ?? page.id, position: (b as any).position ?? 0, data: (b as any).data });
          }
        }
      }
    } catch { /* sin BD: nada que sincronizar */ }
    this.automationManager.syncButtons(buttons);
  }

  public dispose(): void {
    console.log('🧹 Cleaning up ActionRunner...');

    if (this.resyncTimer) {
      clearTimeout(this.resyncTimer);
      this.resyncTimer = null;
    }

    try {
      this.automationManager.stopAll();
    } catch { /* mejor esfuerzo */ }

    // Dispose all native plugins
    for (const plugin of this.nativePlugins) {
      plugin.dispose();
    }

    this.nativePlugins = [];
    this.actionHandlers.clear();
    this.runningActions.clear();
    this.lastExecution.clear();
  }
}