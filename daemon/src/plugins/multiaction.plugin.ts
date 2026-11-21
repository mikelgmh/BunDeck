/**
 * Native Multi-action Plugin (CRÍTICO)
 * run-sequence: ejecuta una lista de {pluginId, actionId, params, delayMs, continueOnError}
 * usando el ActionRunner inyectado (igual que utility.macro). Incluye dry-run y validación.
 */

export interface PluginContext {
    log: (level: string, message: string, meta?: any) => void
}

export interface ActionHandler {
    (params: any, context: any): Promise<any>
}

export interface MultiStep {
    pluginId?: string
    actionId?: string
    /** Alternativa compacta: "pluginId.actionId" (ej. "utility.delay"). */
    type?: string
    params?: Record<string, any>
    /** Pausa previa en ms (0-60000). */
    delayMs?: number
    /** Si es true, el fallo de este paso no detiene la secuencia. */
    continueOnError?: boolean
    /** Tiempo límite del paso en ms (opcional). */
    timeout?: number
}

const MAX_STEPS = 50
const GLOBAL_TIMEOUT_MS = 120000
const MAX_DELAY_MS = 60000

/** IDs que no pueden aparecer como paso (recursión). */
function isNestedType(type: string): boolean {
    return type === 'multiaction.run-sequence' || type === 'utility.macro'
}

export class MultiactionPlugin {
    private context: PluginContext
    private actionExecutor: ((action: any, context: any) => Promise<any>) | null = null

    constructor(context: PluginContext) {
        this.context = context
    }

    public setActionExecutor(executor: (action: any, context: any) => Promise<any>) {
        this.actionExecutor = executor
    }

    public getManifest() {
        return {
            id: 'multiaction',
            name: 'Multi-acción',
            version: '1.0.0',
            description: 'Ejecuta una secuencia de acciones de cualquier plugin, con pausas y dry-run',
            author: 'BunDeck',
            permissions: ['system', 'utility'],
            actions: [
                {
                    id: 'run-sequence',
                    name: 'Ejecutar secuencia',
                    description: 'Secuencia de acciones de cualquier plugin con pausas entre pasos',
                    icon: 'Layers',
                    schema: {
                        type: 'object',
                        required: ['actions'],
                        properties: {
                            actions: {
                                type: 'array',
                                title: 'Acciones',
                                description: 'Pasos a ejecutar en orden (mínimo 1, máximo 50). No se permiten secuencias anidadas.',
                                minItems: 1,
                                maxItems: MAX_STEPS,
                                items: {
                                    type: 'object',
                                    required: ['pluginId', 'actionId'],
                                    properties: {
                                        pluginId: {
                                            type: 'string',
                                            title: 'Plugin',
                                            description: 'ID del plugin (ej. "utility", "obs", "hotkey")',
                                            examples: ['utility', 'obs', 'hotkey']
                                        },
                                        actionId: {
                                            type: 'string',
                                            title: 'Acción',
                                            description: 'ID de la acción dentro del plugin (ej. "delay", "scene")',
                                            examples: ['delay', 'scene', 'hotkey']
                                        },
                                        type: {
                                            type: 'string',
                                            title: 'Tipo compacto',
                                            description: 'Alternativa a pluginId+actionId: "plugin.accion" (ej. "utility.delay")'
                                        },
                                        params: {
                                            type: 'object',
                                            title: 'Parámetros',
                                            description: 'Parámetros de la acción',
                                            default: {}
                                        },
                                        delayMs: {
                                            type: 'number',
                                            title: 'Pausa previa (ms)',
                                            description: 'Espera antes de ejecutar este paso (0-60000)',
                                            minimum: 0,
                                            maximum: MAX_DELAY_MS
                                        },
                                        timeout: {
                                            type: 'number',
                                            title: 'Tiempo límite (ms)',
                                            description: 'Límite para este paso; si se supera, falla',
                                            minimum: 0,
                                            maximum: 120000
                                        },
                                        continueOnError: {
                                            type: 'boolean',
                                            title: 'Seguir si falla',
                                            description: 'Si está activado, el fallo de este paso no detiene la secuencia',
                                            default: false
                                        }
                                    }
                                },
                                ui: { component: 'list', addLabel: 'Añadir acción', placeholder: 'Añade al menos una acción' }
                            },
                            stopOnError: {
                                type: 'boolean',
                                title: 'Detener si hay error',
                                description: 'Detiene la secuencia al primer fallo (salvo pasos con "Seguir si falla")',
                                default: true,
                                ui: { component: 'switch' }
                            },
                            dryRun: {
                                type: 'boolean',
                                title: 'Simular (dry-run)',
                                description: 'Valida y muestra el plan sin ejecutar nada',
                                default: false,
                                ui: { component: 'switch' }
                            },
                            context: {
                                type: 'object',
                                title: 'Contexto extra',
                                description: 'Campos adicionales para el contexto de cada paso',
                                default: {},
                                ui: { component: 'textarea', placeholder: '{"pressType": "short"}' }
                            }
                        }
                    }
                }
            ]
        }
    }

