<template>
  <!-- Velo de inactividad (web/remotos): la opacidad crece con el tiempo sin
    interactuar y el primer toque despierta (poke) sin atravesar. -->
  <div
    v-if="veil.opacity.value > 0.01"
    class="bd-idle-veil"
    data-cy="bd-idle-veil"
    aria-hidden="true"
    :style="{ opacity: veil.opacity.value.toFixed(2) }"
    @pointerdown="veil.poke()"
  />
</template>

<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { createWebIdleVeil, webIdleMinutes } from '../../composables/useDeviceDisplay'

const veil = createWebIdleVeil(() => webIdleMinutes.value)

onMounted(() => veil.start())
onUnmounted(() => veil.stop())
</script>
