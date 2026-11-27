/**
 * Native Weather Plugin
 * El tiempo actual y pronóstico sin API key (Open-Meteo: api.open-meteo.com).
 * Geocodificación vía geocoding-api.open-meteo.com. Sin dependencias.
 */

import { CONTRACT_API_VERSION, CONTRACT_ENGINE } from './contract'

export interface PluginContext {
    log: (level: string, message: string, meta?: any) => void
    getSetting?: (key: string) => string | null
    setSetting?: (key: string, value: string) => void
}

export interface ActionHandler {
    (params: any, context: any): Promise<any>
}

const REQUEST_TIMEOUT_MS = 15000

export const WEATHER_CODES: Record<number, string> = {
    0: 'Despejado', 1: 'Casi despejado', 2: 'Parcialmente nublado', 3: 'Cubierto',
    45: 'Niebla', 48: 'Niebla con escarcha',
    51: 'Llovizna ligera', 53: 'Llovizna', 55: 'Llovizna intensa',
    56: 'Llovizna helada ligera', 57: 'Llovizna helada',
    61: 'Lluvia ligera', 63: 'Lluvia', 65: 'Lluvia intensa',
    66: 'Lluvia helada ligera', 67: 'Lluvia helada',
    71: 'Nieve ligera', 73: 'Nieve', 75: 'Nieve intensa', 77: 'Granizo menudo',
    80: 'Chubascos ligeros', 81: 'Chubascos', 82: 'Chubascos violentos',
    85: 'Chubascos de nieve', 86: 'Chubascos de nieve intensos',
    95: 'Tormenta', 96: 'Tormenta con granizo', 99: 'Tormenta fuerte con granizo',
}

/** Código WMO → texto en español. Función pura (testeable). */
export function weatherLabel(code: number): string {
    return WEATHER_CODES[code] ?? `Código ${code}`
}

/** Temperatura → estado discreto para iconos dinámicos. Función pura. */
export function weatherState(tempC: number, code: number): 'clear' | 'cloudy' | 'rain' | 'storm' | 'snow' | 'fog' {
    if ([95, 96, 99].includes(code)) return 'storm'
    if ([71, 73, 75, 77, 85, 86].includes(code)) return 'snow'
    if ([45, 48].includes(code)) return 'fog'
    if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return 'rain'
    if ([1, 2, 3].includes(code)) return 'cloudy'
    void tempC
    return 'clear'
}

export class WeatherPlugin {
    private context: PluginContext

    constructor(context: PluginContext) {
        this.context = context
    }

