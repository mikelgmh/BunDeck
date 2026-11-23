import type { PluginManifestV2, PluginPermission } from './types';
import { PLUGIN_API_VERSION } from './types';

const VALID_PERMISSIONS: Set<string> = new Set([
  'shell', 'filesystem', 'http', 'network', 'system', 'monitoring', 'clipboard', 'notifications',
  // Legados de plugins built-in actuales (mantener compat)
  'keyboard', 'input', 'multimedia', 'browser', 'process', 'navigation', 'ui', 'utility',
  // Legado del plugin de ejemplo: `emitEvent` es API core (siempre disponible),
  // no un permiso. Se acepta para no romper manifests existentes; se ignora.
  'emitEvent'
]);

// IDs simples (shell, mi-plugin) o con scope (@scope/mi-plugin)
const SIMPLE_ID = /^[a-z0-9][a-z0-9._-]*[a-z0-9]$/i;
const SCOPED_ID = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*[a-z0-9]$/i;
const SEMVER_REGEX = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const ACTION_ID = /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/i;

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

function isValidId(id: string): boolean {
  return SIMPLE_ID.test(id) || SCOPED_ID.test(id);
}

function validateActionSchema(actionId: string, schema: any, errors: string[]): void {
  if (!schema || typeof schema !== 'object') {
    errors.push(`action ${actionId} schema debe ser objeto`);
    return;
  }
  if (schema.type !== 'object') errors.push(`action ${actionId} schema.type debe ser 'object'`);
  if (!schema.properties || typeof schema.properties !== 'object') {
    errors.push(`action ${actionId} schema.properties requerido`);
    return;
  }
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required)) errors.push(`action ${actionId} schema.required debe ser array`);
    else for (const r of schema.required) {
      if (typeof r !== 'string') errors.push(`action ${actionId} required debe ser string`);
      else if (!(r in schema.properties)) errors.push(`action ${actionId} required '${r}' no está en properties`);
    }
  }
  for (const [k, prop] of Object.entries<any>(schema.properties)) {
    if (!prop || typeof prop !== 'object') { errors.push(`action ${actionId} prop '${k}' debe ser objeto`); continue; }
    if (prop.type && typeof prop.type !== 'string') errors.push(`action ${actionId} prop '${k}.type' debe ser string`);
    if (prop.enum !== undefined && !Array.isArray(prop.enum)) errors.push(`action ${actionId} prop '${k}.enum' debe ser array`);
  }
}

