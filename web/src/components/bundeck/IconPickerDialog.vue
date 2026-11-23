<template>
  <dialog ref="dialog" class="bd-dlg bd-flex" :aria-label="t('bd.iconTitle')" style="width: min(640px, 94vw); height: min(640px, 88vh)">
    <div class="bd-dh">
      <h2>{{ t('bd.iconTitle') }}</h2>
      <span class="bd-sp"></span>
      <button class="bd-ibtn" :aria-label="t('bd.close')" @click="close">
        <X :size="20" stroke-width="1.75" aria-hidden="true" />
      </button>
    </div>
    <div class="bd-itabs" role="tablist" :aria-label="t('bd.iconTitle')" style="padding: 0 24px">
      <button role="tab" :aria-selected="!imgTab" @click="imgTab = false">{{ t('bd.iconTabIcons') }}</button>
      <button role="tab" :aria-selected="imgTab" data-cy="bd-icon-tab-image" @click="imgTab = true">{{ t('bd.iconTabImage') }}</button>
    </div>
    <div v-if="!imgTab" style="padding: 12px 24px 0">
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
      <template v-if="!imgTab">
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
      </template>
      <template v-else>
        <p class="bd-hint" style="margin: 0 0 12px">{{ t('bd.imageHint') }}</p>
        <div v-if="currentImageUrl" class="bd-imgcur">
          <img :src="currentImageUrl" class="bd-imgprev" alt="" aria-hidden="true" />
          <button class="bd-btn" @click="emit('clear-image'); close()">
            <Trash2 :size="16" stroke-width="1.75" aria-hidden="true" />{{ t('bd.removeImage') }}
          </button>
        </div>
        <div
          class="bd-imgdrop"
          :class="{ 'bd-on': dragImg }"
          role="button"
          tabindex="0"
          :aria-label="t('bd.chooseImage')"
          data-cy="bd-image-drop"
          @click="imgInput?.click()"
          @keydown.enter="imgInput?.click()"
          @keydown.space.prevent="imgInput?.click()"
          @dragover.prevent="dragImg = true"
          @dragleave="dragImg = false"
          @drop.prevent="onImgDrop"
        >
          <ImagePlus :size="24" stroke-width="1.75" aria-hidden="true" />
          <span v-if="uploading">{{ t('bd.uploadingImage') }}</span>
          <span v-else>{{ t('bd.dropImage') }}</span>
          <span class="bd-btn" aria-hidden="true">{{ t('bd.chooseImage') }}</span>
        </div>
        <input ref="imgInput" type="file" class="bd-sr" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" @change="onImgFile" />
        <p v-if="uploadError" class="bd-err" role="alert">{{ uploadError }}</p>
      </template>
    </div>
  </dialog>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { X, Search, ImagePlus, Trash2 } from 'lucide-vue-next'
import { useI18nStore } from '../../composables/useI18n'
import { assetUrl, isAssetRef, normalizeApiBase } from '../../composables/useKeyShare'

const { t } = useI18nStore()

interface Props {
  current: string
  /** Imagen actual de la tecla (`/assets/…` o ''). */
  currentImage?: string
  /** Base de la API (puerto 3001): la subida y los assets cuelgan de ahí. */
  apiBase?: string
}

interface Emits {
  (e: 'pick', iconName: string): void
  (e: 'pick-image', url: string): void
  (e: 'clear-image'): void
}

const props = withDefaults(defineProps<Props>(), { currentImage: '', apiBase: '' })
const emit = defineEmits<Emits>()

const dialog = ref<HTMLDialogElement | null>(null)
const query = ref('')
const shown = ref(96)
const imgTab = ref(false)
const dragImg = ref(false)
const uploading = ref(false)
const uploadError = ref('')
const imgInput = ref<HTMLInputElement | null>(null)

const currentImageUrl = computed(() => {
  const rel = props.currentImage ?? ''
  return isAssetRef(rel) ? assetUrl(props.apiBase, rel) : ''
})

const all = ref<Record<string, any>>({})
let lucideLoading: Promise<void> | null = null
/** Catálogo completo bajo demanda: evita traer todo lucide al chunk inicial
 *  (y al chunk del diálogo hasta que se abre). Comparte el chunk diferido
 *  de `lucide-vue-next` con useDynamicIcon. */
const ensureLucide = () => {
  if (Object.keys(all.value).length || lucideLoading) return lucideLoading ?? Promise.resolve()
  lucideLoading = import('lucide-vue-next').then((mod) => {
    const out: Record<string, any> = {}
    for (const [key, value] of Object.entries(mod)) {
      if (key === 'default' || key === 'icons' || key === 'Icon' || key === 'Lucide') continue
      if (!/^[A-Z]/.test(key)) continue
      if (/Icon$/.test(key)) continue
      if (typeof value !== 'object' && typeof value !== 'function') continue
      out[key] = value
    }
    all.value = out
  }).catch(() => {
    lucideLoading = null
  })
  return lucideLoading
}

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

const MAX_IMG_BYTES = 8 * 1024 * 1024

const uploadFile = async (file: File | undefined | null) => {
  uploadError.value = ''
  if (!file) return
  if (file.size > MAX_IMG_BYTES) {
    uploadError.value = t('bd.imageTooBig')
    return
  }
  if (!props.apiBase) {
    uploadError.value = t('bd.imageUploadFail')
    return
  }
  uploading.value = true
  try {
    const fd = new FormData()
    fd.append('file', file, file.name)
    const res = await fetch(`${normalizeApiBase(props.apiBase)}/api/v1/assets`, { method: 'POST', body: fd })
    const body: any = await res.json().catch(() => ({}))
    if (!res.ok || !body?.url) {
      uploadError.value = typeof body?.error === 'string' && body.error ? body.error : t('bd.imageUploadFail')
      return
    }
    emit('pick-image', String(body.url))
    close()
  } catch {
    uploadError.value = t('bd.imageUploadFail')
  } finally {
    uploading.value = false
    if (imgInput.value) imgInput.value.value = ''
  }
}

const onImgFile = (e: Event) => {
  const input = e.target as HTMLInputElement | null
  void uploadFile(input?.files?.[0])
  dragImg.value = false
}
const onImgDrop = (e: DragEvent) => {
  dragImg.value = false
  const f = e.dataTransfer?.files?.[0]
  void uploadFile(f)
}

const show = (tab: 'icons' | 'image' = 'icons') => {
  query.value = ''
  shown.value = 96
  imgTab.value = tab === 'image'
  uploadError.value = ''
  dragImg.value = false
  if (tab === 'icons') void ensureLucide()
  dialog.value?.showModal()
}
const close = () => dialog.value?.close()

defineExpose({ show, close })
</script>
