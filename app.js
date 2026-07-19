// ═══════════════════════════════════════
//  ShockTV — app.js
//  Datos: TMDB en español · Streaming: Unlimplay (película/serie) + AnimeAV1 (anime, latino)
// ═══════════════════════════════════════
const IMG3 = 'https://image.tmdb.org/t/p/w185';
const IMG5 = 'https://image.tmdb.org/t/p/w500';
const IMG7 = 'https://image.tmdb.org/t/p/w780';
const IMGO = 'https://image.tmdb.org/t/p/original';
const TMDB = 'https://api.themoviedb.org/3';

// Unlimplay documenta dos paths con los mismos parámetros: /play/embed/
// (el principal) y /f/embed/ ("Recolector"), que según su propia doc es
// "reproducción directa". Probamos este último a ver si evita la pantalla
// de selección de servidor — no hay garantía, pero es un endpoint real
// documentado por ellos, no un parámetro inventado.
const UNL_MOV = id       => `https://unlimplay.com/f/embed/movie/${id}`;
const UNL_TV  = (id,s,e) => `https://unlimplay.com/f/embed/tv/${id}/${s}/${e}`;

const $ = id => document.getElementById(id);
const show = id => $(id)?.classList.remove('hidden');
const hide = id => $(id)?.classList.add('hidden');
const esc = s => (s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));

let tt;
function toast(m, d=2400){ const t=$('toast'); if(!t)return; t.textContent=m; show('toast'); clearTimeout(tt); tt=setTimeout(()=>hide('toast'), d); }

// ── Cache + fetch con timeout/reintento ──
const C = new Map();
async function cached(k, fn, ttl=300000){
  const h = C.get(k); if(h && Date.now()-h.t < ttl) return h.v;
  const v = await fn(); C.set(k, {v, t: Date.now()}); return v;
}
async function fetchRetry(url, opts={}, ms=9000){
  async function attempt(){
    const ctrl = new AbortController();
    const t = setTimeout(()=>ctrl.abort(), ms);
    try { return await fetch(url, {...opts, signal: ctrl.signal}); }
    finally { clearTimeout(t); }
  }
  try { return await attempt(); }
  catch(e){ await sleep(500); return await attempt(); }
}

let TOKEN='', ANIME_KEY='';
const API_BASE = window.__API_BASE__ || ''; // vacío = mismo origen; si el frontend está en otro dominio (ej. GitHub Pages), acá va la URL de Railway
function H(){ return {accept:'application/json', Authorization:'Bearer '+TOKEN}; }
async function api(p){
  return cached(p, async () => {
    const r = await fetchRetry(TMDB+p, {headers:H()});
    if(!r.ok) throw new Error('TMDB '+r.status);
    return r.json();
  });
}
async function animeAPI(endpoint, params={}){
  const qs = new URLSearchParams(params).toString();
  const r = await fetchRetry(`${API_BASE}/api/anime/${endpoint}?${qs}`, {headers:{'x-api-key':ANIME_KEY, accept:'application/json'}});
  if(!r.ok){
    let msg = `AnimeAPI ${r.status}`;
    try{ const j = await r.json(); if(j?.message) msg += ` — ${j.message}`; } catch(e){}
    throw new Error(msg);
  }
  return r.json();
}
async function jikanTitles(q){
  try{
    const r = await fetchRetry(`${API_BASE}/api/jikan/titles?${new URLSearchParams({q})}`, {headers:{'x-api-key':ANIME_KEY, accept:'application/json'}});
    if(!r.ok) return [];
    const j = await r.json();
    return j?.data?.titles || [];
  }catch(e){ return []; }
}

// ═══════════════════════════════
//  ESTADO: favoritos + progreso (localStorage)
// ═══════════════════════════════
let favs={}, prog={};
function loadStore(){
  try{ favs = JSON.parse(localStorage.getItem('stv_f')||'{}'); }catch(e){ favs={}; }
  try{ prog = JSON.parse(localStorage.getItem('stv_p')||'{}'); }catch(e){ prog={}; }
  updBadge();
}
function saveStore(){
  try{ localStorage.setItem('stv_f', JSON.stringify(favs)); localStorage.setItem('stv_p', JSON.stringify(prog)); }catch(e){}
}
const fk = (t,id) => `${t}${id}`;
const isFav = (t,id) => !!favs[fk(t,id)];
function toggleFav(t,id,title,poster,rating,subtype){
  const k=fk(t,id);
  if(favs[k]) delete favs[k];
  else favs[k]={id,type:t,subtype:subtype||null,title,poster,rating,addedAt:Date.now()};
  saveStore(); updBadge();
  document.querySelectorAll(`[data-k="${k}"]`).forEach(el=>el.classList.toggle('on', !!favs[k]));
  const modBtn=$('fav-btn-mod'); if(modBtn && modBtn.dataset.k===k) modBtn.classList.toggle('on', !!favs[k]);
}
function updBadge(){
  const n=Object.keys(favs).length;
  const el=$('fav-count'); if(el) el.textContent = n>0?n:'';
  const bel=$('bnb-fav-count'); if(bel){ bel.textContent = n>0?n:''; bel.classList.toggle('hidden', n===0); }
}

const ek = (t,id,s,ep) => `${t}${id}s${s}e${ep}`;
function setProg(t,id,s,ep,pct){
  const k=ek(t,id,s,ep);
  if(pct>=95) prog[k]={w:1,p:100}; else if(pct>0) prog[k]={w:0,p:pct}; else delete prog[k];
  saveStore();
}
function getProg(t,id,s,ep){ return prog[ek(t,id,s,ep)] || null; }
const isW = (t,id,s,ep) => !!(prog[ek(t,id,s,ep)]?.w);
function markW(t,id,s,ep,v=true){
  if(v) setProg(t,id,s,ep,100); else delete prog[ek(t,id,s,ep)];
  saveStore(); renderEps();
}

// ═══════════════════════════════
//  CONTINUAR VIENDO
// Guardamos en qué episodio/película se quedó cada sesión — no el
// segundo exacto del video, porque ese vive adentro del iframe de un
// tercero (Unlimplay/AnimeAV1) y no tenemos forma de leerlo.
// ═══════════════════════════════
let cw={};
function loadCW(){ try{ cw = JSON.parse(localStorage.getItem('stv_cw')||'{}'); }catch(e){ cw={}; } }
function saveCW(){ try{ localStorage.setItem('stv_cw', JSON.stringify(cw)); }catch(e){} }
function trackWatching(){
  if(!pl || !pl.id) return;
  const t = pl.anime ? 'anime' : pl.type;
  const k = fk(t, pl.id);
  cw[k] = {
    id: pl.id, type: t, subtype: pl.anime ? pl.type : null,
    title: pl.title, poster: pl.poster || '',
    s: pl.s || 1, ep: pl.ep || 1,
    updatedAt: Date.now(),
  };
  saveCW();
}
function removeCW(k, ev){ if(ev) ev.stopPropagation(); delete cw[k]; saveCW(); renderContinueRow(); }
function renderContinueRow(){
  const wrap=$('row-continue'); const sl=$('s-continue'); if(!wrap || !sl) return;
  const items = Object.entries(cw).sort((a,b)=>b[1].updatedAt-a[1].updatedAt).slice(0,15);
  if(!items.length){ wrap.style.display='none'; return; }
  wrap.style.display='';
  sl.innerHTML = items.map(([k,c])=>{
    const isMovie = c.type==='movie' || (c.type==='anime' && c.subtype==='movie');
    const epLabel = isMovie ? 'Película' : `T${c.s} · Ep ${c.ep}`;
    const img = c.poster ? `<img src="${c.poster.startsWith('http')?c.poster:IMG5+c.poster}" alt="${esc(c.title)}" loading="lazy">` : `<div class="card-ph"></div>`;
    const resumeCall = c.type==='anime'
      ? `openPlayer('${c.subtype||'tv'}',${c.id},'${c.title.replace(/'/g,"\\'")}',true,'','${(c.poster||'').replace(/'/g,"\\'")}')`
      : `openPlayer('${c.type}',${c.id},'${c.title.replace(/'/g,"\\'")}',false,'','${(c.poster||'').replace(/'/g,"\\'")}')`;
    return `<div class="card cw-card" tabindex="0" role="button" aria-label="${esc(c.title)}" onclick="${resumeCall}" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();${resumeCall}}">${img}
      <span class="card-tag">${epLabel}</span>
      <button class="cw-x" onclick="removeCW('${k}',event)" title="Quitar" aria-label="Quitar">✕</button>
      <div class="cw-bar"><div class="cw-bar-fill" style="width:${isMovie?100:60}%"></div></div>
    </div>`;
  }).join('');
}

