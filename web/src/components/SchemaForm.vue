<template>
  <div class="bd-schema" data-swapy-no-drag>
    <!-- Render each property based on its schema -->
    <div
      v-for="(property, propKey) in schemaProperties"
      :key="propKey"
      class="bd-fld"
    >
      <!-- Dynamic options field (optionsFrom): buscador con lista lazy.
           Solo renderiza las primeras N coincidencias (sin re-render completo
           por tecla). Escribe para filtrar, elige de la lista o escribe a mano. -->
      <template v-if="isDynField(propKey)">
        <label class="bd-lb" :for="`sf-${propKey}`">{{ property.title || propKey }}</label>
        <div class="bd-r2">
          <input
            :id="`sf-${propKey}`"
            :value="dynQuery"
            @input="onDynInput(propKey, ($event.target as HTMLInputElement).value)"
            @focus="dynOpen = true"
            @keydown.escape="dynOpen = false"
            type="text"
            :placeholder="property.ui.placeholder"
            class="bd-inp"
            data-swapy-no-drag
            data-cy="sf-dyn-input"
            autocomplete="off"
            spellcheck="false"
            role="combobox"
            :aria-expanded="dynOpen"
            :aria-controls="dynListId"
            aria-autocomplete="list"
          />
          <button
            @click="fetchDynamicOptions()"
            class="bd-btn"
            :title="'Recargar lista'"
            :aria-label="'Recargar lista de ' + (property.title || propKey)"
            data-swapy-no-drag
            :disabled="dynLoading"
          >
            <component :is="RefreshCw" :size="16" stroke-width="1.75" aria-hidden="true" :class="{ 'animate-spin': dynLoading }" />
          </button>
        </div>
        <ul
          v-if="dynOpen && dynLoaded && !dynError"
          :id="dynListId"
          class="bd-dyn-list"
          role="listbox"
          data-cy="sf-dyn-list"
        >
          <li v-for="o in visibleDynOptions" :key="o.value" role="option" :aria-selected="String(modelValue[propKey] ?? '') === o.value">
            <button type="button" class="bd-dyn-opt" data-cy="sf-dyn-opt" :data-value="o.value" @click="pickDynOption(propKey, o)">
              <span class="bd-dyn-val">{{ o.value }}</span>
              <small v-if="o.label !== o.value" class="bd-dyn-label">{{ o.label }}</small>
              <small v-if="o.state" class="bd-dyn-state">{{ o.state }}</small>
            </button>
          </li>
        </ul>
        <button
          v-if="dynOpen && dynHasMore"
          type="button"
          class="bd-btn bd-wide"
          data-cy="sf-dyn-more"
          data-swapy-no-drag
          @click="dynShowMore"
        >
          Mostrar más ({{ dynRemaining }} restantes)
        </button>
        <p v-if="dynLoading" class="bd-hint">Cargando lista…</p>
        <p v-else-if="dynError" class="bd-hint">No se pudo cargar la lista ({{ dynError }}). Puedes escribir el valor a mano.</p>
        <p v-if="dynNeedsPluginConfig" class="bd-hint" data-cy="sf-dyn-config-hint">Configura la conexión en los ajustes del plugin (menú ⋯) y pulsa Recargar lista.</p>
        <p v-else-if="dynHint" class="bd-hint">{{ dynHint }}</p>
        <p v-else-if="dynLoaded" class="bd-hint">{{ dynFilteredTotal }} opciones — mostrando {{ visibleDynOptions.length }}. Escribe para filtrar.</p>
      </template>

      <!-- String input -->
      <template v-else-if="property.ui?.component === 'input' && property.ui.type === 'text'">
        <label class="bd-lb" :for="`sf-${propKey}`">{{ property.title || propKey }}</label>
        <input
          :id="`sf-${propKey}`"
          :value="modelValue[propKey] || property.default || ''"
          @input="updateValue(propKey, ($event.target as HTMLInputElement).value)"
          type="text"
          :placeholder="property.ui.placeholder"
          class="bd-inp"
          data-swapy-no-drag
          autocomplete="off"
        />
      </template>

      <!-- URL input -->
      <template v-else-if="property.ui?.component === 'input' && property.ui.type === 'url'">
        <label class="bd-lb" :for="`sf-${propKey}`">{{ property.title || propKey }}</label>
        <input
          :id="`sf-${propKey}`"
          :value="modelValue[propKey] || property.default || ''"
          @input="updateValue(propKey, ($event.target as HTMLInputElement).value)"
          type="url"
          inputmode="url"
          :placeholder="property.ui.placeholder"
          class="bd-inp"
          data-swapy-no-drag
          autocomplete="off"
          spellcheck="false"
        />
      </template>

      <!-- Number input -->
      <template v-else-if="property.ui?.component === 'input' && property.ui.type === 'number'">
        <label class="bd-lb" :for="`sf-${propKey}`">{{ property.title || propKey }}</label>
        <input
          :id="`sf-${propKey}`"
          :value="modelValue[propKey] || property.default || 0"
          @input="updateValue(propKey, parseInt(($event.target as HTMLInputElement).value) || 0)"
          type="number"
          :placeholder="property.ui.placeholder"
          :min="property.ui.min"
          :max="property.ui.max"
          class="bd-inp"
          data-swapy-no-drag
        />
      </template>

      <!-- Textarea -->
      <template v-else-if="property.ui?.component === 'textarea'">
        <label class="bd-lb" :for="`sf-${propKey}`">{{ property.title || propKey }}</label>
        <textarea
          :id="`sf-${propKey}`"
          :value="modelValue[propKey] || property.default || ''"
          @input="updateValue(propKey, ($event.target as HTMLTextAreaElement).value)"
          :placeholder="property.ui.placeholder"
          :rows="property.ui.rows || 3"
          class="bd-inp"
          data-swapy-no-drag
        ></textarea>
      </template>

      <!-- Select dropdown -->
      <template v-else-if="property.ui?.component === 'select'">
        <label class="bd-lb" :for="`sf-${propKey}`">{{ property.title || propKey }}</label>
        <select
          :id="`sf-${propKey}`"
          :value="modelValue[propKey] || property.default || ''"
          @change="updateValue(propKey, ($event.target as HTMLSelectElement).value)"
          class="bd-inp"
          data-swapy-no-drag
        >
          <option value="">{{ property.ui.placeholder || 'Seleccionar...' }}</option>
          <option
            v-for="option in optionsFor(propKey, property)"
            :key="option.value"
            :value="option.value"
          >
            {{ option.label }}
          </option>
        </select>
        <p v-if="propKey === 'action' && actionMismatch" class="bd-hint">{{ actionMismatch }}</p>
      </template>

      <!-- File input with button -->
      <template v-else-if="property.ui?.component === 'file'">
        <label class="bd-lb" :for="`sf-${propKey}`">{{ property.title || propKey }}</label>
        <div class="bd-r2">
          <input
            :id="`sf-${propKey}`"
            :value="modelValue[propKey] || property.default || ''"
            @input="updateValue(propKey, ($event.target as HTMLInputElement).value)"
            :type="property.ui.type || 'text'"
            :placeholder="property.ui.placeholder"
            class="bd-inp"
            data-swapy-no-drag
            autocomplete="off"
          />
          <button
            @click="openFileDialog(propKey)"
            class="bd-btn"
            title="Seleccionar archivo"
            :aria-label="'Seleccionar archivo: ' + (property.title || propKey)"
            data-swapy-no-drag
          >
            <component :is="FolderOpen" :size="16" stroke-width="1.75" aria-hidden="true" />
          </button>
        </div>
      </template>

      <!-- Special case: Page selector -->
      <template v-else-if="property.ui?.component === 'page-select'">
        <label class="bd-lb" :for="`sf-${propKey}`">{{ property.title || propKey }}</label>
        <select
          :id="`sf-${propKey}`"
          :value="modelValue[propKey] || property.default || ''"
          @change="updateValue(propKey, ($event.target as HTMLSelectElement).value)"
          class="bd-inp"
          data-swapy-no-drag
        >
          <option value="">{{ property.ui.placeholder || 'Seleccionar página...' }}</option>
          <option
            v-for="page in availablePages"
            :key="page.id"
            :value="page.id"
          >
            {{ page.name }}
          </option>
        </select>
        <p v-if="selectedPageName" class="bd-hint">
          Navegará a: {{ selectedPageName }}
        </p>
      </template>

      <!-- Hidden field (for internal use) -->
      <template v-else-if="property.ui?.component === 'hidden'">
        <!-- Hidden field, value managed internally -->
      </template>

      <!-- Fallback: Basic input for unknown types -->
      <template v-else>
        <label class="bd-lb" :for="`sf-${propKey}`">{{ property.title || propKey }}</label>
        <input
          :id="`sf-${propKey}`"
          :value="modelValue[propKey] || property.default || ''"
          @input="updateValue(propKey, ($event.target as HTMLInputElement).value)"
          type="text"
          :placeholder="property.ui?.placeholder"
          class="bd-inp"
          data-swapy-no-drag
          autocomplete="off"
        />
      </template>
      <p v-if="property.description" class="bd-hint">{{ property.description }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { FolderOpen, RefreshCw } from 'lucide-vue-next'
import { getTunnelToken, tunnelApiBase } from '../composables/useTunnel'

interface SchemaProperty {
  type: string
  title?: string
  description?: string
  default?: any
  enum?: string[]
  ui?: {
    component: string
    type?: string
    placeholder?: string
    options?: Array<{ value: any; label: string }>
    min?: number
    max?: number
    rows?: number
  }
  visibleWhen?: { field: string; domains?: string[]; values?: string[] }
}

interface Schema {
  type: 'object'
  properties: Record<string, SchemaProperty>
  required?: string[]
}

interface Props {
  schema: Schema
  modelValue: Record<string, any>
  availablePages?: Array<{ id: string; name: string }>
  /** Plugin/acción que se edita (para resolver opciones dinámicas). */
  pluginId?: string | null
  actionId?: string | null
  /** Declaración `optionsFrom` de la acción (campo con lista remota). */
  dynamicOptions?: { field: string; sourceAction?: string; cacheMs?: number } | null
}

interface DynamicOption {
  value: string
  label: string
  domain?: string
  state?: string
  actions?: string[]
}

/** Caché en memoria por plugin/acción/campo+params (respeta cacheMs del plugin). */
const dynCache = new Map<string, { at: number; options: DynamicOption[] }>()

const props = defineProps<Props>()
const emit = defineEmits<Emits>()

/** Opciones visibles a la vez en el desplegable (lista lazy). */
const DYN_PAGE_SIZE = 50

const dynOptions = ref<DynamicOption[]>([])
const dynLoading = ref(false)
const dynError = ref('')
const dynLoaded = ref(false)
const dynOpen = ref(false)
const dynLimit = ref(DYN_PAGE_SIZE)
const dynUid = Math.random().toString(36).slice(2, 8)
const dynListId = computed(() => `dyn-${props.pluginId ?? 'p'}-${props.actionId ?? 'a'}-${dynUid}`)

const isDynField = (propKey: string): boolean =>
  !!props.pluginId && !!props.actionId && props.dynamicOptions?.field === propKey

const dynFieldKey = computed(() => props.dynamicOptions?.field ?? '')

const selectedDynOption = computed((): DynamicOption | null => {
  const k = dynFieldKey.value
  if (!k || !props.pluginId) return null
  const v = props.modelValue?.[k]
  if (v === undefined || v === null || v === '') return null
  return dynOptions.value.find((o) => o.value === String(v)) ?? null
})

/** Dominio de un entity_id ('' si no hay entidad). */
function domainOfEntityId(value: unknown): string {
  return String(value ?? '').split('.')[0]?.trim().toLowerCase() ?? ''
}

/**
 * Tabla dominio->campos (fallback para homeassistant cuando el schema no
 * trae `visibleWhen`). Dominios ausentes o entidad vacia: mostrar todo.
 */
const HA_CONDITIONAL_FIELDS = ['brightness', 'colorTemp', 'position', 'hvacMode', 'temperature']
const HA_DOMAIN_FIELDS: Record<string, string[]> = {
  light: ['brightness', 'colorTemp'],
  cover: ['position'],
  climate: ['hvacMode', 'temperature'],
  sensor: [],
  binary_sensor: [],
  scene: [],
  script: [],
  automation: []
}

/** Texto del buscador (sincronizado con el valor del campo). */
const dynQuery = ref('')
watch(() => props.modelValue?.[dynFieldKey.value], (v) => {
  const s = String(v ?? '')
  if (s !== dynQuery.value) dynQuery.value = s
}, { immediate: true })

/** Coincidencias del buscador (bucle unico sobre datos; el DOM queda acotado). */
const dynFiltered = computed(() => {
  const q = dynQuery.value.trim().toLowerCase()
  if (!q) return dynOptions.value
  const out: DynamicOption[] = []
  for (const o of dynOptions.value) {
    if (o.value.toLowerCase().includes(q) || o.label.toLowerCase().includes(q)) out.push(o)
  }
  return out
})

const dynFilteredTotal = computed(() => dynFiltered.value.length)
const visibleDynOptions = computed(() => dynFiltered.value.slice(0, dynLimit.value))
const dynRemaining = computed(() => Math.max(0, dynFilteredTotal.value - visibleDynOptions.value.length))
const dynHasMore = computed(() => dynRemaining.value > 0)

/** Error por falta de configuracion del plugin (lleva a sus ajustes). */
const dynNeedsPluginConfig = computed(() => /ajuste.*plugin|URL base|token/i.test(dynError.value))

function onDynInput(fieldKey: string, value: string) {
  dynQuery.value = value
  dynLimit.value = DYN_PAGE_SIZE
  dynOpen.value = true
  updateValue(fieldKey, value)
}

function pickDynOption(fieldKey: string, option: DynamicOption) {
  dynQuery.value = option.value
  updateValue(fieldKey, option.value)
  dynOpen.value = false
}

function dynShowMore() {
  dynLimit.value += DYN_PAGE_SIZE
}

/** Visibilidad condicional de un campo (metadata `visibleWhen` del schema
 *  o tabla dominio->campos para homeassistant). Fallback: mostrar todo. */
function isPropVisible(propKey: string, property: SchemaProperty): boolean {
  const vw = property.visibleWhen
  if (vw && (vw.domains?.length || vw.values?.length)) {
    const raw = props.modelValue?.[vw.field]
    if (vw.values?.length) {
      if (raw === undefined || raw === null || raw === '') return true
      return vw.values.map(String).includes(String(raw))
    }
    const domain = domainOfEntityId(raw)
    if (!domain) return true
    if (!(domain in HA_DOMAIN_FIELDS) && !(vw.domains ?? []).includes(domain)) return true
    return (vw.domains ?? []).includes(domain)
  }
  if (props.pluginId === 'homeassistant' && HA_CONDITIONAL_FIELDS.includes(propKey)) {
    const domain = domainOfEntityId(props.modelValue?.['entityId'])
    if (!domain || !(domain in HA_DOMAIN_FIELDS)) return true
    return HA_DOMAIN_FIELDS[domain].includes(propKey)
  }
  return true
}

const actionLabelOf = (value: string): string => {
  const act = props.schema.properties?.['action'] as SchemaProperty | undefined
  const opts = act?.ui?.options ?? []
  return opts.find((o) => String(o.value) === String(value))?.label ?? String(value)
}

/** Pista bajo el campo dinámico: estado + acciones compatibles de la entidad. */
const dynHint = computed(() => {
  const o = selectedDynOption.value
  if (!o) return ''
  const parts: string[] = []
  if (o.state) parts.push(`estado: ${o.state}`)
  if (Array.isArray(o.actions) && o.actions.length) {
    parts.push(`acciones: ${o.actions.map(actionLabelOf).join(', ')}`)
  }
  return parts.join(' · ')
})

/** Filtra el select `action` a las acciones compatibles con la entidad elegida. */
const optionsFor = (propKey: string, property: SchemaProperty) => {
  const base = property.ui?.options ?? []
  if (propKey !== 'action' || !selectedDynOption.value?.actions) return base
  const allowed = new Set(selectedDynOption.value.actions.map(String))
  const current = props.modelValue?.['action']
  const filtered = base.filter(
    (o) => allowed.has(String(o.value)) || (current !== undefined && String(o.value) === String(current))
  )
  return filtered.length ? filtered : base
}

/** Aviso cuando la acción elegida no es compatible con la entidad. */
const actionMismatch = computed(() => {
  const acts = selectedDynOption.value?.actions
  const cur = props.modelValue?.['action']
  if (!acts || cur === undefined || cur === null || cur === '') return ''
  if (!acts.map(String).includes(String(cur))) {
    return `«${actionLabelOf(String(cur))}» no es compatible con ${selectedDynOption.value?.value}`
  }
  return ''
})

const fetchDynamicOptions = async () => {
  if (!props.pluginId || !props.actionId || !props.dynamicOptions?.field) return
  dynLoading.value = true
  dynError.value = ''
  try {
    const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:'
    const hostname = window.location.hostname
    const tunnelToken = getTunnelToken()
    const apiBase = tunnelToken ? tunnelApiBase(tunnelToken) : `${protocol}//${hostname}:3001/api/v1`
    const cacheMs = props.dynamicOptions.cacheMs ?? 30000
    const key = `${props.pluginId}.${props.actionId}.${props.dynamicOptions.field}:${JSON.stringify(props.modelValue ?? {})}`
    const hit = dynCache.get(key)
    if (hit && Date.now() - hit.at < cacheMs) {
      dynOptions.value = hit.options
      dynLoaded.value = true
      dynLimit.value = DYN_PAGE_SIZE
      return
    }
    const res = await fetch(`${apiBase}/plugins/action-options`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pluginId: props.pluginId,
        actionId: props.actionId,
        field: props.dynamicOptions.field,
        params: props.modelValue ?? {}
      }),
      signal: AbortSignal.timeout(25000)
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(String(body?.error ?? `Error ${res.status}`))
    if (body?.success === false) throw new Error(String(body?.error ?? 'No se pudieron obtener las opciones'))
    const list: DynamicOption[] = (Array.isArray(body?.options) ? body.options : [])
      .filter((o: any) => o && o.value !== undefined)
      .map((o: any) => ({
        value: String(o.value),
        label: String(o.label ?? o.value),
        domain: o.domain ? String(o.domain) : undefined,
        state: o.state !== undefined ? String(o.state) : undefined,
        actions: Array.isArray(o.actions) ? o.actions.map(String) : undefined
      }))
    dynOptions.value = list
    dynLoaded.value = true
    dynLimit.value = DYN_PAGE_SIZE
    dynCache.set(key, { at: Date.now(), options: list })
  } catch (e) {
    dynError.value = e instanceof Error ? e.message : String(e)
  } finally {
    dynLoading.value = false
  }
}