    public getManifest() {
        return {
            id: 'weather',
            name: 'El tiempo',
            version: '1.0.2',
            description: 'Tiempo actual y pronóstico (Open-Meteo, sin API key): temperatura, lluvia y viento',
            author: 'BunDeck',
            apiVersion: CONTRACT_API_VERSION,
            engine: CONTRACT_ENGINE,
            category: 'integrations',
            permissions: ['network'] as string[],
            settingsSchema: {
                type: 'object',
                properties: {
                    latitude: {
                        type: 'number', title: 'Latitud',
                        description: 'Latitud de tu ubicación (los parámetros tienen prioridad)',
                        ui: { component: 'input', type: 'number', placeholder: '40.41' }
                    },
                    longitude: {
                        type: 'number', title: 'Longitud',
                        description: 'Longitud de tu ubicación (los parámetros tienen prioridad)',
                        ui: { component: 'input', type: 'number', placeholder: '-3.70' }
                    },
                    units: {
                        type: 'string', title: 'Unidades',
                        description: 'Sistema de unidades para la temperatura',
                        enum: ['celsius', 'fahrenheit'], default: 'celsius',
                        ui: { component: 'select', options: [{ value: 'celsius', label: 'Celsius (°C)' }, { value: 'fahrenheit', label: 'Fahrenheit (°F)' }] }
                    }
                }
            },
            instructions: 'Sin API key: Open-Meteo es gratis y no pide registro.\n\n1. Pon tu latitud/longitud en los ajustes (⋯) o búscala con la acción "Buscar lugar".\n2. Usa "Ahora" para el tiempo actual (ideal para iconos dinámicos del botón) y "Pronóstico" para los próximos días.',
            widgets: [
                { id: 'now', kind: 'text', title: 'Ahora', description: 'Temperatura y condición actuales', sourceAction: 'now', refreshMs: 600000 }
            ],
            actions: [
                {
                    id: 'now',
                    name: 'Tiempo ahora',
                    description: 'Temperatura, condición, lluvia y viento actuales',
                    icon: 'CloudSun',
                    dynamic: true,
                    surface: 'control',
                    component: 'status-cards',
                    freeModeOnly: true,
                    pollMs: 600000,
                    timeoutMs: REQUEST_TIMEOUT_MS,
                    states: [
                        { value: 'clear', label: 'Despejado', icon: 'Sun' },
                        { value: 'cloudy', label: 'Nublado', icon: 'Cloud' },
                        { value: 'rain', label: 'Lluvia', icon: 'CloudRain' },
                        { value: 'storm', label: 'Tormenta', icon: 'CloudLightning' },
                        { value: 'snow', label: 'Nieve', icon: 'Snowflake' },
                        { value: 'fog', label: 'Niebla', icon: 'CloudFog' }
                    ],
                    schema: {
                        type: 'object',
                        properties: {
                            latitude: { type: 'number', title: 'Latitud', description: 'Si se omite usa la de ajustes', ui: { component: 'input', type: 'number', placeholder: '(ajustes)' } },
                            longitude: { type: 'number', title: 'Longitud', description: 'Si se omite usa la de ajustes', ui: { component: 'input', type: 'number', placeholder: '(ajustes)' } },
                            place: { type: 'string', title: 'Lugar', description: 'Nombre de ciudad (se resuelve a coordenadas; tiene prioridad sobre lat/lon)', ui: { component: 'input', type: 'text', placeholder: 'Madrid' } },
                            carouselMs: {
                                type: 'number', title: 'Rotación (ms)',
                                description: 'Cada cuántos ms rota el carrusel en teclas pequeñas (0 = desactivado; vacío = 4000)',
                                minimum: 0, default: 4000,
                                ui: { component: 'input', type: 'number', placeholder: '4000' }
                            }
                        },
                        required: []
                    }
                },
                {
                    id: 'forecast',
                    name: 'Pronóstico',
                    description: 'Máximas/mínimas y lluvia de los próximos días (1-7)',
                    icon: 'CalendarCloud',
                    surface: 'control',
                    component: 'status-cards',
                    freeModeOnly: true,
                    timeoutMs: REQUEST_TIMEOUT_MS,
                    schema: {
                        type: 'object',
                        properties: {
                            latitude: { type: 'number', title: 'Latitud', ui: { component: 'input', type: 'number', placeholder: '(ajustes)' } },
                            longitude: { type: 'number', title: 'Longitud', ui: { component: 'input', type: 'number', placeholder: '(ajustes)' } },
                            place: { type: 'string', title: 'Lugar', description: 'Nombre de ciudad (prioridad sobre lat/lon)', ui: { component: 'input', type: 'text', placeholder: 'Madrid' } },
                            days: { type: 'integer', title: 'Días', description: 'Cuántos días (1-7)', default: 3, minimum: 1, maximum: 7, ui: { component: 'input', type: 'number', placeholder: '3' } },
                            carouselMs: {
                                type: 'number', title: 'Rotación (ms)',
                                description: 'Cada cuántos ms rota el carrusel en teclas pequeñas (0 = desactivado; vacío = 4000)',
                                minimum: 0, default: 4000,
                                ui: { component: 'input', type: 'number', placeholder: '4000' }
                            }
                        },
                        required: []
                    }
                },
                {
                    id: 'search-place',
                    name: 'Buscar lugar',
                    description: 'Resuelve un nombre de ciudad a latitud/longitud (para rellenar los ajustes)',
                    icon: 'Search',
                    timeoutMs: REQUEST_TIMEOUT_MS,
                    schema: {
                        type: 'object',
                        properties: {
                            place: { type: 'string', title: 'Lugar', description: 'Ciudad o pueblo a buscar', ui: { component: 'input', type: 'text', placeholder: 'Madrid' } }
                        },
                        required: ['place']
                    }
                }
            ]
        }
    }

