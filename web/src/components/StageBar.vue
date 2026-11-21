<template>
  <div class="border-b border-base-300 bg-base-200/60 px-4 shrink-0">
    <div class="flex h-11 items-center gap-3">
      <!-- Grid size -->
      <div class="flex items-center gap-1 shrink-0" :aria-label="t('streamDeckGrid.gridSize')">
        <span class="ld-count mr-1 hidden lg:inline">{{ t('streamDeckGrid.gridSize') }}</span>
        <button
          @click="$emit('grid-size-change', -1, 0)"
          class="btn btn-ghost btn-xs btn-square"
          :disabled="gridCols <= 3"
          :title="t('streamDeckGrid.reduceColumns')"
          :aria-label="t('streamDeckGrid.reduceColumns')"
        >
          <Minus :size="14" stroke-width="1.5" aria-hidden="true" />
        </button>
        <span class="ld-count min-w-10 text-center" aria-live="polite">{{ gridCols }}×{{ gridRows }}</span>
        <button
          @click="$emit('grid-size-change', 1, 0)"
          class="btn btn-ghost btn-xs btn-square"
          :disabled="gridCols >= 8"
          :title="t('streamDeckGrid.increaseColumns')"
          :aria-label="t('streamDeckGrid.increaseColumns')"
        >
          <Plus :size="14" stroke-width="1.5" aria-hidden="true" />
        </button>
        <div class="mx-1 hidden gap-1 sm:flex">
          <button
            @click="$emit('grid-size-change', 0, -1)"
            class="btn btn-ghost btn-xs btn-square"
            :disabled="gridRows <= 2"
            :title="t('streamDeckGrid.reduceRows')"
            :aria-label="t('streamDeckGrid.reduceRows')"
          >
            <Minus :size="14" stroke-width="1.5" aria-hidden="true" />
          </button>
          <button
            @click="$emit('grid-size-change', 0, 1)"
            class="btn btn-ghost btn-xs btn-square"
            :disabled="gridRows >= 6"
            :title="t('streamDeckGrid.increaseRows')"
            :aria-label="t('streamDeckGrid.increaseRows')"
          >
            <Plus :size="14" stroke-width="1.5" aria-hidden="true" />
          </button>
        </div>
      </div>

      <div class="h-5 w-px bg-base-content/10 shrink-0" aria-hidden="true"></div>

      <!-- Pages -->
      <div class="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto" data-cy="page-nav" role="tablist" :aria-label="t('pageNavigation.addPage')">
        <div
          v-for="page in visiblePages"
          :key="page.id"
          class="group relative shrink-0"
        >
          <button
            role="tab"
            :aria-selected="page.id === currentPage?.id"
            :class="[
              'rounded-lg border py-1.5 pl-3 pr-8 text-[13px] font-medium whitespace-nowrap transition-[background-color,border-color,color] duration-150',
              page.id === currentPage?.id
                ? 'bg-base-300 border-base-content/15 text-base-content'
                : 'bg-transparent border-transparent text-base-content/60 hover:text-base-content hover:bg-base-300/60'
            ]"
            @click="selectPage(page.id)"
          >
            {{ page.name }}
          </button>
          <button
            @click.stop="showPageMenu($event, page)"
            class="absolute right-1 top-1/2 h-6 w-6 -translate-y-1/2 btn btn-ghost btn-xs btn-square min-h-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100 transition-opacity duration-150"
            :aria-label="`${page.name} — ${t('toolbar.menu')}`"
          >
            <MoreVertical :size="14" stroke-width="1.5" aria-hidden="true" />
          </button>
        </div>
        <button
          @click="showAddPageModal = true"
          class="btn btn-ghost btn-sm btn-square shrink-0"
          :title="t('pageNavigation.addPage')"
          :aria-label="t('pageNavigation.addPage')"
          data-cy="add-page"
        >
          <Plus :size="16" stroke-width="1.5" aria-hidden="true" />
        </button>
      </div>

      <span class="ld-count hidden shrink-0 xl:block" data-cy="current-page" aria-live="polite">
        {{ currentPageIndex + 1 }}/{{ visiblePages.length }}
      </span>
    </div>

    <ContextMenu
      :show="pageMenu.show"
      :x="pageMenu.x"
      :y="pageMenu.y"
      :items="pageMenuItems"
      @item-click="handlePageMenuItem"
      @close="hidePageMenu"
    />

    <div v-if="renameModal.show" class="modal modal-open" role="dialog" aria-modal="true" :aria-label="t('pageNavigation.renamePage')">
      <div class="modal-box">
        <h3 class="font-bold text-lg mb-4">{{ t('pageNavigation.renamePage') }}</h3>
        <div class="form-control w-full mb-4">
          <label class="label" :for="'rename-input'">
            <span class="label-text">{{ t('pageNavigation.newName') }}</span>
          </label>
          <input
            id="rename-input"
            v-model="renameModal.newName"
            type="text"
            :placeholder="t('pageNavigation.pageNamePlaceholder') + '…'"
            class="input input-bordered input-sm w-full ld-control px-3"
            @keyup.enter="confirmRename"
            @keydown.escape="hideRenameModal"
          />
        </div>
        <div class="modal-action">
          <button @click="hideRenameModal" class="btn btn-ghost">{{ t('pageNavigation.cancel') }}</button>
          <button @click="confirmRename" :disabled="!renameModal.newName.trim()" class="btn btn-primary">
            {{ t('pageNavigation.rename') }}
          </button>
        </div>
      </div>
    </div>

    <div v-if="showAddPageModal" class="modal modal-open" role="dialog" aria-modal="true" :aria-label="t('pageNavigation.addNewPage')">
      <div class="modal-box">
        <h3 class="font-bold text-lg mb-4">{{ t('pageNavigation.addNewPage') }}</h3>
        <div class="form-control w-full mb-4">
          <label class="label" for="new-page-input">
            <span class="label-text">{{ t('pageNavigation.pageName') }}</span>
          </label>
          <input
            id="new-page-input"
            v-model="newPageName"
            type="text"
            :placeholder="t('pageNavigation.pageNameExamples')"
            class="input input-bordered input-sm w-full ld-control px-3"
            @keyup.enter="createPage"
            @keydown.escape="showAddPageModal = false"
            data-cy="page-name-input"
          />
        </div>
        <div class="form-control mb-4">
          <label class="label cursor-pointer" for="new-page-folder">
            <span class="label-text">{{ t('pageNavigation.isFolder') }}</span>
            <input id="new-page-folder" v-model="isFolder" type="checkbox" class="checkbox checkbox-primary" />
          </label>
          <div class="label">
            <span class="label-text-alt text-base-content/60">{{ t('pageNavigation.folderDescription') }}</span>
          </div>
        </div>
        <div class="modal-action">
          <button @click="showAddPageModal = false" class="btn btn-ghost">{{ t('pageNavigation.cancel') }}</button>
          <button @click="createPage" :disabled="!newPageName.trim()" class="btn btn-primary" data-cy="create-page">
            {{ t('pageNavigation.createPage') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18nStore } from '../composables/useI18n'
import { Plus, Minus, MoreVertical, Edit, Trash2 } from 'lucide-vue-next'
import ContextMenu from './ContextMenu.vue'
import type { PageData } from '../types/streamdeck'

const { t } = useI18nStore()

interface Props {
  gridCols: number
  gridRows: number
  currentPage: PageData | null
  pages: PageData[]
}

interface Emits {
  (e: 'grid-size-change', dx: number, dy: number): void
  (e: 'page-selected', pageId: string): void
  (e: 'page-created', name: string, isFolder: boolean): void
  (e: 'page-deleted', pageId: string): void
  (e: 'page-renamed', pageId: string, newName: string): void
}

const props = defineProps<Props>()
const emit = defineEmits<Emits>()

const showAddPageModal = ref(false)
const newPageName = ref('')
const isFolder = ref(false)

const pageMenu = ref({ show: false, x: 0, y: 0, page: null as PageData | null })
const pageMenuItems = computed(() => [
  { id: 'rename', label: t('pageNavigation.rename'), icon: Edit, danger: false },
  { id: 'delete', label: t('pageNavigation.delete'), icon: Trash2, danger: true }
])

const renameModal = ref({ show: false, page: null as PageData | null, newName: '' })

const visiblePages = computed(() => props.pages.filter(p => p.is_folder === 0))
const currentPageIndex = computed(() => visiblePages.value.findIndex(p => p.id === props.currentPage?.id))

const selectPage = (id: string) => emit('page-selected', id)

const createPage = () => {
  if (!newPageName.value.trim()) return
  emit('page-created', newPageName.value.trim(), isFolder.value)
  newPageName.value = ''
  isFolder.value = false
  showAddPageModal.value = false
}

const showPageMenu = (event: MouseEvent, page: PageData) => {
  event.preventDefault()
  event.stopPropagation()
  const rect = (event.target as HTMLElement).getBoundingClientRect()
  const menuHeight = 80
  const y = window.innerHeight - rect.bottom >= menuHeight ? rect.bottom + 4 : rect.top - menuHeight - 4
  pageMenu.value = { show: true, x: rect.left, y, page }
}
const hidePageMenu = () => { pageMenu.value.show = false }
const handlePageMenuItem = (item: any) => {
  if (!pageMenu.value.page) return
  if (item.id === 'rename') renameModal.value = { show: true, page: pageMenu.value.page, newName: pageMenu.value.page.name }
  if (item.id === 'delete') emit('page-deleted', pageMenu.value.page.id)
  hidePageMenu()
}
const hideRenameModal = () => { renameModal.value = { show: false, page: null, newName: '' } }
const confirmRename = () => {
  if (!renameModal.value.page || !renameModal.value.newName.trim()) return
  emit('page-renamed', renameModal.value.page.id, renameModal.value.newName.trim())
  hideRenameModal()
}
</script>
