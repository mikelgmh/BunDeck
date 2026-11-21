export interface ProfileData {
    id: string
    name: string
    created_at: number
    updated_at: number
    data: any
}

export interface PageData {
    id: string
    profile_id: string
    name: string
    order_idx: number
    is_folder: number // 1 = folder, 0 = page
    data: any
}

export interface ButtonEntity {
    id: string
    page_id: string
    position: number
    data: ButtonData
}

export interface ButtonData {
    label: string
    textTop?: string
    textBottom?: string
    fontSize?: number
    emoji: string
    icon?: string
    backgroundColor: string
    textColor: string
    actions: ActionConfig[]
    backgroundImage?: string
    showTitle?: boolean
    mode?: 'seq' | 'par' | 'alt'
    longPress?: string
    confirm?: boolean
    rules?: KeyRule[]
    looks?: KeyLook[]
}

export interface ActionConfig {
    id: string
    type: string
    pluginId?: string | null
    parameters: Record<string, any>
    waitMs?: number
}

/** Regla de tecla: disparador + condición + ramas entonces/si-no. */
export interface KeyRule {
    id: string
    on: boolean
    when: 'press' | 'long' | 'load' | 'timer' | 'var'
    every?: number
    vn?: string
    cond?: string
    then: ActionConfig[]
    else: ActionConfig[]
}

/** Apariencia condicional: la primera condición que se cumple manda. */
export interface KeyLook {
    cond: string
    t?: string
    i?: string
    c?: number | null
    bg?: number
}

/** Variable global usable en condiciones y textos {{nombre}}. */
export interface VarDef {
    n: string
    t: 'num' | 'txt' | 'bool'
    v: number | string | boolean
}

export type ActionType = string
