<template>
  <dialog ref="dialog" class="bd-dlg bd-flex" :aria-label="t('bd.iconTitle')" style="width: min(640px, 94vw); height: min(640px, 88vh)">
    <div class="bd-dh">
      <h2>{{ t('bd.iconTitle') }}</h2>
      <span class="bd-sp"></span>
      <button class="bd-ibtn" :aria-label="t('bd.close')" @click="close">
        <X :size="20" stroke-width="1.75" aria-hidden="true" />
      </button>
    </div>
    <div style="padding: 0 24px">
      <div class="bd-srch" style="margin: 0">
        <Search :size="16" stroke-width="1.75" aria-hidden="true" />
        <label class="bd-sr" for="bd-iq">{{ t('bd.searchIcons') }}</label>
        <input
          type="text"
          id="bd-iq"
          class="bd-inp"
          :placeholder="t('bd.searchIcons')"
          autocomplete="off"
          v-model="query"
        />
      </div>
    </div>
    <div class="bd-pb">
      <p class="bd-cap">{{ t('bd.iconsCount', { n: total.toLocaleString('es-ES') }) }}</p>
      <div class="bd-ig">
        <button
          v-for="name in visible"
          :key="name"
          class="bd-ib"
          :title="kebab(name)"
          :aria-label="kebab(name)"
          :aria-pressed="name === current"
          @click="pick(name)"
        >
          <component :is="all[name]" :size="22" stroke-width="1.75" aria-hidden="true" />
        </button>
      </div>
      <button v-if="visible.length < filtered.length" class="bd-btn" @click="shown += 192">
        {{ t('bd.showMore') }}
      </button>
    </div>
  </dialog>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { X, Search } from 'lucide-vue-next'
import * as LucideIcons from 'lucide-vue-next'
import { useI18nStore } from '../../composables/useI18n'

const { t } = useI18nStore()

interface Props {
  current: string
}

interface Emits {
  (e: 'pick', iconName: string): void
}

const props = defineProps<Props>()
const emit = defineEmits<Emits>()

const dialog = ref<HTMLDialogElement | null>(null)
const query = ref('')
const shown = ref(96)

const all = computed(() => {
  const out: Record<string, any> = {}
  for (const [key, value] of Object.entries(LucideIcons)) {
    if (key === 'default' || key === 'icons' || key === 'Icon' || key === 'Lucide') continue
    if (!/^[A-Z]/.test(key)) continue
    if (/Icon$/.test(key)) continue
    if (typeof value !== 'object' && typeof value !== 'function') continue
    out[key] = value
  }
  return out
})

const kebab = (name: string) => name.replace(/([a-z])([A-Z0-9])/g, '$1-$2').toLowerCase()

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  const names = Object.keys(all.value)
  if (!q) return names
  return names.filter((n) => kebab(n).includes(q))
})
const total = computed(() => filtered.value.length)
const visible = computed(() => filtered.value.slice(0, shown.value))

const pick = (name: string) => {
  emit('pick', name)
  close()
}

const show = () => {
  query.value = ''
  shown.value = 96
  dialog.value?.showModal()
}
const close = () => dialog.value?.close()

defineExpose({ show, close })
</script>
