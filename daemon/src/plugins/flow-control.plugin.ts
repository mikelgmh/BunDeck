/**
 * Native Flow Plugin — primitivas del motor de flujos usables también como
 * acciones sueltas (`data.actions`) y en secuencias legacy:
 * wait, set-var, toggle-var, get-var, log.
 *
 * Las escrituras de variables pasan por los hooks del ActionRunner para que
 * disparen automatizaciones `var` y el broadcast `var.changed`.
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

export interface FlowVarHooks {
    getVar(name: string): { name: string; type: string; value: any } | undefined;
    setVar(name: string, value: any): boolean;
}

const MAX_WAIT_MS = 120000;

function coerceVarValue(type: string, value: any): any {
    if (type === 'num') {
        const n = typeof value === 'number' ? value : Number(value);
        return Number.isFinite(n) ? n : 0;
    }
    if (type === 'bool') {
        return value === true || value === 'true' || value === '1' || (typeof value === 'number' && value !== 0);
    }
    return value === undefined || value === null ? '' : String(value);
}

export class FlowControlPlugin {
    private context: PluginContext
    private hooks: FlowVarHooks | null = null

    constructor(context: PluginContext) {
        this.context = context
    }

    public setVarHooks(hooks: FlowVarHooks): void {
        this.hooks = hooks
    }

    public getManifest() {
        return {
            id: 'flow',
            name: 'Flujos',
            version: '1.0.1',
            description: 'Primitivas del motor de flujos: esperas, variables y registro',
            author: 'BunDeck',
            permissions: ['system', 'utility'],
            actions: [
                {
                    id: 'wait',
                    name: 'Esperar',
                    description: 'Pausa la ejecución durante N milisegundos',
                    i18n: { es: { name: 'Esperar', description: 'Pausa la ejecución durante N milisegundos' }, en: { name: 'Esperar', description: 'Pausa la ejecución durante N milisegundos' } }, // TODO i18n: EN temporal = ES
                    icon: 'Timer',
                    schema: {
                        type: 'object',
                        properties: {
                            ms: {
                                type: 'number', title: 'Milisegundos',
                                description: 'Tiempo de espera (0-120000)',
                                default: 1000, minimum: 0, maximum: MAX_WAIT_MS,
                                ui: { component: 'input', type: 'number', min: 0, max: MAX_WAIT_MS, placeholder: '1000' }
                            }
                        }
                    }
                },
                {
                    id: 'set-var',
                    name: 'Fijar variable',
                    description: 'Asigna un valor a una variable global del motor de flujos',
                    i18n: { es: { name: 'Fijar variable', description: 'Asigna un valor a una variable global del motor de flujos' }, en: { name: 'Fijar variable', description: 'Asigna un valor a una variable global del motor de flujos' } }, // TODO i18n: EN temporal = ES
                    icon: 'Variable',
                    surface: 'control',
                    component: 'workflow-control',
                    schema: {
                        type: 'object',
                        required: ['name'],
                        properties: {
                            name: { type: 'string', title: 'Variable', ui: { component: 'input', type: 'text', placeholder: 'contador' } },
                            value: { type: 'string', title: 'Valor (admite {{expresiones}})', ui: { component: 'input', type: 'text', placeholder: 'contador + 1' } },
                            type: {
                                type: 'string', title: 'Tipo si es nueva', enum: ['num', 'bool', 'txt'], default: 'num',
                                ui: { component: 'select', options: [{ value: 'num', label: 'Número' }, { value: 'bool', label: 'Booleano' }, { value: 'txt', label: 'Texto' }] }
                            }
                        }
                    }
                },
                {
                    id: 'toggle-var',
                    name: 'Alternar variable',
                    description: 'Alterna una variable booleana (o 0/1, o vacío/«sí»)',
                    i18n: { es: { name: 'Alternar variable', description: 'Alterna una variable booleana (o 0/1, o vacío/«sí»)' }, en: { name: 'Alternar variable', description: 'Alterna una variable booleana (o 0/1, o vacío/«sí»)' } }, // TODO i18n: EN temporal = ES
                    icon: 'ToggleLeft',
                    surface: 'control',
                    component: 'workflow-control',
                    schema: {
                        type: 'object',
                        required: ['name'],
                        properties: {
                            name: { type: 'string', title: 'Variable', ui: { component: 'input', type: 'text', placeholder: 'micSilenciado' } }
                        }
                    }
                },
                {
                    id: 'get-var',
                    name: 'Leer variable',
                    description: 'Devuelve el valor actual de una variable global',
                    i18n: { es: { name: 'Leer variable', description: 'Devuelve el valor actual de una variable global' }, en: { name: 'Leer variable', description: 'Devuelve el valor actual de una variable global' } }, // TODO i18n: EN temporal = ES
                    icon: 'Eye',
                    surface: 'control',
                    component: 'workflow-control',
                    schema: {
                        type: 'object',
                        required: ['name'],
                        properties: {
                            name: { type: 'string', title: 'Variable', ui: { component: 'input', type: 'text', placeholder: 'contador' } }
                        }
                    }
                },
                {
                    id: 'log',
                    name: 'Registrar',
                    description: 'Escribe una entrada en el registro del daemon',
                    i18n: { es: { name: 'Registrar', description: 'Escribe una entrada en el registro del daemon' }, en: { name: 'Registrar', description: 'Escribe una entrada en el registro del daemon' } }, // TODO i18n: EN temporal = ES
                    icon: 'ScrollText',
                    schema: {
                        type: 'object',
                        properties: {
                            level: {
                                type: 'string', title: 'Nivel', enum: ['info', 'warn', 'error'], default: 'info',
                                ui: { component: 'select', options: [{ value: 'info', label: 'Info' }, { value: 'warn', label: 'Aviso' }, { value: 'error', label: 'Error' }] }
                            },
                            message: { type: 'string', title: 'Mensaje (admite {{expresiones}})', ui: { component: 'input', type: 'text', placeholder: 'hola {{contador}}' } }
                        }
                    }
                }
            ]
        }
    }

    public getActionHandlers(): Map<string, ActionHandler> {
        const handlers = new Map<string, ActionHandler>()
        handlers.set('wait', this.executeWait.bind(this))
        handlers.set('set-var', this.executeSetVar.bind(this))
        handlers.set('toggle-var', this.executeToggleVar.bind(this))
        handlers.set('get-var', this.executeGetVar.bind(this))
        handlers.set('log', this.executeLog.bind(this))
        return handlers
    }

    private async executeWait(params: any, _context: any): Promise<any> {
        const ms = Math.min(Math.max(0, Number(params?.ms ?? 1000) || 0), MAX_WAIT_MS)
        await new Promise((r) => setTimeout(r, ms))
        return { waitedMs: ms }
    }

    private async executeSetVar(params: any, _context: any): Promise<any> {
        const name = String(params?.name ?? '').trim()
        if (!name) throw new Error('flow.set-var requiere "name"')
        if (!this.hooks) throw new Error('flow.set-var sin motor de flujos (hooks no inyectados)')
        // El valor puede traer {{expresiones}}: el motor ya interpola los
        // parámetros string antes de llamar al handler, así que aquí llega
        // resuelto; si el hook no existe en global, setVar crea num/bool/txt.
        const existing = this.hooks.getVar(name)
        const type = existing?.type ?? (params?.type ?? 'num')
        const value = coerceVarValue(type, params?.value)
        this.hooks.setVar(name, value)
        return { name, value }
    }

    private async executeToggleVar(params: any, _context: any): Promise<any> {
        const name = String(params?.name ?? '').trim()
        if (!name) throw new Error('flow.toggle-var requiere "name"')
        if (!this.hooks) throw new Error('flow.toggle-var sin motor de flujos (hooks no inyectados)')
        const cur = this.hooks.getVar(name)?.value
        const next = typeof cur === 'boolean' ? !cur : typeof cur === 'number' ? (cur ? 0 : 1) : cur ? '' : 'sí'
        this.hooks.setVar(name, next)
        return { name, value: next }
    }

    private async executeGetVar(params: any, _context: any): Promise<any> {
        const name = String(params?.name ?? '').trim()
        if (!name) throw new Error('flow.get-var requiere "name"')
        if (!this.hooks) throw new Error('flow.get-var sin motor de flujos (hooks no inyectados)')
        const v = this.hooks.getVar(name)
        if (!v) throw new Error(`Variable desconocida «${name}»`)
        return { name, value: v.value, type: v.type }
    }

    private async executeLog(params: any, _context: any): Promise<any> {
        const level = ['info', 'warn', 'error'].includes(params?.level) ? params.level : 'info'
        // El motor ya interpoló {{...}} en los parámetros string.
        this.context.log(level, String(params?.message ?? ''), { flowAction: true })
        return { logged: true }
    }

    public dispose(): void {
        // Sin recursos persistentes
    }
}
