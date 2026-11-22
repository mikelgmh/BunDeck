<template>
  <div class="bd-schema" data-swapy-no-drag>
    <!-- Render each property based on its schema -->
    <div
      v-for="(property, propKey) in schemaProperties"
      :key="propKey"
      class="bd-fld"
    >
      <!-- String input -->
      <template v-if="property.ui?.component === 'input' && property.ui.type === 'text'">
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
            v-for="option in property.ui.options"
            :key="option.value"
            :value="option.value"
          >
            {{ option.label }}
          </option>
        </select>
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
import { computed } from 'vue'
import { FolderOpen } from 'lucide-vue-next'
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
}

interface Emits {
  (e: 'update:modelValue', value: Record<string, any>): void
}

const props = defineProps<Props>()
const emit = defineEmits<Emits>()

// Get only visible properties (not hidden)
const schemaProperties = computed(() => {
  const properties: Record<string, SchemaProperty> = {}

  for (const [key, property] of Object.entries(props.schema.properties)) {
    if (property.ui?.component !== 'hidden') {
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

    console.log('🔍 Abriendo diálogo de selección de archivos...')

    // Llamar al endpoint que abre el diálogo nativo
    const response = await fetch(apiUrl)

    if (response.ok) {
      const result = await response.json()

      if (result.success && result.path) {
        console.log('✅ Archivo seleccionado:', result.path)
        // Actualizar el campo con la ruta completa
        updateValue(propKey, result.path)

        alert(`Archivo seleccionado exitosamente:\n\n${result.filename}\n\nRuta: ${result.path}`)
      } else {
        console.log('❌ Usuario canceló la selección')
        // No mostrar mensaje de error si el usuario canceló
      }
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
