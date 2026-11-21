<template>
  <div v-if="open" class="fixed inset-0 z-[80]" role="dialog" aria-modal="true" :aria-label="t('profileDrawer.title')">
    <div class="absolute inset-0 bg-black/60" @click="closeModal" aria-hidden="true"></div>
    <aside class="drawer-panel absolute right-0 top-0 flex h-full w-full max-w-[400px] flex-col border-l border-base-300 bg-base-200 shadow-2xl">
      <div class="flex h-12 shrink-0 items-center justify-between border-b border-base-300 px-4">
        <h2 class="text-sm font-semibold tracking-tight">{{ t('profileDrawer.title') }}</h2>
        <button @click="closeModal" class="btn btn-ghost btn-sm btn-square" :aria-label="t('profileDrawer.close')">
          <X :size="16" stroke-width="1.5" aria-hidden="true" />
        </button>
      </div>

      <div class="flex-1 overflow-y-auto px-4 py-4">
        <!-- Lista -->
        <p class="mb-2 text-xs font-medium text-base-content/50">{{ t('profileDrawer.list') }}</p>
        <div role="listbox" :aria-label="t('profileDrawer.list')" class="flex flex-col gap-1">
          <button
            v-for="profile in profiles"
            :key="profile.id"
            role="option"
            :aria-selected="selectedProfileId === profile.id"
            @click="selectProfile(profile.id)"
            @keydown.enter="selectProfile(profile.id)"
            :class="[
              'flex items-center justify-between rounded-xl border px-3 py-2 text-left text-[13px] font-medium transition-[background-color,border-color] duration-150',
              selectedProfileId === profile.id
                ? 'bg-base-300 border-base-content/15 text-base-content'
                : 'bg-transparent border-transparent text-base-content/70 hover:bg-base-300/60 hover:text-base-content'
            ]"
          >
            <span class="truncate">{{ profile.name }}</span>
            <span v-if="selectedProfileId === profile.id" class="ld-count shrink-0">●</span>
          </button>
        </div>

        <!-- Crear inline -->
        <form @submit.prevent="handleCreateProfile" class="mt-3 flex gap-2">
          <label class="sr-only" for="new-profile-name">{{ t('profileDrawer.newName') }}</label>
          <input
            id="new-profile-name"
            v-model="newProfileName"
            type="text"
            :placeholder="t('profileDrawer.newPlaceholder') + '…'"
            class="input input-bordered input-sm ld-control flex-1 px-3 placeholder:text-base-content/40"
            autocomplete="off"
            spellcheck="false"
          />
          <button type="submit" :disabled="!newProfileName.trim()" class="btn btn-primary btn-sm shrink-0">
            <Plus :size="16" stroke-width="1.5" aria-hidden="true" />
            <span class="hidden sm:inline">{{ t('profileDrawer.create') }}</span>
          </button>
        </form>

        <!-- Ajustes -->
        <div v-if="selectedProfile" class="mt-6">
          <p class="mb-2 text-xs font-medium text-base-content/50">{{ t('profileDrawer.settings') }}</p>
          <div class="rounded-xl border border-base-300 bg-base-100/50 p-3">
            <div class="form-control w-full">
              <label class="label py-1" for="profile-name-input">
                <span class="label-text text-[13px] font-medium">{{ t('profileDrawer.name') }}</span>
              </label>
              <input
                id="profile-name-input"
                v-model="profileName"
                type="text"
                class="input input-bordered input-sm ld-control w-full px-3"
                autocomplete="off"
                spellcheck="false"
                @blur="handleNameChange"
                @keyup.enter="handleNameChange"
              />
            </div>

            <div class="mt-3 grid grid-cols-2 gap-2">
              <div>
                <span class="mb-1 block text-[13px] font-medium" id="cols-label">{{ t('profileDrawer.cols') }}</span>
                <div class="flex items-center gap-1" role="group" aria-labelledby="cols-label">
                  <button @click="gridCols = Math.max(3, gridCols - 1); handleGridColsChange()" class="btn btn-ghost btn-xs btn-square" :aria-label="t('streamDeckGrid.reduceColumns')">
                    <Minus :size="14" stroke-width="1.5" aria-hidden="true" />
                  </button>
                  <span class="ld-count min-w-8 text-center" aria-live="polite">{{ gridCols }}</span>
                  <button @click="gridCols = Math.min(8, gridCols + 1); handleGridColsChange()" class="btn btn-ghost btn-xs btn-square" :aria-label="t('streamDeckGrid.increaseColumns')">
                    <Plus :size="14" stroke-width="1.5" aria-hidden="true" />
                  </button>
                </div>
              </div>
              <div>
                <span class="mb-1 block text-[13px] font-medium" id="rows-label">{{ t('profileDrawer.rows') }}</span>
                <div class="flex items-center gap-1" role="group" aria-labelledby="rows-label">
                  <button @click="gridRows = Math.max(2, gridRows - 1); handleGridRowsChange()" class="btn btn-ghost btn-xs btn-square" :aria-label="t('streamDeckGrid.reduceRows')">
                    <Minus :size="14" stroke-width="1.5" aria-hidden="true" />
                  </button>
                  <span class="ld-count min-w-8 text-center" aria-live="polite">{{ gridRows }}</span>
                  <button @click="gridRows = Math.min(6, gridRows + 1); handleGridRowsChange()" class="btn btn-ghost btn-xs btn-square" :aria-label="t('streamDeckGrid.increaseRows')">
                    <Plus :size="14" stroke-width="1.5" aria-hidden="true" />
                  </button>
                </div>
              </div>
            </div>
          </div>

          <details class="mt-3 rounded-xl border border-base-300">
            <summary class="cursor-pointer px-3 py-2.5 text-[13px] font-medium">{{ t('profileDrawer.autoSwitch') }}</summary>
            <div class="border-t border-base-300 px-3 py-3">
              <AutoProfileSwitcher :available-profiles="profiles" @config-updated="handleAutoSwitchConfigUpdate" />
            </div>
          </details>

          <div class="mt-3 rounded-xl border border-error/30 p-3">
            <p class="mb-2 text-[13px] font-medium text-error">{{ t('profileDrawer.danger') }}</p>
            <button
              v-if="!confirmDelete"
              @click="confirmDelete = true"
              class="btn btn-outline btn-error btn-sm w-full"
              :disabled="isDefaultProfile"
            >
              {{ t('profileDrawer.delete') }}
            </button>
            <div v-else class="flex gap-2">
              <button @click="deleteProfile" class="btn btn-error btn-sm flex-1">
                {{ t('profileDrawer.confirmDelete') }}
              </button>
              <button @click="confirmDelete = false" class="btn btn-ghost btn-sm flex-1">
                {{ t('pageNavigation.cancel') }}
              </button>
            </div>
            <p v-if="isDefaultProfile" class="mt-2 text-xs text-base-content/50">{{ t('profileDrawer.cannotDeleteDefault') }}</p>
          </div>
        </div>
      </div>

      <div class="shrink-0 border-t border-base-300 px-4 py-3">
        <button @click="closeModal" class="btn btn-ghost btn-sm w-full">{{ t('profileDrawer.close') }}</button>
      </div>
    </aside>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import { Plus, Minus, X } from 'lucide-vue-next'
