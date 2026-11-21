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
  type NativePlugin
} from './plugins';
import { PluginSandbox } from './plugin-system/sandbox';

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
  pressType?: 'short' | 'long' | 'double';
}

export interface ActionResult {
  success: boolean;
  result?: any;
  error?: string;
  duration: number;
}

export class ActionRunner {
  private pluginLoader: PluginLoader;
  private db: DatabaseService;
  private runningActions: Map<string, Promise<ActionResult>> = new Map();
  private actionHandlers: Map<string, Function> = new Map();
  private lastExecution: Map<string, number> = new Map();
  private nativePlugins: NativePlugin[] = [];
  private sandbox = new PluginSandbox();

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
    this.loadNativePlugins();
    this.setupBuiltInActions();
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
    const multiactionPlugin = new MultiactionPlugin(this.makePluginContext('multiaction'));
    const profileAutoPlugin = new ProfileAutoPlugin(this.makePluginContext('profile-auto'));

    // Set action executor for utility plugin
    utilityPlugin.setActionExecutor(this.executeAction.bind(this));
    // Set action executor for multiaction plugin (usa el ActionRunner existente)
    multiactionPlugin.setActionExecutor(this.executeAction.bind(this));

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
      multiactionPlugin,
      profileAutoPlugin
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
    // All actions are now handled by native plugins
    // This method is kept for future non-plugin actions if needed
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

      // Log action start
      this.db.addLog({
        level: 'info',
        message: `Action started: ${action.type}`,
        meta: { action, context },
        ts: startTime
      });

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

      // Log result
      this.db.addLog({
        level: result.success ? 'info' : 'error',
        message: `Action ${result.success ? 'completed' : 'failed'}: ${action.type}`,
        meta: { action, context, result, duration },
        ts: Date.now()
      });

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

    const result = await handler(action.parameters || {}, context);

    return {
      success: true,
      result,
      duration: 0 // Will be set by caller
    };
  }

  private async executeWithTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number
  ): Promise<T> {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Action timeout')), timeoutMs);
    });

    return Promise.race([promise, timeoutPromise]);
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

  public dispose(): void {
    console.log('🧹 Cleaning up ActionRunner...');

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