// ── Polyfill: algunas versiones de Node (<20) no tienen la clase global
// "File", y axios/form-data la referencian al cargar. Sin esto, crashea
// con "ReferenceError: File is not defined" apenas arranca. ──
if (typeof globalThis.File === 'undefined') {
  try {
    const { File } = require('node:buffer');
    globalThis.File = File || class File {};
  } catch (e) {
    globalThis.File = class File {};
  }
}

// ═══════════════════════════════════════════════
//  ShockTV Server — TMDB (token) + AnimeAV1 API
// ═══════════════════════════════════════════════
require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const morgan  = require('morgan');
const path    = require('path');
const fs      = require('fs');
const axios   = require('axios');
const cheerio = require('cheerio');
const vm      = require('node:vm');
const { URL } = require('node:url');

const app  = express();
const PORT = process.env.PORT || 3000;
const TMDB_TOKEN = (process.env.TMDB_TOKEN || '').trim();
// Key interna para proteger /api/anime/* — la genera y usa el propio frontend
const ANIME_KEY  = process.env.ANIME_API_KEY || 'shocktv-internal-key';

app.use(helmet({ contentSecurityPolicy: false })); // CSP off: la app embebe iframes de terceros
app.use(morgan('tiny'));
// ── CORS: frontend en GitHub Pages + Railway (dominios distintos) ──
const ALLOWED_ORIGINS = [
  'https://jittervpn.github.io',
  'https://shocktv.online',
  'https://www.shocktv.online',
  'http://localhost:3000',
  'http://127.0.0.1:3000'
];
app.use(cors({
  origin(origin, cb) {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error('CORS bloqueado para: ' + origin));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-api-key']
}));
app.use(express.json());

// ── Archivos estáticos ──
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

app.get(['/', '/index.html'], (req, res) => {
  try{
    let html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
    html = html.replace('</head>',
      `<script>window.__TMDB_TOKEN__="${TMDB_TOKEN}";window.__ANIME_KEY__="${ANIME_KEY}";</script></head>`);
    res.setHeader('Content-Type', 'text/html').send(html);
  }catch(e){
    // El frontend real vive en GitHub Pages — esta ruta es solo un extra.
    // Si falta public/index.html en este deploy de Railway, no debe tirar 500.
    res.status(200).send('ShockTV backend OK. El frontend está en GitHub Pages, no acá.');
  }
});

// ── Health / Token (fallback por si el frontend no recibió el inline script) ──
app.get('/api/health', (req, res) => res.json({ status: 'ok', tmdb: !!TMDB_TOKEN }));
app.get('/api/token', (req, res) => {
  if (!TMDB_TOKEN) return res.status(500).json({ error: 'TMDB_TOKEN no configurado en Railway (Variables)' });
  res.json({ token: TMDB_TOKEN, animeKey: ANIME_KEY });
});

function asyncH(fn) {
  return async (req, res, next) => {
    try { await fn(req, res, next); }
    catch (e) { next(e); }
  };
}
function authAnime(req, res, next) {
  const key = req.header('x-api-key') || req.query.apiKey || '';
  if (key !== ANIME_KEY) return res.status(401).json({ success: false, message: 'API Key inválida' });
  next();
}

// ══════════════════════════════════════════════
//  ANIMEAV1 — scraping directo (reemplaza al paquete npm animeav1-api,
//  que estaba roto). Lógica de parseo adaptada del proyecto open source
//  anime1v-api de FxxMorgan (https://github.com/FxxMorgan/anime1v-api),
//  portada a lib/animeav1.service.js sin dependencias externas.
//    GET /api/anime/search?q=naruto
//    GET /api/anime/info?slug=naruto
//    GET /api/anime/episode?slug=naruto&number=1
//    GET /api/anime/debug   ← diagnóstico público, abrí este link en el navegador
// ══════════════════════════════════════════════
// ── Servicio AnimeAV1 (scraping directo, todo en este mismo archivo) ──
// Clase de error propia (sin dependencias externas ni parches ocultos).
// Créditos: lógica de scraping de AnimeAV1 adaptada del proyecto open source
// anime1v-api de FxxMorgan (https://github.com/FxxMorgan/anime1v-api).
class ApiError extends Error {
  constructor(statusCode, message, details) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.details = details;
  }
}

const DEFAULT_DOMAIN = process.env.DEFAULT_ANIME_DOMAIN || "animeav1.com";

const HTTP_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
};

const SERVER_PATTERNS = [
  { token: "pdrain", name: "PDrain", test: /(pixeldrain|pdrain)/i },
  { token: "hls", name: "HLS", test: /(hls|m3u8|zilla|player\.)/i },
  { token: "upnshare", name: "UPNShare", test: /(upnshare|uns\.bio)/i },
  { token: "mega", name: "Mega", test: /(mega\.nz|mega)/i },
  { token: "mp4upload", name: "MP4Upload", test: /(mp4upload)/i },
  { token: "1fichier", name: "1Fichier", test: /(1fichier)/i },
  { token: "fembed", name: "Fembed", test: /(fembed|femax20)/i },
];

const VIDEO_URL_REGEX =
  /https?:\/\/(?:www\.)?(?:pixeldrain\.com|mega\.nz|mp4upload\.com|1fichier\.com|player\.[^\s"'<>]+|[^\s"'<>]*zilla[^\s"'<>]*|[^\s"'<>]*uns\.bio[^\s"'<>]*)[^\s"'<>]*/gi;

async function fetchHtml(url) {
  try {
    const timeout = Number(process.env.REQUEST_TIMEOUT_MS || 15000);
    const response = await axios.get(url, {
      timeout,
      headers: HTTP_HEADERS,
      maxRedirects: 5,
      validateStatus: (status) => status >= 200 && status < 400,
    });
    return response.data;
  } catch (error) {
    throw new ApiError(500, "No se pudo obtener contenido desde AnimeAV1", error.message);
  }
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function walk(value, visitor, seen = new Set()) {
  if (!value || typeof value !== "object") {
    return;
  }

  if (seen.has(value)) {
    return;
  }

  seen.add(value);
  visitor(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      walk(item, visitor, seen);
    }
    return;
  }

  for (const child of Object.values(value)) {
    walk(child, visitor, seen);
  }
}

function collectValuesByKey(root, keyName) {
  const values = [];
  walk(root, (node) => {
    if (!isObject(node)) {
      return;
    }

    if (Object.prototype.hasOwnProperty.call(node, keyName)) {
      values.push(node[keyName]);
    }
  });
  return values;
}

function collectArrays(root) {
  const arrays = [];
  walk(root, (node) => {
    if (Array.isArray(node)) {
      arrays.push(node);
    }
  });
  return arrays;
}

function extractBalancedSection(text, startIndex, openChar, closeChar) {
  let depth = 0;
  let activeQuote = "";
  let escaped = false;

  for (let index = startIndex; index < text.length; index += 1) {
    const character = text[index];

    if (activeQuote) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (character === "\\") {
        escaped = true;
        continue;
      }

      if (character === activeQuote) {
        activeQuote = "";
      }
      continue;
    }

    if (character === '"' || character === "'" || character === "`") {
      activeQuote = character;
      continue;
    }

    if (character === openChar) {
      depth += 1;
    }

    if (character === closeChar) {
      depth -= 1;
      if (depth === 0) {
        return text.slice(startIndex, index + 1);
      }
    }
  }

  return null;
}

