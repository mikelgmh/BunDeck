<template>
  <dialog ref="dialog" class="ios-warning-modal" data-cy="ios-fullscreen-warning">
    <div class="modal-content">
      <div class="modal-icon" aria-hidden="true">
        <TriangleAlert :size="28" stroke-width="1.5" />
      </div>
      <h2 class="modal-title">{{ t('iosFullscreenWarning.title') }}</h2>
      <p class="modal-text">
        {{ t('iosFullscreenWarning.message') }}
      </p>
      <p class="modal-hint">
        {{ t('iosFullscreenWarning.safariHint') }}
      </p>
      <div class="modal-buttons">
        <button @click="closeModal" class="modal-primary" data-cy="ios-warning-got-it" autofocus>
          {{ t('iosFullscreenWarning.gotIt') }}
        </button>
      </div>
    </div>
  </dialog>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { TriangleAlert } from 'lucide-vue-next'
import { useI18nStore } from '../composables/useI18n'
import { shouldShowIosFullscreenWarning } from '../composables/useIosBrowser'

const { t } = useI18nStore()

const dialog = ref<HTMLDialogElement | null>(null)
const isClosing = ref(false)

const showModal = () => {
  isClosing.value = false
  if (dialog.value && !dialog.value.open) {
    dialog.value.showModal()
  }
}

const closeModal = () => {
  if (isClosing.value || !dialog.value?.open) return

  isClosing.value = true
  dialog.value.classList.add('closing')

  // Esperar a que termine la animación antes de cerrar realmente
  setTimeout(() => {
    dialog.value?.close()
    dialog.value?.classList.remove('closing')
    isClosing.value = false
  }, 300)
}

// Al cargar la página: si estamos en iOS con un navegador que no es Safari,
// avisar de que la pantalla completa solo funciona en Safari.
onMounted(() => {
  dialog.value?.addEventListener('click', (e) => {
    const rect = dialog.value!.getBoundingClientRect()
    if (
      e.clientX < rect.left ||
      e.clientX > rect.right ||
      e.clientY < rect.top ||
      e.clientY > rect.bottom
    ) {
      closeModal()
    }
  })

  if (shouldShowIosFullscreenWarning()) {
    showModal()
  }
})

defineExpose({
  showModal,
  closeModal
})
</script>

<style scoped>
.ios-warning-modal {
  border: 2px solid rgba(0, 0, 0, 0.1);
  border-radius: 1rem;
  padding: 0;
  background-color: #1f2937;
  max-width: 90vw;
  width: 26rem;
  opacity: 0;
  transform: scale(0.95) translateY(-1rem);
  transition:
    opacity 0.3s cubic-bezier(0.4, 0, 0.2, 1),
    transform 0.3s cubic-bezier(0.4, 0, 0.2, 1),
    overlay 0.3s cubic-bezier(0.4, 0, 0.2, 1) allow-discrete,
    display 0.3s cubic-bezier(0.4, 0, 0.2, 1) allow-discrete;
  margin: auto;
  box-shadow:
    0 20px 25px -5px rgba(0, 0, 0, 0.3),
    0 8px 10px -6px rgba(0, 0, 0, 0.2);
}

.ios-warning-modal[open] {
  opacity: 1;
  transform: scale(1) translateY(0);
}

.ios-warning-modal.closing {
  opacity: 0;
  transform: scale(0.95) translateY(-1rem);
}

@starting-style {
  .ios-warning-modal[open] {
    opacity: 0;
    transform: scale(0.95) translateY(-1rem);
  }
}

.ios-warning-modal::backdrop {
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(4px);
  opacity: 0;
  transition:
    opacity 0.3s cubic-bezier(0.4, 0, 0.2, 1),
    display 0.3s allow-discrete,
    overlay 0.3s allow-discrete;
}

.ios-warning-modal[open]::backdrop {
  opacity: 1;
}

.ios-warning-modal.closing::backdrop {
  opacity: 0;
}

@starting-style {
  .ios-warning-modal[open]::backdrop {
    opacity: 0;
  }
}

.modal-content {
  padding: 2rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
  align-items: center;
  background-color: #1f2937;
  text-align: center;
}

.modal-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 3.5rem;
  height: 3.5rem;
  border-radius: 9999px;
  background-color: rgba(245, 158, 11, 0.15);
  color: #f59e0b;
}

.modal-title {
  font-size: 1.25rem;
  font-weight: 600;
  color: #f9fafb;
  margin: 0;
}

.modal-text {
  color: #d1d5db;
  line-height: 1.6;
  margin: 0;
  font-size: 0.95rem;
}

.modal-hint {
  color: #9ca3af;
  line-height: 1.5;
  margin: 0;
  font-size: 0.85rem;
  background: #374151;
  padding: 0.75rem 1rem;
  border-radius: 0.5rem;
  width: 100%;
}

.modal-buttons {
  display: flex;
  gap: 0.75rem;
  width: 100%;
  justify-content: center;
  margin-top: 0.5rem;
  flex-wrap: wrap;
}

.modal-primary {
  padding: 0.75rem 1.5rem;
  border-radius: 0.5rem;
  font-weight: 500;
  transition: all 0.2s ease;
  border: none;
  cursor: pointer;
}

.modal-primary {
  background-color: #3b82f6;
  color: white;
}

.modal-primary:hover {
  opacity: 0.9;
  transform: translateY(-1px);
}
</style>
