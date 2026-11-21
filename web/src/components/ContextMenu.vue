<template>
  <div
    v-if="show && items.length > 0"
    ref="contextMenuRef"
    role="menu"
    class="fixed z-[10000] min-w-48 rounded-xl border border-base-300 bg-base-100 py-1 shadow-xl"
    :style="{ top: adjustedY + 'px', left: adjustedX + 'px' }"
    @click.stop
    @keydown.escape="emit('close')"
    @keydown.arrow-down.prevent="focusNext"
    @keydown.arrow-up.prevent="focusPrev"
  >
    <button
      v-for="(item, i) in items"
      :key="item.id"
      ref="itemRefs"
      role="menuitem"
      @click="handleItemClick(item)"
      :class="[
        'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 mx-0 text-left text-[13px] font-medium transition-[background-color,color] duration-150 hover:bg-base-300/60',
        item.danger ? 'text-error' : 'text-base-content'
      ]"
    >
      <component :is="item.icon" :size="16" stroke-width="1.5" aria-hidden="true" class="shrink-0" />
      {{ item.label }}
    </button>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, nextTick, watch } from 'vue'
import type { Component } from 'vue'

interface MenuItem {
  id: string
  label: string
  icon: Component
  danger?: boolean
}

interface Props {
  show: boolean
  x: number
  y: number
  items: MenuItem[]
}

interface Emits {
  (e: 'item-click', item: MenuItem): void
  (e: 'close'): void
}

const props = defineProps<Props>()
const emit = defineEmits<Emits>()

const contextMenuRef = ref<HTMLElement | null>(null)
const itemRefs = ref<HTMLElement[]>([])

const adjustedX = computed(() => {
  if (!contextMenuRef.value) return props.x
  const menuWidth = contextMenuRef.value.offsetWidth || 150
  const viewportWidth = window.innerWidth
  if (props.x + menuWidth > viewportWidth) return Math.max(0, props.x - menuWidth)
  return Math.max(0, props.x)
})

const adjustedY = computed(() => {
  if (!contextMenuRef.value) return props.y
  const menuHeight = contextMenuRef.value.offsetHeight || (props.items.length * 40)
  const viewportHeight = window.innerHeight
  if (props.y + menuHeight > viewportHeight) return Math.max(0, props.y - menuHeight)
  return Math.max(0, props.y)
})

const handleItemClick = (item: MenuItem) => {
  emit('item-click', item)
  emit('close')
}

const focusNext = () => {
  const el = document.activeElement as HTMLElement
  const idx = itemRefs.value.indexOf(el)
  itemRefs.value[(idx + 1) % itemRefs.value.length]?.focus()
}
const focusPrev = () => {
  const el = document.activeElement as HTMLElement
  const idx = itemRefs.value.indexOf(el)
  itemRefs.value[(idx - 1 + itemRefs.value.length) % itemRefs.value.length]?.focus()
}

const handleClickOutside = (event: MouseEvent) => {
  if (props.show && contextMenuRef.value && !contextMenuRef.value.contains(event.target as Node)) {
    emit('close')
  }
}

const handleEscapeKey = (event: KeyboardEvent) => {
  if (event.key === 'Escape' && props.show) emit('close')
}

watch(() => props.show, (v) => {
  if (v) nextTick(() => itemRefs.value[0]?.focus())
})

onMounted(() => {
  nextTick(() => {
    document.addEventListener('click', handleClickOutside)
  })
  document.addEventListener('keydown', handleEscapeKey)
})

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside)
  document.removeEventListener('keydown', handleEscapeKey)
})
</script>
