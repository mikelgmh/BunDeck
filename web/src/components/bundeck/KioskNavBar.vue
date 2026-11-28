<template>
  <div class="kiosk-nav" :data-cy="cyRoot">
    <div class="kiosk-nav__row" role="listbox" :aria-label="profilesLabel" data-cy="bd-kiosk-profiles">
      <span class="kiosk-nav__caption" aria-hidden="true">{{ profilesLabel }}</span>
      <template v-if="profiles.length">
        <button
          v-for="p in profiles"
          :key="p.id"
          type="button"
          role="option"
          class="kiosk-nav__chip"
          :class="{ 'is-active': p.id === selectedProfileId }"
          :aria-selected="p.id === selectedProfileId"
          :data-cy="`bd-kiosk-profile-${p.id}`"
          @click="$emit('select-profile', p.id)"
        >{{ p.name }}</button>
      </template>
      <span v-else class="kiosk-nav__empty" data-cy="bd-kiosk-profiles-empty">{{ noProfilesLabel }}</span>
    </div>
    <div class="kiosk-nav__row" role="listbox" :aria-label="pagesLabel" data-cy="bd-kiosk-pages">
      <span class="kiosk-nav__caption" aria-hidden="true">{{ pagesLabel }}</span>
      <template v-if="pages.length">
        <button
          v-for="pg in pages"
          :key="pg.id"
          type="button"
          role="option"
          class="kiosk-nav__chip"
          :class="{ 'is-active': pg.id === selectedPageId }"
          :aria-selected="pg.id === selectedPageId"
          :disabled="pg.disabled"
          :title="pg.disabledReason ?? pg.name"
          :data-cy="`bd-kiosk-page-${pg.id}`"
          @click="$emit('select-page', pg.id)"
        >{{ pg.name }}</button>
      </template>
      <span v-else class="kiosk-nav__empty" data-cy="bd-kiosk-pages-empty">{{ noPagesLabel }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
export interface KioskNavProfile {
  id: string
  name: string
}

export interface KioskNavPage {
  id: string
  name: string
  disabled?: boolean
  disabledReason?: string
}

withDefaults(
  defineProps<{
    profiles?: KioskNavProfile[]
    pages?: KioskNavPage[]
    selectedProfileId?: string | null
    selectedPageId?: string | null
    profilesLabel?: string
    pagesLabel?: string
    noProfilesLabel?: string
    noPagesLabel?: string
    cyRoot?: string
  }>(),
  {
    profiles: () => [],
    pages: () => [],
    selectedProfileId: null,
    selectedPageId: null,
    profilesLabel: 'Profiles',
    pagesLabel: 'Pages',
    noProfilesLabel: 'No profiles',
    noPagesLabel: 'No pages',
    cyRoot: 'bd-kiosk-nav',
  }
)

defineEmits<{
  'select-profile': [id: string]
  'select-page': [id: string]
}>()
</script>
