/* Timelapse Studio — сайт: тема, фон, появление блоков, версия и реклама с сервера, демо-ролик. */
(function () {
  'use strict';
  var RM = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var d = document.documentElement;
  function $(id) { return document.getElementById(id); }

  /* ---- переключатель темы ---- */
  (function theme() {
    var b = $('tgl'), mt = $('mtheme');
    function sync() { if (mt) mt.setAttribute('content', d.dataset.theme === 'light' ? '#F3F2FF' : '#05070F'); }
    sync();
    if (!b) return;
    b.addEventListener('click', function () {
      var t = d.dataset.theme === 'light' ? 'dark' : 'light';
      d.classList.add('th-anim');
      d.dataset.theme = t;
      try { localStorage.setItem('tls-site-theme', t); } catch (e) {}
      sync();
      setTimeout(function () { d.classList.remove('th-anim'); }, 520);
      document.dispatchEvent(new Event('tls-theme'));
    });
  })();

  /* ---- цифровой дождь в цветах авроры ---- */
  (function matrix() {
    var c = $('mx');
    if (!c || !c.getContext) return;
    var x = c.getContext('2d'), w = 0, h = 0, cols = 0, drops = [], spd = [], fs = 16;
    var chars = 'アイウエオカキクケコサシスセソタチツテト0123456789ABCDEF<>+-*=#';
    var hues = [160, 215, 262];
    function pal() {
      return d.dataset.theme === 'light'
        ? { trail: 'rgba(243,242,255,.2)', dim: function (u) { return 'hsla(' + u + ',80%,36%,.5)'; }, hot: function (u) { return 'hsla(' + u + ',85%,28%,.85)'; } }
        : { trail: 'rgba(5,7,15,.14)', dim: function (u) { return 'hsla(' + u + ',95%,62%,.7)'; }, hot: function (u) { return 'hsla(' + u + ',100%,88%,.95)'; } };
    }
    var P = pal();
    var still = RM || matchMedia('(max-width: 900px)').matches;
    function paintStill() { x.clearRect(0, 0, w, h); for (var k = 0; k < 40; k++) draw(); }
    document.addEventListener('tls-theme', function () { P = pal(); x.clearRect(0, 0, w, h); if (still) paintStill(); });
    function rs() {
      w = c.width = innerWidth; h = c.height = innerHeight; cols = Math.ceil(w / fs); drops = []; spd = [];
      var rows = h / fs;
      for (var i = 0; i < cols; i++) { drops[i] = Math.random() * (rows + 40) - 40; spd[i] = .5 + Math.random() * .8; }
    }
    rs();
    var rt;
    addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(function () { rs(); if (still) paintStill(); }, 150); });
    function draw() {
      x.fillStyle = P.trail; x.fillRect(0, 0, w, h); x.font = fs + 'px ui-monospace,monospace';
      for (var i = 0; i < cols; i++) {
        var ch = chars[Math.random() * chars.length | 0], hue = hues[i % 3];
        x.fillStyle = (Math.random() > .97) ? P.hot(hue) : P.dim(hue);
        x.fillText(ch, i * fs, drops[i] * fs);
        if (drops[i] * fs > h && Math.random() > .976) { drops[i] = 0; spd[i] = .5 + Math.random() * .8; }
        drops[i] += spd[i];
      }
    }
    // на телефонах и при «меньше движения» — неподвижный узор: экономим батарею
    if (still) { paintStill(); return; }
    var timer = setInterval(draw, 60);
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { clearInterval(timer); timer = null; }
      else if (!timer) { timer = setInterval(draw, 60); }
    });
  })();

  /* ---- появление блоков при прокрутке ---- */
  (function reveal() {
    var els = document.querySelectorAll('.rv');
    if (RM || !('IntersectionObserver' in window)) { els.forEach(function (e) { e.classList.add('in'); }); return; }
    var io = new IntersectionObserver(function (en) {
      en.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
    }, { threshold: .12 });
    els.forEach(function (e) { io.observe(e); });
  })();

  /* ---- демо-ролик: играет только когда виден, звук по кнопке ---- */
  (function demo() {
    var v = $('demo'), s = $('sound');
    if (!v) return;
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (en) {
        en.forEach(function (e) {
          if (e.isIntersecting) { if (v.preload === 'none') v.preload = 'auto'; if (!RM) v.play().catch(function () {}); }
          else v.pause();
        });
      }, { threshold: .35 }).observe(v);
    }
    v.addEventListener('click', function () { if (v.paused) v.play().catch(function () {}); else v.pause(); });
    if (s) s.addEventListener('click', function () {
      v.muted = !v.muted;
      s.setAttribute('aria-pressed', String(!v.muted));
      s.setAttribute('aria-label', v.muted ? 'Включить звук' : 'Выключить звук');
      if (v.paused) v.play().catch(function () {});
    });
  })();

  /* ---- данные с сервера: версия, размер, реклама ---- */
  function safeUrl(u) {
    try { var p = new URL(u, location.href); return (p.protocol === 'https:' || p.origin === location.origin) ? p.href : null; } catch (e) { return null; }
  }
  function renderAd(box, a) {
    var hasImg = !!a.img, hasT = !!(a.title && String(a.title).trim()), hasX = !!(a.text && String(a.text).trim());
    if (!hasImg && !hasT && !hasX) return;
    var href = a.url ? safeUrl(a.url) : null;
    var link = document.createElement(href ? 'a' : 'div');
    if (href) { link.href = href; link.target = '_blank'; link.rel = 'sponsored noopener noreferrer'; }
    var img = hasImg ? safeUrl(a.img) : null;
    if (hasT || hasX) {
      link.className = 'pcard';
      if (img) {
        var im = document.createElement('img');
        im.className = 'pimg'; im.src = img; im.alt = a.alt || a.title || 'Реклама'; im.loading = 'lazy'; im.decoding = 'async';
        link.appendChild(im);
      }
      var tx = document.createElement('div'); tx.className = 'ptx';
      if (hasT) { var t = document.createElement('div'); t.className = 'ptitle'; t.textContent = a.title; tx.appendChild(t); }
      if (hasX) { var dd = document.createElement('div'); dd.className = 'ptext'; dd.textContent = a.text; tx.appendChild(dd); }
      link.appendChild(tx);
    } else if (img) {
      var im2 = document.createElement('img');
      im2.src = img; im2.alt = a.alt || 'Реклама'; im2.loading = 'lazy'; im2.decoding = 'async';
      link.appendChild(im2);
    } else return;
    box.textContent = '';
    box.appendChild(link);
    var tag = document.createElement('span');
    tag.className = 'ptag'; tag.textContent = 'Реклама';
    box.appendChild(tag);
    box.hidden = false;
  }
  function setText(id, v) { var e = $(id); if (e) e.textContent = v; }
  (function site() {
    if (!window.fetch) return;
    fetch('/api/site', { cache: 'no-store', credentials: 'omit' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j) return;
        if (j.version) {
          setText('vTop', j.version); setText('vDl', j.version);
          if (j.file) setText('dlName', j.file);
          if (j.mb) { setText('vSize', '~' + j.mb + ' МБ'); setText('kSize', '~' + j.mb + ' МБ'); }
          if (j.date) {
            var dt = new Date(j.date);
            if (!isNaN(dt)) setText('vDate', 'от ' + dt.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }));
          }
        } else {
          // версии ещё нет — кнопки не ведут в никуда
          document.querySelectorAll('.dl-link').forEach(function (a) { a.classList.add('off'); a.setAttribute('aria-disabled', 'true'); a.removeAttribute('href'); });
          var s = $('soon'); if (s) s.hidden = false;
        }
        var ads = j.ads || {};
        ['1', '2'].forEach(function (n) {
          var box = document.querySelector('.promo[data-slot="' + n + '"]');
          if (box && ads[n]) renderAd(box, ads[n]);
        });
      })
      .catch(function () {});
  })();

  /* ---- лёгкий наклон скриншота за мышью ---- */
  (function tilt() {
    var f = $('tilt');
    if (!f || RM || !matchMedia('(hover: hover)').matches || matchMedia('(max-width: 900px)').matches) return;
    var box = f.parentElement, raf = 0;
    box.addEventListener('mousemove', function (e) {
      if (raf) return;
      raf = requestAnimationFrame(function () {
        raf = 0;
        var r = box.getBoundingClientRect();
        var px = (e.clientX - r.left) / r.width - .5, py = (e.clientY - r.top) / r.height - .5;
        f.style.transform = 'rotateY(' + (-7 + px * 6) + 'deg) rotateX(' + (3 - py * 6) + 'deg)';
      });
    });
    box.addEventListener('mouseleave', function () { f.style.transform = ''; });
  })();
})();
