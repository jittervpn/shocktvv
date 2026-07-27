// El frontend está en cPanel (shocktv.online), el backend corre en Render.
window.__API_BASE__ = "https://shocktvv-1.onrender.com";

// ── API multi-proveedor de anime (anime1v-api de FxxMorgan) ──────────
// Suma AnimeFLV, TioAnime, JKAnime y MonosChinos además de AnimeAV1.
// Dejalo vacío para seguir usando solo AnimeAV1 (el scraper que ya
// tiene tu server.js). Cuando despliegues la API, poné acá su URL.
window.__ANIME_MULTI__ = "";              // ej: "https://anime1v-api.onrender.com"
window.__ANIME_MULTI_KEY__ = "";          // la clave que pongas en API_KEYS
