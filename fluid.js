/* ============================================================
   ShockTV — capa de fluidez
   Revelado al scroll · navbar que se condensa · píldora del
   menú inferior · arrastre con inercia en los carruseles
   ============================================================ */
(function () {
  'use strict';

  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ── 1. Revelado suave de cada fila al entrar en pantalla ── */
  function setupReveal() {
    if (reduce || !('IntersectionObserver' in window)) return;
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.06 });

    function observe() {
      document.querySelectorAll('.row:not(.reveal), .pg-title:not(.reveal), .grid:not(.reveal)').forEach(function (el) {
        if (el.offsetParent === null) return;
        el.classList.add('reveal');
        io.observe(el);
      });
    }
    observe();
    // Las secciones se muestran/ocultan dinámicamente: revisamos al cambiar de vista
    document.addEventListener('click', function () { setTimeout(observe, 60); }, true);
  }

  /* ── 2. Navbar: se condensa al bajar ─────────────────────── */
  function setupNav() {
    var nav = document.getElementById('navbar');
    if (!nav) return;
    var last = 0, ticking = false;
    function update() {
      var y = window.scrollY || 0;
      nav.classList.toggle('scrolled', y > 40);
      last = y; ticking = false;
    }
    window.addEventListener('scroll', function () {
      if (!ticking) { ticking = true; requestAnimationFrame(update); }
    }, { passive: true });
    update();
  }

  /* ── 3. Menú inferior: píldora que se desliza al activo ──── */
  function setupBottomNav() {
    var nav = document.getElementById('bottom-nav');
    if (!nav) return;

    var pill = document.createElement('div');
    pill.className = 'bn-pill';
    nav.insertBefore(pill, nav.firstChild);

    function movePill(animate) {
      var active = nav.querySelector('.bn-btn.active');
      if (!active) { pill.style.opacity = '0'; return; }
      if (!animate) pill.style.transition = 'none';
      pill.style.opacity = '1';
      pill.style.width = active.offsetWidth + 'px';
      pill.style.transform = 'translateX(' + active.offsetLeft + 'px)';
      if (!animate) requestAnimationFrame(function () { pill.style.transition = ''; });
    }

    // Posición inicial (sin animar) una vez que las fuentes cargaron
    requestAnimationFrame(function () { movePill(false); });
    setTimeout(function () { movePill(false); }, 400);

    // La clase .active la cambia app.js: observamos el menú
    new MutationObserver(function () { movePill(true); })
      .observe(nav, { subtree: true, attributes: true, attributeFilter: ['class'] });

    window.addEventListener('resize', function () { movePill(false); }, { passive: true });

    // Se esconde al bajar, vuelve al subir
    var lastY = window.scrollY, acc = 0;
    window.addEventListener('scroll', function () {
      var y = window.scrollY, d = y - lastY;
      lastY = y;
      if (Math.abs(d) < 4) return;
      acc = d > 0 ? Math.min(acc + d, 90) : Math.max(acc + d, 0);
      nav.classList.toggle('tucked', acc > 60 && y > 260);
    }, { passive: true });
  }

  /* ── 4. Carruseles: arrastre con inercia ─────────────────── */
  function setupDrag() {
    document.querySelectorAll('.sl, .mod-rec-row, .mod-cast-row').forEach(function (el) {
      if (el.dataset.dragReady) return;
      el.dataset.dragReady = '1';

      var down = false, moved = false, startX = 0, startScroll = 0;
      var vel = 0, lastX = 0, lastT = 0, raf = null;

      el.addEventListener('pointerdown', function (e) {
        if (e.pointerType === 'touch') return;      // el táctil ya se desliza nativo
        down = true; moved = false;
        startX = e.clientX; startScroll = el.scrollLeft;
        lastX = e.clientX; lastT = performance.now(); vel = 0;
        cancelAnimationFrame(raf);
      });

      el.addEventListener('pointermove', function (e) {
        if (!down) return;
        var dx = e.clientX - startX;
        if (!moved && Math.abs(dx) > 4) { moved = true; el.classList.add('dragging'); el.setPointerCapture(e.pointerId); }
        if (!moved) return;
        el.scrollLeft = startScroll - dx;
        var now = performance.now(), dt = now - lastT;
        if (dt > 0) vel = (e.clientX - lastX) / dt;
        lastX = e.clientX; lastT = now;
        e.preventDefault();
      });

      function release() {
        if (!down) return;
        down = false;
        if (!moved) return;
        el.classList.remove('dragging');
        // Inercia
        var v = vel * 16;
        (function glide() {
          if (Math.abs(v) < 0.4) return;
          el.scrollLeft -= v;
          v *= 0.94;
          raf = requestAnimationFrame(glide);
        })();
      }
      el.addEventListener('pointerup', release);
      el.addEventListener('pointercancel', release);
      el.addEventListener('pointerleave', release);
      // Evita que el arrastre abra la ficha
      el.addEventListener('click', function (e) {
        if (moved) { e.stopPropagation(); e.preventDefault(); moved = false; }
      }, true);
    });
  }

  function init() {
    setupNav();
    setupBottomNav();
    setupReveal();
    setupDrag();
    // Los carruseles se llenan de forma asíncrona
    setTimeout(setupDrag, 1200);
    setTimeout(setupDrag, 3000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
