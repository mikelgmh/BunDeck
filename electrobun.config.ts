import type { ElectrobunConfig } from "electrobun";

export default {
  app: {
    name: "LibreDeck",
    identifier: "dev.libredeck.app",
    version: "1.5.0",
  },
  runtime: {
    exitOnLastWindowClosed: false,
  },
  release: {
    // Artefactos se publican en GitHub Releases; Updater los descarga desde /latest/download
    baseUrl: "https://github.com/mikelgmh/libredeck/releases/latest/download",
  },
  build: {
    bun: {
      entrypoint: "src/bun/index.ts",
    },
    views: {
      mainview: {
        entrypoint: "src/electrobun/view.ts",
      },
    },
    mac: {
      icons: "icon.ico",
    },
    win: {
      icon: "icon.ico",
    },
    linux: {
      icon: "assets/bundeck-512.png",
    },
    // Astro ya genera web/dist; lo copiamos a la view para modo offline
    // En híbrido la ventana carga http://localhost:3002, pero mantenemos copia por si LAN falla
    copy: {
      "web/dist": "views/mainview",
    },
    watch: ["web/dist"],
  },
  scripts: {
    // Prebuild compila web si no existe dist
    preBuild: "./scripts/electrobun-prebuild.ts",
  },
} satisfies ElectrobunConfig;
