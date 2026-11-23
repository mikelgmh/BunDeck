<template>
  <dialog ref="dialog" class="bd-dlg bd-wlc" :aria-label="t('bd.welcomeTitle')" data-cy="bd-welcome">
    <div class="bd-wlc-art" aria-hidden="true" v-html="steps[step].svg"></div>
    <div class="bd-wlc-body">
      <h2>{{ steps[step].title }}</h2>
      <p>{{ steps[step].desc }}</p>
      <div class="bd-wlc-pills">
        <span v-for="(pill, i) in steps[step].pills" :key="i" class="bd-wlc-pill">
          <component :is="pill.icon" :size="14" stroke-width="1.75" aria-hidden="true" />
          {{ pill.label }}
        </span>
      </div>
    </div>
    <div class="bd-wlc-foot">
      <button class="bd-btn" data-cy="bd-welcome-skip" @click="close">
        {{ isLast ? t('bd.close') : t('bd.welcomeSkip') }}
      </button>
      <div class="bd-wlc-dots" role="tablist" :aria-label="t('bd.welcomeTitle')">
        <button
          v-for="(_, i) in steps"
          :key="i"
          role="tab"
          :aria-selected="i === step"
          :aria-label="t('bd.welcomeStep', { n: i + 1 })"
          :data-cy="`bd-welcome-dot-${i}`"
          @click="go(i)"
        ></button>
      </div>
      <div style="display: flex; gap: 8px">
        <button v-if="step > 0" class="bd-btn" data-cy="bd-welcome-prev" @click="prev">
          {{ t('bd.welcomePrev') }}
        </button>
        <button class="bd-btn bd-pri" data-cy="bd-welcome-next" @click="next">
          {{ isLast ? t('bd.welcomeStart') : t('bd.welcomeNext') }}
        </button>
      </div>
    </div>
  </dialog>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import {
  ShieldCheck, Zap, Layers, MousePointerClick, Command, Folder,
  Variable, GitBranch, Sparkles, Smartphone, Move, QrCode,
} from 'lucide-vue-next'
import { useI18nStore } from '../../composables/useI18n'

const { t } = useI18nStore()

const WELCOME_KEY = 'bundeck:welcome-seen'
const WELCOME_STEP = 'bundeck:welcome-step'

const dialog = ref<HTMLDialogElement | null>(null)
const step = ref(0)

