"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const ui = {
    image: $("page-image"), stage: $("page-stage"), wrap: $("page-wrap"), reader: $("reader"),
    message: $("reader-message"), messageText: $("reader-message-text"), retry: $("retry-button"),
    imageLoading: $("image-loading"), status: $("reader-status"), title: $("current-title"),
    kind: $("page-kind"), track: $("current-track"), previous: $("previous-page"), next: $("next-page"),
    input: $("page-input"), total: $("page-total"), zoomIn: $("zoom-in"), zoomOut: $("zoom-out"),
    zoomReset: $("zoom-reset"), fullscreen: $("fullscreen-button"), search: $("character-search"),
    navigation: $("navigation-list"), navigationLabel: $("navigation-label"), navigationCount: $("navigation-count"),
    searchFeedback: $("search-feedback"), sidebar: $("sidebar"), backdrop: $("drawer-backdrop"),
    contentsToggle: $("contents-toggle"), drawerClose: $("drawer-close"), downloads: $("download-links")
  };
  const state = { book: null, slides: [], characters: [], chapters: [], page: 1, zoom: 1, track: "all", token: 0, drawerOpen: false, prefetched: new Set() };
  const smallScreen = window.matchMedia("(max-width: 900px)");
  const zoomSteps = [1, 1.25, 1.5, 2, 2.5];
  let searchTimer;
  let touchStart;
  let returnFocus;
  let pendingFrame;

  function text(value, fallback = "") {
    return typeof value === "string" || typeof value === "number" ? String(value) : fallback;
  }
  function safeURL(value) {
    if (typeof value !== "string" || !value.trim()) return null;
    try {
      const url = new URL(value, document.baseURI);
      return ["http:", "https:"].includes(url.protocol) ? url.href : null;
    } catch { return null; }
  }
  function normalize(value) {
    return text(value).normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/\s+/g, " ").trim();
  }
  function storageKey() {
    return `genshin-handbook:page:${text(state.book?.cutoff, "2026-07-26")}:${text(state.book?.edition, "revised")}`;
  }
  function savePage() {
    try { localStorage.setItem(storageKey(), String(state.page)); } catch { /* Reading works without local storage. */ }
  }
  function readSavedPage() {
    try { return Number(localStorage.getItem(storageKey())); } catch { return 1; }
  }
  function slideForPage(page) {
    return state.slides.find((slide) => slide.page === page);
  }
  function characterForSlide(slide) {
    return state.characters.find((character) => character.id === slide?.characterId);
  }
  function currentChapter() {
    return [...state.chapters].reverse().find((chapter) => chapter.startPage <= state.page && state.page < (chapter.endPage ?? Infinity));
  }
  function pageFromHash() {
    const params = new URLSearchParams(location.hash.slice(1));
    const characterId = params.get("character");
    if (characterId) {
      const character = state.characters.find((item) => item.id === characterId);
      if (character) return character.page;
    }
    const page = Number(params.get("page"));
    return Number.isInteger(page) && slideForPage(page) ? page : null;
  }
  function setHash(page) {
    const hash = `#page=${page}`;
    if (location.hash !== hash) history.replaceState(null, "", hash);
  }
  function showMessage(message, retry = false) {
    ui.messageText.textContent = message;
    ui.message.hidden = false;
    ui.message.classList.toggle("is-error", retry);
    ui.retry.hidden = !retry;
    ui.imageLoading.hidden = true;
    ui.stage.setAttribute("aria-busy", "false");
  }
  function announce(message) {
    ui.status.textContent = message;
  }
  function formatSize(size) {
    if (typeof size === "number" && Number.isFinite(size) && size > 0) {
      return size >= 1024 * 1024 ? `${(size / (1024 * 1024)).toFixed(1)} MiB` : `${Math.ceil(size / 1024)} KiB`;
    }
    return text(size);
  }
  function renderDownloads(downloads) {
    ui.downloads.replaceChildren();
    const valid = Array.isArray(downloads) ? downloads.filter((item) => item && safeURL(item.url)) : [];
    if (!valid.length) {
      const pending = document.createElement("p");
      pending.className = "download-pending";
      pending.textContent = "完整下载文件正在准备。";
      ui.downloads.append(pending);
      return;
    }
    for (const item of valid) {
      const link = document.createElement("a");
      link.className = "download-link";
      link.href = safeURL(item.url);
      link.download = new URL(link.href).pathname.split("/").pop() || "";
      const copy = document.createElement("span");
      const title = document.createElement("strong");
      title.textContent = text(item.label, "下载完整版");
      const size = document.createElement("small");
      size.textContent = [formatSize(item.size), "免费下载"].filter(Boolean).join(" · ");
      copy.append(title, size);
      const arrow = document.createElement("span");
      arrow.setAttribute("aria-hidden", "true");
      arrow.textContent = "↓";
      link.append(copy, arrow);
      ui.downloads.append(link);
    }
  }
  function makeNavigationButton({ title, subtitle, page, number, character, track }) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = character ? "character-button" : "chapter-button";
    button.dataset.page = String(page);
    if (character) button.dataset.character = character.id;
    const marker = document.createElement("span");
    marker.className = character ? "character-monogram" : "chapter-number";
    marker.textContent = character ? [...title][0] || "人" : String(number).padStart(2, "0");
    marker.setAttribute("aria-hidden", "true");
    const copy = document.createElement("span");
    copy.className = "navigation-copy";
    const name = document.createElement("strong");
    name.textContent = title;
    const info = document.createElement("small");
    const dot = document.createElement("span");
    dot.className = `track-dot${track === "B" ? " track-b" : ""}`;
    dot.setAttribute("aria-hidden", "true");
    info.append(dot, document.createTextNode(subtitle));
    copy.append(name, info);
    const arrow = document.createElement("span");
    arrow.className = "chapter-arrow";
    arrow.setAttribute("aria-hidden", "true");
    arrow.textContent = "›";
    button.append(marker, copy, arrow);
    button.addEventListener("click", () => { navigate(page); setDrawer(false); });
    return button;
  }
  function renderNavigation() {
    if (!state.book) return;
    const query = normalize(ui.search.value);
    const trackMatch = (item) => state.track === "all" || item.track === state.track;
    const fragment = document.createDocumentFragment();
    let count = 0;
    if (query) {
      const tokens = query.split(" ").filter(Boolean);
      const results = state.characters.filter((character) => {
        const haystack = normalize([character.name, character.id, character.section, ...(character.aliases || [])].join(" "));
        return trackMatch(character) && tokens.every((token) => haystack.includes(token));
      });
      count = results.length;
      for (const character of results) {
        fragment.append(makeNavigationButton({ title: text(character.name, character.id), subtitle: `${text(character.section)} · 第 ${character.page} 页`, page: character.page, character, track: character.track }));
      }
      ui.navigationLabel.textContent = "角色搜索结果";
      ui.searchFeedback.textContent = count ? `找到 ${count} 位人物。` : "没有找到人物，试试其他名称或章节。";
    } else {
      for (const [index, chapter] of state.chapters.entries()) {
        if (!trackMatch(chapter)) continue;
        count += 1;
        fragment.append(makeNavigationButton({ title: chapter.name, subtitle: `${chapter.characterCount} 人物 · 第 ${chapter.startPage} 页`, page: chapter.startPage, number: index + 1, track: chapter.track }));
      }
      ui.navigationLabel.textContent = state.track === "all" ? "章节目录" : state.track === "A" ? "A · 提瓦特旅行志" : "B · 七国遗珍图录";
      ui.searchFeedback.textContent = "";
    }
    if (!count) {
      const empty = document.createElement("p");
      empty.className = "empty-search";
      empty.textContent = query ? "这份手册中没有找到匹配人物。试试更短的名字、别名，或清空篇章筛选。" : "这个篇章筛选下暂时没有内容。";
      fragment.append(empty);
    }
    ui.navigation.replaceChildren(fragment);
    ui.navigationCount.textContent = String(count);
    markCurrentNavigation();
  }
  function markCurrentNavigation() {
    const chapter = currentChapter();
    const current = slideForPage(state.page);
    for (const button of ui.navigation.querySelectorAll("button[data-page]")) {
      const active = button.dataset.character ? button.dataset.character === current?.characterId : Number(button.dataset.page) === chapter?.startPage;
      button.classList.toggle("is-current", active);
      if (active) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current");
    }
  }
  function setZoom(value) {
    state.zoom = Math.min(2.5, Math.max(1, value));
    ui.wrap.style.width = state.zoom === 1 ? "" : `${state.zoom * 100}%`;
    ui.stage.classList.toggle("is-zoomed", state.zoom > 1);
    ui.zoomReset.textContent = `${Math.round(state.zoom * 100)}%`;
    ui.zoomOut.disabled = state.zoom <= 1;
    ui.zoomIn.disabled = state.zoom >= 2.5;
    if (state.zoom === 1) ui.stage.scrollTo({ top: 0, left: 0, behavior: "instant" });
  }
  function shiftZoom(direction) {
    const position = zoomSteps.indexOf(state.zoom);
    setZoom(zoomSteps[Math.max(0, Math.min(zoomSteps.length - 1, position + direction))]);
  }
  function canPrefetch() {
    const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    return !connection?.saveData && !["slow-2g", "2g"].includes(connection?.effectiveType);
  }
  function prefetchNext(page, token) {
    if (!canPrefetch()) return;
    if (pendingFrame) window.cancelAnimationFrame(pendingFrame);
    pendingFrame = window.requestAnimationFrame(() => {
      if (token !== state.token) return;
      const slide = slideForPage(page + 1);
      const source = safeURL(slide?.image);
      if (!source || state.prefetched.has(source)) return;
      state.prefetched.add(source);
      const preload = new Image();
      preload.decoding = "async";
      preload.fetchPriority = "low";
      preload.src = source;
      preload.onerror = () => state.prefetched.delete(source);
    });
  }
  function navigate(page, { updateHash = true, persist = true } = {}) {
    const number = Number(page);
    const slide = slideForPage(number);
    if (!slide) {
      ui.input.value = String(state.page);
      announce(`请输入 1 到 ${state.slides.length} 之间的页码。`);
      return false;
    }
    state.page = number;
    state.token += 1;
    const token = state.token;
    const character = characterForSlide(slide);
    ui.input.value = String(number);
    ui.previous.disabled = number === state.slides[0].page;
    ui.next.disabled = number === state.slides[state.slides.length - 1].page;
    ui.title.textContent = text(slide.title, text(character?.name, `第 ${number} 页`));
    ui.kind.textContent = ({ cover: "手册封面", catalog: "章节目录", section: "章节扉页", profile: "人物档案", sources: "来源与阅读说明", source: "来源与阅读说明" })[slide.type] || text(slide.section, "手册页面");
    ui.track.hidden = !["A", "B"].includes(slide.track);
    ui.track.textContent = slide.track === "A" ? "A · 提瓦特旅行志" : "B · 七国遗珍图录";
    ui.track.classList.toggle("track-b", slide.track === "B");
    setZoom(1);
    if (updateHash) setHash(number);
    if (persist) savePage();
    markCurrentNavigation();
    const source = safeURL(slide.image);
    ui.stage.setAttribute("aria-busy", "true");
    ui.stage.classList.remove("is-loaded");
    ui.message.hidden = true;
    ui.imageLoading.hidden = false;
    ui.image.hidden = true;
    ui.image.removeAttribute("src");
    ui.image.alt = `${text(slide.title, "手册页面")}，第 ${number} 页，共 ${state.slides.length} 页${character?.spoiler || slide.spoiler ? "，包含剧情剧透" : ""}`;
    ui.image.onload = () => {
      if (token !== state.token) return;
      ui.image.hidden = false;
      ui.imageLoading.hidden = true;
      ui.stage.setAttribute("aria-busy", "false");
      ui.stage.classList.add("is-loaded");
      announce(`第 ${number} 页，共 ${state.slides.length} 页。${ui.title.textContent}${character?.spoiler || slide.spoiler ? "。本页包含剧情剧透" : ""}`);
      prefetchNext(number, token);
    };
    ui.image.onerror = () => {
      if (token !== state.token) return;
      ui.image.hidden = true;
      showMessage("这一页暂时未能打开，可以重试或继续翻阅。", true);
      announce(`第 ${number} 页暂时未能打开。`);
    };
    if (source) ui.image.src = source; else ui.image.onerror();
    return true;
  }
  function setDrawer(open) {
    if (!smallScreen.matches) open = false;
    state.drawerOpen = open;
    ui.sidebar.classList.toggle("is-open", open);
    ui.backdrop.hidden = !open;
    ui.contentsToggle.setAttribute("aria-expanded", String(open));
    $("reading-column").inert = open;
    $("masthead").inert = open;
    document.body.style.overflow = open ? "hidden" : "";
    if (open) {
      returnFocus = document.activeElement;
      ui.sidebar.setAttribute("role", "dialog");
      ui.sidebar.setAttribute("aria-modal", "true");
      ui.search.focus();
    } else {
      ui.sidebar.removeAttribute("role");
      ui.sidebar.removeAttribute("aria-modal");
      if (returnFocus?.isConnected && smallScreen.matches) returnFocus.focus();
      returnFocus = null;
    }
  }
  function validateData(book) {
    if (!book || !Array.isArray(book.slides) || !book.slides.length) throw new Error("Missing slides");
    const slides = [...book.slides].sort((a, b) => a.page - b.page);
    const pages = new Set();
    for (const slide of slides) {
      if (!Number.isInteger(slide.page) || slide.page < 1 || pages.has(slide.page) || !safeURL(slide.image)) throw new Error("Invalid page");
      pages.add(slide.page);
    }
    if (slides.some((slide, index) => slide.page !== index + 1)) throw new Error("Noncontiguous pages");
    const characters = Array.isArray(book.characters) ? book.characters.filter((item) => item && pages.has(item.page)).map((item) => ({ ...item, aliases: Array.isArray(item.aliases) ? item.aliases.filter((alias) => typeof alias === "string") : [] })) : [];
    const chapters = Array.isArray(book.chapters) ? book.chapters.filter((item) => item && pages.has(item.startPage)).sort((a, b) => a.startPage - b.startPage).map((item, index, items) => ({ ...item, endPage: items[index + 1]?.startPage ?? (slides.find((slide) => slide.page > item.startPage && ["source", "sources"].includes(slide.type))?.page ?? slides.length + 1) })) : [];
    return { slides, characters, chapters };
  }
  async function loadBook() {
    ui.retry.hidden = true;
    ui.message.classList.remove("is-error");
    ui.messageText.textContent = "正在打开手册…";
    ui.message.hidden = false;
    ui.stage.setAttribute("aria-busy", "true");
    try {
      const response = await fetch("handbook.json", { cache: "no-cache" });
      if (!response.ok) throw new Error("Unavailable book");
      const book = await response.json();
      const data = validateData(book);
      state.book = book;
      Object.assign(state, data);
      state.prefetched.clear();
      $("character-count").textContent = String(data.characters.length);
      $("chapter-count").textContent = String(data.chapters.length);
      $("page-count").textContent = String(data.slides.length);
      ui.input.max = String(data.slides.length);
      ui.total.textContent = String(data.slides.length);
      if (text(book.edition)) $("edition-label").textContent = book.edition;
      $("book-title").textContent = text(book.title, "七国人物志");
      document.title = `${text(book.title, "原神角色手册")} · 七国人物志`;
      document.querySelector('meta[name="description"]').content = `${text(book.title, "原神角色手册")}：${data.characters.length} 人物、${data.chapters.length} 章、${data.slides.length} 页，可在线翻阅、搜索与免费下载。`;
      renderDownloads(book.downloads);
      renderNavigation();
      const firstPage = pageFromHash() ?? (slideForPage(readSavedPage()) ? readSavedPage() : 1);
      navigate(firstPage);
    } catch {
      state.book = null;
      ui.previous.disabled = true;
      ui.next.disabled = true;
      showMessage("暂时未能载入手册，请稍后刷新再试。", true);
      announce("暂时未能载入手册。请重试。");
    }
  }
  function focusableDrawerElements() {
    return [...ui.sidebar.querySelectorAll("button:not(:disabled), input, a[href]")].filter((element) => element.getClientRects().length);
  }
  ui.previous.addEventListener("click", () => navigate(state.page - 1));
  ui.next.addEventListener("click", () => navigate(state.page + 1));
  $("page-jump").addEventListener("submit", (event) => { event.preventDefault(); navigate(Number(ui.input.value)); });
  ui.zoomIn.addEventListener("click", () => shiftZoom(1));
  ui.zoomOut.addEventListener("click", () => shiftZoom(-1));
  ui.zoomReset.addEventListener("click", () => setZoom(1));
  ui.retry.addEventListener("click", () => state.book ? navigate(state.page) : loadBook());
  ui.search.addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(renderNavigation, 90); });
  for (const button of document.querySelectorAll("button[data-track]")) {
    button.addEventListener("click", () => {
      state.track = button.dataset.track;
      for (const item of document.querySelectorAll("button[data-track]")) {
        const active = item.dataset.track === state.track;
        item.classList.toggle("is-active", active);
        item.setAttribute("aria-pressed", String(active));
      }
      renderNavigation();
    });
  }
  ui.contentsToggle.addEventListener("click", () => setDrawer(!state.drawerOpen));
  ui.drawerClose.addEventListener("click", () => setDrawer(false));
  ui.backdrop.addEventListener("click", () => setDrawer(false));
  smallScreen.addEventListener("change", () => setDrawer(false));
  ui.fullscreen.hidden = !document.fullscreenEnabled;
  ui.fullscreen.addEventListener("click", async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen(); else await ui.reader.requestFullscreen();
    } catch { announce("当前浏览器无法进入全屏，可以横屏或放大阅读。"); }
  });
  document.addEventListener("fullscreenchange", () => {
    const full = document.fullscreenElement === ui.reader;
    ui.fullscreen.setAttribute("aria-label", full ? "退出全屏阅读" : "全屏阅读");
    ui.fullscreen.setAttribute("aria-pressed", String(full));
  });
  window.addEventListener("hashchange", () => {
    if (!state.book) return;
    const page = pageFromHash();
    if (page && page !== state.page) navigate(page, { updateHash: false });
  });
  document.addEventListener("keydown", (event) => {
    if (state.drawerOpen) {
      if (event.key === "Escape") { event.preventDefault(); setDrawer(false); return; }
      if (event.key === "Tab") {
        const elements = focusableDrawerElements();
        const first = elements[0];
        const last = elements[elements.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
      return;
    }
    const target = event.target;
    if (!state.book || event.altKey || event.ctrlKey || event.metaKey || target.matches("input,textarea,select,[contenteditable='true']") || target.closest("[contenteditable='true']")) return;
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      const next = state.page + (event.key === "ArrowRight" ? 1 : -1);
      if (slideForPage(next)) navigate(next);
    } else if (event.key === "Home" || event.key === "End") {
      if (document.activeElement === ui.reader || document.fullscreenElement === ui.reader) {
        event.preventDefault(); navigate(event.key === "Home" ? 1 : state.slides.length);
      }
    }
  });
  ui.stage.addEventListener("touchstart", (event) => {
    if (state.zoom !== 1 || event.touches.length !== 1) { touchStart = null; return; }
    touchStart = { x: event.touches[0].clientX, y: event.touches[0].clientY, time: performance.now() };
  }, { passive: true });
  ui.stage.addEventListener("touchmove", (event) => {
    if (event.touches.length !== 1) touchStart = null;
  }, { passive: true });
  ui.stage.addEventListener("touchcancel", () => { touchStart = null; }, { passive: true });
  ui.stage.addEventListener("touchend", (event) => {
    if (!touchStart || event.changedTouches.length !== 1 || state.zoom !== 1) return;
    const deltaX = event.changedTouches[0].clientX - touchStart.x;
    const deltaY = event.changedTouches[0].clientY - touchStart.y;
    const elapsed = performance.now() - touchStart.time;
    touchStart = null;
    if (elapsed > 700 || Math.abs(deltaX) < 55 || Math.abs(deltaX) < Math.abs(deltaY) * 1.5) return;
    const next = state.page + (deltaX < 0 ? 1 : -1);
    if (slideForPage(next)) navigate(next);
  }, { passive: true });
  loadBook();
})();