// ═══════════════════════════════
//  PRESENCIA EN VIVO (real: basada en pings de cada pestaña conectada,
//  no un número inventado)
// ═══════════════════════════════
function getSessionId(){
  let id = sessionStorage.getItem('stv_sid');
  if(!id){ id = 'sid_'+Date.now().toString(36)+Math.random().toString(36).slice(2,10); sessionStorage.setItem('stv_sid', id); }
  return id;
}
const SID = getSessionId();
let currentWatching = null;

async function pingPresence(){
  try{
    await fetch(`${window.__API_BASE__}/api/presence/ping`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ sessionId: SID, watching: currentWatching })
    });
  }catch(e){ /* silencioso: un fallo acá no debe afectar el resto de la app */ }
}
async function fetchGlobalStats(){
  try{
    const r = await fetch(`${window.__API_BASE__}/api/presence/stats`);
    const d = await r.json();
    const el = $('online-count'); const lbl = $('online-label');
    if(el && d?.data){
      el.textContent = d.data.online;
      if(lbl) lbl.textContent = ' '+(d.data.online===1?'conectado':'conectados');
    }
  }catch(e){ /* silencioso */ }
}
function startPresence(){
  pingPresence();
  setInterval(pingPresence, 15000);
  fetchGlobalStats();
  setInterval(fetchGlobalStats, 20000);
  window.addEventListener('beforeunload', () => {
    try{
      navigator.sendBeacon?.(`${window.__API_BASE__}/api/presence/leave`, new Blob([JSON.stringify({sessionId:SID})], {type:'application/json'}));
    }catch(e){}
  });
}
function startWatchingPing(type, id, title){
  currentWatching = { type, id, title };
  pingPresence();
}
function stopWatchingPing(){
  currentWatching = null;
  pingPresence();
}

// ═══════════════════════════════
//  MODO NIÑOS
// ═══════════════════════════════
// Filtra por género (Animación 16, Familia 10751, Infantil-TV 10762).
// El PIN se guarda en localStorage sin cifrar: es un freno para que un
// chico no lo desactive solo, no una medida de seguridad real.
const KIDS_OK_GENRES = new Set([16, 10751, 10762]);
let kidsMode = false, kidsPin = '';
function loadKidsStore(){
  try{ kidsMode = localStorage.getItem('stv_kids') === '1'; }catch(e){ kidsMode = false; }
  try{ kidsPin = localStorage.getItem('stv_kidspin') || ''; }catch(e){ kidsPin = ''; }
  applyKidsUI();
}
function saveKidsStore(){
  try{ localStorage.setItem('stv_kids', kidsMode?'1':'0'); localStorage.setItem('stv_kidspin', kidsPin); }catch(e){}
}
function kidsFilterItems(items){
  if(!kidsMode) return items||[];
  return (items||[]).filter(i => !i.adult && (i.genre_ids||[]).some(g=>KIDS_OK_GENRES.has(g)));
}
function applyKidsUI(){
  const badge=$('kids-badge'); if(badge) badge.classList.toggle('hidden', !kidsMode);
  const t=$('kids-toggle'); if(t) t.classList.toggle('on', kidsMode);
  // El catálogo de AnimeAV1 no tiene clasificación por edad, así que en
  // Modo Niños se oculta la sección de Anime por completo (nav + home).
  ['nb-anime','bnb-anime'].forEach(id=>{ const el=$(id); if(el) el.style.display = kidsMode?'none':''; });
  ['row-anime-tv','row-anime-movies'].forEach(id=>{ const el=$(id); if(el) el.style.display = kidsMode?'none':''; });
}
function toggleKidsMode(){
  if(kidsMode){
    if(kidsPin) openKidsModal('exit');
    else{ kidsMode=false; saveKidsStore(); applyKidsUI(); refreshCurrentView(); toast('Modo Niños desactivado'); }
  }else{
    openKidsModal('enter');
  }
}
let kidsModalMode='enter';
function openKidsModal(mode){
  kidsModalMode=mode;
  $('kidsmod-title').textContent = mode==='enter' ? 'Activar Modo Niños' : 'Salir del Modo Niños';
  $('kidsmod-sub').textContent = mode==='enter'
    ? (kidsPin ? 'Ingresá el PIN para activarlo.' : 'Creá un PIN de 4 dígitos. Vas a necesitarlo para volver a salir del Modo Niños.')
    : 'Ingresá el PIN para salir del Modo Niños.';
  $('kidsmod-pin').value=''; hide('kidsmod-err');
  show('kidsmod-ov'); setTimeout(()=>$('kidsmod-pin')?.focus(), 50);
}
function closeKidsModal(e){ if(e && e.target!==$('kidsmod-ov')) return; hide('kidsmod-ov'); }
function confirmKidsModal(){
  const val=($('kidsmod-pin').value||'').trim();
  if(kidsModalMode==='enter'){
    if(!kidsPin){
      if(!/^\d{4}$/.test(val)){ $('kidsmod-err').textContent='Ingresá 4 dígitos'; show('kidsmod-err'); return; }
      kidsPin=val;
    }else if(val!==kidsPin){ $('kidsmod-err').textContent='PIN incorrecto'; show('kidsmod-err'); return; }
    kidsMode=true;
  }else{
    if(val!==kidsPin){ $('kidsmod-err').textContent='PIN incorrecto'; show('kidsmod-err'); return; }
    kidsMode=false;
  }
  saveKidsStore(); applyKidsUI(); hide('kidsmod-ov');
  refreshCurrentView();
  toast(kidsMode?'✅ Modo Niños activado':'Modo Niños desactivado');
}
function refreshCurrentView(){
  ['movies-grid','tv-grid','anime-grid','anime-movies-grid'].forEach(id=>{ const el=$(id); if(el) delete el.dataset.l; });
  C.clear();
  goHome();
  loadHomeWithRetry();
}

