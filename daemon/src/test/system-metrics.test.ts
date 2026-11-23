import { describe, it, expect } from 'bun:test'
import { getSystemMetricsScript } from '../scripts/system-metrics.ps1'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('system-metrics (honesto, sin datos inventados)', () => {
    it('el script Windows intenta LHM/OHM + ACPI + GPU Engine + nvidia-smi', () => {
        const script = getSystemMetricsScript()
        for (const needle of [
            'root/LibreHardwareMonitor',
            'root/OpenHardwareMonitor',
            'MSAcpi_ThermalZoneTemperature',
            'GPU Engine',
            'nvidia-smi',
        ]) {
            expect(script, `script debe intentar ${needle}`).toContain(needle)
        }
        // Nunca null fijo para todo: debe devolver sources
        expect(script).toContain('sources')
    })

    it('el endpoint no devuelve Math.random como fallback', () => {
        const src = readFileSync(join(import.meta.dir, '..', 'api', 'system.ts'), 'utf8')
        expect(src).not.toContain('Math.random() * 100')
        expect(src).toContain('honestDegraded')
        expect(src).toContain('enrichWithLhmRemote')
        // LHM Remote Web Server como en el plugin de Macro-Deck
        expect(src).toContain('localhost:8085/data.json')
    })

    it('el recolector Unix existe (Linux/macOS ya no usan powershell)', () => {
        const src = readFileSync(join(import.meta.dir, '..', 'api', 'system.ts'), 'utf8')
        expect(src).toContain('collectNativeUnixMetrics')
        expect(src).toContain('sys-thermal-zone')
        expect(src).toContain('nvidia-smi')
        expect(src).toContain('rocm-smi')
    })
})