const steps = computed(() => [
  {
    title: t('bd.welcomeS0Title'),
    desc: t('bd.welcomeS0Desc'),
    pills: [
      { icon: ShieldCheck, label: t('bd.welcomeS0P1') },
      { icon: Zap, label: t('bd.welcomeS0P2') },
      { icon: Layers, label: t('bd.welcomeS0P3') },
    ],
    svg: `<svg viewBox="0 0 360 164" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="44" y="16" width="272" height="132" rx="22" fill="#17181b" stroke="#2f333a" stroke-width="2"/>
      <rect x="64" y="34" width="52" height="44" rx="11" fill="#2d3036" stroke="#e0a84a" stroke-width="2"/>
      <circle cx="90" cy="52" r="7" stroke="#e0a84a" stroke-width="2"/><rect x="81" y="65" width="18" height="3" rx="1.5" fill="#e0a84a"/>
      <rect x="126" y="34" width="52" height="44" rx="11" fill="#26292e"/>
      <path d="M147 50l10 6-10 6V50z" fill="#86cba5"/>
      <rect x="188" y="34" width="52" height="44" rx="11" fill="#26292e"/>
      <circle cx="214" cy="56" r="8" stroke="#82b4ea" stroke-width="2"/>
      <rect x="250" y="34" width="46" height="44" rx="11" fill="#26292e"/>
      <path d="M267 56h12M273 50v12" stroke="#ec8e7e" stroke-width="2" stroke-linecap="round"/>
      <rect x="64" y="88" width="52" height="44" rx="11" fill="#26292e"/>
      <rect x="81" y="106" width="18" height="8" rx="2" stroke="#c7a6e0" stroke-width="2"/>
      <rect x="126" y="88" width="52" height="44" rx="11" fill="#26292e"/>
      <path d="M145 110h14" stroke="#8c9096" stroke-width="2" stroke-linecap="round"/>
      <rect x="188" y="88" width="52" height="44" rx="11" fill="#26292e"/>
      <rect x="250" y="88" width="46" height="44" rx="11" fill="#202226" stroke="#3a3e45" stroke-dasharray="4 4"/>
    </svg>`,
  },
  {
    title: t('bd.welcomeS1Title'),
    desc: t('bd.welcomeS1Desc'),
    pills: [
      { icon: MousePointerClick, label: t('bd.welcomeS1P1') },
      { icon: Command, label: t('bd.welcomeS1P2') },
      { icon: Folder, label: t('bd.welcomeS1P3') },
    ],
    svg: `<svg viewBox="0 0 360 164" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="32" y="24" width="112" height="116" rx="14" fill="#1a1c1f" stroke="#2f333a"/>
      <rect x="44" y="38" width="88" height="24" rx="7" fill="#2d3036" stroke="#e0a84a" stroke-width="1.5"/>
      <circle cx="56" cy="50" r="4" fill="#e0a84a"/><rect x="66" y="48" width="48" height="4" rx="2" fill="#e8e9eb"/>
      <rect x="44" y="70" width="88" height="24" rx="7" fill="#222428"/>
      <rect x="66" y="80" width="42" height="4" rx="2" fill="#6b6e73"/>
      <rect x="44" y="102" width="88" height="24" rx="7" fill="#222428"/>
      <rect x="66" y="112" width="52" height="4" rx="2" fill="#6b6e73"/>
      <path d="M148 52 C 185 52, 195 82, 232 82" stroke="#e0a84a" stroke-width="2.5" stroke-dasharray="5 4" stroke-linecap="round"/>
      <path d="M226 76l8 6-8 6" stroke="#e0a84a" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
      <rect x="242" y="42" width="84" height="84" rx="18" fill="#2d3036" stroke="#e0a84a" stroke-width="2"/>
      <circle cx="284" cy="76" r="12" stroke="#e0a84a" stroke-width="2.2"/>
      <rect x="266" y="98" width="36" height="5" rx="2.5" fill="#e8e9eb"/>
    </svg>`,
  },
  {
    title: t('bd.welcomeS2Title'),
    desc: t('bd.welcomeS2Desc'),
    pills: [
      { icon: Variable, label: t('bd.welcomeS2P1') },
      { icon: GitBranch, label: t('bd.welcomeS2P2') },
      { icon: Sparkles, label: t('bd.welcomeS2P3') },
    ],
    svg: `<svg viewBox="0 0 360 164" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="36" y="46" width="76" height="72" rx="16" fill="#2b5a3a" stroke="#86cba5" stroke-width="2"/>
      <circle cx="74" cy="75" r="9" stroke="#86cba5" stroke-width="2"/>
      <rect x="58" y="94" width="32" height="4" rx="2" fill="#e8e9eb"/>
      <path d="M118 82h34" stroke="#8c9096" stroke-width="2" stroke-linecap="round"/>
      <polygon points="180,52 214,82 180,112 146,82" fill="#1a1c1f" stroke="#e0a84a" stroke-width="2"/>
      <text x="180" y="86" text-anchor="middle" fill="#e0a84a" font-family="monospace" font-size="13" font-weight="bold">?</text>
      <path d="M214 82h34" stroke="#8c9096" stroke-width="2" stroke-linecap="round"/>
      <rect x="252" y="46" width="76" height="72" rx="16" fill="#5a2b2b" stroke="#ec8e7e" stroke-width="2"/>
      <path d="M283 68l14 14M297 68l-14 14" stroke="#ec8e7e" stroke-width="2.2" stroke-linecap="round"/>
      <rect x="274" y="94" width="32" height="4" rx="2" fill="#e8e9eb"/>
    </svg>`,
  },
  {
    title: t('bd.welcomeS3Title'),
    desc: t('bd.welcomeS3Desc'),
    pills: [
      { icon: Smartphone, label: t('bd.welcomeS3P1') },
      { icon: Move, label: t('bd.welcomeS3P2') },
      { icon: QrCode, label: t('bd.welcomeS3P3') },
    ],
    svg: `<svg viewBox="0 0 360 164" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="52" y="24" width="168" height="116" rx="16" fill="#1a1c1f" stroke="#2f333a" stroke-width="2"/>
      <rect x="66" y="38" width="66" height="40" rx="9" fill="#2b3f5a" stroke="#82b4ea" stroke-width="1.5"/>
      <rect x="140" y="38" width="66" height="40" rx="9" fill="#2d3036"/>
      <rect x="66" y="86" width="140" height="40" rx="9" fill="#5a4a24" stroke="#e0a84a" stroke-width="1.5"/>
      <rect x="242" y="32" width="66" height="104" rx="14" fill="#17181b" stroke="#e0a84a" stroke-width="2"/>
      <rect x="252" y="46" width="20" height="20" rx="5" fill="#2d3036"/>
      <rect x="278" y="46" width="20" height="20" rx="5" fill="#2b5a3a"/>
      <rect x="252" y="72" width="20" height="20" rx="5" fill="#5a2b2b"/>
      <rect x="278" y="72" width="20" height="20" rx="5" fill="#2d3036"/>
      <rect x="252" y="98" width="46" height="22" rx="6" fill="#e0a84a"/>
    </svg>`,
  },
])

const isLast = computed(() => step.value === steps.value.length - 1)

function isSeen(): boolean {
  try {
    return !!localStorage.getItem(WELCOME_KEY)
  } catch {
    return false
  }
}

function readStoredStep(max: number): number {
  try {
    const n = Number(localStorage.getItem(WELCOME_STEP))
    if (Number.isInteger(n) && n >= 0 && n < max) return n
  } catch { /* noop */ }
  return 0
}

function persistStep() {
  // Solo guarda el progreso mientras la guía siga pendiente: recargar a
  // mitad reabre el diálogo en el mismo paso en vez de darlo por visto.
  if (isSeen()) return
  try {
    localStorage.setItem(WELCOME_STEP, String(step.value))
  } catch { /* noop */ }
}

function markSeen() {
  try {
    localStorage.setItem(WELCOME_KEY, '1')
  } catch { /* noop */ }
  try {
    localStorage.removeItem(WELCOME_STEP)
  } catch { /* noop */ }
}

function show(at?: number) {
  step.value = typeof at === 'number'
    ? Math.min(Math.max(0, at), steps.value.length - 1)
    : readStoredStep(steps.value.length)
  dialog.value?.showModal()
}

function close() {
  // Salida explícita (Saltar/Cerrar): única vía junto con llegar al final
  // para dar la guía por vista. Esc o recargar no marcan nada.
  markSeen()
  dialog.value?.close()
}

function go(i: number) {
  step.value = Math.min(Math.max(0, i), steps.value.length - 1)
  persistStep()
}

function prev() {
  step.value = Math.max(0, step.value - 1)
  persistStep()
}

function next() {
  if (step.value < steps.value.length - 1) {
    step.value++
    persistStep()
  } else close()
}

function shouldAutoShow(): boolean {
  return !isSeen()
}

defineExpose({ show, close, shouldAutoShow })
</script>
