import { defineConfig } from 'astro/config';
import vue from '@astrojs/vue';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  integrations: [vue()],
  server: {
    port: 4321,
    host: true
  },
  vite: {
    plugins: [tailwindcss()],
    define: {
      __VUE_OPTIONS_API__: true,
      __VUE_PROD_DEVTOOLS__: false,
    },
    build: {
      // Presupuesto: el chunk inicial (vue + app) ronda los 600KB minificado.
      // Los pesados (gridstack, swapy, lucide, qr) viajan en chunks diferidos
      // vía import() y no cuentan para la primera pintura.
      chunkSizeWarningLimit: 700,
      rollupOptions: {
        output: {
          // Rolldown (Vite 8) exige manualChunks como función.
          manualChunks: (id) => {
            const p = id.replace(/\\/g, '/')
            if (!p.includes('node_modules/')) return undefined
            // Cargados bajo demanda (initGs / initializeSwapy / initSwapy).
            if (p.includes('node_modules/gridstack/')) return 'gridstack'
            if (p.includes('node_modules/swapy/')) return 'swapy'
            // Iconos diferidos (useDynamicIcon / IconPickerDialog).
            if (p.includes('node_modules/lucide-vue-next/')) return 'lucide'
            // Núcleo reactivo + i18n: cambia poco, se cachea bien.
            if (/node_modules\/(@vueuse\/|vue-i18n\/|pinia\/|vue\/)/.test(p)) return 'vue-vendor'
            return undefined
          },
        },
      },
    },
  },
});