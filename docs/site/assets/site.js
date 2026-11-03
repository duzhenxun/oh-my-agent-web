
  // 语言：页面默认英文；浏览器首选中文且用户没手动选过 → 去中文页
  (function () {
    var PREF_KEY = "omaw.lang";
    var pref = null;
    try { pref = localStorage.getItem(PREF_KEY); } catch (error) { pref = null; }
    var isZhPage = /(^|\/)zh\.html$/.test(location.pathname);
    if (pref === null) {
      var langs = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || ""];
      var chinese = langs.some(function (item) { return /^zh/i.test(String(item)); });
      if (chinese && !isZhPage) { location.replace("zh.html"); return; }
      if (!chinese && isZhPage) { location.replace("index.html"); return; }
    } else if ((pref === "zh") !== isZhPage) {
      location.replace(pref === "zh" ? "zh.html" : "index.html");
      return;
    }
    document.querySelectorAll("[data-lang]").forEach(function (link) {
      link.addEventListener("click", function () {
        try { localStorage.setItem(PREF_KEY, link.getAttribute("data-lang")); } catch (error) {}
      });
    });
  })();

document.documentElement.classList.add("reveal-ready");
(function () {
  // 复制
  document.querySelectorAll("[data-copy]").forEach(function (btn) {
    btn.addEventListener("click", async function () {
      var text = btn.getAttribute("data-copy") || "";
      try {
        await navigator.clipboard.writeText(text);
      } catch (error) {
        var area = document.createElement("textarea");
        area.value = text;
        document.body.appendChild(area);
        area.select();
        document.execCommand("copy");
        area.remove();
      }
      var old = btn.textContent;
      btn.textContent = "✓";
      setTimeout(function () { btn.textContent = old; }, 1200);
    });
  });

  // 移动端导航
  var toggle = document.querySelector(".nav-toggle");
  var links = document.getElementById("navlinks");
  if (toggle && links) {
    toggle.addEventListener("click", function () {
      var open = links.classList.toggle("open");
      toggle.setAttribute("aria-expanded", String(open));
    });
    links.addEventListener("click", function (event) {
      if (event.target.tagName === "A") links.classList.remove("open");
    });
  }

  // 巡览切换
  var tabs = Array.prototype.slice.call(document.querySelectorAll(".tour-tab"));
  var tourImg = document.getElementById("tourImg");
  var tourCap = document.getElementById("tourCap");
  tabs.forEach(function (tab) {
    tab.addEventListener("click", function () {
      tabs.forEach(function (other) { other.setAttribute("aria-selected", "false"); });
      tab.setAttribute("aria-selected", "true");
      var src = tab.getAttribute("data-src");
      tourImg.src = src;
      tourImg.alt = tab.getAttribute("data-alt") || "";
      tourCap.textContent = tab.getAttribute("data-cap") || "";
    });
  });

  // 大图
  var lightbox = document.getElementById("lightbox");
  var lightboxImg = document.getElementById("lightboxImg");
  document.querySelectorAll("[data-zoom]").forEach(function (img) {
    img.style.cursor = "zoom-in";
    img.addEventListener("click", function () {
      lightboxImg.src = img.currentSrc || img.src;
      lightboxImg.alt = img.alt;
      lightbox.setAttribute("open", "");
    });
  });
  function closeLightbox() { lightbox.removeAttribute("open"); lightboxImg.src = ""; }
  document.getElementById("lightboxClose").addEventListener("click", closeLightbox);
  lightbox.addEventListener("click", function (event) { if (event.target === lightbox) closeLightbox(); });
  document.addEventListener("keydown", function (event) { if (event.key === "Escape") closeLightbox(); });

  // 滚动出现
  if ("IntersectionObserver" in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) { entry.target.classList.add("in"); io.unobserve(entry.target); }
      });
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.06 });
    document.querySelectorAll(".reveal").forEach(function (el) { io.observe(el); });
  } else {
    document.querySelectorAll(".reveal").forEach(function (el) { el.classList.add("in"); });
  }
})();
