/**
 * Native Calendar Plugin
 * Próximo evento, cuenta atrás y apertura desde un .ics local
 * o desde Google Calendar (API Key opcional).
 */

import { openUrl } from './sysrun'

export interface PluginContext {
    log: (level: string, message: string, meta?: any) => void
    getSetting?: (key: string) => string | null
    setSetting?: (key: string, value: string) => void
}

export interface ActionHandler {
    (params: any, context: any): Promise<any>
}

export interface CalEvent {
    summary: string
    start: Date | null
    startRaw: string
    location: string
    url: string
    description: string
}

const REQUEST_TIMEOUT_MS = 15000

/** Despliega líneas plegadas del ICS (las que empiezan por espacio). */
export function unfoldIcs(text: string): string[] {
    return text.replace(/\r\n/g, '\n').split('\n').reduce<string[]>((acc, line) => {
        if (/^[ \t]/.test(line) && acc.length > 0) acc[acc.length - 1] += line.slice(1)
        else acc.push(line)
        return acc
    }, [])
}

/** Parsea DTSTART básico: YYYYMMDDTHHMMSSZ, con offset o fecha sola (todo el día). */
export function parseIcsDate(value: string): Date | null {
    const v = value.trim()
    let m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z|[+-]\d{4})?$/)
    if (m) {
        const [, Y, Mo, D, h, mi, s, tz] = m
        let suffix = 'Z'
        if (tz && tz !== 'Z') suffix = `${tz.slice(0, 3)}:${tz.slice(3)}`
        const d = new Date(`${Y}-${Mo}-${D}T${h}:${mi}:${s}${suffix}`)
        return Number.isNaN(d.getTime()) ? null : d
    }
    m = v.match(/^(\d{4})(\d{2})(\d{2})$/)
    if (m) {
        const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00`)
        return Number.isNaN(d.getTime()) ? null : d
    }
    return null
}

/** Extrae VEVENTs de un texto .ics. Función pura (testeable). */
export function parseIcs(text: string): CalEvent[] {
    const lines = unfoldIcs(text)
    const events: CalEvent[] = []
    let current: Record<string, string> | null = null
    for (const line of lines) {
        if (line === 'BEGIN:VEVENT') { current = {}; continue }
        if (line === 'END:VEVENT') {
            if (current) {
                events.push({
                    summary: unescapeIcs(current['SUMMARY'] ?? '(sin título)'),
                    start: current['DTSTART'] ? parseIcsDate(current['DTSTART'].split(';').pop()!) : null,
                    startRaw: current['DTSTART'] ?? '',
                    location: unescapeIcs(current['LOCATION'] ?? ''),
                    url: (current['URL'] ?? '').trim(),
                    description: unescapeIcs(current['DESCRIPTION'] ?? ''),
                })
            }
            current = null
            continue
        }
        if (current) {
            const idx = line.indexOf(':')
            if (idx > 0) current[line.slice(0, idx).split(';')[0]] = line.slice(idx + 1)
        }
    }
    return events
}

function unescapeIcs(v: string): string {
    return v.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\')
}

/** Próximos eventos ordenados (solo futuros). Función pura (testeable). */
export function upcomingEvents(events: CalEvent[], nowMs: number = Date.now(), limit: number = 5): CalEvent[] {
    return events
        .filter(e => e.start && e.start.getTime() >= nowMs - 60_000)
        .sort((a, b) => a.start!.getTime() - b.start!.getTime())
        .slice(0, Math.max(1, limit))
}

/** "en 2 h 15 min" / "en 3 días" / "ahora mismo". Función pura (testeable). */
export function humanCountdown(targetMs: number, nowMs: number = Date.now()): string {
    const diff = targetMs - nowMs
    if (diff <= 60_000) return 'ahora mismo'
    const mins = Math.floor(diff / 60_000)
    const days = Math.floor(mins / 1440)
    if (days >= 1) {
        const rest = mins - days * 1440
        const hours = Math.floor(rest / 60)
        return hours > 0 ? `en ${days} ${days === 1 ? 'día' : 'días'} y ${hours} h` : `en ${days} ${days === 1 ? 'día' : 'días'}`
    }
    const hours = Math.floor(mins / 60)
    if (hours >= 1) {
        const rest = mins - hours * 60
        return rest > 0 ? `en ${hours} h y ${rest} min` : `en ${hours} h`
    }
    return `en ${mins} min`
}

export class CalendarPlugin {
    private context: PluginContext

    constructor(context: PluginContext) {
        this.context = context
    }

    /** Punto de inyección para tests (apertura real de URL). */
    protected async open(target: string): Promise<void> {
        return openUrl(target)
    }

    public getManifest() {
        return {
            id: 'calendar',
            name: 'Calendario',
            version: '1.0.0',
            description: 'Próximo evento, cuenta atrás y apertura (ICS local o Google Calendar)',
            author: 'BunDeck',
            permissions: ['filesystem', 'network'],
            settingsSchema: {
                type: 'object',
                properties: {
                    icsPath: {
                        type: 'string',
                        title: 'Archivo .ics',
                        description: 'Ruta a un calendario local en formato ICS (tiene prioridad sobre Google)',
                        ui: { component: 'input', type: 'text', placeholder: '/ruta/a/calendario.ics' }
                    },
                    googleApiKey: {
                        type: 'string',
                        title: 'Google API Key',
                        description: 'Clave de API de Google Cloud (Calendar API activada). Solo lee calendarios públicos o compartidos.',
                        ui: { component: 'input', type: 'password', placeholder: 'AIza…' }
                    },
                    googleCalendarId: {
                        type: 'string',
                        title: 'ID de calendario Google',
                        description: 'Normalmente tu email de Google',
                        ui: { component: 'input', type: 'text', placeholder: 'tucorreo@gmail.com' }
                    }
                }
            },
            instructions:
                'Muestra tu próximo evento.\n\n' +
                '· Opción A (sin internet): pon la ruta de un .ics local en los ajustes (o en cada acción).\n' +
                '· Opción B: crea una API Key en Google Cloud con Calendar API activada y ponla junto al ID del calendario.\n' +
                '· "Cuenta atrás" devuelve el tiempo restante en texto ("en 2 h y 15 min") para mostrarlo en el botón.',
            actions: [
                {
                    id: 'next-event',
                    name: 'Próximo evento',
                    description: 'Devuelve el próximo evento del calendario',
                    icon: 'CalendarClock',
                    schema: {
                        type: 'object',
                        properties: {
                            icsPath: {
                                type: 'string',
                                title: 'Archivo .ics',
                                description: 'Si se omite se usa el de los ajustes',
                                ui: { component: 'input', type: 'text', placeholder: '(usa el de ajustes)' }
                            }
                        }
                    }
                },
                {
                    id: 'countdown',
                    name: 'Cuenta atrás',
                    description: 'Tiempo restante hasta el próximo evento (o el N-ésimo)',
                    icon: 'Hourglass',
                    schema: {
                        type: 'object',
                        properties: {
                            index: {
                                type: 'number',
                                title: 'Nº de evento',
                                description: '0 = próximo, 1 = siguiente, …',
                                default: 0,
                                minimum: 0,
                                ui: { component: 'input', type: 'number', min: 0, placeholder: '0' }
                            },
                            icsPath: {
                                type: 'string',
                                title: 'Archivo .ics',
                                ui: { component: 'input', type: 'text', placeholder: '(usa el de ajustes)' }
                            }
                        }
                    }
                },
                {
                    id: 'open-event',
                    name: 'Abrir evento',
                    description: 'Abre el enlace del próximo evento (o la URL indicada)',
                    icon: 'ExternalLink',
                    schema: {
                        type: 'object',
                        properties: {
                            url: {
                                type: 'string',
                                title: 'URL',
                                description: 'Si se omite se usa el enlace del próximo evento (hangout/URL del ICS)',
                                ui: { component: 'input', type: 'text', placeholder: '(próximo evento)' }
                            }
                        }
                    }
                }
            ]
        }
    }

    public getActionHandlers(): Map<string, ActionHandler> {
        const handlers = new Map<string, ActionHandler>()
        handlers.set('next-event', this.executeNextEvent.bind(this))
        handlers.set('countdown', this.executeCountdown.bind(this))
        handlers.set('open-event', this.executeOpenEvent.bind(this))
        return handlers
    }

    private setting(key: string): string | null {
        try {
            const v = this.context.getSetting?.(key)
            return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null
        } catch {
            return null
        }
    }

    private async loadEvents(icsPath?: string): Promise<CalEvent[]> {
        const path = (typeof icsPath === 'string' && icsPath.trim().length > 0 ? icsPath.trim() : null)
            ?? this.setting('icsPath')
        if (path) {
            const file = Bun.file(path)
            if (!(await file.exists())) {
                throw new Error(`No se encontró el archivo ICS: "${path}". Revisa la ruta en los ajustes del plugin.`)
            }
            const text = await file.text()
            const events = parseIcs(text)
            if (events.length === 0) throw new Error(`El archivo "${path}" no contiene eventos (¿formato ICS válido?).`)
            return events
        }
        const apiKey = this.setting('googleApiKey')
        const calId = this.setting('googleCalendarId')
        if (apiKey && calId) return this.fetchGoogle(apiKey, calId)
        throw new Error(
            'Sin fuente de calendario: configura "icsPath" (archivo .ics local) o "googleApiKey" + "googleCalendarId" en los ajustes del plugin (⋯).'
        )
    }

    private async fetchGoogle(apiKey: string, calId: string): Promise<CalEvent[]> {
        const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events` +
            `?singleEvents=true&orderBy=startTime&timeMin=${encodeURIComponent(new Date().toISOString())}` +
            `&maxResults=10&key=${encodeURIComponent(apiKey)}`
        this.context.log('info', 'Calendario: consultando Google Calendar')
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
        try {
            const res = await fetch(url, { signal: controller.signal })
            if (res.status === 400 || res.status === 403) {
                throw new Error('Google rechazó la petición: revisa la API Key (Calendar API activada) y que el calendario sea legible con esa clave.')
            }
            if (res.status === 404) throw new Error(`Google no encuentra el calendario "${calId}": revisa el ID en ajustes.`)
            if (!res.ok) throw new Error(`Google Calendar devolvió HTTP ${res.status}.`)
            const data = await res.json() as any
            return ((data.items ?? []) as any[]).map(it => ({
                summary: it.summary ?? '(sin título)',
                start: it.start?.dateTime ? new Date(it.start.dateTime) : it.start?.date ? new Date(`${it.start.date}T00:00:00`) : null,
                startRaw: it.start?.dateTime ?? it.start?.date ?? '',
                location: it.location ?? '',
                url: it.hangoutLink ?? it.htmlLink ?? '',
                description: it.description ?? '',
            }))
        } catch (error: any) {
            if (error?.name === 'AbortError') throw new Error('Google Calendar tardó demasiado (timeout de 15s).')
            throw error
        } finally {
            clearTimeout(timer)
        }
    }

    private serialize(e: CalEvent) {
        return {
            summary: e.summary,
            start: e.start ? e.start.toISOString() : null,
            startLocal: e.start ? e.start.toLocaleString() : e.startRaw,
            location: e.location,
            url: e.url || null,
        }
    }

    private async executeNextEvent(params: any, _context: any): Promise<any> {
        const events = await this.loadEvents(params?.icsPath)
        const [next] = upcomingEvents(events, Date.now(), 1)
        if (!next) return { found: false, hint: 'No hay próximos eventos en el calendario.' }
        this.context.log('info', `Calendario: próximo "${next.summary}"`)
        return { found: true, event: this.serialize(next), countdown: next.start ? humanCountdown(next.start.getTime()) : null }
    }

    private async executeCountdown(params: any, _context: any): Promise<any> {
        const index = params?.index ?? 0
        if (typeof index !== 'number' || index < 0 || !Number.isInteger(index)) {
            throw new Error('El parámetro "index" debe ser un entero ≥ 0 (0 = próximo).')
        }
        const events = await this.loadEvents(params?.icsPath)
        const upcoming = upcomingEvents(events, Date.now(), index + 1)
        const target = upcoming[index]
        if (!target?.start) {
            return { found: false, countdown: 'sin eventos', hint: 'No hay próximos eventos en el calendario.' }
        }
        const countdown = humanCountdown(target.start.getTime())
        return { found: true, countdown, event: this.serialize(target) }
    }

    private async executeOpenEvent(params: any, _context: any): Promise<any> {
        const { url } = params ?? {}
        let target = typeof url === 'string' && url.trim().length > 0 ? url.trim() : null
        if (!target) {
            const events = await this.loadEvents()
            const [next] = upcomingEvents(events, Date.now(), 1)
            if (!next) throw new Error('No hay próximos eventos que abrir.')
            if (!next.url) throw new Error(`El evento "${next.summary}" no tiene enlace (ni URL ni hangout). Indica "url" manualmente.`)
            target = next.url
        }
        this.context.log('info', `Calendario: abriendo ${target}`)
        await this.open(target)
        return { url: target, opened: true }
    }

    public dispose(): void {
        // Sin recursos persistentes
    }
}
