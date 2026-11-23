/**
 * Utilidades compartidas de los plugins de sistema.
 * Sin dependencias nuevas: solo Bun.spawn + fetch global.
 */

export interface RunResult {
    stdout: string
    stderr: string
    exitCode: number
}

export interface RunOptions {
    /** Tiempo límite en ms (por defecto 15000). */
    timeoutMs?: number
    /** Entrada estándar para el proceso. */
    stdin?: string
}

const DEFAULT_TIMEOUT_MS = 15000

/**
 * Ejecuta un comando del sistema y devuelve stdout/stderr/exitCode.
 * Lanza si el binario no existe (para degradación elegante en el llamador).
 */
export async function runCommand(cmd: string[], opts: RunOptions = {}): Promise<RunResult> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    let proc: any
    try {
        proc = Bun.spawn(cmd as any, { windowsHide: true, 
            stdio: ['pipe', 'pipe', 'pipe'],
        } as any)
    } catch (error) {
        throw commandNotFoundError(cmd[0], error)
    }
    if (opts.stdin !== undefined) {
        try {
            const writer = proc.stdin?.writer?.() ?? proc.stdin
            if (writer && typeof writer.write === 'function') {
                writer.write(opts.stdin)
                if (typeof writer.close === 'function') writer.close()
            }
        } catch {
            // mejor esfuerzo: la mayoría de comandos no necesitan stdin
        }
    }
    let timedOut = false
    const timer = setTimeout(() => {
        timedOut = true
        try { proc.kill() } catch { /* ya terminó */ }
    }, timeoutMs)
    let stdout = ''
    let stderr = ''
    try {
        stdout = await new Response(proc.stdout).text()
        stderr = await new Response(proc.stderr).text()
        await proc.exited
    } finally {
        clearTimeout(timer)
    }
    if (timedOut) {
        throw new Error(`El comando tardó demasiado (límite ${timeoutMs} ms): ${cmd.join(' ')}`)
    }
    return { stdout, stderr, exitCode: proc.exitCode ?? 0 }
}

/** ¿El error indica que el binario no existe? */
export function isCommandNotFound(error: unknown): boolean {
    const msg = error instanceof Error ? `${error.message} ${String((error as any).code ?? '')}` : String(error)
    return /ENOENT|not found|no such file|no se encontr|nicht gefunden|command not found|fue reconocido/i.test(msg)
}

function commandNotFoundError(cmd: string, cause: unknown): Error {
    const detail = cause instanceof Error && cause.message ? `: ${cause.message}` : ''
    const err = new Error(`No se encontró el comando "${cmd}"${detail}`)
    ;(err as any).code = 'COMMAND_NOT_FOUND'
    return err
}

/** Abre una URL con la aplicación predeterminada del sistema. */
export async function openUrl(url: string, run: typeof runCommand = runCommand): Promise<void> {
    if (!/^https?:\/\//i.test(url)) {
        throw new Error(`URL no válida para abrir: "${url}" (debe empezar por http:// o https://)`)
    }
    const platform = process.platform
    if (platform === 'win32') {
        await run(['cmd', '/c', 'start', '""', url])
    } else if (platform === 'darwin') {
        await run(['open', url])
    } else {
        await run(['xdg-open', url])
    }
}

/** Lanza un error amigable cuando falta una herramienta del sistema. */
export function missingToolError(tool: string, installHint: string): Error {
    return new Error(
        `No se encontró "${tool}" en este equipo. ${installHint} ` +
        `Si ya está instalado, comprueba que esté en el PATH y reintenta.`
    )
}
