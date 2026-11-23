<template>
  <div class="bd-deck-pair" data-cy="bd-deck-pair">
    <QrcodeVue v-if="url" :value="url" :size="240" level="M" render-as="svg" :margin="2" data-cy="bd-deck-pair-qr" />
    <p class="bd-hint">{{ t('bd.deckPairHint') }}</p>
    <div class="bd-r2">
      <label class="bd-sr" for="bd-deck-pair-url">{{ t('bd.address') }}</label>
      <input id="bd-deck-pair-url" type="text" class="bd-inp" readonly :value="url" data-cy="bd-deck-pair-url" @focus="($event.target as HTMLInputElement).select()" />
      <button class="bd-btn" data-cy="bd-deck-pair-copy" @click="copy">{{ t('bd.copy') }}</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import QrcodeVue from 'qrcode.vue'
import { useI18nStore } from '../../composables/useI18n'

const { t } = useI18nStore()

interface Props {
  layoutId: string
}

interface Emits {
  (e: 'notify', message: string): void
}

const props = defineProps<Props>()
const emit = defineEmits<Emits>()

/** URL de solo-uso: /use?layout=<id>. Sin editor, sin ajustes: el móvil solo pulsa. */
const url = computed(() => {
  const base = typeof window !== 'undefined'
    ? `${window.location.protocol}//${window.location.host}`
    : ''
  return `${base}/use?layout=${encodeURIComponent(props.layoutId)}`
})

const copy = async () => {
  try {
    await navigator.clipboard.writeText(url.value)
    emit('notify', t('bd.copied'))
  } catch { /* noop */ }
}
</script>
