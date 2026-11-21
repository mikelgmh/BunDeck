/**
 * Native Profile Auto Plugin
 * Cambio automático de perfil según la app activa: mapea app -> profileId,
 * sincroniza las reglas con el windowWatcher y restaura el perfil anterior.
 */

import { windowWatcher, type AutoSwitchRule } from '../window-watcher'

export interface PluginContext {
    log: (level: string, message: string, meta?: any) => void
    getSetting?: (key: string) => string | null
    setSetting?: (key: string, value: string) => void
    deleteSetting?: (key: string) => void
}

export interface ActionHandler {
    (params: any, context: any): Promise<any>
}

type Op = 'contains' | 'exact' | 'starts' | 'regex'
const OPS: Op[] = ['contains', 'exact', 'starts', 'regex']

let listenerAttached = false

export class ProfileAutoPlugin {
    private context: PluginContext

    constructor(context: PluginContext) {
        this.context = context
    }

    public getManifest() {
        return {
            id: 'profile-auto',
            name: 'Perfiles automáticos',
            version: '1.0.0',
            description: 'Cambia de perfil según la app activa y restaura el anterior',
            author: 'BunDeck',
            permissions: ['system'],
            instructions:
                'Cambio de perfil según la ventana activa.\n\n' +
                '· "add-rule": asocia una app (ej. "obs", "chrome.exe") con un profileId.\n' +
                '· "set-enabled" true: activa la vigilancia (usa el windowWatcher del daemon).\n' +
                '· Al cambiar solo, guarda el perfil anterior: "restore" vuelve a él.\n' +
                'El "op" controla cómo se compara el nombre del proceso: contains (defecto), exact, starts o regex.',
            actions: [
                {
                    id: 'add-rule',
                    name: 'Añadir regla',
                    description: 'Asocia una app con un perfil (cambio automático)',
                    icon: 'Plus',
                    schema: {
                        type: 'object',
                        properties: {
                            app: {
                                type: 'string', title: 'Aplicación',
                                description: 'Texto a buscar en el proceso (ej. "obs", "chrome")',
                                ui: { component: 'input', type: 'text', placeholder: 'obs' }
                            },
                            profileId: {
                                type: 'string', title: 'Perfil',
                                description: 'ID del perfil a activar',
                                ui: { component: 'input', type: 'text', placeholder: 'id-del-perfil' }
                            },
                            op: {
                                type: 'string', title: 'Comparación',
                                enum: OPS, default: 'contains',
                                ui: {
                                    component: 'select',
                                    options: [
                                        { value: 'contains', label: 'Contiene' },
                                        { value: 'exact', label: 'Exacta' },
                                        { value: 'starts', label: 'Empieza por' },
                                        { value: 'regex', label: 'Expresión regular' },
                                    ]
                                }
                            }
                        },
                        required: ['app', 'profileId']
                    }
                },
                {
                    id: 'remove-rule',
                    name: 'Quitar regla',
                    description: 'Elimina la regla de una app',
                    icon: 'Trash2',
                    schema: {
                        type: 'object',
                        properties: {
                            app: {
                                type: 'string', title: 'Aplicación',
                                ui: { component: 'input', type: 'text', placeholder: 'obs' }
                            }
                        },
                        required: ['app']
                    }
                },
                {
                    id: 'list-rules',
                    name: 'Listar reglas',
                    description: 'Muestra las reglas app → perfil',
                    icon: 'List',
                    schema: { type: 'object', properties: {} }
                },
                {
                    id: 'set-enabled',
                    name: 'Activar / desactivar',
                    description: 'Activa o desactiva la vigilancia de la ventana activa',
                    icon: 'ToggleRight',
                    schema: {
                        type: 'object',
                        properties: {
                            enabled: {
                                type: 'boolean', title: 'Activado',
                                ui: { component: 'switch' }
                            }
                        },
                        required: ['enabled']
                    }
                },
                {
                    id: 'status',
                    name: 'Estado',
                    description: 'Indica si la vigilancia está activa y cuántas reglas hay',
                    icon: 'Info',
                    schema: { type: 'object', properties: {} }
                },
                {
                    id: 'switch-profile',
                    name: 'Cambiar de perfil',
                    description: 'Cambia manualmente al perfil indicado',
                    icon: 'UserCheck',
                    schema: {
                        type: 'object',
                        properties: {
                            profileId: {
                                type: 'string', title: 'Perfil',
                                description: 'ID del perfil a activar',
                                ui: { component: 'input', type: 'text', placeholder: 'id-del-perfil' }
                            }
                        },
                        required: ['profileId']
                    }
                },
                {
                    id: 'restore',
                    name: 'Restaurar perfil',
                    description: 'Vuelve al perfil anterior al último cambio automático',
                    icon: 'Undo2',
                    schema: { type: 'object', properties: {} }
                }
            ]
        }
    }

