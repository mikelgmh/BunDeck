<template>
  <div v-if="open" class="fixed inset-0 z-[80]" role="dialog" aria-modal="true" :aria-label="t('settings.title')">
    <div class="absolute inset-0 bg-black/60" @click="close" aria-hidden="true"></div>
    <div class="absolute inset-0 flex items-center justify-center p-4">
      <div class="drawer-panel w-full max-w-[680px] rounded-2xl border border-base-300 bg-base-200 shadow-2xl">
        <div class="flex h-12 shrink-0 items-center justify-between border-b border-base-300 px-4">
          <h2 class="text-sm font-semibold tracking-tight">{{ t('settings.title') }}</h2>
          <button @click="close" class="btn btn-ghost btn-sm btn-square" :aria-label="t('settings.close')">
            <X :size="16" stroke-width="1.5" aria-hidden="true" />
          </button>
        </div>

        <div class="flex flex-col sm:flex-row sm:overflow-hidden">
          <!-- Navegación izquierda (pestañas arriba en móvil) -->
          <nav
            class="flex shrink-0 flex-row gap-1 overflow-x-auto border-b border-base-300 p-2 sm:min-h-[380px] sm:w-48 sm:flex-col sm:border-b-0 sm:border-r sm:p-3"
            :aria-label="t('settings.title')"
          >
            <button
              v-for="item in navItems"
              :key="item.id"
              @click="activeSection = item.id"
              :aria-current="activeSection === item.id ? 'page' : undefined"
              :data-cy="`settings-nav-${item.id}`"
              :class="[
                'flex shrink-0 items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] font-medium transition-[background-color] duration-150',
                activeSection === item.id
                  ? 'bg-base-300 text-base-content'
                  : 'text-base-content/70 hover:bg-base-300/60'
              ]"
            >
              <component :is="item.icon" :size="16" stroke-width="1.5" aria-hidden="true" />
              {{ item.label }}
            </button>
          </nav>

          <!-- Contenido derecha -->
          <div class="max-h-[60vh] min-h-[280px] flex-1 overflow-y-auto px-4 py-4 sm:max-h-none sm:min-h-[380px] sm:max-h-[380px]">
            <!-- General -->
            <section v-if="activeSection === 'general'" :aria-labelledby="'settings-general-title'">
              <h3 id="settings-general-title" class="mb-3 text-sm font-semibold">{{ t('settings.general') }}</h3>

              <!-- Dispositivo -->
              <p id="settings-device-title" class="mb-2 text-xs font-medium text-base-content/50">{{ t('settings.device') }}</p>
              <div class="rounded-xl border border-base-300 bg-base-100/50 p-3">
                <label class="sr-only" for="settings-device-select">{{ t('toolbar.selectStreamDeck') }}</label>
                <select
                  id="settings-device-select"
                  v-model="selectedDevice"
                  @change="handleDeviceChange"
                  class="select select-bordered select-sm ld-control ld-device-select w-full max-w-full font-medium"
                  :title="selectedDeviceTitle"
                  data-cy="streamdeck-selector"
                >
                  <option value="">{{ t('toolbar.selectStreamDeck') }}</option>
                  <option v-for="(d, i) in devices" :key="d.path" :value="d.path" :title="deviceTitle(d)">
                    {{ deviceShortLabel(d, i) }}
                  </option>
                </select>
                <button
                  @click="testDevice"
                  :disabled="!selectedDevice"
                  class="btn btn-ghost btn-sm mt-2 w-full"
                >
                  <Palette :size="16" stroke-width="1.5" aria-hidden="true" />
                  {{ t('toolbar.testStreamDeck') }}
                </button>
                <p class="ld-device-status mt-2 text-xs text-base-content/50" :title="deviceStatus" aria-live="polite">{{ deviceStatusShort }}</p>
              </div>

              <!-- Actualizaciones -->
              <template v-if="showUpdates">
                <p id="settings-updates-title" class="mb-2 mt-5 text-xs font-medium text-base-content/50">{{ t('toolbar.checkUpdates') }}</p>
                <div class="rounded-xl border border-base-300 bg-base-100/50 p-3">
                  <p class="text-[13px] text-base-content/70">{{ versionLine }}</p>
                  <button @click="emit('check-updates'); close()" class="btn btn-ghost btn-sm mt-2 w-full" data-cy="check-updates-button">
                    <Download :size="16" stroke-width="1.5" aria-hidden="true" />
                    {{ t('toolbar.checkUpdates') }}
                  </button>
                </div>
              </template>
            </section>

            <!-- Idioma -->
            <section v-else-if="activeSection === 'language'" :aria-labelledby="'settings-lang-title'">
              <h3 id="settings-lang-title" class="mb-3 text-sm font-semibold">{{ t('toolbar.language') }}</h3>
              <div class="rounded-xl border border-base-300 bg-base-100/50 p-1.5" role="radiogroup" :aria-label="t('toolbar.language')">
                <button
                  role="radio"
                  :aria-checked="currentLocale === 'es'"
                  @click="chooseLocale('es')"
                  :class="[
                    'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] font-medium transition-[background-color] duration-150',
                    currentLocale === 'es' ? 'bg-base-300 text-base-content' : 'text-base-content/70 hover:bg-base-300/60'
                  ]"
                >
                  <span class="w-4 text-center" aria-hidden="true">{{ currentLocale === 'es' ? '✓' : '' }}</span>
                  {{ t('toolbar.spanish') }}
                </button>
                <button
                  role="radio"
                  :aria-checked="currentLocale === 'en'"
                  @click="chooseLocale('en')"
                  data-cy="language-en"
                  :class="[
                    'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] font-medium transition-[background-color] duration-150',
                    currentLocale === 'en' ? 'bg-base-300 text-base-content' : 'text-base-content/70 hover:bg-base-300/60'
                  ]"
                >
                  <span class="w-4 text-center" aria-hidden="true">{{ currentLocale === 'en' ? '✓' : '' }}</span>
                  {{ t('toolbar.english') }}
                </button>
              </div>
            </section>

            <!-- Acerca de -->
            <section v-else :aria-labelledby="'settings-about-title'">
              <h3 id="settings-about-title" class="mb-3 text-sm font-semibold">{{ t('settings.about') }}</h3>
              <div class="rounded-xl border border-base-300 bg-base-100/50 p-3">
                <p class="text-[13px] font-medium">BunDeck</p>
                <p class="ld-count mt-0.5" translate="no">{{ versionLine }}</p>
              </div>
            </section>
          </div>
        </div>

        <div class="shrink-0 border-t border-base-300 px-4 py-3">
          <button @click="close" class="btn btn-ghost btn-sm w-full">{{ t('settings.close') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, nextTick, computed } from 'vue'
import { X, Palette, Download, SlidersHorizontal, Languages, Info } from 'lucide-vue-next'
import { useI18nStore } from '../composables/useI18n'

const { t } = useI18nStore()

type SettingsSection = 'general' | 'language' | 'about'

interface Props {
  currentLocale: string
  showUpdates: boolean
}

interface Emits {
  (e: 'language-changed', locale: string): void
  (e: 'streamdeck-connected'): void
  (e: 'streamdeck-disconnected'): void
  (e: 'check-updates'): void
}

const props = defineProps<Props>()
const emit = defineEmits<Emits>()

const open = ref(false)
const activeSection = ref<SettingsSection>('general')
const devices = ref<any[]>([])
const selectedDevice = ref('')
const deviceStatus = ref('')
const versionLine = ref('')
const config = ref({ wsPort: 3003, apiPort: 3001, frontendPort: 4321 })

// Etiqueta corta: solo el modelo (el path HID es larguísimo y desborda el select).
// El path completo queda en `title` como tooltip.
const deviceShortLabel = (d: any, index: number) => {
  const model = String(d?.model ?? '').trim() || 'Stream Deck'
  const sameModelCount = devices.value.filter((x) => String(x?.model ?? '').trim() === String(d?.model ?? '').trim()).length
  return sameModelCount > 1 ? `${model} · ${index + 1}` : model
}
const deviceTitle = (d: any) => {
  const model = String(d?.model ?? '').trim() || 'Stream Deck'
  return d?.path ? `${model} (${d.path})` : model
}
const selectedDeviceTitle = computed(() => {
  const found = devices.value.find((d) => d.path === selectedDevice.value)
  if (found) return deviceTitle(found)
  return selectedDevice.value || ''
})
const deviceStatusShort = computed(() => {
  if (!deviceStatus.value) return ''
  const found = devices.value.find((d) => d.path === deviceStatus.value)
  if (found) return deviceShortLabel(found, devices.value.indexOf(found))
  return deviceStatus.value.length > 40 ? `…${deviceStatus.value.slice(-36)}` : deviceStatus.value
})

const navItems = computed(() => [
  { id: 'general' as const, label: t('settings.general'), icon: SlidersHorizontal },
  { id: 'language' as const, label: t('toolbar.language'), icon: Languages },
  { id: 'about' as const, label: t('settings.about'), icon: Info }
])

const getApiBase = () => {
  if (typeof window !== 'undefined') {
    return `${window.location.protocol}//${window.location.hostname}:${config.value.apiPort}/api/v1`
  }
  return 'http://localhost:3001/api/v1'
}

const loadConfig = async () => {
  try {
    const url = typeof window !== 'undefined' && window.location.port !== '3001'
      ? 'http://localhost:3001/config' : '/config'
    const res = await fetch(url)
    config.value = await res.json()
  } catch { /* keep defaults */ }
}

const loadDevices = async () => {
  try {
    const res = await fetch(`${getApiBase()}/devices/streamdeck`)
    devices.value = res.ok ? (await res.json() ?? []) : []
    if (!Array.isArray(devices.value)) devices.value = []
  } catch { devices.value = [] }
}

const loadVersion = async () => {
  try {
    const res = await fetch(`${getApiBase()}/version`)
    if (res.ok) {
      const data = await res.json()
      versionLine.value = data.version ? `v${data.version}` : ''
    }
  } catch { /* noop */ }
}

const handleDeviceChange = async () => {
  const path = selectedDevice.value
  try {
    if (path) {
      const res = await fetch(`${getApiBase()}/devices/streamdeck/connect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ devicePath: path })
      })
      const result = await res.json()
      if (result.success) {
        deviceStatus.value = result.connectedDevice ?? ''
        emit('streamdeck-connected')
      } else {
        selectedDevice.value = ''
        deviceStatus.value = ''
      }
    } else {
      await fetch(`${getApiBase()}/devices/streamdeck/disconnect`, { method: 'POST' })
      deviceStatus.value = ''
      emit('streamdeck-disconnected')
    }
  } catch {
    selectedDevice.value = ''
    deviceStatus.value = ''
  }
}

const testDevice = async () => {
  try {
    await fetch(`${getApiBase()}/devices/streamdeck/test`, { method: 'POST' })
  } catch { /* noop */ }
}

const chooseLocale = (locale: string) => {
  emit('language-changed', locale)
}

const show = () => {
  activeSection.value = 'general'
  open.value = true
  loadDevices()
  loadVersion()
  nextTick(() => {
    document.querySelector<HTMLElement>('#settings-device-select')?.focus()
  })
}
const close = () => { open.value = false }

watch(open, (v) => {
  if (v) document.addEventListener('keydown', onEsc)
  else document.removeEventListener('keydown', onEsc)
})
const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }

loadConfig()
defineExpose({ show, close, open })
</script>
