// View de Electrobun — cuando se usa views://mainview/index.html (fallback offline)
// El HTML real viene de web/dist copiado via electrobun.config.ts copy.
// Este entrypoint solo añade helper para modo híbrido y no interfiere con Astro.
console.log("[electrobun-view] LibreDeck view cargada, location:", window.location.href);

// Si estamos en views:// y el daemon LAN está disponible, podríamos ofrecer botón "Abrir en navegador"
// pero no redirigir automáticamente para no romper offline.
document.addEventListener("DOMContentLoaded", () => {
  // No-op: Astro app se encarga
});