function safeEvaluate(expression) {
  try {
    const context = Object.create(null);
    return vm.runInNewContext(expression, context, {
      timeout: 1000,
      displayErrors: false,
    });
  } catch (_error) {
    return null;
  }
}

function extractSvelteData(html) {
  const $ = cheerio.load(html);
  const scripts = $("script")
    .map((_, element) => $(element).html() || "")
    .get();

  for (const scriptContent of scripts) {
    if (!scriptContent.includes("__sveltekit_") || !scriptContent.includes("data:")) {
      continue;
    }

    let pointer = scriptContent.indexOf("__sveltekit_");
    while (pointer !== -1) {
      const equalsPosition = scriptContent.indexOf("=", pointer);
      if (equalsPosition === -1) {
        break;
      }

      const objectStart = scriptContent.indexOf("{", equalsPosition);
      if (objectStart === -1) {
        break;
      }

      const objectLiteral = extractBalancedSection(scriptContent, objectStart, "{", "}");
      if (objectLiteral) {
        const payload = safeEvaluate(`(${objectLiteral})`);
        if (payload && Array.isArray(payload.data)) {
          return payload.data;
        }
      }

      pointer = scriptContent.indexOf("__sveltekit_", pointer + "__sveltekit_".length);
    }

    const dataMarker = scriptContent.indexOf("data:");
    if (dataMarker !== -1) {
      const listStart = scriptContent.indexOf("[", dataMarker);
      if (listStart !== -1) {
        const listLiteral = extractBalancedSection(scriptContent, listStart, "[", "]");
        if (listLiteral) {
          const payloadData = safeEvaluate(`(${listLiteral})`);
          if (Array.isArray(payloadData)) {
            return payloadData;
          }
        }
      }
    }
  }

  return null;
}

function resolveAbsoluteUrl(urlCandidate, domain = DEFAULT_DOMAIN) {
  if (!urlCandidate || typeof urlCandidate !== "string") {
    return null;
  }

  try {
    const base = `https://${domain}`;
    return new URL(urlCandidate, base).toString();
  } catch (_error) {
    return null;
  }
}

function normalizeInputUrl(urlCandidate, domain = DEFAULT_DOMAIN) {
  const normalized = resolveAbsoluteUrl(urlCandidate, domain);
  if (!normalized) {
    throw new ApiError(400, "URL invalida");
  }
  return normalized;
}

function detectDomain(urlCandidate) {
  try {
    return new URL(urlCandidate).hostname || DEFAULT_DOMAIN;
  } catch (_error) {
    return DEFAULT_DOMAIN;
  }
}

function parseNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const converted = Number(value);
  return Number.isFinite(converted) ? converted : null;
}

function parseEpisodeNumberFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    const segments = pathname.split("/").filter(Boolean);
    const lastSegment = segments[segments.length - 1] || "";
    const number = Number(lastSegment);
    return Number.isFinite(number) ? number : null;
  } catch (_error) {
    return null;
  }
}

function normalizeServerName(serverName, url) {
  const source = `${serverName || ""} ${url || ""}`.trim();
  for (const knownServer of SERVER_PATTERNS) {
    if (knownServer.test.test(source)) {
      return knownServer;
    }
  }

  if (serverName && typeof serverName === "string") {
    return {
      name: serverName.trim(),
      token: serverName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "")
        .trim(),
    };
  }

  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return {
      name: host,
      token: host.toLowerCase().replace(/[^a-z0-9]+/g, ""),
    };
  } catch (_error) {
    return { name: "Unknown", token: "unknown" };
  }
}

function normalizeLinkObject(entry, domain) {
  if (!entry) {
    return null;
  }

  if (typeof entry === "string") {
    const url = resolveAbsoluteUrl(entry, domain);
    if (!url) {
      return null;
    }
    const server = normalizeServerName("", url);
    return {
      server: server.name,
      token: server.token,
      url,
      quality: null,
    };
  }

  if (!isObject(entry)) {
    return null;
  }

  const urlCandidate =
    entry.url ||
    entry.href ||
    entry.link ||
    entry.embed ||
    entry.streamUrl ||
    entry.downloadUrl ||
    entry.file ||
    entry.source ||
    null;

  const url = resolveAbsoluteUrl(urlCandidate, domain);
  if (!url) {
    return null;
  }

  const server = normalizeServerName(entry.server || entry.name || entry.provider || entry.host, url);
  const quality =
    entry.quality ||
    entry.resolution ||
    entry.label ||
    (typeof entry.size === "string" ? entry.size : null) ||
    null;

  return {
    server: server.name,
    token: server.token,
    url,
    quality,
  };
}

function inferLinkKind(url, explicitKind) {
  if (explicitKind) {
    return explicitKind;
  }

  if (typeof url !== "string") {
    return "stream";
  }

  if (/(embed|play\/?|m3u8|hls|player\.|uns\.bio|upnshare)/i.test(url)) {
    return "stream";
  }

  return "download";
}

function pushDeduped(target, link) {
  if (!link) {
    return;
  }

  const exists = target.some((item) => item.url === link.url);
  if (!exists) {
    target.push(link);
  }
}

