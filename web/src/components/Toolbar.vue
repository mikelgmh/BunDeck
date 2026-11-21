<template>
  <header class="bg-base-200 border-b border-base-300 px-4 shrink-0">
    <div class="flex justify-between items-center h-12 gap-2">
      <div class="flex items-center gap-2 min-w-0">
        <div class="join" role="tablist" :aria-label="t('toolbar.editMode')">
          <button
            @click="$emit('mode-changed', 'edit')"
            role="tab"
            :aria-selected="currentMode === 'edit'"
            :class="[
              'btn join-item btn-sm border-0 shadow-none',
              currentMode === 'edit' ? 'btn-primary' : 'btn-ghost'
            ]"
            :title="t('toolbar.editMode')"
            :aria-label="t('toolbar.editMode')"
          >
            <Edit :size="16" stroke-width="1.5" aria-hidden="true" />
            <span class="hidden sm:inline ml-1.5 font-medium">{{ t('toolbar.edit') }}</span>
          </button>
          <button
            @click="$emit('mode-changed', 'deck')"
            role="tab"
            :aria-selected="currentMode === 'deck'"
            :class="[
              'btn join-item btn-sm border-0 shadow-none',
              currentMode === 'deck' ? 'btn-primary' : 'btn-ghost'
            ]"
            :title="t('toolbar.deckMode')"
            :aria-label="t('toolbar.deckMode')"
          >
            <Grid3x3 :size="16" stroke-width="1.5" aria-hidden="true" />
            <span class="hidden sm:inline ml-1.5 font-medium">{{ t('toolbar.deck') }}</span>
          </button>
        </div>

        <div class="w-px h-6 bg-base-content/10 mx-1 shrink-0" aria-hidden="true"></div>

        <label class="sr-only" for="profile-select">{{ t('toolbar.selectProfile') }}</label>
        <select
          id="profile-select"
          :value="selectedProfile"
          @change="handleProfileChange"
          class="select select-bordered select-sm ld-control w-44 font-medium"
          data-cy="profile-selector"
        >
          <option value="">{{ t('toolbar.selectProfile') }}</option>
          <option v-for="profile in profiles" :key="profile.id" :value="profile.id" data-cy="profile-option">
            {{ profile.name }}
          </option>
        </select>
        <button
          @click="$emit('show-profile-settings')"
          class="btn btn-ghost btn-sm btn-square"
          :title="t('toolbar.profileSettings')"
          :aria-label="t('toolbar.profileSettings')"
        >
          <Settings :size="16" stroke-width="1.5" aria-hidden="true" />
        </button>
      </div>
      <div class="flex items-center gap-2 shrink-0">
        <button
          @click="$emit('show-qr')"
          class="btn btn-ghost btn-sm btn-square"
          :title="t('toolbar.showQR')"
          :aria-label="t('toolbar.showQR')"
        >
          <QrCode :size="16" stroke-width="1.5" aria-hidden="true" />
        </button>

        <button
          v-if="!isIPhone"
          @click="toggleFullscreen"
          class="btn btn-ghost btn-sm btn-square"
          :title="isFullscreen ? t('toolbar.exitFullscreen') : t('toolbar.fullscreen')"
          :aria-label="isFullscreen ? t('toolbar.exitFullscreen') : t('toolbar.fullscreen')"
        >
          <Maximize2 v-if="!isFullscreen" :size="16" stroke-width="1.5" aria-hidden="true" />
          <Minimize2 v-else :size="16" stroke-width="1.5" aria-hidden="true" />
        </button>

        <button
          @click="$emit('show-settings')"
          class="btn btn-ghost btn-sm btn-square"
          :title="t('settings.title')"
          :aria-label="t('settings.title')"
          data-cy="toolbar-settings"
        >
          <SlidersHorizontal :size="16" stroke-width="1.5" aria-hidden="true" />
        </button>
      </div>
    </div>
  </header>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { QrCode, Maximize2, Minimize2, Settings, Edit, Grid3x3, SlidersHorizontal } from 'lucide-vue-next'
import { useI18nStore } from '../composables/useI18n'
import type { ProfileData } from '../types/streamdeck'

const { t } = useI18nStore()

interface Props {
  profiles: ProfileData[]
  selectedProfile: string
  currentMode: 'edit' | 'deck'
}

interface Emits {
  (e: 'profile-changed', profileId: string): void
  (e: 'show-qr'): void
  (e: 'show-profile-settings'): void
  (e: 'show-settings'): void
  (e: 'mode-changed', mode: 'edit' | 'deck'): void
}

defineProps<Props>()
const emit = defineEmits<Emits>()

const isFullscreen = ref(false)
const isIPhone = ref(false)

const handleProfileChange = (event: Event) => {
  const target = event.target as HTMLSelectElement
  emit('profile-changed', target.value)
}

const toggleFullscreen = async () => {
  try {
    if (!document.fullscreenElement) {
      await document.documentElement.requestFullscreen()
    } else {
      await document.exitFullscreen()
    }
  } catch (error) {
    console.error('Error al cambiar pantalla completa:', error)
  }
}

const handleFullscreenChange = () => {
  isFullscreen.value = !!document.fullscreenElement
}

onMounted(() => {
  const userAgent = window.navigator.userAgent.toLowerCase()
  isIPhone.value = /iphone/.test(userAgent)
  document.addEventListener('fullscreenchange', handleFullscreenChange)
})

onUnmounted(() => {
  document.removeEventListener('fullscreenchange', handleFullscreenChange)
})
</script>
