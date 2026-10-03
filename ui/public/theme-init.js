// Тема до первой отрисовки: без белой вспышки при запуске в тёмной теме.
(function () {
  var t = null;
  try {
    t = localStorage.getItem("tls-theme");
  } catch (e) {}
  if (t !== "dark" && t !== "light") t = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  document.documentElement.dataset.theme = t;
})();