import AutoProfileSwitcher from './AutoProfileSwitcher.vue'
import { useI18nStore } from '../composables/useI18n'
import type { ProfileData } from '../types/streamdeck'

const { t } = useI18nStore()

interface Props {
  profiles: ProfileData[]
  selectedProfile: string
}
interface Emits {
  (e: 'profile-changed', profileId: string): void
  (e: 'profile-created', name: string): Promise<void> | void
  (e: 'profile-updated', profileId: string, updates: any): void
  (e: 'profile-deleted', profileId: string): void
}
const props = defineProps<Props>()
const emit = defineEmits<Emits>()

const open = ref(false)
const selectedProfileId = ref(props.selectedProfile)
const profileName = ref('')
const gridCols = ref(5)
const gridRows = ref(3)
const newProfileName = ref('')
const confirmDelete = ref(false)

const selectedProfile = computed(() => props.profiles.find(p => p.id === selectedProfileId.value))
const isDefaultProfile = computed(() => {
  if (!selectedProfile.value) return false
  let data = selectedProfile.value.data as any
  if (typeof data === 'string') { try { data = JSON.parse(data) } catch { data = {} } }
  return data?.isDefault === true
})

const parseData = (profile: ProfileData | undefined) => {
  let data: any = (profile as any)?.data
  if (typeof data === 'string') { try { data = JSON.parse(data) } catch { data = {} } }
  return data || {}
}

const selectProfile = (id: string) => {
  selectedProfileId.value = id
  confirmDelete.value = false
  const p = props.profiles.find(x => x.id === id)
  if (p) {
    profileName.value = p.name
    const d = parseData(p)
    gridCols.value = d?.gridCols || 5
    gridRows.value = d?.gridRows || 3
  }
  emit('profile-changed', id)
}

const handleNameChange = () => {
  if (selectedProfile.value && profileName.value !== selectedProfile.value.name) {
    emit('profile-updated', selectedProfileId.value, { name: profileName.value })
  }
}
const handleGridColsChange = () => {
  if (!selectedProfile.value) return
  emit('profile-updated', selectedProfileId.value, { data: { ...parseData(selectedProfile.value), gridCols: gridCols.value } })
}
const handleGridRowsChange = () => {
  if (!selectedProfile.value) return
  emit('profile-updated', selectedProfileId.value, { data: { ...parseData(selectedProfile.value), gridRows: gridRows.value } })
}
const handleCreateProfile = async () => {
  if (!newProfileName.value.trim()) return
  await emit('profile-created', newProfileName.value.trim())
  newProfileName.value = ''
}
const handleAutoSwitchConfigUpdate = (config: any) => {
  console.log('Auto-profile configuration updated:', config)
}
const deleteProfile = () => {
  emit('profile-deleted', selectedProfileId.value)
  confirmDelete.value = false
}

const showModal = () => {
  open.value = true
  if (props.selectedProfile) selectProfile(props.selectedProfile)
  nextTick(() => {
    document.querySelector<HTMLElement>('#new-profile-name')?.focus()
  })
}
const closeModal = () => { open.value = false; confirmDelete.value = false }

watch(() => props.selectedProfile, (v) => { if (v && open.value) selectProfile(v) })
watch(open, (v) => {
  document.body.style.overflow = v ? 'hidden' : ''
  if (v) document.addEventListener('keydown', onEsc)
  else document.removeEventListener('keydown', onEsc)
})
const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') closeModal() }

defineExpose({ showModal, closeModal, open })
</script>