    public getActionHandlers(): Map<string, ActionHandler> {
        const handlers = new Map<string, ActionHandler>()
        handlers.set('run-sequence', this.executeRunSequence.bind(this))
        return handlers
    }

    /** Resuelve y valida un paso a descriptor {type, parameters}. Lanza si es inválido. */
    private resolveStep(step: MultiStep, index: number): { type: string; parameters: Record<string, any> } {
        if (!step || typeof step !== 'object') {
            throw new Error(`El paso ${index} debe ser un objeto con pluginId+actionId (o "type").`)
        }
        let type: string | undefined
        if (typeof step.type === 'string' && step.type.length > 0) {
            type = step.type
        } else if (typeof step.pluginId === 'string' && typeof step.actionId === 'string'
            && step.pluginId.length > 0 && step.actionId.length > 0) {
            type = `${step.pluginId}.${step.actionId}`
        }
        if (!type || !/^[a-z0-9_-]+\.[a-z0-9_-]+$/i.test(type)) {
            throw new Error(`El paso ${index} necesita pluginId+actionId válidos (ej. pluginId "obs", actionId "scene") o "type" con formato "plugin.accion".`)
        }
        if (isNestedType(type)) {
            throw new Error(`El paso ${index} (${type}) no está permitido: las secuencias anidadas están prohibidas.`)
        }
        if (step.params !== undefined && (typeof step.params !== 'object' || step.params === null || Array.isArray(step.params))) {
            throw new Error(`El paso ${index} tiene "params" inválidos (debe ser un objeto).`)
        }
        if (step.delayMs !== undefined && (typeof step.delayMs !== 'number' || step.delayMs < 0 || step.delayMs > MAX_DELAY_MS)) {
            throw new Error(`El paso ${index} tiene "delayMs" inválido (0-${MAX_DELAY_MS}).`)
        }
        if (step.timeout !== undefined && (typeof step.timeout !== 'number' || step.timeout < 0 || step.timeout > 120000)) {
            throw new Error(`El paso ${index} tiene "timeout" inválido (0-120000).`)
        }
        if (step.continueOnError !== undefined && typeof step.continueOnError !== 'boolean') {
            throw new Error(`El paso ${index} tiene "continueOnError" inválido (debe ser booleano).`)
        }
        return { type, parameters: step.params ?? {} }
    }

