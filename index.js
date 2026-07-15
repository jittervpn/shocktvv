// ─────────────────────────────────────────────────────────────
// PeliApi integrado dentro de ShockTV.
// Expone una función `mountPeliApi(app)` que registra los mismos
// endpoints que el servidor original de PeliApi (FxxMorgan) pero
// montados sobre la instancia de Express de ShockTV.
// ─────────────────────────────────────────────────────────────
const path = require("node:path");
const express = require("express");
const compression = require("compression");
const rateLimit = require("express-rate-limit");

const contentRoutes = require("./routes/content.routes");
const downloadService = require("./services/download.service");
const ytdlpResolver = require("./utils/resolvers/ytdlp.resolver");

function mountPeliApi(app) {
  // Compresión sólo para las rutas de PeliApi
  const peliCompression = compression();

  // Rate limits equivalentes a los del server.js original de PeliApi
  const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: "Demasiadas peticiones. Espera 1 minuto." },
  });
  const scrapeLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: "Límite de scrapeo alcanzado. Espera 1 minuto." },
  });

  app.use("/api/v1/", peliCompression, apiLimiter);
  app.use("/api/pelisplus", peliCompression, apiLimiter);
  app.use("/api/v1/content/resolve", scrapeLimiter);
  app.use("/api/v1/content/search", scrapeLimiter);
  app.use("/api/pelisplus/resolve", scrapeLimiter);
  app.use("/api/pelisplus/search", scrapeLimiter);

  // Descargas estáticas
  const downloadsDir = downloadService.getDownloadsDir();
  const staticDownloadOptions = {
    index: false,
    fallthrough: false,
    setHeaders: (res, filePath) => {
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${path.basename(filePath)}"`
      );
    },
  };
  app.use("/downloads", express.static(downloadsDir, staticDownloadOptions));
  app.use("/api/downloads", express.static(downloadsDir, staticDownloadOptions));

  // Endpoint informativo de PeliApi (equivalente a GET /api del server original)
  app.get("/api/peliapi", (_req, res) => {
    res.status(200).json({
      success: true,
      message: "PeliApi integrado en ShockTV",
      version: "1.0.0",
      endpoints: {
        modern: [
          "/api/v1/content/search",
          "/api/v1/content/catalog",
          "/api/v1/content/genres",
          "/api/v1/content/info/:slug",
          "/api/v1/content/servers",
          "/api/v1/content/resolve",
        ],
        legacy: [
          "/api/pelisplus/search",
          "/api/pelisplus/catalog",
          "/api/pelisplus/genres",
          "/api/pelisplus/info/:slug",
          "/api/pelisplus/servers",
          "/api/pelisplus/resolve",
        ],
      },
    });
  });

  // Rutas de contenido (modernas + legacy)
  app.use("/api/v1/content", contentRoutes);
  app.use("/api/pelisplus", contentRoutes);

  // Chequeo no bloqueante de yt-dlp
  ytdlpResolver
    .checkYtdlpAvailability()
    .then(() => {
      if (ytdlpResolver.isAvailable) {
        console.log("[PeliApi] yt-dlp detectado. Usando como resolvedor primario.");
      } else {
        console.log("[PeliApi] yt-dlp no disponible. Se usará Puppeteer como fallback.");
      }
    })
    .catch(() => {});
}

module.exports = { mountPeliApi };