function parseVariantContainer(container, kindHint, domain, collector) {
  if (!isObject(container)) {
    return;
  }

  const variantPairs = [
    ["SUB", container.SUB ?? container.sub],
    ["DUB", container.DUB ?? container.dub],
  ];

  for (const [variant, value] of variantPairs) {
    if (!value) {
      continue;
    }

    if (Array.isArray(value)) {
      for (const entry of value) {
        const normalized = normalizeLinkObject(entry, domain);
        if (!normalized) {
          continue;
        }
        const kind = inferLinkKind(normalized.url, kindHint);
        pushDeduped(collector[kind][variant], normalized);
      }
      continue;
    }

    if (isObject(value)) {
      for (const [childKey, childValue] of Object.entries(value)) {
        if (!Array.isArray(childValue)) {
          const normalized = normalizeLinkObject(childValue, domain);
          if (!normalized) {
            continue;
          }
          const childKind =
            /download/i.test(childKey) ? "download" : /stream|embed|server/i.test(childKey) ? "stream" : inferLinkKind(normalized.url, kindHint);
          pushDeduped(collector[childKind][variant], normalized);
          continue;
        }

        const childKind =
          /download/i.test(childKey) ? "download" : /stream|embed|server/i.test(childKey) ? "stream" : kindHint || "stream";

        for (const entry of childValue) {
          const normalized = normalizeLinkObject(entry, domain);
          if (!normalized) {
            continue;
          }
          const inferredKind = inferLinkKind(normalized.url, childKind);
          pushDeduped(collector[inferredKind][variant], normalized);
        }
      }
    }
  }
}

function extractLinksFromData(dataRoot, html, domain) {
  const collector = {
    stream: { SUB: [], DUB: [] },
    download: { SUB: [], DUB: [] },
  };

  walk(dataRoot, (node) => {
    if (!isObject(node)) {
      return;
    }

    if (node.streamLinks) {
      parseVariantContainer(node.streamLinks, "stream", domain, collector);
    }

    if (node.downloadLinks) {
      parseVariantContainer(node.downloadLinks, "download", domain, collector);
    }

    if (node.servers) {
      parseVariantContainer(node.servers, "stream", domain, collector);
    }

    const hasVariantShape =
      Object.prototype.hasOwnProperty.call(node, "SUB") ||
      Object.prototype.hasOwnProperty.call(node, "sub") ||
      Object.prototype.hasOwnProperty.call(node, "DUB") ||
      Object.prototype.hasOwnProperty.call(node, "dub");

    if (hasVariantShape) {
      parseVariantContainer(node, null, domain, collector);
    }
  });

  if (collector.stream.SUB.length === 0 && collector.download.SUB.length === 0 && typeof html === "string") {
    const foundUrls = html.match(VIDEO_URL_REGEX) || [];
    for (const rawUrl of foundUrls) {
      const url = resolveAbsoluteUrl(rawUrl, domain);
      if (!url) {
        continue;
      }
      const server = normalizeServerName("", url);
      const link = { server: server.name, token: server.token, url, quality: null };
      const kind = inferLinkKind(url);
      pushDeduped(collector[kind].SUB, link);
    }
  }

  return collector;
}

function buildExcludedTokens(includeMega, excludeServersRaw) {
  const excluded = new Set();

  const raw = typeof excludeServersRaw === "string" ? excludeServersRaw : "";
  for (const part of raw.split(",")) {
    const token = part.toLowerCase().replace(/[^a-z0-9]+/g, "").trim();
    if (token) {
      excluded.add(token);
    }
  }

  if (!includeMega) {
    excluded.add("mega");
  }

  return excluded;
}

function filterLinksByServers(links, excludedTokens) {
  return links.filter((link) => {
    const token = (link.token || "").toLowerCase();
    if (excludedTokens.has(token)) {
      return false;
    }

    if (token.includes("mega") && excludedTokens.has("mega")) {
      return false;
    }

    return true;
  });
}

function sanitizeLinksForResponse(links) {
  return links.map((link) => {
    const result = {
      server: link.server,
      url: link.url,
    };

    if (link.quality) {
      result.quality = link.quality;
    }

    return result;
  });
}