    private async executeRunSequence(params: any, context: any): Promise<any> {
        const { actions, stopOnError = true, dryRun = false, context: extraContext = {} } = params ?? {}

        if (!Array.isArray(actions) || actions.length < 1 || actions.length > MAX_STEPS) {
            throw new Error(`"actions" debe ser un array con entre 1 y ${MAX_STEPS} pasos.`)
        }
        if (typeof stopOnError !== 'boolean') throw new Error('"stopOnError" debe ser booleano.')
        if (typeof dryRun !== 'boolean') throw new Error('"dryRun" debe ser booleano.')

        const resolved = actions.map((s: MultiStep, i: number) => ({ step: s, descriptor: this.resolveStep(s, i) }))

        if (dryRun) {
            this.context.log('info', `Multi-acción: dry-run con ${resolved.length} pasos (sin ejecutar)`)
            return {
                dryRun: true,
                total: resolved.length,
                plan: resolved.map(({ step, descriptor }, i) => ({
                    index: i,
                    type: descriptor.type,
                    parameters: descriptor.parameters,
                    delayMs: step.delayMs ?? 0,
                    continueOnError: step.continueOnError ?? false,
                })),
                hint: 'Simulación: no se ejecutó ninguna acción.',
            }
        }

        if (!this.actionExecutor) {
            throw new Error('run-sequence requiere executor: no se ha inyectado ningún ejecutor de acciones (setActionExecutor).')
        }

        const baseContext = {
            ...(context ?? {}),
            buttonId: context?.buttonId,
            pageId: context?.pageId,
            profileId: context?.profileId,
            ...(extraContext ?? {}),
        }

        const runSteps = async () => {
            const results: Array<Record<string, any>> = []
            let completed = 0
            let failedStep: number | null = null

            for (let i = 0; i < resolved.length; i++) {
                const { step, descriptor } = resolved[i]

                if (step.delayMs && step.delayMs > 0) {
                    await new Promise(r => setTimeout(r, step.delayMs))
                }

                const stepContext = { ...baseContext, timestamp: Date.now() }
                const invocation: any = { type: descriptor.type, parameters: descriptor.parameters }
                if (typeof step.timeout === 'number') invocation.timeout = step.timeout

                try {
                    const raw: any = typeof step.timeout === 'number'
                        ? await this.withTimeout(this.actionExecutor!(invocation, stepContext), step.timeout, `Multi-acción: tiempo límite superado en el paso ${i} (${descriptor.type})`)
                        : await this.actionExecutor!(invocation, stepContext)
                    const normalized = this.normalize(raw)
                    results.push({ index: i, type: descriptor.type, ...normalized })
                    if (normalized.success) {
                        completed++
                    } else {
                        failedStep = failedStep ?? i
                        this.context.log('error', `Multi-acción: paso ${i} (${descriptor.type}) fallido: ${normalized.error}`)
                        if (stopOnError && !step.continueOnError) break
                    }
                } catch (error) {
                    const message = error instanceof Error ? error.message : 'Unknown error'
                    results.push({ index: i, type: descriptor.type, success: false, error: message })
                    failedStep = failedStep ?? i
                    this.context.log('error', `Multi-acción: paso ${i} (${descriptor.type}) fallido: ${message}`)
                    if (stopOnError && !step.continueOnError) break
                }
            }

            return { completed, total: resolved.length, failedStep, results }
        }

        return await this.withTimeout(runSteps(), GLOBAL_TIMEOUT_MS, 'Multi-acción: tiempo límite global superado (120s)')
    }

    private normalize(raw: any): { success: boolean; result?: any; error?: string } {
        if (raw !== null && typeof raw === 'object' && typeof (raw as any).success === 'boolean') {
            const r = raw as { success: boolean; result?: any; error?: string }
            return r.success ? { success: true, result: r.result ?? raw } : { success: false, error: r.error ?? 'Unknown error' }
        }
        return { success: true, result: raw }
    }

    private withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
        let timer: ReturnType<typeof setTimeout> | undefined
        const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(message)), timeoutMs)
        })
        return Promise.race([promise, timeout]).finally(() => {
            if (timer !== undefined) clearTimeout(timer)
        }) as Promise<T>
    }

    public dispose(): void {
        // Sin recursos persistentes
    }
}