// ═══════════════════════════════
//  NAV
// ═══════════════════════════════
const NM = {
  home:   ['nb-home','bnb-home'],
  fav:    ['nb-fav','bnb-fav'],
  movies: ['nb-movies','bnb-movies'],
  tv:     ['nb-tv','bnb-tv'],
  anime:  ['nb-anime','bnb-anime'],
};
function setNav(s){
  Object.values(NM).flat().forEach(id => $(id)?.classList.remove('active'));
  (NM[s]||[]).forEach(id => $(id)?.classList.add('active'));
}
const SECS = ['home-sections', 'movies-section','tv-section','anime-section','fav-section','search-section'];
function hideAll(){ SECS.forEach(hide); hide('loader-ov'); clearInterval(heroTimer); }
function goHome(){
  hideAll(); show('home-sections');
  setNav('home'); window.scrollTo({top:0, behavior:'smooth'});
}
function setSection(sec){
  hideAll(); setNav(sec); window.scrollTo({top:0, behavior:'smooth'});
  ({
    fav:    () => { show('fav-section'); renderFavs(); },
    movies: () => { show('movies-section'); loadGrid('movies-grid', 'movie'); },
    tv:     () => { show('tv-section'); loadGrid('tv-grid', 'tv'); },
    anime:  () => {
      if(kidsMode){ toast('Anime no disponible en Modo Niños'); goHome(); return; }
      show('anime-section'); setAnimeTab(animeTab);
    },
  }[sec] || (()=>{}))();
}
function renderFavs(){
  const el=$('fav-grid'); if(!el) return;
  const items = Object.values(favs).sort((a,b)=>(b.addedAt||0)-(a.addedAt||0));
  if(!items.length){ el.innerHTML = '<p style="color:var(--muted);padding:24px;grid-column:1/-1">No tenés favoritos aún.</p>'; return; }
  el.innerHTML = items.map(i => i.type==='anime'
    ? animeCard({id:i.id, title:i.title, image:i.poster, score:i.rating, type:i.subtype||'tv'})
    : card(i, i.type)
  ).join('');
}

// ═══════════════════════════════
//  BÚSQUEDA
// ═══════════════════════════════
let searchTimer, searchReqId=0;
function onSearchInput(){
  const q=$('search-input').value.trim();
  clearTimeout(searchTimer);
  if(!q){ hide('search-dropdown'); return; }
  searchTimer=setTimeout(()=>liveSearch(q), 400);
}
// Si un resultado de TMDB en realidad es anime (animación + idioma
// original japonés), lo sacamos de la lista de TMDB — ya va a aparecer
// la versión correcta (de Jikan/AnimeAV1) en animeItems. Si dejáramos
// las dos, la de TMDB manda directo a Unlimplay en vez de buscar en
// AnimeAV1, que es justo lo que no queremos para anime.
const isLikelyAnimeTmdb = i => (i.genre_ids||[]).includes(16) && i.original_language==='ja';

async function liveSearch(q){
  const myId=++searchReqId;
  const dd=$('search-dropdown');
  dd.innerHTML='<div class="sd-no-results">Buscando...</div>'; show('search-dropdown');
  try{
    const tmdbR = await api('/search/multi?query='+encodeURIComponent(q)+'&language=es-ES&page=1').catch(()=>({results:[]}));
    if(myId!==searchReqId) return;
    const tmdbItems=kidsFilterItems((tmdbR.results||[]).filter(i=>i.media_type!=='person')).slice(0,10);
    if(!tmdbItems.length){ dd.innerHTML='<div class="sd-no-results">Sin resultados</div>'; return; }
    dd.innerHTML = tmdbItems.map(i=>`
      <div class="sd-item" onclick="hide('search-dropdown');openDetail('${i.media_type||'tv'}',${i.id})">
        ${i.poster_path?`<img class="sd-img" src="${IMG5+i.poster_path}" alt="" loading="lazy" onerror="this.style.display='none'">`:'<div class="sd-img"></div>'}
        <div class="sd-info"><div class="sd-title">${esc(i.title||i.name||'')}</div><div class="sd-meta">${(i.release_date||i.first_air_date||'').slice(0,4)}</div></div>
        <span class="sd-tag">${isLikelyAnimeTmdb(i)?'Anime':(i.media_type==='movie'?'Película':'Serie')}</span>
      </div>`).join('');
  }catch(e){ if(myId===searchReqId) dd.innerHTML='<div class="sd-no-results">Error al buscar</div>'; }
}
let doSearchReqId=0;
function doSearch(){
  const q=$('search-input').value.trim(); if(!q) return;
  const myId=++doSearchReqId;
  hideAll(); show('search-section'); $('search-title').textContent=`Resultados: "${q}"`;
  $('search-results').innerHTML='<div class="sd-no-results big">Buscando...</div>';
  api('/search/multi?query='+encodeURIComponent(q)+'&language=es-ES').catch(()=>({results:[]})).then((tmdbD)=>{
    if(myId!==doSearchReqId) return;
    const tmdbItems=kidsFilterItems((tmdbD.results||[]).filter(i=>i.media_type!=='person'));
    const html = tmdbItems.map(i=>card(i, i.media_type||'tv')).join('');
    $('search-results').innerHTML = html || '<p style="color:var(--muted);padding:24px">Sin resultados.</p>';
  }).catch(e=>{ if(myId===doSearchReqId) $('search-results').innerHTML=`<p style="color:var(--red);padding:24px">Error: ${esc(e.message)}</p>`; });
}
document.addEventListener('click', e => { if(!e.target.closest('.nav-search')) hide('search-dropdown'); });

// ═══════════════════════════════
//  HOME
// ═══════════════════════════════
let hero=[], heroIdx=0, heroTimer=null;
async function loadHome(){
  const calls = [
    api('/trending/movie/week?language=es-ES'),
    api('/trending/tv/week?language=es-ES'),
    api('/movie/popular?language=es-ES&page=1'),
    api('/movie/popular?language=es-ES&page=2'),
    api('/tv/popular?language=es-ES'),
  ];
  const ANIME_Q = 'with_genres=16&with_original_language=ja&sort_by=popularity.desc';
  if(!kidsMode){
    calls.push(api(`/discover/tv?language=es-ES&${ANIME_Q}&page=1`).catch(()=>null));
    calls.push(api(`/discover/tv?language=es-ES&${ANIME_Q}&page=2`).catch(()=>null));
    calls.push(api(`/discover/movie?language=es-ES&${ANIME_Q}&page=1`).catch(()=>null));
    calls.push(api(`/discover/movie?language=es-ES&${ANIME_Q}&page=2`).catch(()=>null));
  }
  const [tm, ttv, mp1, mp2, tvp, anTV1, anTV2, anMov1, anMov2] = await Promise.all(calls);
  const heroPool = kidsFilterItems(tm.results||[]).filter(m=>m.backdrop_path && !isLikelyAnimeTmdb(m));
  hero = heroPool.slice(0,8);
  if(hero.length){ $('hero-section').style.display=''; renderHero(hero[0],'movie'); startHero(); }
  else{ $('hero-section').style.display='none'; }
  renderSl('s0', kidsFilterItems([...(tm.results||[]).slice(0,10), ...(ttv.results||[]).slice(0,10)]).filter(i=>!isLikelyAnimeTmdb(i)), true);
  renderSl('s1', kidsFilterItems([...(mp1.results||[]),...(mp2.results||[])]).filter(i=>!isLikelyAnimeTmdb(i)));
  renderSl('s2', kidsFilterItems(ttv.results||[]).filter(i=>!isLikelyAnimeTmdb(i)), false, true);
  if(!kidsMode){
    const s3=$('s3'), s4=$('s4');
    const anTVAll=[...(anTV1?.results||[]),...(anTV2?.results||[])];
    const anMovAll=[...(anMov1?.results||[]),...(anMov2?.results||[])];
    if(s3) s3.innerHTML = anTVAll.map(i=>card(i,'tv')).join('') || '<p style="color:var(--muted);padding:10px">Sin contenido.</p>';
    if(s4) s4.innerHTML = anMovAll.map(i=>card(i,'movie')).join('') || '<p style="color:var(--muted);padding:10px">Sin contenido.</p>';
  }
  renderContinueRow();
  applyKidsUI();
}
function renderHero(item, type){
  $('hero-bg').style.backgroundImage = item.backdrop_path?`url(${IMGO+item.backdrop_path})`:'';
  $('hero-title').textContent = item.title||item.name||'';
  $('hero-desc').textContent = item.overview||'';
  $('hero-meta').innerHTML = `<span class="star">★ ${(item.vote_average||0).toFixed(1)}</span><span>${(item.release_date||item.first_air_date||'').slice(0,4)}</span>`;
  $('hero-play').onclick=()=>openPlayer(type,item.id,item.title||item.name,false,'',item.poster_path||'');
  $('hero-info').onclick=()=>openDetail(type,item.id);
}
function startHero(){
  clearInterval(heroTimer);
  heroTimer=setInterval(()=>{ heroIdx=(heroIdx+1)%hero.length; renderHero(hero[heroIdx],'movie'); }, 7000);
}
function renderSl(id, items, mixed=false, isTV=false){
  const el=$(id); if(!el) return;
  el.innerHTML = items.map(i => card(i, mixed?(i.media_type||(i.title?'movie':'tv')):(isTV?'tv':'movie'))).join('') || '<p style="color:var(--muted);padding:10px">Sin contenido.</p>';
}
function slide(id, dir){ const el=$(id); if(el) el.scrollBy({left: dir*600, behavior:'smooth'}); }