function chooseBestMediaCandidate(dataRoot) {
  const candidates = collectValuesByKey(dataRoot, "media").filter(isObject);

  walk(dataRoot, (node) => {
    if (!isObject(node)) {
      return;
    }

    if (typeof node.title === "string" && (Array.isArray(node.episodes) || node.description)) {
      candidates.push(node);
    }
  });

  let best = null;
  let bestScore = -1;

  for (const candidate of candidates) {
    let score = 0;
    if (typeof candidate.title === "string") score += 3;
    if (Array.isArray(candidate.episodes)) score += 3;
    if (Array.isArray(candidate.genres)) score += 1;
    if (candidate.description) score += 1;
    if (candidate.poster || candidate.image) score += 1;
    if (candidate.id) score += 1;

    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  return best;
}

function normalizeGenres(genres) {
  if (!Array.isArray(genres)) {
    return [];
  }

  return genres
    .map((genre) => {
      if (typeof genre === "string") {
        return {
          id: null,
          name: genre,
          slug: genre.toLowerCase().replace(/\s+/g, "-"),
          malId: null,
        };
      }

      if (!isObject(genre)) {
        return null;
      }

      return {
        id: genre.id ?? null,
        name: genre.name || genre.title || null,
        slug: genre.slug || null,
        malId: genre.malId ?? genre.mal_id ?? null,
      };
    })
    .filter((genre) => genre && genre.name);
}

function normalizeEpisodes(episodes, domain, slug) {
  if (!Array.isArray(episodes)) {
    return [];
  }

  return episodes
    .map((episode, index) => {
      if (!isObject(episode)) {
        return null;
      }

      const inferredNumber =
        parseNumber(episode.number) ??
        parseNumber(episode.episode) ??
        parseNumber(episode.ep) ??
        parseNumber(episode.order) ??
        index + 1;

      let episodeUrl = resolveAbsoluteUrl(episode.url || episode.href || episode.link, domain);
      if (!episodeUrl && slug && Number.isFinite(inferredNumber)) {
        episodeUrl = resolveAbsoluteUrl(`/media/${slug}/${inferredNumber}`, domain);
      }

      return {
        id: episode.id ?? null,
        number: inferredNumber,
        title: episode.title || `Episodio ${inferredNumber}`,
        url: episodeUrl,
      };
    })
    .filter((episode) => episode && episode.url);
}

function normalizeAnimeInfo(media, domain) {
  const episodes = normalizeEpisodes(media.episodes || media.episodeList || [], domain, media.slug);

  return {
    id: media.id ?? null,
    title: media.title || null,
    titleJapanese:
      (isObject(media.aka) && (media.aka["ja-jp"] || media.aka["ja"] || media.aka.jp)) || media.titleJapanese || null,
    description: media.description || media.synopsis || null,
    image: resolveAbsoluteUrl(media.poster || media.image || media.cover || (media.id ? `https://cdn.animeav1.com/covers/${media.id}.jpg` : null), domain),
    backdrop: resolveAbsoluteUrl(media.backdrop || media.banner || media.thumbnail, domain),
    status: (isObject(media.status) ? media.status.name : media.status) || null,
    type: (isObject(media.category) ? media.category.name : media.type) || null,
    year: media.year ? String(media.year) : null,
    startDate: media.startDate || media.start_date || null,
    endDate: media.endDate || media.end_date || null,
    score: parseNumber(media.score),
    votes: parseNumber(media.votes || media.scoreVotes || media.voters),
    totalEpisodes: parseNumber(media.totalEpisodes) || episodes.length,
    malId: media.malId ?? media.mal_id ?? null,
    trailer: resolveAbsoluteUrl(media.trailer, domain),
    genres: normalizeGenres(media.genres),
    episodes,
  };
}

function chooseLikelySearchArray(dataRoot) {
  const candidateArrays = collectArrays(dataRoot).filter((array) => array.length > 0 && array.length <= 300);

  let bestArray = null;
  let bestScore = -1;

  for (const array of candidateArrays) {
    let totalScore = 0;
    let objectItems = 0;

    for (const item of array) {
      if (!isObject(item)) {
        continue;
      }

      objectItems += 1;
      let score = 0;

      if (typeof item.title === "string" || typeof item.name === "string") score += 2;
      if (typeof item.slug === "string" || typeof item.url === "string") score += 2;
      if (item.poster || item.image || item.backdrop) score += 1;
      if (item.category || item.type) score += 1;
      if (item.status || item.year) score += 0.5;
      if (item.description || item.synopsis) score += 0.5;

      totalScore += score;
    }

    if (objectItems === 0) {
      continue;
    }

    const averageScore = totalScore / objectItems;
    if (averageScore > bestScore) {
      bestScore = averageScore;
      bestArray = array;
    }
  }

  return bestScore >= 2 ? bestArray : null;
}

function mapSearchResults(array, domain) {
  return array
    .map((item) => {
      if (!isObject(item)) {
        return null;
      }

      const title = item.title || item.name || null;
      if (!title) {
        return null;
      }

      const slug = item.slug || null;
      const url = resolveAbsoluteUrl(item.url || item.href || (slug ? `/media/${slug}` : null), domain);
      if (!url) {
        return null;
      }

      let img = item.poster || item.image || item.cover || null;
      if (!img && item.id) {
        img = `https://cdn.animeav1.com/covers/${item.id}.jpg`;
      }

      return {
        id: item.id ?? null,
        title,
        slug,
        url,
        image: resolveAbsoluteUrl(img, domain),
        backdrop: resolveAbsoluteUrl(item.backdrop || item.banner, domain),
        type: (isObject(item.category) ? item.category.name : item.type) || null,
        score: parseNumber(item.score),
        status: (isObject(item.status) ? item.status.name : item.status) || null,
        year: item.year ? String(item.year) : null,
      };
    })
    .filter(Boolean);
}

function normalizeTextForSearch(value) {
  return (value || "")
    .toString()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function filterSearchResultsByQuery(results, query) {
  const normalizedQuery = normalizeTextForSearch(query);
  if (!normalizedQuery) {
    return results.slice(0, 20);
  }

  const queryTerms = normalizedQuery.split(/\s+/).filter(Boolean);
  const scored = [];

  for (const result of results) {
    const title = normalizeTextForSearch(result.title);
    const slug = normalizeTextForSearch(result.slug);
    const combined = `${title} ${slug}`.trim();

    let score = 0;
    if (title === normalizedQuery || slug === normalizedQuery) {
      score += 5;
    }

    if (title.includes(normalizedQuery) || slug.includes(normalizedQuery)) {
      score += 3;
    }

    for (const term of queryTerms) {
      if (term.length < 2) {
        continue;
      }

      if (combined.includes(term)) {
        score += 1;
      }
    }

    if (score > 0) {
      scored.push({ result, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.map((item) => item.result).slice(0, 20);
}

function parseSearchResultsFromHtml(html, domain) {
  const $ = cheerio.load(html);
  const results = [];

  $("a[href^='/media/']").each((_, element) => {
    const href = $(element).attr("href");
    if (!href || !/^\/media\/[^/]+$/i.test(href)) {
      return;
    }

    const card = $(element).closest("article").length ? $(element).closest("article") : $(element);
    const title =
      $(card).find("h3, h2, [title]").first().text().trim() ||
      $(card).find("img").first().attr("alt") ||
      $(element).attr("title") ||
      null;

    if (!title) {
      return;
    }

    const slug = href.replace(/^\/media\//, "").trim();
    const image = resolveAbsoluteUrl($(card).find("img").first().attr("src"), domain);

    results.push({
      id: null,
      title,
      slug,
      url: resolveAbsoluteUrl(href, domain),
      image,
      backdrop: null,
      type: null,
      score: null,
      status: null,
      year: null,
    });
  });

  const unique = [];
  const seenUrls = new Set();

  for (const item of results) {
    if (seenUrls.has(item.url)) {
      continue;
    }
    seenUrls.add(item.url);
    unique.push(item);
  }

  return unique;
}

function firstObjectByKey(dataRoot, keyName) {
  const values = collectValuesByKey(dataRoot, keyName);
  for (const value of values) {
    if (isObject(value)) {
      return value;
    }
  }
  return null;
}

function parseBoolean(value) {
  if (typeof value === "boolean") {
    return value;
  }
  return String(value).toLowerCase() === "true";
}

async function getAnimeInfo(urlCandidate) {
  const normalizedUrl = normalizeInputUrl(urlCandidate);
  const domain = detectDomain(normalizedUrl);
  const html = await fetchHtml(normalizedUrl);

  const svelteData = extractSvelteData(html);
  if (!svelteData) {
    throw new ApiError(500, "No se pudo extraer informacion del anime");
  }

  const media = chooseBestMediaCandidate(svelteData);
  if (!media) {
    throw new ApiError(404, "No se encontro informacion del anime");
  }

  return {
    success: true,
    data: normalizeAnimeInfo(media, domain),
    source: "json",
  };
}

async function searchAnime(query, domainCandidate) {
  const cleanQuery = (query || "").toString().trim();
  if (!cleanQuery) {
    throw new ApiError(400, "Se requiere el parametro q");
  }

  const domain = (domainCandidate || DEFAULT_DOMAIN || "animeav1.com").toString().trim();

  let bestResults = [];
  let bestSource = "html";

  const candidates = [
    { key: "search", value: cleanQuery },
    { key: "q", value: cleanQuery },
  ];

  for (const candidate of candidates) {
    const searchUrl = `https://${domain}/catalogo?${candidate.key}=${encodeURIComponent(candidate.value)}`;
    const html = await fetchHtml(searchUrl);

    let results = [];
    const svelteData = extractSvelteData(html);
    if (svelteData) {
      const bestArray = chooseLikelySearchArray(svelteData);
      if (bestArray) {
        results = mapSearchResults(bestArray, domain);
      }
    }

    if (results.length === 0) {
      results = parseSearchResultsFromHtml(html, domain);
    }

    results = filterSearchResultsByQuery(results, cleanQuery);

    if (results.length > bestResults.length) {
      bestResults = results;
      bestSource = svelteData ? "json" : "html";
    }

    if (bestResults.length >= 5) {
      break;
    }
  }

  return {
    success: true,
    data: {
      query: cleanQuery,
      results: bestResults,
      count: bestResults.length,
    },
    source: bestSource,
  };
}

async function getEpisodeLinks(urlCandidate, includeMegaRaw, excludeServersRaw) {
  const normalizedUrl = normalizeInputUrl(urlCandidate);
  const domain = detectDomain(normalizedUrl);
  const includeMega = parseBoolean(includeMegaRaw);
  const excludedTokens = buildExcludedTokens(includeMega, excludeServersRaw);

  const html = await fetchHtml(urlCandidate);
  const svelteData = extractSvelteData(html);
  const dataRoot = svelteData || {};

  const episodeObject = firstObjectByKey(dataRoot, "episode") || {};
  const links = extractLinksFromData(dataRoot, html, domain);

  const filteredStreamSub = filterLinksByServers(links.stream.SUB, excludedTokens);
  const filteredStreamDub = filterLinksByServers(links.stream.DUB, excludedTokens);
  const filteredDownloadSub = filterLinksByServers(links.download.SUB, excludedTokens);
  const filteredDownloadDub = filterLinksByServers(links.download.DUB, excludedTokens);

  return {
    success: true,
    data: {
      id: episodeObject.id ?? null,
      episode:
        parseNumber(episodeObject.number) ||
        parseNumber(episodeObject.episode) ||
        parseEpisodeNumberFromUrl(normalizedUrl),
      title: episodeObject.title || `Episodio ${parseEpisodeNumberFromUrl(normalizedUrl) || "?"}`,
      season: episodeObject.season ?? null,
      variants: {
        SUB: filteredStreamSub.length > 0 || filteredDownloadSub.length > 0 ? 1 : 0,
        DUB: filteredStreamDub.length > 0 || filteredDownloadDub.length > 0 ? 1 : 0,
      },
      publishedAt: episodeObject.publishedAt || episodeObject.published_at || null,
      servers: {
        sub: sanitizeLinksForResponse(filteredStreamSub),
        dub: sanitizeLinksForResponse(filteredStreamDub),
      },
      streamLinks: {
        SUB: sanitizeLinksForResponse(filteredStreamSub),
        DUB: sanitizeLinksForResponse(filteredStreamDub),
      },
      downloadLinks: {
        SUB: sanitizeLinksForResponse(filteredDownloadSub),
        DUB: sanitizeLinksForResponse(filteredDownloadDub),
      },
    },
    source: svelteData ? "json" : "html",
  };
}

async function getCatalog(page, genre) {
  const pageNum = Math.max(1, parseInt(page) || 1);
  const domain = DEFAULT_DOMAIN;

  let catalogUrl = `https://${domain}/catalogo?page=${pageNum}`;
  if (genre && typeof genre === "string" && genre.trim()) {
    catalogUrl += `&genre=${encodeURIComponent(genre.trim())}`;
  }

  const html = await fetchHtml(catalogUrl);

  let results = [];
  const svelteData = extractSvelteData(html);
  if (svelteData) {
    const bestArray = chooseLikelySearchArray(svelteData);
    if (bestArray) {
      results = mapSearchResults(bestArray, domain);
    }
  }

  if (results.length === 0) {
    results = parseSearchResultsFromHtml(html, domain);
  }

  return {
    success: true,
    data: {
      page: pageNum,
      genre: genre || null,
      results,
      count: results.length,
      hasMore: results.length >= 10,
    },
    source: svelteData ? "json" : "html",
  };
}

const av1 = {
  searchAnime,
  getAnimeInfo,
  getEpisodeLinks,
  getCatalog,
};

// ══════════════════════════════════════════════
//  ANIMEFLV — fuente adicional, junto a AnimeAV1. Portado del proyecto
//  open source animeflv-api (Python, MIT) de jorgeajimenezl/JimScope
//  (https://github.com/jorgeajimenezl/animeflv-api) a JS/axios+cheerio,
//  siguiendo el mismo patrón que ya usamos para AnimeAV1: solo extrae
//  la lista de servidores de video (embeds a terceros), nunca el
//  archivo real.
//  Aviso: animeflv.net puede tener protección Cloudflare que la
//  versión Python esquiva con "cloudscraper" — acá usamos axios plano,
//  así que si Cloudflare bloquea, hay que revisar esto puntual.
// ══════════════════════════════════════════════
const FLV_BASE = 'https://www3.animeflv.net';
const FLV_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
};
async function fetchHtmlFLV(url) {
  const r = await axios.get(url, { headers: FLV_HEADERS, timeout: 15000, validateStatus: () => true });
  if (r.status < 200 || r.status >= 400 || !r.data) {
    throw new Error(`No se pudo obtener contenido desde AnimeFLV (status ${r.status})`);
  }
  return typeof r.data === 'string' ? r.data : String(r.data);
}

async function searchAnimeFLV(query) {
  const url = `${FLV_BASE}/browse?q=${encodeURIComponent(query)}`;
  const html = await fetchHtmlFLV(url);
  const $ = cheerio.load(html);
  const results = [];
  $('div.Container ul.ListAnimes li article').each((i, el) => {
    const $el = $(el);
    const href = $el.find('div.Description a.Button').attr('href') || '';
    const id = href.replace(/^\/?(anime\/)?/, '').trim();
    const title = $el.find('a h3').text().trim();
    const img = $el.find('a div.Image figure img');
    let poster = img.attr('src') || img.attr('data-cfsrc') || '';
    if (poster && !/^https?:\/\//i.test(poster)) poster = FLV_BASE + (poster.startsWith('/') ? '' : '/') + poster;
    const type = $el.find('div.Description p span.Type').text().trim();
    if (id && title) results.push({ id, title, poster, type });
  });
  return results;
}

async function getAnimeFLVServers(id, episode) {
  const url = `${FLV_BASE}/ver/${id}-${episode}`;
  const html = await fetchHtmlFLV(url);
  const marker = html.indexOf('var videos');
  if (marker === -1) return { SUB: [], LAT: [] };
  const braceStart = html.indexOf('{', marker);
  if (braceStart === -1) return { SUB: [], LAT: [] };
  const literal = extractBalancedSection(html, braceStart, '{', '}');
  if (!literal) return { SUB: [], LAT: [] };
  let data;
  try { data = JSON.parse(literal); } catch (e) { return { SUB: [], LAT: [] }; }

  const normalizeEntry = (entry) => {
    if (!entry) return null;
    // "code" es el link de embed (lo que sirve para reproducir); "url" es
    // el link de descarga (otra cosa, no sirve para el iframe). A veces
    // mega.nz viene con un formato que hay que ajustar para poder embeberlo.
    let embedUrl = entry.code || entry.url || '';
    if (typeof embedUrl === 'string') {
      embedUrl = embedUrl.replace('mega.nz/embed#!', 'mega.nz/embed/');
    }
    if (!embedUrl || !/^https?:\/\//i.test(embedUrl)) return null;
    return { server: entry.title || entry.server || 'AnimeFLV', url: embedUrl, quality: entry.quality || null };
  };
  const mapList = (arr) => (Array.isArray(arr) ? arr.map(normalizeEntry).filter(Boolean) : []);

  return { SUB: mapList(data.SUB), LAT: mapList(data.LAT) };
}

// Diagnóstico público — https://TU-BACKEND.up.railway.app/api/animeflv/debug?q=naruto
app.get('/api/animeflv/debug', asyncH(async (req, res) => {
  const q = req.query.q || 'naruto';
  const report = { query: q };
  try {
    const t0 = Date.now();
    const results = await searchAnimeFLV(q);
    report.busquedaOk = true;
    report.tiempoMs = Date.now() - t0;
    report.cantidadResultados = results.length;
    report.primerResultado = results[0] || null;
    if (results[0]) {
      try {
        const servers = await getAnimeFLVServers(results[0].id, 1);
        report.servidoresEp1 = servers;
      } catch (e) {
        report.errorServidores = e.message;
      }
      // Diagnóstico extra: traemos el HTML crudo de la página del episodio
      // para ver si realmente llegamos al contenido real o si algo (ej.
      // Cloudflare) nos está devolviendo otra cosa.
      try {
        const epUrl = `${FLV_BASE}/ver/${results[0].id}-1`;
        const rawHtml = await fetchHtmlFLV(epUrl);
        report.diagnosticoHtml = {
          url: epUrl,
          largoHtml: rawHtml.length,
          contieneVarVideos: rawHtml.includes('var videos'),
          pareceCloudflare: /just a moment|cf-browser-verification|cloudflare/i.test(rawHtml),
          primeros500Caracteres: rawHtml.slice(0, 500),
        };
      } catch (e) {
        report.errorDiagnosticoHtml = e.message;
      }
    }
  } catch (e) {
    report.busquedaOk = false;
    report.errorBusqueda = e.message;
  }
  res.json(report);
}));

app.get('/api/animeflv/search', authAnime, asyncH(async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ success: false, message: 'Falta parámetro q' });
  try {
    const results = await searchAnimeFLV(q);
    res.json({ success: true, data: { results } });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
}));

app.get('/api/animeflv/episode', authAnime, asyncH(async (req, res) => {
  const { id, number } = req.query;
  if (!id || !number) return res.status(400).json({ success: false, message: 'Faltan parámetros id y number' });
  try {
    const servers = await getAnimeFLVServers(id, Number(number));
    res.json({ success: true, data: { servers: { sub: servers.SUB, dub: servers.LAT } } });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
}));

const ANIME_DOMAIN = process.env.DEFAULT_ANIME_DOMAIN || 'animeav1.com';
const mediaUrl   = slug => `https://${ANIME_DOMAIN}/media/${slug}`;
const episodeUrl = (slug, n) => `https://${ANIME_DOMAIN}/media/${slug}/${n}`;

// Diagnóstico público — abrí esto directo en el navegador para ver el error real:
// https://TU-BACKEND.up.railway.app/api/anime/debug?q=naruto
app.get('/api/anime/debug', asyncH(async (req, res) => {
  const q = req.query.q || 'naruto';
  const report = { query: q };
  try {
    const t0 = Date.now();
    const r = await av1.searchAnime(q);
    report.busquedaOk = true;
    report.tiempoMs = Date.now() - t0;
    report.fuente = r.source;
    report.cantidadResultados = r.data.results.length;
    report.primerResultado = r.data.results[0] || null;
  } catch (e) {
    report.busquedaOk = false;
    report.errorBusqueda = e.message;
  }
  res.json(report);
}));

// Diagnóstico público de EPISODIO — abrí esto en el navegador con un anime real:
// https://TU-BACKEND.up.railway.app/api/anime/debug-episode?q=naruto&number=1
app.get('/api/anime/debug-episode', asyncH(async (req, res) => {
  const q = req.query.q || 'naruto';
  const number = Number(req.query.number || 1);
  const report = { query: q, number };
  try {
    const s = await av1.searchAnime(q);
    if (!s.data.results.length) { report.error = 'No se encontraron resultados para: ' + q; return res.json(report); }
    report.slugUsado = s.data.results[0].slug;
    const ep = await av1.getEpisodeLinks(episodeUrl(report.slugUsado, number));
    report.episodioCrudo = ep.data;
    report.fuente = ep.source;
  } catch (e) {
    report.errorEpisodio = e.message;
  }
  res.json(report);
}));

app.get('/api/anime/search', authAnime, asyncH(async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ success: false, message: 'Falta parámetro q' });
  try {
    const r = await av1.searchAnime(q);
    res.json({ success: true, data: { results: r.data.results } });
  } catch (e) {
    res.status(e.statusCode || 500).json({ success: false, message: e.message });
  }
}));

app.get('/api/anime/info', authAnime, asyncH(async (req, res) => {
  const { slug } = req.query;
  if (!slug) return res.status(400).json({ success: false, message: 'Falta parámetro slug' });
  try {
    const r = await av1.getAnimeInfo(mediaUrl(slug));
    res.json({ success: true, data: r.data });
  } catch (e) {
    res.status(e.statusCode || 500).json({ success: false, message: e.message });
  }
}));

app.get('/api/anime/episode', authAnime, asyncH(async (req, res) => {
  const { slug, number } = req.query;
  if (!slug || !number) return res.status(400).json({ success: false, message: 'Faltan parámetros slug y number' });
  try {
    const r = await av1.getEpisodeLinks(episodeUrl(slug, Number(number)));
    res.json({ success: true, data: r.data });
  } catch (e) {
    res.status(e.statusCode || 500).json({ success: false, message: e.message });
  }
}));

// ══════════════════════════════════════════════
//  JIKAN v4 (MyAnimeList no oficial) — solo metadata
//  Da títulos alternativos (inglés/japonés) para reintentar la
//  búsqueda en AnimeAV1 cuando el título en español no matchea.
//    GET /api/jikan/titles?q=Nombre
// ══════════════════════════════════════════════
// Si MyMemory se queda sin cupo diario, no devuelve un error — mete este
// aviso como si fuera la traducción. Lo detectamos para no mostrarlo nunca.
const MYMEMORY_QUOTA_RE = /MYMEMORY WARNING|YOU USED ALL AVAILABLE FREE TRANSLATIONS|QUERY LENGTH LIMIT/i;
// Opcional: si configurás MYMEMORY_EMAIL en las variables de Railway, el
// cupo diario de MyMemory sube de ~5000 a ~50000 caracteres (lo pide su API).
const MYMEMORY_EMAIL = process.env.MYMEMORY_EMAIL || '';

async function translateToSpanish(text) {
  const clean = (text || '').trim();
  if (!clean) return { text: '', translated: false };
  const chunks = [];
  let rest = clean;
  while (rest.length) {
    if (rest.length <= 480) { chunks.push(rest); break; }
    let cut = rest.lastIndexOf('. ', 480);
    if (cut < 100) cut = 480;
    chunks.push(rest.slice(0, cut + 1));
    rest = rest.slice(cut + 1).trim();
  }
  const out = [];
  let quotaHit = false;
  for (const chunk of chunks) {
    if (quotaHit) { out.push(chunk); continue; } // ya sabemos que no hay cupo: no seguimos pegándole a la API
    try {
      const de = MYMEMORY_EMAIL ? `&de=${encodeURIComponent(MYMEMORY_EMAIL)}` : '';
      const r = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(chunk)}&langpair=en|es${de}`);
      const j = await r.json();
      const translated = j?.responseData?.translatedText || '';
      if (!translated || MYMEMORY_QUOTA_RE.test(translated)) { quotaHit = true; out.push(chunk); }
      else out.push(translated);
    } catch (e) {
      out.push(chunk);
    }
  }
  // Si no se pudo traducir nada, devolvemos el texto original en inglés
  // (mejor eso que el aviso de cupo repetido).
  return { text: out.join(' '), translated: !quotaHit };
}

async function jikanAnimeById(id) {
  const r = await fetch(`https://api.jikan.moe/v4/anime/${id}`);
  if (!r.ok) return null;
  const j = await r.json();
  return j?.data || null;
}
async function jikanAnimeSearch(q, limit = 1) {
  const r = await fetch(`https://api.jikan.moe/v4/anime?q=${encodeURIComponent(q)}&limit=${limit}&sfw=true`);
  if (!r.ok) return [];
  const j = await r.json();
  return j?.data || [];
}
function normalizeJikanBrief(it) {
  return {
    id: it.mal_id,
    title: it.title,
    titleEnglish: it.title_english || null,
    image: it.images?.jpg?.large_image_url || it.images?.jpg?.image_url || '',
    score: it.score || 0,
    year: it.year || (it.aired?.from ? new Date(it.aired.from).getFullYear() : null),
    episodes: it.episodes || null,
    type: (it.type || 'tv').toLowerCase(), // tv, movie, ova, ona, special, music
    status: it.status || null,
  };
}

// TTL: 1h para catálogo/búsqueda, 24h para fichas individuales (con traducción)
const animeMetaCache = new Map();
function cacheGet(key, ttl) {
  const hit = animeMetaCache.get(key);
  return (hit && Date.now() - hit.t < ttl) ? hit.v : null;
}
function cacheGetRaw(key) { return animeMetaCache.get(key) || null; }
function cacheSet(key, v) { animeMetaCache.set(key, { v, t: Date.now() }); }

// ══════════════════════════════════════════════
//  JIKAN (MyAnimeList — API de código abierto) — única fuente de datos
//  para anime en la app: catálogo, búsqueda y fichas, con sinopsis
//  traducida al español (Jikan solo la da en inglés). Se usa MyMemory
//  (gratis, sin API key) para traducir, con caché de 24h por título.
// ══════════════════════════════════════════════

//    GET /api/anime/top?type=tv|movie&page=1   — catálogo (home / grillas)
app.get('/api/anime/top', authAnime, asyncH(async (req, res) => {
  const type = req.query.type === 'movie' ? 'movie' : 'tv';
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const ck = `top:${type}:${page}`;
  const hit = cacheGet(ck, 3600000);
  if (hit) return res.json({ success: true, data: hit });

  const r = await fetch(`https://api.jikan.moe/v4/top/anime?type=${type}&filter=bypopularity&page=${page}`);
  if (!r.ok) return res.json({ success: true, data: { results: [] } });
  const j = await r.json();
  const data = { results: (j?.data || []).map(normalizeJikanBrief), hasNext: !!j?.pagination?.has_next_page };
  cacheSet(ck, data);
  res.json({ success: true, data });
}));

//    GET /api/anime/find?q=Nombre   — búsqueda de catálogo (para la barra de búsqueda)
app.get('/api/anime/find', authAnime, asyncH(async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ success: false, message: 'Falta parámetro q' });
  const ck = `find:${q.toLowerCase().trim()}`;
  const hit = cacheGet(ck, 1800000);
  if (hit) return res.json({ success: true, data: hit });

  const arr = await jikanAnimeSearch(q, 15);
  const data = { results: arr.map(normalizeJikanBrief) };
  cacheSet(ck, data);
  res.json({ success: true, data });
}));

//    GET /api/anime/meta?id=malId  ó  ?q=Nombre   — ficha completa (detalle)
app.get('/api/anime/meta', authAnime, asyncH(async (req, res) => {
  const { q, id } = req.query;
  if (!q && !id) return res.status(400).json({ success: false, message: 'Falta parámetro q o id' });
  const ck = id ? `meta-id:${id}` : `meta-q:${q.toLowerCase().trim()}`;

  const raw = cacheGetRaw(ck);
  if (raw) {
    const fresh = raw.v.translated !== false
      ? Date.now() - raw.t < 604800000   // sinopsis ya traducida: cache 7 días
      : Date.now() - raw.t < 3600000;    // se cachea el fallback en inglés solo 1h, para reintentar traducir pronto
    if (fresh) return res.json({ success: true, data: raw.v });
  }

  let it = null;
  if (id) it = await jikanAnimeById(id);
  else { const arr = await jikanAnimeSearch(q, 1); it = arr[0] || null; }
  if (!it) return res.json({ success: true, data: null });

  const { text: synopsis, translated } = await translateToSpanish(it.synopsis || '');
  const data = { ...normalizeJikanBrief(it), synopsis, translated, genres: (it.genres || []).map(g => g.name), url: it.url };
  cacheSet(ck, data);
  res.json({ success: true, data });
}));

// Compatibilidad: alias viejo de títulos alternativos (lo usa AnimeAV1
// para reintentar la búsqueda de streaming con nombres en inglés/japonés)
app.get('/api/jikan/titles', authAnime, asyncH(async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ success: false, message: 'Falta parámetro q' });
  const arr = await jikanAnimeSearch(q, 3);
  const titles = new Set();
  arr.forEach(it => {
    if (it.title) titles.add(it.title);
    if (it.title_english) titles.add(it.title_english);
    (it.title_synonyms || []).forEach(s => titles.add(s));
  });
  res.json({ success: true, data: { titles: [...titles].filter(Boolean).slice(0, 10) } });
}));

