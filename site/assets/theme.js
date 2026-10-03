/* Тема до первой отрисовки страницы — без вспышки. Подключается в <head> синхронно. */
(function () {
  var t = null;
  try { t = localStorage.getItem('tls-site-theme'); } catch (e) {}
  if (t !== 'light' && t !== 'dark') {
    t = window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  document.documentElement.dataset.theme = t;
  document.documentElement.classList.add('js'); // анимации появления — только когда скрипты работают
})();