    public getActionHandlers(): Map<string, ActionHandler> {
        const handlers = new Map<string, ActionHandler>()
        handlers.set('add-rule', this.executeAddRule.bind(this))
        handlers.set('remove-rule', this.executeRemoveRule.bind(this))
        handlers.set('list-rules', this.executeListRules.bind(this))
        handlers.set('set-enabled', this.executeSetEnabled.bind(this))
        handlers.set('status', this.executeStatus.bind(this))
        handlers.set('switch-profile', this.executeSwitchProfile.bind(this))
        handlers.set('restore', this.executeRestore.bind(this))
        return handlers
    }

    private readRules(): AutoSwitchRule[] {
        try {
            const raw = this.context.getSetting?.('rules')
            if (!raw) return []
            const parsed = JSON.parse(raw)
            return Array.isArray(parsed) ? parsed.filter(r => r && typeof r === 'object') : []
        } catch {
            return []
        }
    }

    private writeRules(rules: AutoSwitchRule[]): void {
        this.context.setSetting?.('rules', JSON.stringify(rules))
    }

    private isEnabled(): boolean {
        try {
            return this.context.getSetting?.('enabled') === '1'
        } catch {
            return false
        }
    }

    private syncWatcher(): void {
        try {
            if (this.isEnabled()) {
                windowWatcher.updateRules(this.readRules())
            }
        } catch (error) {
            this.context.log('warn', `Perfiles auto: no se pudo sincronizar el watcher: ${error instanceof Error ? error.message : String(error)}`)
        }
    }

    private attachListener(): void {
        if (listenerAttached) return
        listenerAttached = true
        try {
            windowWatcher.on('profile-switch', (profileId: string, window: any) => {
                try {
                    this.context.setSetting?.('lastSwitch', JSON.stringify({
                        to: profileId,
                        ts: Date.now(),
                        window: window ? { processName: window.processName ?? null, title: window.title ?? null } : null,
                    }))
                    this.context.log('info', `Perfiles auto: cambio a perfil ${profileId}`, { window })
                } catch { /* mejor esfuerzo */ }
                this.broadcast('profile-auto.switched', { profileId, window: window ?? null })
            })
        } catch { /* sin watcher: se ignora */ }
    }

    private broadcast(type: string, payload: any): void {
        try {
            ;(globalThis as any).__libredeckWs?.broadcast?.(type, payload, 'profiles')
        } catch { /* sin WS: mejor esfuerzo */ }
    }

    private async executeAddRule(params: any, _context: any): Promise<any> {
        const { app, profileId, op = 'contains' } = params ?? {}
        if (typeof app !== 'string' || app.trim().length === 0) {
            throw new Error('Indica la "app" (texto a buscar en el proceso, ej. "obs").')
        }
        if (typeof profileId !== 'string' || profileId.trim().length === 0) {
            throw new Error('Indica el "profileId" del perfil a activar.')
        }
        if (!OPS.includes(op)) {
            throw new Error(`"op" no válido: "${op}". Usa uno de: ${OPS.join(', ')}.`)
        }
        if (op === 'regex') {
            try { new RegExp(app) } catch {
                throw new Error(`La expresión regular "${app}" no es válida.`)
            }
        }
        const rules = this.readRules()
        const needle = app.trim().toLowerCase()
        const existing = rules.findIndex(r => (r.value ?? '').toLowerCase() === needle)
        const rule: AutoSwitchRule = {
            id: `rule-${needle}`,
            profileId: profileId.trim(),
            target: 'app',
            op,
            value: app.trim(),
            enabled: true,
        }
        if (existing >= 0) rules[existing] = rule
        else rules.push(rule)
        this.writeRules(rules)
        this.syncWatcher()
        this.context.log('info', `Perfiles auto: regla "${app}" -> perfil ${profileId}`, { op })
        return { added: true, rule: { app: rule.value, profileId: rule.profileId, op }, total: rules.length }
    }

