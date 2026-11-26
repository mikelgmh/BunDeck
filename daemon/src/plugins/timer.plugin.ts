/**
 * Native Timer Plugin (Pomodoro)
 * start/stop/status con estado en memoria + persistencia en ajustes.
 * Emite tick por WS (best-effort) mientras corre y avisa al terminar.
 */

export interface PluginContext {
    log: (level: string, message: string, meta?: any) => void
    getSetting?: (key: string) => string | null
    setSetting?: (key: string, value: string) => void
    deleteSetting?: (key: string) => void
}

export interface ActionHandler {
    (params: any, context: any): Promise<any>
}

type TimerMode = 'work' | 'break' | 'custom'
type TimerStatus = 'idle' | 'running' | 'paused' | 'finished'

export interface TimerState {
    status: TimerStatus
    mode: TimerMode
    label: string
    totalMs: number
    endsAt: number | null
    remainingMs: number
    startedAt: number | null
    finishedAt: number | null
}

const IDLE: TimerState = {
    status: 'idle', mode: 'work', label: '', totalMs: 0,
    endsAt: null, remainingMs: 0, startedAt: null, finishedAt: null,
}

export function remainingOf(state: TimerState, nowMs: number = Date.now()): number {
    if (state.status !== 'running' || !state.endsAt) return Math.max(0, state.remainingMs)
    return Math.max(0, state.endsAt - nowMs)
}