// ══════════════════════════════════════════════
//  PRESENCIA EN VIVO — usuarios conectados y viendo contenido, en tiempo real
//  No es un número simulado: cada pestaña abierta manda un "ping" cada
//  15s con un ID de sesión propio; acá se cuentan los pings vigentes
//  (si una pestaña no manda ping en 30s, se la da de baja automáticamente).
//  Nota: esto vive en memoria de este proceso. Si algún día corrés más
//  de una instancia/réplica de Railway al mismo tiempo, cada una tendría
//  su propio conteo parcial — para ese caso haría falta un store
//  compartido (ej. Redis). Con una sola instancia (tu caso actual) el
//  número es 100% real.
// ══════════════════════════════════════════════
const PRESENCE_TTL_MS = 30_000;
const presence = new Map(); // sessionId -> { lastSeen, watching:{type,id,title}|null }

function prunePresence(){
  const now = Date.now();
  for (const [id, p] of presence) if (now - p.lastSeen > PRESENCE_TTL_MS) presence.delete(id);
}

app.post('/api/presence/ping', (req, res) => {
  const { sessionId, watching } = req.body || {};
  if (!sessionId || typeof sessionId !== 'string' || sessionId.length > 100) {
    return res.status(400).json({ success: false, message: 'sessionId inválido' });
  }
  prunePresence();
  presence.set(sessionId, {
    lastSeen: Date.now(),
    watching: (watching && watching.type && watching.id) ? {
      type: String(watching.type).slice(0, 10),
      id: String(watching.id).slice(0, 30),
      title: String(watching.title || '').slice(0, 150),
    } : null,
  });
  res.json({ success: true });
});

app.post('/api/presence/leave', (req, res) => {
  const { sessionId } = req.body || {};
  if (sessionId) presence.delete(sessionId);
  res.json({ success: true });
});

app.get('/api/presence/stats', (req, res) => {
  prunePresence();
  let watchingNow = 0;
  const perTitle = new Map();
  for (const p of presence.values()) {
    if (p.watching) {
      watchingNow++;
      const key = `${p.watching.type}:${p.watching.id}`;
      perTitle.set(key, (perTitle.get(key) || 0) + 1);
    }
  }
  const { type, id } = req.query;
  const thisTitle = (type && id) ? (perTitle.get(`${type}:${id}`) || 0) : 0;
  res.json({ success: true, data: { online: presence.size, watchingNow, thisTitle } });
});

// Error handler
app.use((err, req, res, next) => {
  res.status(err.statusCode || 500).json({ success: false, message: err.message || 'Error interno' });
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'), err => {
    if (err) res.status(404).send('Not found. El frontend de ShockTV vive en GitHub Pages.');
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ ShockTV escuchando en :${PORT} | TMDB token: ${TMDB_TOKEN ? 'OK' : 'FALTA'}`);
});