export function validateManifest(manifest: any): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!manifest || typeof manifest !== 'object') {
    return { valid: false, errors: ['manifest debe ser objeto'], warnings };
  }
  if (!manifest.id || typeof manifest.id !== 'string' || !isValidId(manifest.id)) {
    errors.push('id inválido (alfanumérico, ., _, -, @scope/nombre)');
  }
  if (!manifest.name || typeof manifest.name !== 'string' || manifest.name.length < 2) {
    errors.push('name requerido (>=2 chars)');
  }
  if (!manifest.version || typeof manifest.version !== 'string' || !SEMVER_REGEX.test(manifest.version)) {
    errors.push('version semver inválida (ej: 1.0.0)');
  }
  if (manifest.main !== undefined && (typeof manifest.main !== 'string' || manifest.main.includes('..'))) {
    errors.push('main debe ser ruta relativa sin ..');
  }
  if (!Array.isArray(manifest.permissions)) {
    errors.push('permissions debe ser array');
  } else {
    for (const p of manifest.permissions) {
      if (!VALID_PERMISSIONS.has(p)) errors.push(`permission desconocido: ${p}`);
    }
    if (manifest.permissions.includes('shell') || manifest.permissions.includes('system')) {
      warnings.push('Este plugin pide acceso amplio al sistema (shell/system). Instálalo solo si confías en el autor.');
    }
  }
  if (!Array.isArray(manifest.actions)) {
    errors.push('actions debe ser array');
  } else {
    const seen = new Set<string>();
    for (const a of manifest.actions) {
      if (!a.id || typeof a.id !== 'string' || !ACTION_ID.test(a.id)) errors.push(`action.id inválido: ${a.id}`);
      else if (seen.has(a.id)) errors.push(`action.id duplicado: ${a.id}`);
      else seen.add(a.id);
      if (!a.name || typeof a.name !== 'string') errors.push(`action ${a.id} requiere name`);
      if (a.schema !== undefined) validateActionSchema(a.id ?? '?', a.schema, errors);
      if (a.timeoutMs !== undefined && (typeof a.timeoutMs !== 'number' || a.timeoutMs < 100 || a.timeoutMs > 120000)) {
        errors.push(`action ${a.id} timeoutMs 100-120000`);
      }
      if (a.cooldownMs !== undefined && (typeof a.cooldownMs !== 'number' || a.cooldownMs < 0 || a.cooldownMs > 3600000)) {
        errors.push(`action ${a.id} cooldownMs 0-3600000`);
      }
      // Presentación de la tecla: 'control' posee la superficie (un solo
      // control por tecla). `dynamic` (dato en tecla estándar) no es excluyente.
      if (a.surface !== undefined && a.surface !== 'control') {
        errors.push(`action ${a.id} surface debe ser 'control'`);
      }
      if (a.component !== undefined && (typeof a.component !== 'string' || a.component.length === 0)) {
        errors.push(`action ${a.id} component debe ser el nombre del componente visual`);
      }
      if (a.component !== undefined && a.surface !== 'control') {
        errors.push(`action ${a.id} component requiere surface 'control'`);
      }
      if (a.freeModeOnly !== undefined && typeof a.freeModeOnly !== 'boolean') {
        errors.push(`action ${a.id} freeModeOnly debe ser booleano`);
      }
      if (a.pollMs !== undefined && (typeof a.pollMs !== 'number' || a.pollMs < 250 || a.pollMs > 3600000)) {
        errors.push(`action ${a.id} pollMs 250-3600000`);
      }
      if (a.states !== undefined) {
        if (!Array.isArray(a.states)) errors.push(`action ${a.id} states debe ser array`);
        else {
          const seenStates = new Set<string>();
          for (const s of a.states) {
            if (!s || typeof s.value !== 'string' || s.value.length === 0) { errors.push(`action ${a.id} states[].value requerido`); continue; }
            if (seenStates.has(s.value)) errors.push(`action ${a.id} state duplicado: ${s.value}`);
            else seenStates.add(s.value);
            if (typeof s.label !== 'string' || s.label.length === 0) errors.push(`action ${a.id} state '${s.value}' requiere label`);
          }
        }
      }
      if (a.optionsFrom !== undefined) {
        const o = a.optionsFrom;
        if (!o || typeof o !== 'object') errors.push(`action ${a.id} optionsFrom debe ser objeto`);
        else {
          if (typeof o.field !== 'string' || o.field.length === 0) errors.push(`action ${a.id} optionsFrom.field requerido`);
          else if (a.schema?.properties && !(o.field in a.schema.properties)) {
            errors.push(`action ${a.id} optionsFrom.field '${o.field}' no está en schema.properties`);
          }
          if (typeof o.sourceAction !== 'string' || o.sourceAction.length === 0) errors.push(`action ${a.id} optionsFrom.sourceAction requerido`);
          if (o.cacheMs !== undefined && (typeof o.cacheMs !== 'number' || o.cacheMs < 0 || o.cacheMs > 3600000)) {
            errors.push(`action ${a.id} optionsFrom.cacheMs 0-3600000`);
          }
        }
      }
    }
  }
  if (manifest.engine && typeof manifest.engine !== 'string') errors.push('engine debe ser string semver range');
  if (manifest.apiVersion && typeof manifest.apiVersion !== 'string') errors.push('apiVersion debe ser string');
  else if (typeof manifest.apiVersion === 'string') {
    // Contrato versionado: avisar si el plugin pide un API mayor que el daemon.
    const majorOf = (v: string): number | null => {
      const m = /^\s*v?(\d+)/.exec(v);
      return m ? parseInt(m[1], 10) : null;
    };
    const wantMajor = majorOf(manifest.apiVersion);
    const haveMajor = majorOf(PLUGIN_API_VERSION);
    if (wantMajor !== undefined && haveMajor !== undefined && wantMajor > haveMajor) {
      warnings.push(`El plugin pide Plugin API ${manifest.apiVersion} y el daemon ofrece ${PLUGIN_API_VERSION}: actualiza LibreDeck`);
    }
  }
  if (manifest.category !== undefined) {
    const known = ['system', 'integrations', 'media', 'input', 'utility'];
    if (typeof manifest.category !== 'string') errors.push('category debe ser string');
    else if (!known.includes(manifest.category)) warnings.push(`category desconocida '${manifest.category}' (válidas: ${known.join(', ')})`);
  }
  if (manifest.os !== undefined) {
    if (!Array.isArray(manifest.os) || manifest.os.some((o: unknown) => typeof o !== 'string')) {
      errors.push('os debe ser array de strings (ej. ["win32","linux","darwin"])');
    }
  }
  if (manifest.widgets !== undefined) {
    if (!Array.isArray(manifest.widgets)) errors.push('widgets debe ser array');
    else {
      const seenW = new Set<string>();
      const kinds = ['text', 'progress', 'list', 'gauge', 'toggle'];
      const actionIds = new Set((manifest.actions ?? []).map((a: any) => a?.id));
      for (const w of manifest.widgets) {
        if (!w || typeof w.id !== 'string' || w.id.length === 0) { errors.push('widgets[].id requerido'); continue; }
        if (seenW.has(w.id)) errors.push(`widget.id duplicado: ${w.id}`);
        else seenW.add(w.id);
        if (!kinds.includes(w.kind)) errors.push(`widget '${w.id}' kind inválido (válidos: ${kinds.join(', ')})`);
        if (w.sourceAction !== undefined && !actionIds.has(w.sourceAction)) {
          errors.push(`widget '${w.id}' sourceAction '${w.sourceAction}' no existe en actions`);
        }
        if (w.refreshMs !== undefined && (typeof w.refreshMs !== 'number' || w.refreshMs < 500 || w.refreshMs > 3600000)) {
          errors.push(`widget '${w.id}' refreshMs 500-3600000`);
        }
      }
    }
  }
  if (manifest.instructions !== undefined && typeof manifest.instructions !== 'string') {
    errors.push('instructions debe ser texto');
  } else if (typeof manifest.instructions === 'string' && manifest.instructions.length > 20000) {
    errors.push('instructions excede 20000 caracteres');
  }
  if (manifest.settingsSchema !== undefined) {
    validateActionSchema('settings', manifest.settingsSchema, errors);
  }
  return { valid: errors.length === 0, errors, warnings };
}