/** "25:00" / "04:07". Función pura (testeable). */
export function formatRemaining(ms: number): string {
    const total = Math.max(0, Math.ceil(ms / 1000))
    const m = Math.floor(total / 60)
    const s = total % 60
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export class TimerPlugin {
    private context: PluginContext
    private state: TimerState = { ...IDLE }
    private ticker: ReturnType<typeof setInterval> | null = null

    constructor(context: PluginContext) {
        this.context = context
        this.restore()
    }

    public getManifest() {
        return {
            id: 'timer',
            name: 'Temporizador',
            version: '1.0.1',
            description: 'Pomodoro: inicia, detiene y consulta un temporizador de trabajo/descanso',
            author: 'BunDeck',
            permissions: ['system'],
            settingsSchema: {
                type: 'object',
                properties: {
                    workMinutes: {
                        type: 'number', title: 'Minutos de trabajo', default: 25, minimum: 1, maximum: 480,
                        ui: { component: 'input', type: 'number', min: 1, max: 480, placeholder: '25' }
                    },
                    breakMinutes: {
                        type: 'number', title: 'Minutos de descanso', default: 5, minimum: 1, maximum: 180,
                        ui: { component: 'input', type: 'number', min: 1, max: 180, placeholder: '5' }
                    }
                }
            },
            instructions:
                'Temporizador tipo Pomodoro.\n\n' +
                '· "start" con mode work/break (usa los minutos de ajustes) o custom con "minutes".\n' +
                '· "stop" lo detiene y guarda lo restante; "status" devuelve el tiempo restante.\n' +
                '· Mientras corre emite "timer.tick" por WebSocket cada segundo (topic "timers") y "timer.finished" al terminar.',
            actions: [
                {
                    id: 'start',
                    name: 'Iniciar',
                    description: 'Inicia el temporizador (trabajo, descanso o personalizado)',
                    icon: 'Play',
                    surface: 'control',
                    component: 'pomodoro',
                    freeModeOnly: true,
                    schema: {
                        type: 'object',
                        properties: {
                            mode: {
                                type: 'string', title: 'Modo',
                                enum: ['work', 'break', 'custom'],
                                default: 'work',
                                ui: {
                                    component: 'select',
                                    options: [
                                        { value: 'work', label: 'Trabajo' },
                                        { value: 'break', label: 'Descanso' },
                                        { value: 'custom', label: 'Personalizado' },
                                    ]
                                }
                            },
                            workMinutes: {
                                type: 'number', title: 'Minutos de trabajo',
                                description: 'Si se omite se usa el de ajustes',
                                minimum: 1, maximum: 480,
                                ui: { component: 'input', type: 'number', min: 1, max: 480, placeholder: '25' }
                            },
                            breakMinutes: {
                                type: 'number', title: 'Minutos de descanso',
                                description: 'Si se omite se usa el de ajustes',
                                minimum: 1, maximum: 180,
                                ui: { component: 'input', type: 'number', min: 1, max: 180, placeholder: '5' }
                            },
                            minutes: {
                                type: 'number', title: 'Minutos (custom)',
                                description: 'Duración para mode=custom',
                                minimum: 1, maximum: 480,
                                ui: { component: 'input', type: 'number', min: 1, max: 480, placeholder: '15' }
                            },
                            label: {
                                type: 'string', title: 'Etiqueta',
                                ui: { component: 'input', type: 'text', placeholder: 'Enfoque profundo' }
                            }
                        }
                    }
                },
                {
                    id: 'stop',
                    name: 'Detener',
                    description: 'Detiene el temporizador (guarda lo restante)',
                    icon: 'Square',
                    surface: 'control',
                    component: 'pomodoro',
                    freeModeOnly: true,
                    schema: { type: 'object', properties: {} }
                },
                {
                    id: 'status',
                    name: 'Estado',
                    description: 'Devuelve el estado y el tiempo restante',
                    icon: 'Hourglass',
                    surface: 'control',
                    component: 'pomodoro',
                    freeModeOnly: true,
                    schema: { type: 'object', properties: {} }
                }
            ]
        }
    }

    public getActionHandlers(): Map<string, ActionHandler> {
        const handlers = new Map<string, ActionHandler>()
        handlers.set('start', this.executeStart.bind(this))
        handlers.set('stop', this.executeStop.bind(this))
        handlers.set('status', this.executeStatus.bind(this))
        return handlers
    }

    private numSetting(key: string, fallback: number): number {
        try {
            const v = Number(this.context.getSetting?.(key))
            if (Number.isFinite(v) && v > 0) return v
        } catch { /* fallback */ }
        return fallback
    }

    private persist(): void {
        try {
            this.context.setSetting?.('state', JSON.stringify(this.state))
        } catch { /* mejor esfuerzo */ }
    }

    private restore(): void {
        try {
            const raw = this.context.getSetting?.('state')
            if (!raw) return
            const s = JSON.parse(raw) as TimerState
            if (!s || typeof s !== 'object') return
            if (s.status === 'running' && s.endsAt) {
                if (Date.now() >= s.endsAt) {
                    this.state = { ...s, status: 'finished', remainingMs: 0, finishedAt: s.endsAt }
                } else {
                    this.state = s
                    this.ensureTicker()
                }
            } else if (s.status === 'paused' || s.status === 'finished') {
                this.state = { ...s, endsAt: null }
            }
            this.persist()
        } catch { /* estado corrupto: se ignora */ }
    }

    private snapshot(nowMs: number = Date.now()): any {
        const remaining = remainingOf(this.state, nowMs)
        return {
            status: this.state.status,
            mode: this.state.mode,
            label: this.state.label,
            totalMs: this.state.totalMs,
            remainingMs: remaining,
            remaining: formatRemaining(remaining),
            endsAt: this.state.endsAt,
        }
    }

    private async executeStart(params: any, _context: any): Promise<any> {
        const { mode = 'work', workMinutes, breakMinutes, minutes, label } = params ?? {}
        if (!['work', 'break', 'custom'].includes(mode)) {
            throw new Error(`Modo no válido: "${mode}". Usa work, break o custom.`)
        }
        let totalMin: number
        if (mode === 'work') totalMin = typeof workMinutes === 'number' ? workMinutes : this.numSetting('workMinutes', 25)
        else if (mode === 'break') totalMin = typeof breakMinutes === 'number' ? breakMinutes : this.numSetting('breakMinutes', 5)
        else {
            if (typeof minutes !== 'number' || !(minutes > 0)) throw new Error('Para mode=custom indica "minutes" (número > 0).')
            totalMin = minutes
        }
        if (!(totalMin >= 1 && totalMin <= 480)) {
            throw new Error('La duración debe estar entre 1 y 480 minutos.')
        }
        const now = Date.now()
        const totalMs = Math.round(totalMin * 60_000)
        this.state = {
            status: 'running', mode, label: typeof label === 'string' ? label : '',
            totalMs, endsAt: now + totalMs, remainingMs: totalMs, startedAt: now, finishedAt: null,
        }
        this.persist()
        this.ensureTicker()
        this.context.log('info', `Temporizador iniciado: ${mode} ${totalMin} min`, { label: this.state.label })
        this.broadcast('timer.started', this.snapshot(now))
        return { started: true, ...this.snapshot(now) }
    }

    private async executeStop(_params: any, _context: any): Promise<any> {
        if (this.state.status !== 'running' && this.state.status !== 'paused') {
            return { stopped: false, ...this.snapshot(), hint: 'No hay ningún temporizador en marcha.' }
        }
        const remaining = remainingOf(this.state)
        this.state = { ...this.state, status: 'paused', remainingMs: remaining, endsAt: null }
        this.persist()
        this.stopTicker()
        this.context.log('info', `Temporizador detenido (${formatRemaining(remaining)} restantes)`)
        const snap = this.snapshot()
        this.broadcast('timer.stopped', snap)
        return { stopped: true, ...snap }
    }

    private async executeStatus(_params: any, _context: any): Promise<any> {
        this.checkExpiry()
        return this.snapshot()
    }

    private ensureTicker(): void {
        if (this.ticker) return
        this.ticker = setInterval(() => this.tick(), 1000)
        if (typeof (this.ticker as any).unref === 'function') (this.ticker as any).unref()
    }

    private stopTicker(): void {
        if (this.ticker) clearInterval(this.ticker)
        this.ticker = null
    }

    /** Avance del reloj: emite tick y detecta el fin. Público para tests. */
    public tick(nowMs: number = Date.now()): void {
        if (this.state.status !== 'running') return
        if (this.state.endsAt && nowMs >= this.state.endsAt) {
            this.state = { ...this.state, status: 'finished', remainingMs: 0, finishedAt: nowMs, endsAt: null }
            this.persist()
            this.stopTicker()
            this.context.log('info', `Temporizador terminado: ${this.state.mode}${this.state.label ? ` (${this.state.label})` : ''}`)
            this.broadcast('timer.finished', this.snapshot(nowMs))
            return
        }
        this.broadcast('timer.tick', this.snapshot(nowMs))
    }

    private checkExpiry(): void {
        if (this.state.status === 'running' && this.state.endsAt && Date.now() >= this.state.endsAt) {
            this.tick(Date.now())
        }
    }

    private broadcast(type: string, payload: any): void {
        try {
            ;(globalThis as any).__libredeckWs?.broadcast?.(type, payload, 'timers')
        } catch { /* sin WS: mejor esfuerzo */ }
    }

    public dispose(): void {
        this.stopTicker()
        this.persist()
    }
}