async function loadGrid(elId, type){
  const el=$(elId); if(!el || el.dataset.l) return; el.dataset.l=1;
  el.innerHTML=Array(10).fill('<div class="skel-card"></div>').join('');
  try{
    const base = kidsMode
      ? `/discover/${type}?language=es-ES&with_genres=${type==='movie'?'16,10751':'16,10762'}&sort_by=popularity.desc`
      : `/${type}/popular?language=es-ES`;
    const [p1,p2,p3] = await Promise.all([api(`${base}&page=1`), api(`${base}&page=2`), api(`${base}&page=3`)]);
    const items = kidsFilterItems([...(p1.results||[]),...(p2.results||[]),...(p3.results||[])]).filter(i=>!isLikelyAnimeTmdb(i)); // filtro extra de seguridad
    el.innerHTML=items.map(i=>card(i,type)).join('') || '<p style="color:var(--muted);padding:24px;grid-column:1/-1">Sin contenido.</p>';
  }catch(e){ el.innerHTML=`<p style="color:var(--red);padding:24px">Error: ${esc(e.message)}</p>`; }
}
async function loadAnimeGrid(){
  const el=$('anime-grid'); if(!el || el.dataset.l) return; el.dataset.l=1;
  el.innerHTML=Array(10).fill('<div class="skel-card"></div>').join('');
  try{
    const q='with_genres=16&with_original_language=ja&sort_by=popularity.desc&language=es-ES';
    const pages = await Promise.all([1,2,3,4,5].map(p=>api(`/discover/tv?${q}&page=${p}`)));
    const items = pages.flatMap(p=>p?.results||[]);
    el.innerHTML=items.map(i=>card(i,'tv')).join('') || '<p style="color:var(--muted);padding:24px;grid-column:1/-1">Sin contenido.</p>';
  }catch(e){ el.innerHTML=`<p style="color:var(--red);padding:24px">Error: ${esc(e.message)}</p>`; }
}
async function loadAnimeMoviesGrid(){
  const el=$('anime-movies-grid'); if(!el || el.dataset.l) return; el.dataset.l=1;
  el.innerHTML=Array(10).fill('<div class="skel-card"></div>').join('');
  try{
    const q='with_genres=16&with_original_language=ja&sort_by=popularity.desc&language=es-ES';
    const pages = await Promise.all([1,2,3,4].map(p=>api(`/discover/movie?${q}&page=${p}`)));
    const items = pages.flatMap(p=>p?.results||[]);
    el.innerHTML=items.map(i=>card(i,'movie')).join('') || '<p style="color:var(--muted);padding:24px;grid-column:1/-1">Sin contenido.</p>';
  }catch(e){ el.innerHTML=`<p style="color:var(--red);padding:24px">Error: ${esc(e.message)}</p>`; }
}
let animeTab='tv';
function setAnimeTab(tab){
  animeTab=tab;
  $('atab-tv')?.classList.toggle('active', tab==='tv');
  $('atab-movie')?.classList.toggle('active', tab==='movie');
  if(tab==='tv'){ hide('anime-movies-grid'); show('anime-grid'); loadAnimeGrid(); }
  else{ hide('anime-grid'); show('anime-movies-grid'); loadAnimeMoviesGrid(); }
}

// ═══════════════════════════════
//  CARDS
// ═══════════════════════════════
// card(): películas/series — siempre TMDB
function card(item, type){
  const title=esc(item.title||item.name||'Sin título');
  const posterPath=item.poster_path||item.poster||'';
  const rat=(item.vote_average??item.rating??0);
  const tag=type==='movie'?'Film':'TV';
  const k=fk(type,item.id);
  const poster=posterPath?IMG5+posterPath:'';
  const img=poster?`<img src="${poster}" alt="${title}" loading="lazy" onerror="this.parentElement.innerHTML='<div class=\\'card-ph\\'></div>'">`:`<div class="card-ph"></div>`;
  return `<div class="card" tabindex="0" role="button" aria-label="${title}" onclick="openDetail('${type}',${item.id})" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openDetail('${type}',${item.id})}">${img}
    <span class="card-tag">${tag}</span>
    ${rat>0?`<span class="card-rating">★ ${rat.toFixed(1)}</span>`:''}
    <button class="fav-heart${isFav(type,item.id)?' on':''}" data-k="${k}"
      onclick="event.stopPropagation();toggleFav('${type}',${item.id},'${title.replace(/'/g,"\\'")}','${posterPath}',${rat})"></button>
  </div>`;
}
// animeCard(): anime (series y películas) — siempre Jikan/MyAnimeList
function animeCard(item){
  const title=esc(item.title||'Sin título');
  const subtype=item.type==='movie'?'movie':'tv';
  const tagSub=subtype==='movie'?'Película':'Serie';
  const k=fk('anime',item.id);
  const img=item.image?`<img src="${item.image}" alt="${title}" loading="lazy" onerror="this.parentElement.innerHTML='<div class=\\'card-ph\\'></div>'">`:`<div class="card-ph"></div>`;
  return `<div class="card" tabindex="0" role="button" aria-label="${title}" onclick="openAnimeDetail(${item.id})" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openAnimeDetail(${item.id})}">${img}
    <span class="card-tag">Anime · ${tagSub}</span>
    ${item.score>0?`<span class="card-rating">★ ${Number(item.score).toFixed(1)}</span>`:''}
    <button class="fav-heart${isFav('anime',item.id)?' on':''}" data-k="${k}"
      onclick="event.stopPropagation();toggleFav('anime',${item.id},'${title.replace(/'/g,"\\'")}','${item.image||''}',${item.score||0},'${subtype}')"></button>
  </div>`;
}