export function assertValidManifest(manifest: any): asserts manifest is PluginManifestV2 {
  const r = validateManifest(manifest);
  if (!r.valid) throw new Error(`Manifest inválido: ${r.errors.join('; ')}`);
}

// --- semver mínimo (sin dependencias) ---

export function parseSemver(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (!m) return null;
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
}

/** -1 si a<b, 0 si iguales, 1 si a>b */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a); const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] < pb[i]) return -1;
    if (pa[i] > pb[i]) return 1;
  }
  return 0;
}

/** Soporta '*', 'x', '^1.2.3', '~1.2.3', '>=1.2.3', '=1.2.3' y '1.2.3'. */
export function satisfiesEngine(engine: string, current: string): boolean {
  const e = engine.trim();
  if (!e || e === '*' || e.toLowerCase() === 'x') return true;
  const cur = parseSemver(current);
  if (!cur) return true;
  const clean = (s: string) => s.replace(/^[=v\s]+/, '');
  if (e.startsWith('^')) {
    const base = parseSemver(clean(e.slice(1)));
    if (!base) return true;
    if (compareSemver(current, `${base[0]}.${base[1]}.${base[2]}`) < 0) return false;
    // ^0.x es más estricto, pero aquí basta con major igual cuando major>0
    if (base[0] > 0) return cur[0] === base[0];
    if (base[1] > 0) return cur[0] === 0 && cur[1] === base[1];
    return cur[0] === 0 && cur[1] === 0 && cur[2] === base[2];
  }
  if (e.startsWith('~')) {
    const base = parseSemver(clean(e.slice(1)));
    if (!base) return true;
    return cur[0] === base[0] && cur[1] === base[1] && compareSemver(current, `${base[0]}.${base[1]}.${base[2]}`) >= 0;
  }
  if (e.startsWith('>=')) {
    return compareSemver(current, clean(e.slice(2))) >= 0;
  }
  if (e.startsWith('>')) {
    return compareSemver(current, clean(e.slice(1))) > 0;
  }
  return compareSemver(current, clean(e)) >= 0;
}
