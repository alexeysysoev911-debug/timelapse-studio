/* Timelapse Studio — панель управления. Без inline-кода (строгий CSP), сессия — HttpOnly cookie. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var STATE = null;
  var RM = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- утилиты ---------- */
  function toast(msg, err) {
    var t = $('toast'); t.textContent = msg; t.className = err ? 'err' : ''; t.style.display = 'block';
    retrigger(t, 'x'); clearTimeout(t._t); t._t = setTimeout(function () { t.style.display = 'none'; }, err ? 4500 : 2600);
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function human(b) { var u = ['Б', 'КБ', 'МБ', 'ГБ'], i = 0; b = +b || 0; while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; } return b.toFixed(i ? 1 : 0).replace('.', ',') + ' ' + u[i]; }
  function dt(iso) { if (!iso) return '—'; var d = new Date(iso); return d.toLocaleDateString('ru-RU') + ' ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }); }
  function vkey(v) { return String(v || '0').split('.').map(function (x) { return parseInt(x, 10) || 0; }); }
  function vgt(a, b) { a = vkey(a); b = vkey(b); for (var i = 0; i < 3; i++) { if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0); } return false; }
  function bump(v) { var p = vkey(v || '0.0.0'); while (p.length < 3) p.push(0); p[2]++; return p.slice(0, 3).join('.'); }
  function newest() { var v = null; (STATE ? STATE.releases : []).forEach(function (r) { if (!v || vgt(r.version, v)) v = r.version; }); return v; }
  function retrigger(el, cls) { el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); }
  function flash(el) { if (el) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); setTimeout(function () { el.classList.remove('flash'); }, 900); } }
  function shake(el) { if (el) { el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake'); setTimeout(function () { el.classList.remove('shake'); }, 500); } }
  function countUp(el, to) {
    el.classList.remove('skel');
    if (typeof to !== 'number' || RM) { el.textContent = to; return; }
    var from = parseInt(el.dataset.v || '0', 10) || 0; el.dataset.v = to;
    if (from === to) { el.textContent = to; return; }
    var st = null;
    requestAnimationFrame(function step(t) { if (!st) st = t; var p = Math.min(1, (t - st) / 550); p = 1 - Math.pow(1 - p, 3); el.textContent = Math.round(from + (to - from) * p); if (p < 1) requestAnimationFrame(step); else retrigger(el, 'numpop'); });
  }
  function plural(n, f) { var a = Math.abs(n) % 100, b = a % 10; if (a > 10 && a < 20) return f[2]; if (b === 1) return f[0]; if (b >= 2 && b <= 4) return f[1]; return f[2]; }
  function api(method, path, body) {
    var opt = { method: method, credentials: 'same-origin', headers: { 'X-TLS-CSRF': '1' } };
    if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    return fetch(path, opt).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.status === 401) { showApp(false); throw new Error('Сессия закончилась — войдите снова'); }
        if (!r.ok) throw new Error(j.error || ('Ошибка ' + r.status));
        return j;
      });
    });
  }
  function upload(path, file, ctype, onProgress) {
    return new Promise(function (res, rej) {
      var x = new XMLHttpRequest(); x.open('PUT', path);
      x.setRequestHeader('X-TLS-CSRF', '1'); x.setRequestHeader('Content-Type', ctype || 'application/octet-stream');
      x.upload.onprogress = function (e) { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
      x.onload = function () {
        var j = {}; try { j = JSON.parse(x.responseText); } catch (e) {}
        if (x.status === 401) { showApp(false); return rej(new Error('Сессия закончилась')); }
        if (x.status < 300) res(j); else rej(new Error(j.error || ('Ошибка ' + x.status)));
      };
      x.onerror = function () { rej(new Error('Нет связи с сервером')); };
      x.send(file);
    });
  }

  /* ---------- цифровой дождь в цветах авроры ---------- */
  (function matrix() {
    var c = $('mx'); if (!c || !c.getContext) return; var x = c.getContext('2d');
    var w = 0, h = 0, cols = 0, drops = [], spd = [], fs = 16, chars = 'アイウエオカキクケコサシスセソタチツテト0123456789ABCDEF<>+-*=#', hues = [160, 215, 262];
    function rs() { w = c.width = innerWidth; h = c.height = innerHeight; cols = Math.ceil(w / fs); drops = []; spd = []; var rows = h / fs; for (var i = 0; i < cols; i++) { drops[i] = Math.random() * (rows + 40) - 40; spd[i] = .5 + Math.random() * .8; } }
    rs(); addEventListener('resize', rs);
    function draw() {
      x.fillStyle = 'rgba(5,7,15,.14)'; x.fillRect(0, 0, w, h); x.font = fs + 'px ui-monospace,monospace';
      for (var i = 0; i < cols; i++) {
        var ch = chars[Math.random() * chars.length | 0], hue = hues[i % 3];
        x.fillStyle = (Math.random() > .97) ? 'hsla(' + hue + ',100%,88%,.95)' : 'hsla(' + hue + ',95%,62%,.7)';
        x.fillText(ch, i * fs, drops[i] * fs); if (drops[i] * fs > h && Math.random() > .976) { drops[i] = 0; spd[i] = .5 + Math.random() * .8; } drops[i] += spd[i];
      }
    }
    if (RM) { for (var k = 0; k < 40; k++) draw(); return; }
    var timer = setInterval(draw, 60);
    document.addEventListener('visibilitychange', function () { if (document.hidden) { clearInterval(timer); timer = null; } else if (!timer) { timer = setInterval(draw, 60); } });
  })();

  /* ---------- сервер онлайн ---------- */
  function setSrv(ok, ver) { var s = $('srv'); s.className = ok ? 'pill' : 'pill off'; s.textContent = ''; s.appendChild(document.createElement('i')); s.appendChild(document.createTextNode(ok ? 'server: online · v' + ver : 'server: нет связи')); }
  function ping() { fetch('/health', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) { setSrv(true, j.server); }).catch(function () { setSrv(false); }); }
  ping(); setInterval(ping, 30000);

  /* ---------- вход / выход ---------- */
  function showApp(on) {
    $('login').hidden = on; $('app').hidden = !on; $('logout').hidden = !on; $('refresh').hidden = !on; $('siteLink').hidden = !on;
    if (!on) setTimeout(function () { $('pw').focus(); }, 50);
  }
  $('loginForm').addEventListener('submit', function (e) {
    e.preventDefault(); var b = $('loginBtn'); b.disabled = true;
    fetch('/api/login', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-TLS-CSRF': '1' }, body: JSON.stringify({ password: $('pw').value }) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || 'Ошибка входа'); return j; }); })
      .then(function () { $('pw').value = ''; showApp(true); return load(); })
      .then(function () { setTab(savedTab()); })
      .catch(function (err) { toast(err.message, true); shake($('login')); })
      .finally(function () { b.disabled = false; });
  });
  $('logout').onclick = function () { api('POST', '/api/logout').catch(function () {}).finally(function () { showApp(false); }); };
  $('refresh').onclick = function () { load().then(function () { if (TAB === 'stats') loadStats(); toast('Обновлено'); }); };

  /* ---------- вкладки ---------- */
  var TAB = 'upd';
  function savedTab() { try { return sessionStorage.getItem('tls-tab') || 'upd'; } catch (e) { return 'upd'; } }
  document.querySelectorAll('.tab').forEach(function (t) { t.onclick = function () { setTab(t.dataset.tab); }; });
  function setTab(name) {
    if (!document.querySelector('.tab[data-tab="' + name + '"]')) name = 'upd';
    TAB = name;
    document.querySelectorAll('.tab').forEach(function (t) { var on = t.dataset.tab === name; t.classList.toggle('sel', on); t.setAttribute('aria-selected', on); });
    document.querySelectorAll('section[data-panel]').forEach(function (s) {
      var on = s.dataset.panel === name; s.hidden = !on;
      if (on) { retrigger(s, 'panel-in'); if (!RM) s.querySelectorAll('.card').forEach(function (c, i) { c.style.animationDelay = (i * 55) + 'ms'; retrigger(c, 'cardin'); }); }
    });
    if (name === 'stats') loadStats();
    try { sessionStorage.setItem('tls-tab', name); } catch (e) {}
  }

  /* ---------- данные ---------- */
  function load() { return api('GET', '/api/state').then(function (s) { STATE = s; render(); }).catch(function (e) { toast(e.message, true); }); }
  function curRelease() { return STATE && STATE.releases.filter(function (r) { return r.version === STATE.current; })[0]; }
  var KIND = { normal: 'обычное', major: 'крупное', mandatory: 'обязательное' };

  function render() {
    var s = STATE, cur = curRelease();
    countUp($('kVer'), s.current ? 'v' + s.current : '—'); $('kVerS').textContent = cur ? KIND[cur.kind] + ' · ' + dt(cur.date) + ' · ' + human(cur.size) : 'ещё не выпускалась';
    countUp($('kDl'), s.stats.downloads); $('kDlS').textContent = 'установщиков с сайта';
    countUp($('kRuns'), s.stats.launches); $('kRunsS').textContent = 'устройств: ' + s.stats.devices + ' · сегодня: ' + s.stats.today;
    countUp($('kVis'), s.stats.visitors_today); $('kVisS').textContent = 'уникальных за сегодня';
    $('curV').textContent = s.current ? 'v' + s.current + (cur ? ' (' + KIND[cur.kind] + ')' : '') : 'ничего';
    renderStaging(); renderSlots(); renderHist();
    var base = s.public_url || location.origin;
    $('aBase').textContent = base; $('aLatest').textContent = base + '/updates/latest.json'; $('aDl').textContent = base + '/downloads/latest'; $('dUrl').textContent = base;
  }

  /* ---------- 1. загрузка установщика ---------- */
  function renderStaging() {
    var st = STATE.staging || {}, el = $('stg'), h = '';
    if (st.file) {
      h += '<div class="box">✓ Установщик: <b>' + esc(st.name) + '</b> · ' + human(st.size) + ' · ' + dt(st.uploaded) + '<div class="mono">sha256 ' + esc((st.sha256 || '').slice(0, 16)) + '…</div></div>';
      h += st.signature ? '<div class="box">✓ Подпись .sig загружена — программы проверят, что установщик ваш.</div>' : '<div class="box no">Нет подписи <b>.sig</b> — перетащите её сюда тоже. Без неё обновление не установится.</div>';
      h += '<div class="actions"><button class="rb del" id="clrStg">Очистить</button></div>';
      if (st.version && !$('nv').value) $('nv').value = st.version;
    } else if (st.signature) {
      h = '<div class="box no">Подпись загружена, теперь добавьте сам установщик <b>.exe</b>.</div>';
    } else {
      h = '<div class="statusline">Пока ничего не загружено. У пользователей ничего не меняется до кнопки «Выпустить».</div>';
    }
    el.innerHTML = h;
    var c = $('clrStg'); if (c) c.onclick = function () { api('DELETE', '/api/staging').then(function () { toast('Очищено'); load(); }).catch(function (e) { toast(e.message, true); }); };
  }
  var drop = $('drop'), fileIn = $('file');
  drop.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileIn.click(); } });
  ['dragenter', 'dragover'].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
  ['dragleave', 'drop'].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.remove('over'); }); });
  drop.addEventListener('drop', function (e) { sendFiles(e.dataTransfer.files); });
  fileIn.addEventListener('change', function () { sendFiles(fileIn.files); fileIn.value = ''; });
  function sendFiles(list) {
    var files = [].slice.call(list || []); if (!files.length) return;
    files.sort(function (a, b) { return /\.sig$/i.test(a.name) - /\.sig$/i.test(b.name); }); // сначала .exe, потом его подпись
    var bad = files.filter(function (f) { return !/\.(exe|sig)$/i.test(f.name); });
    if (bad.length) { toast('Нужны файлы .exe и .sig, а не ' + bad[0].name, true); shake(drop); return; }
    var bar = $('bar'), i = bar.firstElementChild, total = files.reduce(function (a, f) { return a + f.size; }, 0) || 1, done = 0;
    bar.style.display = 'block'; i.style.width = '0';
    var chain = Promise.resolve();
    files.forEach(function (f) {
      chain = chain.then(function () {
        var kind = /\.sig$/i.test(f.name) ? 'signature' : 'installer';
        return upload('/api/upload?kind=' + kind + '&name=' + encodeURIComponent(f.name), f, 'application/octet-stream', function (p) { i.style.width = Math.round((done + p * f.size) / total * 100) + '%'; }).then(function () { done += f.size; });
      });
    });
    chain.then(function () { i.style.width = '100%'; toast('Загружено на сервер'); return load(); }).then(function () { flash($('stg')); })
      .catch(function (e) { toast(e.message, true); shake(drop); load(); })
      .finally(function () { setTimeout(function () { bar.style.display = 'none'; }, 700); });
  }

  /* ---------- 2. выпуск ---------- */
  $('bumpBtn').onclick = function () { $('nv').value = bump(newest() || '3.0.0'); };
  var KHINT = {
    normal: 'Пользователь увидит предложение обновиться и сам решит когда.',
    major: 'Как обычное, но с пометкой «Крупное обновление» — расскажите в «Что нового», что изменилось.',
    mandatory: 'Программа не даст работать, пока пользователь не обновится. Только для критических исправлений!'
  };
  document.querySelectorAll('input[name=kind]').forEach(function (r) { r.onchange = function () { $('kindHint').textContent = KHINT[r.value]; }; });
  $('relBtn').onclick = function () {
    var v = $('nv').value.trim(), kind = document.querySelector('input[name=kind]:checked').value, st = STATE.staging || {}, top = newest();
    if (!st.file) { toast('Сначала загрузите установщик', true); shake($('drop')); return; }
    if (!st.signature) { toast('Добавьте файл подписи .sig', true); shake($('drop')); return; }
    if (!/^\d+\.\d+\.\d+$/.test(v)) { toast('Версия вида 3.0.1', true); shake($('nv')); return; }
    if (top && !vgt(v, top)) { toast('Версия должна быть больше ' + top, true); shake($('nv')); return; }
    if (st.version && st.version !== v && !confirm('Имя файла говорит о версии ' + st.version + ', а вы выпускаете ' + v + '.\nВерсия внутри программы должна совпадать, иначе обновление будет предлагаться по кругу. Продолжить?')) return;
    if (kind === 'mandatory' && !confirm('Обязательное обновление: программа у всех пользователей будет заблокирована до обновления. Выпустить?')) return;
    var b = $('relBtn'); b.disabled = true;
    api('POST', '/api/release', { version: v, kind: kind, notes: $('notes').value }).then(function () {
      toast('Версия ' + v + ' выпущена'); $('nv').value = ''; $('notes').value = ''; return load();
    }).then(function () { flash($('kVer').parentNode); })
      .catch(function (e) { toast(e.message, true); }).finally(function () { b.disabled = false; });
  };

  /* ---------- реклама: 2 блока в программе + 2 на сайте ---------- */
  var WHERE = {
    app1: 'Программа: левая панель под списком музыки — виден всегда',
    app2: 'Программа: окно «Ролики готовы» — после каждой сборки',
    site1: 'Сайт: после блока «Возможности»',
    site2: 'Сайт: перед блоком «Скачать»'
  };
  var SLOTS = [['app', '1'], ['app', '2'], ['site', '1'], ['site', '2']];
  function sid(place, k) { return 'slot-' + place + k; }
  function slotHtml(place, k) {
    return '' +
      '<div class="card" id="' + sid(place, k) + '">' +
      '<h2>Блок ' + k + '<span class="spacer"></span><label class="sw"><input type="checkbox" data-f="enabled"><i></i><span>Вкл</span></label></h2>' +
      '<div class="slotwhere"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M9 9v11"/></svg>' + WHERE[place + k] + '</div>' +
      '<label class="f">Заголовок <span class="counter" data-c="title"></span></label><input type="text" data-f="title" maxlength="90" placeholder="Например: Пластик для 3D-печати −15%">' +
      '<label class="f">Текст <span class="counter" data-c="text"></span></label><textarea data-f="text" maxlength="240" placeholder="Коротко: что предлагаете и почему стоит нажать"></textarea>' +
      '<label class="f">Куда ведёт клик <small>https://…</small></label><input type="url" data-f="url" maxlength="500" placeholder="https://">' +
      '<label class="f">Картинка <small>PNG / JPG / WEBP до 5 МБ</small></label>' +
      '<div class="imgrow"><div class="thumb" data-thumb>нет</div><label class="rb" tabindex="0">Загрузить картинку<input type="file" accept="image/png,image/jpeg,image/webp" hidden data-img></label><button class="rb del" data-noimg type="button">Убрать</button></div>' +
      '<div class="prevlabel">' + (place === 'app' ? 'Так блок выглядит в программе' : 'Так блок выглядит на сайте') + '</div>' +
      '<div class="' + (place === 'app' ? 'appwin' : 'siteprev') + '"><div data-prev></div></div>' +
      '<div class="actions"><button class="btn" data-save>Сохранить блок ' + k + '</button><span class="statusline" data-saved></span></div>' +
      '</div>';
  }
  function slotEl(place, k) { return $(sid(place, k)); }
  function field(place, k, f) { return slotEl(place, k).querySelector('[data-f=' + f + ']'); }
  function renderSlots() {
    var app = $('slots-app'), site = $('slots-site');
    if (!app.dataset.ready) {
      app.innerHTML = slotHtml('app', '1') + slotHtml('app', '2');
      site.innerHTML = slotHtml('site', '1') + slotHtml('site', '2');
      app.dataset.ready = '1';
      SLOTS.forEach(function (ps) {
        var place = ps[0], k = ps[1], c = slotEl(place, k);
        c.querySelectorAll('[data-f]').forEach(function (inp) {
          inp.addEventListener('input', function () { preview(place, k); dirty(place, k, true); });
          inp.addEventListener('change', function () { preview(place, k); dirty(place, k, true); });
        });
        c.querySelector('[data-save]').onclick = function () { saveSlot(place, k); };
        c.querySelector('[data-img]').onchange = function (e) { var f = e.target.files[0]; e.target.value = ''; if (f) uploadImg(place, k, f); };
        c.querySelector('label.rb').addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); c.querySelector('[data-img]').click(); } });
        c.querySelector('[data-noimg]').onclick = function () {
          api('DELETE', '/api/ad-image?place=' + place + '&slot=' + k).then(function () {
            toast('Картинка убрана'); var a = STATE.ads[place][k]; a.img = ''; a.img_url = ''; fillSlot(place, k, true);
          }).catch(function (e) { toast(e.message, true); });
        };
      });
    }
    SLOTS.forEach(function (ps) { fillSlot(ps[0], ps[1]); });
  }
  function fillSlot(place, k, keepText) {
    var a = STATE.ads[place][k], c = slotEl(place, k);
    if (!keepText && !c.dataset.dirty) {
      field(place, k, 'enabled').checked = !!a.enabled; field(place, k, 'title').value = a.title || '';
      field(place, k, 'text').value = a.text || ''; field(place, k, 'url').value = a.url || '';
    }
    var th = c.querySelector('[data-thumb]');
    if (a.img_url) { th.style.backgroundImage = 'url("' + encodeURI(a.img_url) + '")'; th.textContent = ''; } else { th.style.backgroundImage = ''; th.textContent = 'нет'; }
    c.querySelector('[data-noimg]').disabled = !a.img_url;
    preview(place, k);
  }
  function dirty(place, k, on) {
    var c = slotEl(place, k);
    if (on) { c.dataset.dirty = '1'; c.querySelector('[data-saved]').textContent = 'есть несохранённые изменения'; }
    else { delete c.dataset.dirty; c.querySelector('[data-saved]').textContent = ''; }
  }
  function preview(place, k) {
    var c = slotEl(place, k), t = field(place, k, 'title').value.trim(), x = field(place, k, 'text').value.trim(), img = STATE.ads[place][k].img_url, on = field(place, k, 'enabled').checked;
    c.querySelector('[data-c=title]').textContent = field(place, k, 'title').value.length + '/90';
    c.querySelector('[data-c=text]').textContent = field(place, k, 'text').value.length + '/240';
    var cls = place === 'app' ? 'promo' : 'spromo', p = c.querySelector('[data-prev]'), h;
    if (!on) h = '<div class="' + cls + ' empty">Блок выключен — его не будет видно</div>';
    else if (!t && !x && !img) h = '<div class="' + cls + ' empty">Пустой блок не показывается</div>';
    else if (!t && !x) h = '<div class="' + cls + ' imgonly"><img src="' + esc(img) + '" alt=""><span class="tag">Реклама</span></div>';
    else h = '<div class="' + cls + '">' + (img ? '<img src="' + esc(img) + '" alt="">' : '') + '<div class="tx">' + (t ? '<div class="pt">' + esc(t) + '</div>' : '') + (x ? '<div class="px">' + esc(x) + '</div>' : '') + '</div><span class="tag">Реклама</span></div>';
    p.innerHTML = h;
  }
  function saveSlot(place, k) {
    var body = { place: place, slot: k, enabled: field(place, k, 'enabled').checked, title: field(place, k, 'title').value, text: field(place, k, 'text').value, url: field(place, k, 'url').value.trim() };
    if (body.url && !/^https:\/\/\S+$/.test(body.url)) { toast('Ссылка должна начинаться с https:// и быть без пробелов', true); shake(field(place, k, 'url')); return; }
    if (body.enabled && !body.url && !confirm('У блока нет ссылки — по нему нельзя будет перейти. Сохранить так?')) return;
    var b = slotEl(place, k).querySelector('[data-save]'); b.disabled = true;
    api('POST', '/api/ad', body).then(function (r) {
      var img = STATE.ads[place][k].img_url; STATE.ads[place][k] = r.ad; STATE.ads[place][k].img_url = img;
      dirty(place, k, false); toast('Блок ' + k + ' сохранён'); flash(slotEl(place, k)); fillSlot(place, k);
    }).catch(function (e) { toast(e.message, true); }).finally(function () { b.disabled = false; });
  }
  function uploadImg(place, k, f) {
    if (!/^image\/(png|jpeg|webp)$/.test(f.type)) { toast('Картинка PNG, JPG или WEBP', true); return; }
    if (f.size > 5 * 1024 * 1024) { toast('Картинка больше 5 МБ', true); return; }
    upload('/api/ad-image?place=' + place + '&slot=' + k, f, f.type).then(function (r) {
      var a = STATE.ads[place][k]; a.img = r.img; a.img_url = r.img_url; fillSlot(place, k, true); toast('Картинка загружена');
    }).catch(function (e) { toast(e.message, true); });
  }

  /* ---------- статистика ---------- */
  document.querySelectorAll('input[name=days]').forEach(function (r) { r.onchange = loadStats; });
  function shortDay(s) { return new Date(s + 'T12:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }); }
  function bars(el, days, pick) {
    var max = Math.max.apply(null, days.map(function (x) { return pick(x).total; }).concat([1]));
    el.textContent = '';
    days.forEach(function (x) {
      var v = pick(x), c = document.createElement('div'); c.className = 'c';
      var tt = document.createElement('span'); tt.className = 'tt'; tt.textContent = shortDay(x.day) + ': ' + v.tip; c.appendChild(tt);
      var main = document.createElement('b'); if (v.cls) main.className = v.cls;
      main.style.height = Math.max(Math.round((v.total - (v.extra || 0)) / max * 100), v.total ? 2 : 0) + '%';
      c.appendChild(main);
      if (v.extra) { var e = document.createElement('b'); e.className = 'nw'; e.style.height = Math.round(v.extra / max * 100) + '%'; c.appendChild(e); }
      el.appendChild(c);
    });
    var axis = el.nextElementSibling;
    axis.querySelector('.ax0').textContent = shortDay(days[0].day);
    axis.querySelector('.ax1').textContent = 'сегодня, ' + shortDay(days[days.length - 1].day);
  }
  function chips(el, items, empty) {
    el.textContent = '';
    if (!items.length) { var s = document.createElement('span'); s.textContent = empty; el.appendChild(s); return; }
    items.forEach(function (it) { var s = document.createElement('span'), b = document.createElement('b'); b.textContent = it[0]; s.appendChild(b); s.appendChild(document.createTextNode(it[1])); el.appendChild(s); });
  }
  function loadStats() {
    var d = (document.querySelector('input[name=days]:checked') || {}).value || 30;
    api('GET', '/api/stats?days=' + d).then(function (s) {
      countUp($('sAll'), s.launches); countUp($('sDev'), s.devices); countUp($('sNew'), s.new); countUp($('sVis'), s.visitors_period);
      bars($('chart'), s.days, function (x) { return { total: x.devices, extra: x.new, tip: x.devices + ' ' + plural(x.devices, ['устройство', 'устройства', 'устройств']) + ', запусков ' + x.launches + (x.new ? ', новых ' + x.new : '') }; });
      bars($('chart2'), s.days, function (x) { return { total: x.visitors, cls: 'vis', tip: x.visitors + ' ' + plural(x.visitors, ['посетитель', 'посетителя', 'посетителей']) }; });
      chips($('vers'), s.versions.map(function (v) { return ['v' + v.version, ' ' + v.devices + ' ' + plural(v.devices, ['устройство', 'устройства', 'устройств'])]; }), 'Пока нет данных — запусков ещё не было');
      chips($('dls'), s.downloads_by_version.map(function (v) { return ['v' + v[0], ' ' + v[1] + ' ' + plural(v[1], ['скачивание', 'скачивания', 'скачиваний'])]; }), 'Скачиваний пока нет');
    }).catch(function (e) { toast(e.message, true); });
  }

  /* ---------- история ---------- */
  function renderHist() {
    var el = $('hist'), items = STATE.releases;
    if (!items.length) { el.innerHTML = '<div class="statusline">Выпусков ещё не было. Загрузите установщик на вкладке «Обновление».</div>'; return; }
    el.innerHTML = items.map(function (r) {
      var cur = r.version === STATE.current;
      var kb = r.kind === 'mandatory' ? '<span class="badge err">обязательное</span>' : r.kind === 'major' ? '<span class="badge warn">крупное</span>' : '';
      return '<div class="hrow"><span class="v">v' + esc(r.version) + '</span>' + (cur ? '<span class="badge ok">текущая</span>' : '<span class="badge">в архиве</span>') + kb +
        '<span class="meta">' + dt(r.date) + ' · ' + human(r.size) + (r.notes ? '\n' + esc(r.notes) : '') + '</span>' +
        '<a class="rb" href="/downloads/' + encodeURIComponent(r.version) + '/' + encodeURIComponent(r.file) + '">Скачать</a>' +
        '<button class="rb" data-rb="' + esc(r.version) + '"' + (cur ? ' disabled' : '') + '>Откат на эту</button>' +
        '<button class="rb del" data-del="' + esc(r.version) + '"' + (cur ? ' disabled title="Текущую удалить нельзя"' : '') + '>Удалить</button></div>';
    }).join('');
    el.querySelectorAll('[data-rb]').forEach(function (b) {
      b.onclick = function () {
        var v = b.dataset.rb; if (!confirm('Сделать v' + v + ' текущей версией для сайта и новых установок?')) return;
        api('POST', '/api/rollback', { version: v }).then(function () { toast('Текущая версия: ' + v); load(); }).catch(function (e) { toast(e.message, true); });
      };
    });
    el.querySelectorAll('[data-del]').forEach(function (b) {
      b.onclick = function () {
        var v = b.dataset.del; if (!confirm('Удалить v' + v + ' с сервера вместе с установщиком?')) return;
        api('DELETE', '/api/release?version=' + encodeURIComponent(v)).then(function () { toast('Удалено'); load(); }).catch(function (e) { toast(e.message, true); });
      };
    });
  }

  /* ---------- настройки ---------- */
  function copy(text, ok) { navigator.clipboard.writeText(text).then(function () { toast(ok); }).catch(function () { toast('Не удалось скопировать — выделите текст вручную', true); }); }
  $('copyDl').onclick = function () { copy($('aDl').textContent, 'Ссылка скопирована'); };
  $('copyKey').onclick = function () { copy($('dKey').textContent, 'Ключ скопирован — вставьте его в GitHub'); };
  $('newKey').onclick = function () {
    if (!confirm('Создать новый ключ? Старый в GitHub перестанет работать — его нужно будет заменить.')) return;
    api('POST', '/api/deploy-key').then(function (r) { $('dKey').textContent = r.deploy_key; $('copyKey').hidden = false; toast('Новый ключ создан — скопируйте его в GitHub'); }).catch(function (e) { toast(e.message, true); });
  };
  $('pwForm').addEventListener('submit', function (e) {
    e.preventDefault();
    api('POST', '/api/password', { old: $('pwOld').value, new: $('pwNew').value })
      .then(function () { toast('Пароль изменён — войдите снова'); $('pwOld').value = ''; $('pwNew').value = ''; showApp(false); })
      .catch(function (err) { toast(err.message, true); shake($('pwForm')); });
  });

  /* ---------- старт ---------- */
  addEventListener('beforeunload', function (e) { if (document.querySelector('[data-dirty]')) { e.preventDefault(); e.returnValue = ''; } });
  fetch('/api/session', { credentials: 'same-origin', cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) {
    if (j.authed) { showApp(true); return load().then(function () { setTab(savedTab()); }); }
    showApp(false);
  }).catch(function () { showApp(false); });
})();
