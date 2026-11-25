<template>
  <!-- Cliente móvil de SOLO-USO: sin editor, sin inspector, sin biblioteca.
       Se abre vía QR (?layout=<id>) y solo ejecuta widgets. -->
  <div class="bundeck" data-cy="bd-mobile-use">
    <main class="bd-deck-use">
      <header class="bd-deck-use-head">
        <h1>{{ layout?.name ?? t('bd.deckLayouts') }}</h1>
      </header>
      <DeckUseView v-if="layout" :layout="layout" @widget-press="onPress" />
      <p v-else class="bd-hint" data-cy="bd-mobile-empty">{{ t('bd.deckEmpty') }}</p>
      <p v-if="error" class="bd-err" role="alert">{{ error }}</p>
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import DeckUseView from './DeckUseView.vue'
import { useDeckLayouts, type DeckWidget } from '../../composables/useDeckLayouts'
import { pressFeedback } from '../../composables/useFeedback'
import { useI18nStore } from '../../composables/useI18n'
import { getOrCreateDeviceId } from '../../utils/sessionRouting'

const { t } = useI18nStore()
const { layouts } = useDeckLayouts()
const error = ref('')

const queryLayoutId = (): string | null => {
  try {
    const u = new URL(window.location.href)
    return u.searchParams.get('layout')
  } catch {
    return null
  }
}

const layout = computed(() => {
  const id = queryLayoutId()
  if (!id) return layouts.value[0] ?? null
  return layouts.value.find((l) => l.id === id) ?? null
})

const onPress = async (widget: DeckWidget) => {
  // Solo-uso: los widgets action ejecutan contra el daemon vía API/WS si hay
  // posición enlazada; el resto (slider/clock/timer) es local.
  if (widget.kind !== 'action') return
  const pos = widget.buttonPosition
  if (pos === null || pos === undefined) return
  pressFeedback('click')
  try {
    const base = `${window.location.protocol}//${window.location.hostname}:3001/api/v1`
    await fetch(`${base}/buttons/press`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        buttonId: null,
        pageId: layout.value?.pageId ?? null,
        position: pos,
        pressType: 'short',
        context: { deviceId: getOrCreateDeviceId(), source: 'mobile' }
      })
    })
  } catch (e) {
    error.value = String((e as Error)?.message ?? e)
  }
}

onMounted(() => {})
</script>