// ═══════════════════════════════
//  DETALLE
// ═══════════════════════════════
let detailReqId=0;
async function openDetail(type, id){
  const myId=++detailReqId;
  show('loader-ov');
  try{
    const det = await api(`/${type}/${id}?language=es-ES&append_to_response=videos,credits,recommendations`);
    if(myId!==detailReqId) return;
    const title=det.title||det.name||'';
    $('mod-back').style.backgroundImage = det.backdrop_path?`url(${IMG7+det.backdrop_path})`:(det.poster_path?`url(${IMG5+det.poster_path})`:'');
    $('mod-title').textContent = title;
    setSyn(det.overview || 'Sin sinopsis disponible.');
    $('mod-tags').innerHTML = (det.genres||[]).map(g=>`<span class="badge">${esc(g.name)}</span>`).join('');
    $('mod-meta').innerHTML = `<span class="star">★ ${(det.vote_average||0).toFixed(1)}</span><span>${(det.release_date||det.first_air_date||'').slice(0,4)}</span><span>${type==='movie'?'Película':'Serie'}</span>`;
    const faved = isFav(type,id);
    const trailer = findTrailer(det.videos?.results);
    const isAnime = isLikelyAnimeTmdb({genre_ids:(det.genres||[]).map(g=>g.id), original_language:det.original_language});
    const watchBtn = `<button class="watch-btn" onclick="closeMod();openPlayer('${type}',${id},'${title.replace(/'/g,"\\'")}',${isAnime?'true':'false'},'${(det.original_title||det.original_name||'').replace(/'/g,"\\'")}','${(det.poster_path||'').replace(/'/g,"\\'")}')">▶ Ver ahora</button>`;
    $('mod-acts').innerHTML = `
      ${watchBtn}
      ${trailer?`<button class="fav-btn" onclick="openTrailer('${trailer}')" title="Ver tráiler" aria-label="Ver tráiler">🎬</button>`:''}
      <button class="fav-btn${faved?' on':''}" id="fav-btn-mod" data-k="${fk(type,id)}" onclick="toggleFav('${type}',${id},'${title.replace(/'/g,"\\'")}','${det.poster_path||''}',${det.vote_average||0})" title="Favoritos" aria-label="Favoritos">${faved?'❤️':'🤍'}</button>
      <button class="fav-btn" onclick="shareTitle('${type}',${id},'${title.replace(/'/g,"\\'")}')" title="Compartir" aria-label="Compartir">📤</button>`;
    renderCast(det.credits?.cast);
    renderRecs((det.recommendations?.results||[]).filter(i=>!isLikelyAnimeTmdb(i)).slice(0,12), type);
    show('mod-ov');
  }catch(e){ toast('Error al cargar: '+e.message); }
  finally{ hide('loader-ov'); }
}
function findTrailer(videos){
  if(!Array.isArray(videos)) return null;
  const v = videos.find(v=>v.site==='YouTube' && v.type==='Trailer') || videos.find(v=>v.site==='YouTube');
  return v ? v.key : null;
}
function openTrailer(key){
  window.open(`https://www.youtube.com/watch?v=${key}`, '_blank', 'noopener');
}
function shareTitle(type, id, title){
  const url = `${location.origin}${location.pathname}?ver=${type}-${id}`;
  if(navigator.share){
    navigator.share({title, text:`Mirá "${title}" en ShockTV`, url}).catch(()=>{});
  }else{
    navigator.clipboard?.writeText(url).then(()=>toast('🔗 Link copiado'), ()=>toast('No se pudo copiar el link'));
  }
}
function renderCast(cast){
  const wrap=$('mod-cast-wrap'), row=$('mod-cast');
  if(!Array.isArray(cast) || !cast.length){ wrap.classList.add('hidden'); return; }
  wrap.classList.remove('hidden');
  row.innerHTML = cast.slice(0,12).map(p=>{
    const img = p.profile_path ? `<img src="${IMG3+p.profile_path}" alt="${esc(p.name)}" loading="lazy">` : `<div class="cast-ph">🙂</div>`;
    return `<div class="cast-card">${img}<div class="cast-name">${esc(p.name)}</div><div class="cast-role">${esc(p.character||'')}</div></div>`;
  }).join('');
}
function renderRecs(items, type){
  const wrap=$('mod-rec-wrap'), row=$('mod-rec');
  if(!items.length){ wrap.classList.add('hidden'); return; }
  wrap.classList.remove('hidden');
  row.innerHTML = items.map(i=>card(i, i.media_type||type)).join('');
}
// Detalle de anime — 100% Jikan (sinopsis ya traducida por el backend)
let animeDetailReqId=0;
async function openAnimeDetail(malId){
  const myId=++animeDetailReqId;
  show('loader-ov');
  try{
    const meta = await animeAPI('meta', {id: malId});
    const m = meta?.data;
    if(myId!==animeDetailReqId) return;
    if(!m){ toast('No se pudo cargar la ficha de este anime'); return; }
    const title=m.title||'Sin título';
    const subtype=m.type==='movie'?'movie':'tv';
    $('mod-back').style.backgroundImage = m.image?`url(${m.image})`:'';
    $('mod-title').textContent = title;
    setSyn(m.synopsis || 'Sin sinopsis disponible.');
    $('mod-tags').innerHTML = (m.genres||[]).map(g=>`<span class="badge">${esc(g)}</span>`).join('') + '<span class="badge">Anime</span>';
    $('mod-meta').innerHTML = `<span class="star">★ ${(m.score||0).toFixed(1)}</span><span>${m.year||''}</span><span>${subtype==='movie'?'Película':'Serie'}</span>`;
    const faved = isFav('anime', malId);
    $('mod-acts').innerHTML = `
      <button class="watch-btn" onclick="closeMod();openPlayer('${subtype}',${malId},'${title.replace(/'/g,"\\'")}',true,'${(m.titleEnglish||'').replace(/'/g,"\\'")}','${(m.image||'').replace(/'/g,"\\'")}')">▶ Ver ahora</button>
      ${m.trailerYoutubeId?`<button class="fav-btn" onclick="openTrailer('${m.trailerYoutubeId}')" title="Ver tráiler" aria-label="Ver tráiler">🎬</button>`:''}
      <button class="fav-btn${faved?' on':''}" id="fav-btn-mod" data-k="${fk('anime',malId)}" onclick="toggleFav('anime',${malId},'${title.replace(/'/g,"\\'")}','${m.image||''}',${m.score||0},'${subtype}')" title="Favoritos" aria-label="Favoritos">${faved?'❤️':'🤍'}</button>
      <button class="fav-btn" onclick="shareTitle('anime',${malId},'${title.replace(/'/g,"\\'")}')" title="Compartir" aria-label="Compartir">📤</button>`;
    // El reparto (actores) no existe para anime de esta forma — se oculta
    // en vez de arrastrar el de la última película/serie que se abrió.
    $('mod-cast-wrap').classList.add('hidden');
    renderAnimeRecs(malId);
    show('mod-ov');
  }catch(e){ toast('Error al cargar: '+e.message); }
  finally{ hide('loader-ov'); }
}
async function renderAnimeRecs(malId){
  const wrap=$('mod-rec-wrap'), row=$('mod-rec');
  wrap.classList.add('hidden'); row.innerHTML='';
  try{
    const r = await animeAPI('recommendations', {id: malId});
    const items = r?.data?.results || [];
    if(!items.length) return;
    wrap.classList.remove('hidden');
    row.innerHTML = items.map(animeCard).join('');
  }catch(e){ /* silencioso: si falla, simplemente no se muestra la fila */ }
}
// Sinopsis truncada a 3 líneas + botón "Ver sinopsis completa" (solo si hace falta)
function setSyn(text){
  const el=$('mod-syn'); const btn=$('mod-syn-more');
  el.textContent = text; el.classList.remove('expanded');
  btn.textContent='Ver sinopsis completa'; hide('mod-syn-more');
  // Si el texto entra en 3 líneas no mostramos el botón — se decide tras pintar
  requestAnimationFrame(()=>{ if(el.scrollHeight > el.clientHeight + 2) show('mod-syn-more'); });
}
function toggleSyn(){
  const el=$('mod-syn'); const btn=$('mod-syn-more');
  const exp = el.classList.toggle('expanded');
  btn.textContent = exp ? 'Ver menos' : 'Ver sinopsis completa';
}
function closeMod(e){ if(e && e.target!==$('mod-ov')) return; hide('mod-ov'); }