onMounted(() => {
  if (props.pluginId && props.actionId && props.dynamicOptions?.field) fetchDynamicOptions()
})

interface Emits {
  (e: 'update:modelValue', value: Record<string, any>): void
}

// Get only visible properties (not hidden)
const schemaProperties = computed(() => {
  const properties: Record<string, SchemaProperty> = {}

  for (const [key, property] of Object.entries(props.schema.properties)) {
    if (property.ui?.component !== 'hidden' && isPropVisible(key, property)) {
      properties[key] = property
    }
  }

  return properties
})

// Get selected page name for display
const selectedPageName = computed(() => {
  if (!props.availablePages || !props.modelValue.pageId) return ''
  const page = props.availablePages.find(p => p.id === props.modelValue.pageId)
  return page ? page.name : ''
})

const updateValue = (key: string, value: any) => {
  // If updating pageId, also update pageName for display
  if (key === 'pageId' && props.availablePages) {
    const page = props.availablePages.find(p => p.id === value)
    if (page) {
      emit('update:modelValue', {
        ...props.modelValue,
        [key]: value,
        pageName: page.name
      })
      return
    }
  }

  emit('update:modelValue', {
    ...props.modelValue,
    [key]: value
  })
}

const openFileDialog = async (propKey: string) => {
  try {
    // Construir la URL de la API del daemon
    const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:'
    const hostname = window.location.hostname
    const tunnelToken = getTunnelToken()
    const apiUrl = tunnelToken
      ? `${tunnelApiBase(tunnelToken)}/files/select`
      : `${protocol}//${hostname}:3001/api/v1/files/select`

    // Llamar al endpoint que abre el diálogo nativo
    const response = await fetch(apiUrl)

    if (response.ok) {
      const result = await response.json()

      if (result.success && result.path) {
        // Actualizar el campo con la ruta completa
        updateValue(propKey, result.path)

        alert(`Archivo seleccionado exitosamente:\n\n${result.filename}\n\nRuta: ${result.path}`)
      }
      // Si el usuario canceló, no se muestra ningún mensaje de error
    } else {
      const errorText = await response.text()
      console.error('❌ Error en selección de archivos:', errorText)
      alert('Error al abrir el diálogo de selección de archivos. Verifica que el daemon esté ejecutándose.')
    }
  } catch (error) {
    console.error('❌ Error de conexión:', error)
    alert(`Error de conexión: ${error instanceof Error ? error.message : 'Error desconocido'}. Verifica que el daemon esté ejecutándose en el puerto 3001.`)
  }
}
</script>
