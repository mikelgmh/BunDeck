<template>
  <div
    v-if="isElectrobun"
    class="bd-titlebar"
    role="toolbar"
    :aria-label="t('bd.windowChrome')"
  >
    <div
      class="bd-titlebar-drag electrobun-webkit-app-region-drag"
      @dblclick="toggleMaximize"
    >
      <svg class="bd-titlebar-mark" viewBox="0 0 64 64" aria-hidden="true"><defs><linearGradient id="bdtg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f4d9a8"/><stop offset=".6" stop-color="#e3b77a"/><stop offset="1" stop-color="#c98f52"/></linearGradient></defs><ellipse cx="32" cy="55" rx="21" ry="4" opacity=".2"/><path d="M7 40c0-18 10-29 25-29s25 11 25 29c0 9-7 14-25 14S7 49 7 40" fill="url(#bdtg)"/><circle cx="24" cy="37" r="2.6" fill="#33200f"/><circle cx="40" cy="37" r="2.6" fill="#33200f"/><path d="M28 42c2 3 6 3 8 0" fill="none" stroke="#33200f" stroke-width="2" stroke-linecap="round"/></svg>
      <span class="bd-titlebar-name">LibreDeck</span>
    </div>
    <div class="bd-titlebar-btns electrobun-webkit-app-region-no-drag">
      <button
        class="bd-winbtn"
        :title="t('bd.windowMinimize')"
        :aria-label="t('bd.windowMinimize')"
        @click="minimize"
        data-cy="bd-win-min"
      >
        <Minus :size="16" stroke-width="1.75" aria-hidden="true" />
      </button>
      <button
        class="bd-winbtn"
        :title="maximized ? t('bd.windowRestore') : t('bd.windowMaximize')"
        :aria-label="maximized ? t('bd.windowRestore') : t('bd.windowMaximize')"
        @click="toggleMaximize"
        data-cy="bd-win-max"
      >
        <Copy v-if="maximized" :size="13" stroke-width="1.75" aria-hidden="true" />
        <Square v-else :size="13" stroke-width="1.75" aria-hidden="true" />
      </button>
      <button
        class="bd-winbtn bd-close"
        :title="t('bd.windowClose')"
        :aria-label="t('bd.windowClose')"
        @click="close"
        data-cy="bd-win-close"
      >
        <X :size="16" stroke-width="1.75" aria-hidden="true" />
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Minus, Square, Copy, X } from 'lucide-vue-next'
import { useWindowChrome } from '../../composables/useWindowChrome'
import { useI18nStore } from '../../composables/useI18n'

const { t } = useI18nStore()
const { isElectrobun, maximized, minimize, toggleMaximize, close } = useWindowChrome()
</script>
