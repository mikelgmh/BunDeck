<template>
  <dialog ref="dialog" class="bd-dlg" :aria-label="t('bd.iosTitle')" data-cy="ios-fullscreen-warning" style="width: min(420px, 94vw); height: auto">
    <div class="bd-pb" style="align-items: center; text-align: center">
      <div class="bd-warn-ic" aria-hidden="true">
        <TriangleAlert :size="28" stroke-width="1.75" />
      </div>
      <h2>{{ t('bd.iosTitle') }}</h2>
      <p class="bd-hint" style="font-size: 14px; color: var(--bd-ink)">{{ t('bd.iosMessage') }}</p>
      <p class="bd-hint">{{ t('bd.iosHint') }}</p>
      <button class="bd-btn bd-pri bd-wide" @click="close" data-cy="ios-warning-got-it" autofocus>
        {{ t('bd.gotIt') }}
      </button>
    </div>
  </dialog>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { TriangleAlert } from 'lucide-vue-next'
import { useI18nStore } from '../../composables/useI18n'
import { shouldShowIosFullscreenWarning } from '../../composables/useIosBrowser'

const { t } = useI18nStore()
const dialog = ref<HTMLDialogElement | null>(null)

const close = () => dialog.value?.close()

onMounted(() => {
  dialog.value?.addEventListener('click', (e) => {
    const rect = dialog.value!.getBoundingClientRect()
    if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) {
      close()
    }
  })
  if (shouldShowIosFullscreenWarning()) dialog.value?.showModal()
})

defineExpose({ close })
</script>