// ═══════════════════════════════
//  REPRODUCTOR
// ═══════════════════════════════
let pl = {};
async function openPlayer(type, id, title, isAnime=false, origTitle='', poster=''){
  if(isAnime) return openAnimePlayer(type, id, title, origTitle, poster);
  hide('mod-ov'); show('loader-ov');
  pl = {type, id, title, s:1, ep:1, anime:false, total:0, animeSlug:'', servers:[], srcIdx:0, eps:[], poster:poster||''};
  startWatchingPing(type, id, title);
  $('season-select')?.classList.remove('hidden'); // por si quedó oculto de una sesión de anime anterior

  if(type==='tv'){
    try{
      const tvd = await api(`/tv/${id}?language=es-ES`);
      pl.seasons=(tvd.seasons||[]).filter(s=>s.season_number>0);
      if(pl.seasons.length){ show('ep-panel'); renderSeasonBtns(); await loadSeasonEps(pl.seasons[0].season_number); }
      else hide('ep-panel');
    }catch(e){ console.error('[TV seasons] Error:', e.message); hide('ep-panel'); }
  }else{
    hide('ep-panel');
  }

  $('ply-title').textContent = pl.title;
  updPlyBadge();
  if(type==='tv'){
    $('ply-frame').src='';
    show('ply-placeholder');
  }else{
    hide('ply-placeholder');
    loadFrame();
    trackWatching();
  }
  hide('loader-ov'); show('ply-ov'); document.body.style.overflow='hidden';
}
// Reproductor de anime — AnimeAV1 es la fuente principal (busca por título).
// El "id" que llega acá es el tmdb_id (el anime ahora sale del catálogo de
// TMDB), así que también se puede ofrecer Cinetoons como fuente alterna
// (ver openSrcModal). Unlimplay se deja afuera para anime a propósito.
async function openAnimePlayer(subtype, malId, title, origTitle, poster){
  hide('mod-ov'); show('loader-ov');
  pl = {type:subtype, id:malId, title, s:1, ep:1, anime:true, total:0, animeSlug:'', servers:[], srcIdx:0, animeEpisodes:[], poster:poster||''};
  startWatchingPing('anime', malId, title);
  $('ply-title').textContent = title;
  updPlyBadge();

  if(subtype==='movie'){
    hide('ep-panel');
    hide('ply-placeholder');
    await findAnimeOnly(title, origTitle||title);
    if(!(pl.servers && pl.servers.length)){
      $('ply-placeholder').innerHTML = `
        <svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M8 21h8M12 19v2"/></svg>
        <p>No encontramos esta película en AnimeAV1.</p>
        <button class="ply-ph-btn" onclick="findAnimeOnly('${title.replace(/'/g,"\\'")}','${(origTitle||title).replace(/'/g,"\\'")}')">Reintentar</button>`;
      show('ply-placeholder');
    }else{
      trackWatching();
    }
  }else{
    show('ep-panel');
    $('season-select')?.classList.add('hidden'); // AnimeAV1 no agrupa por temporadas
    $('ep-list').innerHTML = '<div class="sd-no-results">Buscando en AnimeAV1...</div>';
    $('ply-frame').src=''; show('ply-placeholder');
    await findAnimeOnly(title, origTitle||title);
    // Autocargar el primer episodio apenas se encontró el anime (así no hay
    // que tocarlo a mano). Si no hay servidores, playAnimeEp muestra el aviso.
    if(pl.animeEpisodes && pl.animeEpisodes.length){
      const first = pl.animeEpisodes[0].number || 1;
      await playAnimeEp(first);
    }
  }
  hide('loader-ov'); show('ply-ov'); document.body.style.overflow='hidden';
}
function updPlyBadge(){
  if(pl.anime) $('ply-epbadge').textContent = (pl.type==='tv' && pl.ep) ? `Episodio ${pl.ep}` : '';
  else $('ply-epbadge').textContent = pl.type==='tv' ? `Temporada ${pl.s} · Episodio ${pl.ep}` : '';
  const nextBtn=$('ply-next-btn'); if(nextBtn) nextBtn.style.display = pl.type==='movie' ? 'none' : '';
}
function loadFrame(){
  if(pl.type==='movie') setPlyFrame(UNL_MOV(pl.id));
  else setPlyFrame(UNL_TV(pl.id, pl.s, pl.ep));
}
let plyLastUrl='';
// Sin "allow-popups": esto es justo lo que evita que el botón "saltar
// anuncio" de Unlimplay/AnimeAV1 abra pestañas nuevas con publicidad.
// El reproductor de video no necesita abrir ventanas para funcionar.
// Sin allow-popups: esto bloquea las pestañas de publicidad del botón
// "saltar anuncio" de Unlimplay. El video se sigue viendo bien sin este
// permiso — solo hacía falta mientras había una fuente rota metida
// (ya la sacamos).
const PLY_SANDBOX='allow-scripts allow-same-origin allow-forms allow-presentation allow-pointer-lock allow-fullscreen';
function setPlyFrame(url){
  const f=$('ply-frame'); if(!f) return;
  f.setAttribute('sandbox', PLY_SANDBOX);
  show('ply-loading');
  f.onload = () => hide('ply-loading');
  plyLastUrl=url; f.src=url;
  hide('ply-placeholder');
}
function reloadPlyFrame(){
  if(!plyLastUrl){ toast('Nada para recargar'); return; }
  const f=$('ply-frame'); if(!f) return;
  show('ply-loading');
  f.src=''; requestAnimationFrame(()=>{ f.src=plyLastUrl; });
  toast('Reproductor recargado');
}
function closePly(){
  hide('ply-ov'); hide('srcmod-ov'); hide('ply-loading'); $('ply-frame').src=''; document.body.style.overflow='';
  stopWatchingPing();
}
function toggleFullscreen(){
  const el = $('ply-frame-w'); if(!el) return;
  const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
  if(!fsEl){
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    req?.call(el);
  }else{
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    exit?.call(document);
  }
}
document.addEventListener('keydown', e => { if(e.key==='Escape'){ closeSrcModal(); closePly(); closeMod(); } });