    private async executeRemoveRule(params: any, _context: any): Promise<any> {
        const { app } = params ?? {}
        if (typeof app !== 'string' || app.trim().length === 0) {
            throw new Error('Indica la "app" de la regla a eliminar.')
        }
        const needle = app.trim().toLowerCase()
        const rules = this.readRules()
        const next = rules.filter(r => (r.value ?? '').toLowerCase() !== needle)
        if (next.length === rules.length) {
            throw new Error(`No hay ninguna regla para "${app}". Usa "list-rules" para verlas.`)
        }
        this.writeRules(next)
        this.syncWatcher()
        this.context.log('info', `Perfiles auto: regla "${app}" eliminada`)
        return { removed: true, app: app.trim(), total: next.length }
    }

    private async executeListRules(_params: any, _context: any): Promise<any> {
        const rules = this.readRules()
        return {
            rules: rules.map(r => ({ app: r.value, profileId: r.profileId, op: r.op ?? 'contains', enabled: r.enabled !== false })),
            count: rules.length,
            enabled: this.isEnabled(),
        }
    }

    private async executeSetEnabled(params: any, _context: any): Promise<any> {
        const { enabled } = params ?? {}
        if (typeof enabled !== 'boolean') {
            throw new Error('Indica "enabled" (booleano).')
        }
        this.context.setSetting?.('enabled', enabled ? '1' : '0')
        const rules = this.readRules()
        try {
            if (enabled) {
                this.attachListener()
                if (!windowWatcher.isActive()) windowWatcher.startWatching(rules)
                else windowWatcher.updateRules(rules)
                this.context.log('info', `Perfiles auto: vigilancia activada (${rules.length} reglas)`)
            } else {
                // Vaciar reglas en el watcher sin detenerlo (menos invasivo si el
                // servidor lo usa para su propio auto-switch).
                windowWatcher.updateRules([])
                this.context.log('info', 'Perfiles auto: vigilancia desactivada')
            }
        } catch (error) {
            throw new Error(`No se pudo ${enabled ? 'activar' : 'desactivar'} la vigilancia: ${error instanceof Error ? error.message : String(error)}`)
        }
        return { enabled, rules: rules.length, watching: windowWatcher.isActive() }
    }

    private async executeStatus(_params: any, _context: any): Promise<any> {
        return {
            enabled: this.isEnabled(),
            watching: windowWatcher.isActive(),
            rules: this.readRules().length,
            lastSwitch: this.lastSwitch(),
        }
    }

    private lastSwitch(): any {
        try {
            const raw = this.context.getSetting?.('lastSwitch')
            return raw ? JSON.parse(raw) : null
        } catch {
            return null
        }
    }

    private async executeSwitchProfile(params: any, _context: any): Promise<any> {
        const { profileId } = params ?? {}
        if (typeof profileId !== 'string' || profileId.trim().length === 0) {
            throw new Error('Indica el "profileId" del perfil a activar.')
        }
        const id = profileId.trim()
        try {
            windowWatcher.setCurrentProfile(id)
        } catch { /* mejor esfuerzo */ }
        this.context.log('info', `Perfiles auto: cambio manual a perfil ${id}`)
        // El API lo difunde como profile.navigate (igual que page.navigate).
        return { success: true, action: 'navigate_to_profile', profileId: id, switched: true }
    }

    private async executeRestore(_params: any, _context: any): Promise<any> {
        const prev = (() => {
            try {
                const raw = this.context.getSetting?.('previousProfile')
                return typeof raw === 'string' && raw.length > 0 ? raw : null
            } catch {
                return null
            }
        })()
        if (!prev) {
            throw new Error('No hay perfil anterior que restaurar (aún no hubo ningún cambio automático).')
        }
        try {
            windowWatcher.setCurrentProfile(prev)
        } catch { /* mejor esfuerzo */ }
        this.context.log('info', `Perfiles auto: restaurado perfil ${prev}`)
        return { success: true, action: 'navigate_to_profile', profileId: prev, restored: true }
    }

    /**
     * Guarda el perfil actual como "anterior" antes de un cambio automático.
     * Lo llama el servidor/flujo que ejecute el cambio (best-effort).
     */
    public rememberPrevious(profileId: string): void {
        try {
            if (typeof profileId === 'string' && profileId.length > 0) {
                this.context.setSetting?.('previousProfile', profileId)
            }
        } catch { /* mejor esfuerzo */ }
    }

    public dispose(): void {
        // El watcher es singleton del daemon: no se detiene aquí.
    }
}
