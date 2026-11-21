/**
 * Native Utility Plugin
 * Utility actions like delay, etc.
 */

export interface PluginContext {
    log: (level: string, message: string, meta?: any) => void
}

export interface ActionHandler {
    (params: any, context: any): Promise<any>
}

export class UtilityPlugin {
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
            id: 'utility',
            name: 'Utility Actions',
            version: '1.0.0',
            description: 'Utility actions for delays and more',
            author: 'BunDeck',
            permissions: ['system', 'utility'],
            actions: [
                {
                    id: 'delay',
                    name: 'Delay',
                    description: 'Wait for a specified duration',
                    icon: 'Clock',
                    schema: {
                        type: 'object',
                        properties: {
                            duration: {
                                type: 'number',
                                title: 'Duración (milisegundos)',
                                description: 'Delay duration in milliseconds',
                                default: 1000,
                                minimum: 0,
                                maximum: 60000,
                                ui: {
                                    component: 'input',
                                    type: 'number',
                                    min: 0,
                                    max: 60000,
                                    placeholder: '1000'
                                }
                            }
                        }
                    }
                },
                {
                    id: 'macro',
                        name: 'Macro rápida',
                        description: 'Ejecuta una secuencia de acciones en orden',
                        icon: 'ListOrdered',
                        schema: {
                            type: 'object',
                            required: ['steps'],
                            properties: {
                                steps: {
                                    type: 'array',
                                    title: 'Pasos de la macro',
                                    description: 'Lista de acciones a ejecutar en secuencia (mínimo 1, máximo 50). No se permiten macros anidadas.',
                                    minItems: 1,
                                    maxItems: 50,
                                    items: {
                                        type: 'object',
                                        required: ['type'],
                                        properties: {
                                            type: {
                                                type: 'string',
                                                title: 'Tipo de acción',
                                                description: "Identificador de la acción (ej 'utility.delay' o 'multimedia.multimedia')",
                                                examples: ['utility.delay', 'multimedia.multimedia']
                                            },
                                            parameters: {
                                                type: 'object',
                                                title: 'Parámetros',
                                                description: 'Parámetros de la acción del paso',
                                                default: {}
                                            },
                                            timeout: {
                                                type: 'number',
                                                title: 'Tiempo límite del paso (ms)',
                                                description: 'Tiempo máximo de espera para este paso en milisegundos. Si se omite, se usa el del ejecutor.',
                                                minimum: 0,
                                                maximum: 120000
                                            }
                                        }
                                    },
                                    ui: {
                                        component: 'list',
                                        addLabel: 'Añadir paso',
                                        placeholder: 'Añade al menos un paso'
                                    }
                                },
                                stopOnError: {
                                    type: 'boolean',
                                    title: 'Detener si hay error',
                                    description: 'Si está activado, la macro se detiene al primer paso fallido',
                                    default: true,
                                    ui: {
                                        component: 'switch'
                                    }
                                },
                                context: {
                                    type: 'object',
                                    title: 'Contexto extra',
                                    description: 'Campos adicionales que se mezclan en el contexto de cada paso (opcional)',
                                    default: {},
                                    ui: {
                                        component: 'textarea',
                                        placeholder: '{"pressType": "short"}'
                                    }
                                }
                            }
                        }
                    }
            ]
        }
    }

    public getActionHandlers(): Map<string, ActionHandler> {
        const handlers = new Map<string, ActionHandler>()
        handlers.set('delay', this.executeDelayAction.bind(this))
        handlers.set('macro', this.executeMacroAction.bind(this))
        return handlers
    }

    private async executeDelayAction(params: any, context: any): Promise<any> {
        const { duration = 1000 } = params

        this.context.log('info', `Delaying for ${duration}ms`)

        await new Promise(resolve => setTimeout(resolve, duration))

        return { delayed: duration }
    }

    private static readonly MACRO_GLOBAL_TIMEOUT_MS = 120000

    private async executeMacroAction(params: any, context: any): Promise<any> {
        const { steps, stopOnError = true, context: extraContext = {} } = params ?? {}

        if (!this.actionExecutor) {
            throw new Error('macro requiere executor: no se ha inyectado ningún ejecutor de acciones (setActionExecutor)')
        }

        if (!Array.isArray(steps) || steps.length < 1 || steps.length > 50) {
            throw new Error('macro requiere "steps": array con entre 1 y 50 pasos')
        }

        for (let i = 0; i < steps.length; i++) {
            const step = steps[i]
            if (!step || typeof step !== 'object' || typeof step.type !== 'string' || step.type.length === 0) {
                throw new Error(`macro: el paso ${i} debe ser un objeto con "type" (string no vacío)`)
            }
            if (step.parameters !== undefined && (typeof step.parameters !== 'object' || step.parameters === null || Array.isArray(step.parameters))) {
                throw new Error(`macro: el paso ${i} tiene "parameters" inválidos (debe ser un objeto)`)
            }
        }

        const baseContext = {
            ...(context ?? {}),
            buttonId: context?.buttonId,
            pageId: context?.pageId,
            profileId: context?.profileId,
            ...(extraContext ?? {})
        }

        const runSteps = async () => {
            const results: Array<Record<string, any>> = []
            let completed = 0
            let failedStep: number | null = null

            for (let i = 0; i < steps.length; i++) {
                const step = steps[i]

                if (step.type === 'utility.macro') {
                    const failure = {
                        index: i,
                        type: step.type,
                        success: false,
                        error: 'macros anidadas no permitidas: un paso no puede ser utility.macro'
                    }
                    results.push(failure)
                    failedStep = failedStep ?? i
                    this.context.log('error', `Macro: paso ${i} (${step.type}) rechazado: macros anidadas no permitidas`)
                    if (stopOnError) break
                    continue
                }

                const stepContext = { ...baseContext, timestamp: Date.now() }
                const descriptor = {
                    type: step.type,
                    parameters: step.parameters ?? {}
                } as any
                if (typeof step.timeout === 'number') {
                    descriptor.timeout = step.timeout
                }

                try {
                    const invocation: Promise<any> = this.actionExecutor!(descriptor, stepContext)
                    const raw = typeof step.timeout === 'number'
                        ? await this.withTimeout(invocation, step.timeout, `macro: tiempo límite superado en el paso ${i} (${step.type})`)
                        : await invocation
                    const normalized = this.normalizeStepResult(raw)
                    results.push({ index: i, type: step.type, ...normalized })
                    if (normalized.success) {
                        completed++
                    } else {
                        failedStep = failedStep ?? i
                        this.context.log('error', `Macro: paso ${i} (${step.type}) fallido: ${normalized.error}`)
                        if (stopOnError) break
                    }
                } catch (error) {
                    const message = error instanceof Error ? error.message : 'Unknown error'
                    results.push({ index: i, type: step.type, success: false, error: message })
                    failedStep = failedStep ?? i
                    this.context.log('error', `Macro: paso ${i} (${step.type}) fallido: ${message}`)
                    if (stopOnError) break
                }
            }

            return { completed, total: steps.length, failedStep, results }
        }

        return await this.withTimeout(
            runSteps(),
            UtilityPlugin.MACRO_GLOBAL_TIMEOUT_MS,
            'macro: tiempo límite global de seguridad superado (120s)'
        )
    }

    private normalizeStepResult(raw: any): { success: boolean; result?: any; error?: string } {
        if (raw !== null && typeof raw === 'object' && typeof (raw as any).success === 'boolean') {
            const r = raw as { success: boolean; result?: any; error?: string }
            return r.success
                ? { success: true, result: r.result ?? raw }
                : { success: false, error: r.error ?? 'Unknown error' }
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
        // Cleanup if needed
    }
}