// ── Temporadas / episodios ──
function renderSeasonBtns(){
  const cur = pl.seasons.find(s=>s.season_number===pl.s);
  const label = $('season-select-label');
  if(label) label.textContent = cur ? (cur.name || `Temporada ${cur.season_number}`) : `Temporada ${pl.s}`;
  const dd = $('season-dropdown'); if(!dd) return;
  dd.innerHTML = pl.seasons.map(s=>`
    <button class="season-opt${s.season_number===pl.s?' active':''}" onclick="switchSeason(${s.season_number})">
      <span>${esc(s.name || `Temporada ${s.season_number}`)}</span>
      <span class="season-opt-count">${s.episode_count?`${s.episode_count} ep.`:''}</span>
    </button>`).join('');
}
function toggleSeasonDropdown(e){
  if(e) e.stopPropagation();
  $('season-dropdown')?.classList.toggle('hidden');
  $('season-select')?.classList.toggle('open');
}
document.addEventListener('click', e=>{
  const wrap=$('season-select');
  if(wrap && !wrap.contains(e.target)){ $('season-dropdown')?.classList.add('hidden'); wrap.classList.remove('open'); }
});
async function switchSeason(s){
  pl.s=s; pl.ep=1; renderSeasonBtns();
  $('season-dropdown')?.classList.add('hidden');
  $('season-select')?.classList.remove('open');
  await loadSeasonEps(s);
}
async function loadSeasonEps(season){
  $('ep-list').innerHTML='<div class="sd-no-results">Cargando episodios...</div>';
  try{
    const d = await api(`/tv/${pl.id}/season/${season}?language=es-ES`);
    pl.eps = d.episodes||[];
    pl.total = Math.max(pl.total, pl.eps.length);
    renderEps();
  }catch(e){ $('ep-list').innerHTML=`<div class="sd-no-results">Error: ${esc(e.message)}</div>`; }
}
function renderEps(){
  const list=$('ep-list'); if(!list || !pl.eps) return;
  list.innerHTML = pl.eps.map(ep=>{
    const w = isW('tv', pl.id, pl.s, ep.episode_number);
    const p = getProg('tv', pl.id, pl.s, ep.episode_number);
    const hasAV1 = !!(pl.animeSlug && pl.total && ep.episode_number<=pl.total);
    return `<div class="ep-row" onclick="playEp(${ep.episode_number})">
      <div class="ep-thumb-w">${ep.still_path?`<img src="${IMG5+ep.still_path}" loading="lazy">`:''}</div>
      <div class="ep-info">
        <div class="ep-epname${pl.ep===ep.episode_number?' active':''}">Ep ${ep.episode_number}: ${esc(ep.name||'')} ${hasAV1?'<span class="av1-badge">LATINO</span>':''}</div>
        <div class="ep-desc">${esc(ep.overview||'Sin descripción')}${p&&!w?` · ${Math.round(p.p)}% visto`:''}</div>
      </div>
      <button class="ep-mrkbtn${w?' on':''}" onclick="event.stopPropagation();toggleMark(${ep.episode_number})" title="Marcar visto">✓</button>
    </div>`;
  }).join('') || '<div class="sd-no-results">Sin episodios.</div>';
}
function toggleMark(ep){
  const w=isW('tv',pl.id,pl.s,ep); markW('tv',pl.id,pl.s,ep,!w);
  toast(w?`Ep ${ep}: no visto`:`✓ Ep ${ep}: visto`);
}
function playEp(ep){
  pl.ep=ep; updPlyBadge();
  loadFrame();
  renderEps();
  trackWatching();
}
function playNextEpisode(){
  if(pl.type==='movie'){ toast('Esto es una película, no tiene siguiente episodio'); return; }
  if(pl.anime){
    const nums=(pl.animeEpisodes||[]).map(e=>e.number).sort((a,b)=>a-b);
    const next=nums.find(n=>n>pl.ep);
    if(next!=null){ playAnimeEp(next); toast(`▶ Episodio ${next}`); }
    else toast('No hay más episodios disponibles todavía');
    return;
  }
  const list=(pl.eps||[]).map(e=>e.episode_number).sort((a,b)=>a-b);
  const next=list.find(n=>n>pl.ep);
  if(next!=null){ playEp(next); toast(`▶ Episodio ${next}`); return; }
  // Se acabó la temporada actual: probamos saltar a la primera de la siguiente
  const seasons=(pl.seasons||[]).map(s=>s.season_number).sort((a,b)=>a-b);
  const nextSeason=seasons.find(s=>s>pl.s);
  if(nextSeason!=null){
    switchSeason(nextSeason).then(()=>{
      const firstEp=(pl.eps||[])[0]?.episode_number;
      if(firstEp!=null){ playEp(firstEp); toast(`▶ Temporada ${nextSeason} · Episodio ${firstEp}`); }
    });
  }else{
    toast('No hay más episodios');
  }
}

// ── AnimeAV1 (streaming) — usado tanto por el flujo de anime como fuente
//    de "otra fuente" para películas/series regulares no aplica más acá ──
async function findAnimeOnly(titleEs, titleEn){
  try{
    let results=[];
    for(const q of [titleEs, titleEn]){
      if(!q) continue;
      const r = await animeAPI('search', {q});
      results = r?.data?.results || [];
      if(results.length) break;
    }
    if(!results.length){
      const alts = await jikanTitles(titleEs);
      for(const alt of alts){
        const r = await animeAPI('search', {q: alt});
        results = r?.data?.results || [];
        if(results.length) break;
      }
    }
    if(!results.length){
      toast('No se encontró en AnimeAV1');
      renderAnimeEpList();
      return;
    }
    pl.animeSlug = results[0].slug;
    const info = await animeAPI('info', {slug: pl.animeSlug});
    pl.animeEpisodes = info?.data?.episodes || [];
    pl.total = pl.animeEpisodes.length || info?.data?.episodesCount || 0;
    if(pl.type==='movie' && pl.total>0) await loadAnimeEp(1);
    if(pl.total>0) toast('✅ Encontrado en AnimeAV1');
    renderAnimeEpList();
  }catch(e){
    console.warn('[AnimeAV1] Error buscando:', e.message);
    toast('AnimeAV1 no disponible ahora mismo');
    renderAnimeEpList();
  }
}
async function loadAnimeEp(epNum){
  if(!pl.animeSlug) return false;
  try{
    const data = await animeAPI('episode', {slug: pl.animeSlug, number: epNum});
    const servers = data?.data?.servers || {};
    const subServers=(servers.sub||[]).map(s=>({...s,kind:'sub'}));
    const dubServers=(servers.dub||[]).map(s=>({...s,kind:'dub'}));
    const allServers=[...dubServers, ...subServers]; // preferimos latino primero
    if(!allServers.length) return false;
    pl.servers=allServers; pl.srcIdx=0;
    const first=allServers[0];
    const url=first.url||first.link||first.embed||first.embedUrl||first.src||'';
    if(url){ setPlyFrame(url); hide('ply-placeholder'); return true; }
  }catch(e){ console.warn('[AnimeAV1 ep] Error:', e.message); }
  return false;
}
function renderAnimeEpList(){
  const list=$('ep-list'); if(!list) return;
  if(!pl.animeEpisodes || !pl.animeEpisodes.length){
    list.innerHTML = '<div class="sd-no-results">No se encontraron episodios en AnimeAV1.</div>';
    return;
  }
  const thumb = pl.poster ? `<img src="${pl.poster}" loading="lazy" onerror="this.style.display='none'">` : '';
  list.innerHTML = pl.animeEpisodes.map(ep=>{
    const w = isW('anime', pl.id, 1, ep.number);
    return `<div class="ep-row${pl.ep===ep.number?' playing':''}" onclick="playAnimeEp(${ep.number})">
      <div class="ep-thumb-w">${thumb}<span class="ep-thumb-num">${ep.number}</span></div>
      <div class="ep-info">
        <div class="ep-epname${pl.ep===ep.number?' active':''}">Ep ${ep.number}${ep.title?': '+esc(ep.title):''} <span class="av1-badge">LATINO</span></div>
      </div>
      <button class="ep-mrkbtn${w?' on':''}" onclick="event.stopPropagation();toggleMarkAnime(${ep.number})" title="Marcar visto">✓</button>
    </div>`;
  }).join('');
}
async function playAnimeEp(ep){
  pl.ep=ep; pl.srcIdx=0; pl.servers=[]; updPlyBadge();
  show('loader-ov');
  const ok = await loadAnimeEp(ep);
  hide('loader-ov');
  if(!ok){
    // Sin servidores para este episodio: mostramos nuestro propio aviso
    // en vez de dejar el iframe con el error interno del reproductor.
    $('ply-frame').src='';
    $('ply-placeholder').innerHTML = `
      <svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M8 21h8M12 19v2"/></svg>
      <p>Este episodio no tiene servidores disponibles ahora mismo. Probá con otro episodio o volvé más tarde.</p>
      <button class="ply-ph-btn" onclick="playAnimeEp(${ep})">Reintentar</button>`;
    show('ply-placeholder');
    toast('Sin servidores para el Ep '+ep);
  }else{
    trackWatching();
  }
  renderAnimeEpList();
}
function toggleMarkAnime(ep){
  const w=isW('anime',pl.id,1,ep);
  if(!w) setProg('anime',pl.id,1,ep,100); else { delete prog[ek('anime',pl.id,1,ep)]; saveStore(); }
  toast(w?`Ep ${ep}: no visto`:`✓ Ep ${ep}: visto`);
  renderAnimeEpList();
}