    public getActionHandlers(): Map<string, ActionHandler> {
        const handlers = new Map<string, ActionHandler>()
        handlers.set('now', this.executeNow.bind(this))
        handlers.set('forecast', this.executeForecast.bind(this))
        handlers.set('search-place', this.executeSearchPlace.bind(this))
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

    private numSetting(key: string): number | null {
        const raw = this.setting(key)
        if (raw === null) return null
        const n = Number(raw)
        return Number.isFinite(n) ? n : null
    }

    private async fetchJson(label: string, url: string): Promise<any> {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
        try {
            this.context.log('info', `Tiempo ${label}: GET ${url.split('?')[0]}`)
            const res = await fetch(url, { signal: controller.signal })
            if (!res.ok) throw new Error(`Open-Meteo devolvió HTTP ${res.status} en "${label}".`)
            return await res.json()
        } catch (error: any) {
            if (error?.name === 'AbortError') throw new Error(`Open-Meteo tardó demasiado (timeout de 15s): ${label}`)
            throw error
        } finally {
            clearTimeout(timer)
        }
    }

    private async coords(params: any): Promise<{ latitude: number; longitude: number; placeName: string | null }> {
        const place = typeof params?.place === 'string' && params.place.trim() ? params.place.trim() : null
        if (place) {
            const found = await this.fetchJson('buscar lugar', `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=1&language=es&format=json`)
            const first = found?.results?.[0]
            if (!first) throw new Error(`No se encontró ningún lugar llamado "${place}". Prueba con la ciudad más cercana o usa latitud/longitud.`)
            return { latitude: Number(first.latitude), longitude: Number(first.longitude), placeName: [first.name, first.country].filter(Boolean).join(', ') }
        }
        const lat = (typeof params?.latitude === 'number' ? params.latitude : null) ?? this.numSetting('latitude')
        const lon = (typeof params?.longitude === 'number' ? params.longitude : null) ?? this.numSetting('longitude')
        if (lat === null || lon === null) {
            throw new Error('Falta la ubicación: pon latitud/longitud en los ajustes (⋯) o usa el parámetro "place" (ej. "Madrid").')
        }
        return { latitude: lat, longitude: lon, placeName: null }
    }

    private async executeNow(params: any, _context: any): Promise<any> {
        const { latitude, longitude, placeName } = await this.coords(params)
        const units = this.setting('units') === 'fahrenheit' ? 'fahrenheit' : 'celsius'
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&temperature_unit=${units}&timezone=auto`
        const res = await this.fetchJson('ahora', url)
        const cur = res?.current
        if (!cur) throw new Error('Open-Meteo no devolvió el tiempo actual.')
        const temp = Number(cur.temperature_2m)
        const code = Number(cur.weather_code)
        const state = weatherState(temp, code)
        const unit = units === 'fahrenheit' ? '°F' : '°C'
        this.context.log('info', `Tiempo ahora: ${temp}${unit} ${weatherLabel(code)}`)
        return {
            action: 'now',
            state,
            temperature: temp, unit,
            condition: weatherLabel(code),
            weatherCode: code,
            humidity: cur.relative_humidity_2m ?? null,
            windKmh: cur.wind_speed_10m ?? null,
            place: placeName,
            widget: { kind: 'text' as const, value: `${Math.round(temp)}${unit}`, label: weatherLabel(code) },
        }
    }

    private async executeForecast(params: any, _context: any): Promise<any> {
        const { latitude, longitude, placeName } = await this.coords(params)
        const daysRaw = params?.days ?? 3
        const days = Math.min(7, Math.max(1, Math.floor(Number(daysRaw) || 3)))
        const units = this.setting('units') === 'fahrenheit' ? 'fahrenheit' : 'celsius'
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&temperature_unit=${units}&timezone=auto&forecast_days=${days}`
        const res = await this.fetchJson('pronóstico', url)
        const d = res?.daily
        if (!d?.time) throw new Error('Open-Meteo no devolvió el pronóstico.')
        const out = d.time.map((date: string, i: number) => ({
            date,
            max: d.temperature_2m_max?.[i] ?? null,
            min: d.temperature_2m_min?.[i] ?? null,
            condition: weatherLabel(Number(d.weather_code?.[i])),
            rainChance: d.precipitation_probability_max?.[i] ?? null,
        }))
        return { action: 'forecast', place: placeName, days, daysForecast: out, unit: units === 'fahrenheit' ? '°F' : '°C' }
    }

    private async executeSearchPlace(params: any, _context: any): Promise<any> {
        const place = typeof params?.place === 'string' && params.place.trim() ? params.place.trim() : ''
        if (!place) throw new Error('La acción "Buscar lugar" requiere el parámetro "place" (ej. "Madrid").')
        const res = await this.fetchJson('buscar lugar', `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=5&language=es&format=json`)
        const options = Array.isArray(res?.results) ? res.results.map((r: any) => ({
            value: `${r.latitude},${r.longitude}`,
            label: [r.name, r.admin1, r.country].filter(Boolean).join(', '),
            latitude: Number(r.latitude), longitude: Number(r.longitude),
        })) : []
        if (options.length === 0) throw new Error(`No se encontró ningún lugar llamado "${place}".`)
        return { action: 'search-place', place, options }
    }

    public dispose(): void {
        // Sin recursos persistentes
    }
}
