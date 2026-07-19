# Integración de servidores Cinetoons en ShockTV

## Qué se agregó

En el modal "Seleccionar reproductor" (botón "Otra fuente"), para **películas y series** (no anime, ver nota abajo), ahora aparecen 2 opciones nuevas junto a Unlimplay:

- **Cinetoons 1** (color rojo de marca) — sirve el contenido vía StreamVault
- **Cinetoons 2** (color turquesa de marca) — sirve el contenido vía UPnShare

Estos dos consumen un único endpoint:

```
https://panel.cinetoons.xyz/api/embed.php?tmdb_id={id}&type={movie|tv}&s={temporada}&e={episodio}&srv={1|2}
```

- `srv=1` → StreamVault
- `srv=2` → UPnShare
- Para type=movie no hace falta mandar `s` ni `e`.

El endpoint ya identifica el contenido por `tmdb_id`, así que no hace falta ningún cambio en cómo ShockTV maneja su catálogo — se reusa el mismo ID de TMDB que ya usa para Unlimplay.

## Requisito de dominio (ya resuelto)

El servidor de Cinetoons solo permite mostrar el reproductor embebido a dominios autorizados explícitamente (protección `Content-Security-Policy: frame-ancestors` + `X-Frame-Options`). **`https://shocktv.online` ya está autorizado** — no hace falta ningún cambio de tu lado para esto, ya funciona en cuanto despliegues con ese dominio.

## Comportamiento esperado

- Si el título **no está** en el catálogo de Cinetoons, el iframe va a mostrar un mensaje de error simple ("Video no encontrado") en vez de reproducir — es normal, Cinetoons no tiene el 100% del catálogo de TMDB.
- El reproductor que se ve dentro del iframe es el **skin original** de StreamVault o UPnShare (no un reproductor personalizado de Cinetoons) — es el comportamiento actual del sistema, más simple y ya funcional. Está anotado como mejora a futuro reemplazarlo por un reproductor propio.

## ⚠️ Pendiente: Anime

**El anime de ShockTV todavía NO tiene los servidores de Cinetoons integrados.**

Motivo técnico: la sección de anime de ShockTV identifica cada título con un `mal_id` (ID de MyAnimeList, vía Jikan/AnimeAV1), mientras que el catálogo de Cinetoons identifica todo por `tmdb_id` (TMDB). No existe una tabla pública gratuita que traduzca de forma confiable un ID al otro.

La solución posible (no implementada todavía) sería buscar el título del anime directamente en TMDB por nombre y tomar el resultado más probable como su `tmdb_id` — funcionaría la mayoría de las veces, pero no sería 100% exacto (puede fallar con títulos ambiguos, remakes, o nombres traducidos distinto al original). Se dejó pendiente para evaluar con más cuidado antes de implementarlo.

## Testing realizado

Se probó exitosamente con la película "Michael" (tmdb_id 936075) — ambos servidores (Cinetoons 1 y 2) cargan el video correctamente cuando se accede vía HTTPS real. Durante pruebas locales sobre HTTP puro (sin certificado), el servidor 2 mostró un error de `crypto.subtle` — esto es una limitación exclusiva de probar sin HTTPS (el navegador no considera "contexto seguro" a ningún iframe anidado dentro de una página sin HTTPS), y no debería repetirse en producción sobre `https://shocktv.online`.