// ── Modal "Otra fuente" ──
function openSrcModal(){
  const list=$('srcmod-list');
  const items=[];
  (pl.servers||[]).forEach((s,i)=>{
    items.push({
      label: `${s.kind==='sub'?'Sub':'Latino'} · Servidor ${i+1}`,
      tag: s.kind==='sub'?'JAP/SUB':'LATINO',
      active: pl.srcIdx===i,
      run: ()=>{
        const url=s.url||s.link||s.embed||s.embedUrl||s.src||'';
        pl.srcIdx=i; setPlyFrame(url);
        toast(`Reproduciendo: ${items[i].label}`);
      }
    });
  });
  if(!pl.anime){
    // Unlimplay necesita un ID de TMDB — no lo ofrecemos para anime (AnimeAV1 es la fuente principal ahí)
    items.push({
      label:'Unlimplay', tag:'ALTERNO', active: pl.srcIdx===-1,
      run: ()=>{ pl.srcIdx=-1; loadFrame(); toast('Reproduciendo: Unlimplay'); }
    });
  }
  {
    // Servidores adicionales de Cinetoons (catálogo propio, srv=1/srv=2).
    // Ahora que el anime también usa TMDB id (pl.id), Cinetoons funciona igual para anime.
    const CT_BASE = 'https://panel.cinetoons.xyz/api/embed.php';
    const ctParams = pl.type === 'movie'
      ? `tmdb_id=${pl.id}&type=movie`
      : `tmdb_id=${pl.id}&type=tv&s=${pl.anime?1:pl.s}&e=${pl.ep}`;
    items.push({
      label:'Cinetoons 1', tag:'ALTERNO', active: pl.srcIdx===-2, cls:'ct-srv ct-srv-1',
      run: ()=>{ pl.srcIdx=-2; setPlyFrame(`${CT_BASE}?${ctParams}&srv=1`); toast('Reproduciendo: Cinetoons 1'); }
    });
    items.push({
      label:'Cinetoons 2', tag:'ALTERNO', active: pl.srcIdx===-3, cls:'ct-srv ct-srv-2',
      run: ()=>{ pl.srcIdx=-3; setPlyFrame(`${CT_BASE}?${ctParams}&srv=2`); toast('Reproduciendo: Cinetoons 2'); }
    });
  }
  list.innerHTML = items.length ? items.map((it,i)=>`
    <div class="src-item${it.active?' active':''}${it.cls?' '+it.cls:''}" onclick="runSrc(${i})">
      <div class="src-icon">▶</div>
      <div class="src-label">${esc(it.label)}</div>
      <div class="src-tag">${it.tag}</div>
    </div>`).join('') : '<div class="sd-no-results">No hay otras fuentes disponibles.</div>';
  window.__srcItems = items;
  show('srcmod-ov');
}
function runSrc(i){ window.__srcItems[i].run(); closeSrcModal(); }
function closeSrcModal(e){ if(e && e.target!==$('srcmod-ov')) return; hide('srcmod-ov'); }

// ═══════════════════════════════
//  ESTABILIDAD — si algo se rompe en un lugar que no anticipamos, avisamos
//  con un toast en vez de dejar la app rota en silencio sin explicación.
// ═══════════════════════════════
window.addEventListener('error', (e) => {
  console.error('[ShockTV] Error:', e.error || e.message);
  try{ toast('⚠️ Ocurrió un error — probá recargar la página'); }catch(_){}
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('[ShockTV] Promesa rechazada:', e.reason);
});

// ═══════════════════════════════
//  INIT
// ═══════════════════════════════
window.addEventListener('scroll', () => {
  const btn = $('scroll-top-btn'); if(!btn) return;
  btn.classList.toggle('hidden', window.scrollY < 500);
}, { passive: true });

document.addEventListener('DOMContentLoaded', async () => {
  show('loader-ov');
  loadStore();
  loadCW();
  loadKidsStore();
  startPresence();
  TOKEN = window.__TMDB_TOKEN__ || '';
  ANIME_KEY = window.__ANIME_KEY__ || '';
  if(!TOKEN){
    try{ const r = await fetch(`${API_BASE}/api/token`); if(r.ok){ const d=await r.json(); TOKEN=d.token||''; ANIME_KEY=d.animeKey||ANIME_KEY; } }catch(e){}
  }
  if(!TOKEN){
    $('main-content').innerHTML='<div style="color:var(--red);padding:40px;text-align:center">⚠️ Token TMDB no encontrado — configurá TMDB_TOKEN en las Variables de Railway</div>';
    hide('loader-ov'); return;
  }
  await loadHomeWithRetry();
  setTimeout(()=>hide('loader-ov'), 400);
});
async function loadHomeWithRetry(){
  try{ await loadHome(); }
  catch(e){
    console.error('[loadHome] primer intento falló:', e.message);
    try{ await sleep(1200); await loadHome(); }
    catch(e2){
      console.error('[loadHome] segundo intento falló:', e2.message);
      $('main-content').innerHTML=`<div style="padding:60px 20px;text-align:center">
        <div style="font-size:1.1rem;margin-bottom:10px">⚠️ No se pudo cargar el contenido</div>
        <div style="color:rgba(240,240,248,.6);font-size:.85rem;margin-bottom:16px">Puede ser tu conexión o que TMDB esté lento en este momento.</div>
        <button onclick="location.reload()" style="background:var(--red);color:#fff;border:none;padding:10px 22px;border-radius:7px;font-weight:700;cursor:pointer">Reintentar</button>
      </div>`;
    }
  }
}
