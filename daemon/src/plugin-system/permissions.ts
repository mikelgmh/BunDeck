import type { PluginPermission, PluginManifestV2 } from './types';

const PERMISSION_DESCRIPTIONS: Record<PluginPermission, string> = {
  shell: 'Ejecutar comandos del sistema',
  filesystem: 'Acceso a archivos (sandbox data/plugins/<id>/)',
  http: 'Peticiones HTTP salientes',
  network: 'Acceso red',
  system: 'Métricas sistema',
  monitoring: 'Monitorización',
  clipboard: 'Portapapeles',
  notifications: 'Notificaciones',
};

export function hasPermission(manifest: PluginManifestV2, perm: PluginPermission): boolean {
  return manifest.permissions.includes(perm);
}

export function requirePermission(manifest: PluginManifestV2, perm: PluginPermission): void {
  if (!hasPermission(manifest, perm)) {
    throw new Error(`Plugin ${manifest.id} requiere permiso '${perm}' (${PERMISSION_DESCRIPTIONS[perm]}) no declarado en manifest`);
  }
}

export function checkUrlPermission(manifest: PluginManifestV2, url: string): void {
  // http/network permiten cualquier URL https/http; sin permiso bloquea
  if (!hasPermission(manifest, 'http') && !hasPermission(manifest, 'network')) {
    throw new Error(`Plugin ${manifest.id} no tiene permiso http/network para fetch ${url}`);
  }
  const u = new URL(url);
  if (!['http:', 'https:'].includes(u.protocol)) {
    throw new Error(`Protocolo no permitido: ${u.protocol}`);
  }
  // Bloquear localhost sin permiso system (evitar SSRF a daemon)
  if (['localhost', '127.0.0.1', '::1'].includes(u.hostname) && !hasPermission(manifest, 'system')) {
    throw new Error(`Acceso a localhost requiere permiso system`);
  }
}

export function checkShellPermission(manifest: PluginManifestV2, command: string): void {
  requirePermission(manifest, 'shell');
  // Lista de DENEGADOS, no sandbox: solo bloquea patrones conocidos.
  // El aislamiento real de plugins externos lo da el Worker (memoria/proceso
  // lógico separada, timeout con terminate, I/O mediada por el padre), pero un
  // plugin malicioso dentro del Worker aún puede importar node:child_process.
  // No presentes esto como contención a nivel OS.
  const blocked = ['rm -rf /', 'format', 'shutdown', 'mkfs'];
  const lower = command.toLowerCase();
  for (const b of blocked) if (lower.includes(b)) throw new Error(`Comando bloqueado por política: ${b}`);
}

export function getPermissionDescriptions(perms: string[]): string[] {
  return perms.map(p => (PERMISSION_DESCRIPTIONS as Record<string, string>)[p] || p);
}

/** Permisos que implican acceso amplio al equipo (para avisos en UI). */
export function isPrivilegedPermission(perm: string): boolean {
  return perm === 'shell' || perm === 'system' || perm === 'filesystem';
}

export function manifestIsPrivileged(manifest: PluginManifestV2): boolean {
  return (manifest.permissions ?? []).some(isPrivilegedPermission);
}
