/* =========================================================
   KNIHOVNA POHÁDEK
   Statická webová appka nad Google Drive (jen čtení).
   ========================================================= */

/* ---------------------------------------------------------
   1) NASTAVENÍ — tady upravujte podle potřeby
   --------------------------------------------------------- */
const CONFIG = {
  API_KEY: "AIzaSyCR0rsJ07IKNXcXPtjF02O3jnlbuSGUTkI", // Google API klíč (jen čtení Disku)
  ROOT_FOLDER_ID: "1IC0jvfW2ZE-gCK9pW_Qu2cStT0j7mF50",  // ID hlavní složky s pohádkami
  ROOT_NAME: "Knihovna",                                 // jen popisek pro domovskou obrazovku
  PIN: "1308",                                            // 4místný kód — ZMĚŇTE si ho!
  SCAN_CONCURRENCY: 4,                                    // kolik složek skenovat najednou
  CACHE_KEY: "pohadky_cache_v1",
  LASTPLAY_KEY: "pohadky_lastplay_v1",
  INFINITE_KEY: "pohadky_infinite_v1",
  VOLUME_KEY: "pohadky_volume_v1",
  THEME_KEY: "pohadky_theme_v1",
};

const FOLDER_MIME = "application/vnd.google-apps.folder";
const DIAL_RADIUS = 92;
const DIAL_CIRCUMFERENCE = 2 * Math.PI * DIAL_RADIUS;

/* ---------------------------------------------------------
   2) POMOCNÉ FUNKCE
   --------------------------------------------------------- */
const el = (id) => document.getElementById(id);

function naturalCompare(a, b) {
  return a.localeCompare(b, "cs", { numeric: true, sensitivity: "base" });
}
function normalizeSearch(str) {
  return str
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}
function isAudioFile(f) {
  if (f.mimeType && f.mimeType.startsWith("audio/")) return true;
  return /\.(mp3|m4a|m4b|mp4|wav|ogg|oga|flac|aac|wma|opus)$/i.test(f.name);
}
function isImageFile(f) {
  if (f.mimeType && f.mimeType.startsWith("image/")) return true;
  return /\.(jpe?g|png|webp|gif|bmp)$/i.test(f.name);
}
function stripExt(name) {
  return name.replace(/\.[^./]+$/, "");
}
function fmtTime(seconds) {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
function mediaUrl(fileId) {
  return `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${CONFIG.API_KEY}`;
}
function thumbUrl(fileId) {
  return `https://drive.google.com/thumbnail?id=${fileId}&sz=w400`;
}
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker);
  await Promise.all(workers);
  return results;
}
function svgUse(symbolId, cls) {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("class", cls || "icon");
  const use = document.createElementNS(NS, "use");
  use.setAttribute("href", "#" + symbolId);
  svg.appendChild(use);
  return svg;
}

/* ---------------------------------------------------------
   3) PŘÍSTUP NA GOOGLE DRIVE
   --------------------------------------------------------- */
async function fetchAllChildren(folderId) {
  let files = [];
  let pageToken = "";
  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed = false`,
      fields: "nextPageToken, files(id,name,mimeType)",
      pageSize: "1000",
      key: CONFIG.API_KEY,
    });
    if (pageToken) params.set("pageToken", pageToken);
    const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params.toString()}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || "Neznámá chyba Google Drive API");
    files = files.concat(data.files || []);
    pageToken = data.nextPageToken || "";
  } while (pageToken);
  return files;
}

async function scanFolder(folderId, name, path) {
  const children = await fetchAllChildren(folderId);
  const folders = children.filter((c) => c.mimeType === FOLDER_MIME);
  const audioFiles = children
    .filter(isAudioFile)
    .sort((a, b) => naturalCompare(a.name, b.name))
    .map((f) => ({ id: f.id, name: f.name }));
  const imageFiles = children
    .filter(isImageFile)
    .sort((a, b) => naturalCompare(a.name, b.name))
    .map((f) => ({ id: f.id, name: f.name }));

  const node = {
    id: folderId, name, path, audioFiles, imageFiles,
    isBook: audioFiles.length > 0,
    coverId: imageFiles.length > 0 ? imageFiles[0].id : null,
    children: [],
  };
  const childNodes = await mapLimit(folders, CONFIG.SCAN_CONCURRENCY, (f) =>
    scanFolder(f.id, f.name, [...path, f.name])
  );
  childNodes.sort((a, b) => naturalCompare(a.name, b.name));
  node.children = childNodes;
  return node;
}
function collectBooks(node, out) {
  if (node.isBook) out.push(node);
  node.children.forEach((c) => collectBooks(c, out));
}
function findBookById(id) {
  return state.allBooks.find((b) => b.id === id) || null;
}
/** Název knížky pro zobrazení: pokud je to jediná osamocená nahrávka
    (1 audio soubor přímo ve složce), použije se název souboru — ne složky. */
function bookLabel(node) {
  if (node.isBook && node.audioFiles.length === 1) return stripExt(node.audioFiles[0].name);
  return node.name;
}

/* ---------------------------------------------------------
   4) STAV APPKY
   --------------------------------------------------------- */
const state = {
  tree: null,
  allBooks: [],
  browseStack: [],
  returnScreen: "home",
  currentBook: null,
  currentChapterIndex: 0,
  currentMode: "sequential",
  infinitePlay: localStorage.getItem(CONFIG.INFINITE_KEY) === "1",
  sleepMinutes: 0,
  sleepDeadline: null,
  fadeFactor: 1,
  userVolume: parseFloat(localStorage.getItem(CONFIG.VOLUME_KEY)) || 1,
  isScrubbing: false,
  isDraggingDial: false,
};

const audio = new Audio();
audio.preload = "metadata";
applyVolume();

/* ---------------------------------------------------------
   5) PŘEPÍNÁNÍ OBRAZOVEK / PANELŮ
   --------------------------------------------------------- */
const SCREENS = ["pin", "loading", "error", "home", "browse", "player"];
function showScreen(name) {
  SCREENS.forEach((s) => el(`screen-${s}`).classList.toggle("screen--hidden", s !== name));
  updateMiniPlayer(name);
}
function openSheet(id) { el(id).classList.remove("sheet--hidden"); }
function closeSheet(id) { el(id).classList.add("sheet--hidden"); }

/* ---------------------------------------------------------
   6) TMAVÝ REŽIM
   --------------------------------------------------------- */
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  const use = el("theme-icon-use");
  if (use) use.setAttribute("href", theme === "dark" ? "#icon-sun" : "#icon-moon");
}
function initTheme() {
  let theme = localStorage.getItem(CONFIG.THEME_KEY);
  if (!theme) {
    theme = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  applyTheme(theme);
}
el("btn-theme").addEventListener("click", () => {
  const current = document.documentElement.getAttribute("data-theme");
  const next = current === "dark" ? "light" : "dark";
  localStorage.setItem(CONFIG.THEME_KEY, next);
  applyTheme(next);
});
initTheme();

/* ---------------------------------------------------------
   7) PIN OBRAZOVKA
   --------------------------------------------------------- */
let pinBuffer = "";
function renderPinDots() {
  const dots = el("pin-dots").children;
  for (let i = 0; i < dots.length; i++) dots[i].classList.toggle("pin-dot--filled", i < pinBuffer.length);
}
function pinError() {
  const box = el("screen-pin").querySelector(".pin-box");
  el("pin-error").classList.add("pin-error--show");
  box.classList.add("pin-box--shake");
  setTimeout(() => {
    box.classList.remove("pin-box--shake");
    pinBuffer = "";
    renderPinDots();
  }, 350);
  setTimeout(() => el("pin-error").classList.remove("pin-error--show"), 1500);
}
function checkPin() {
  if (pinBuffer === CONFIG.PIN) {
    sessionStorage.setItem("pohadky_unlocked", "1");
    pinBuffer = "";
    renderPinDots();
    afterUnlock();
  } else {
    pinError();
  }
}
el("pin-pad").addEventListener("click", (e) => {
  const btn = e.target.closest(".pin-key");
  if (!btn) return;
  const key = btn.dataset.key;
  if (key === "clear") pinBuffer = "";
  else if (key === "back") pinBuffer = pinBuffer.slice(0, -1);
  else if (pinBuffer.length < 4) pinBuffer += key;
  renderPinDots();
  if (pinBuffer.length === 4) setTimeout(checkPin, 120);
});

/* ---------------------------------------------------------
   8) SKENOVÁNÍ / CACHE KNIHOVNY
   --------------------------------------------------------- */
function saveCache(tree) {
  try { localStorage.setItem(CONFIG.CACHE_KEY, JSON.stringify({ ts: Date.now(), tree })); } catch (e) {}
}
function loadCache() {
  try {
    const raw = localStorage.getItem(CONFIG.CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}
async function performScan() {
  showScreen("loading");
  try {
    const root = await scanFolder(CONFIG.ROOT_FOLDER_ID, CONFIG.ROOT_NAME, [CONFIG.ROOT_NAME]);
    state.tree = root;
    state.allBooks = [];
    collectBooks(root, state.allBooks);
    saveCache(root);
    showHome();
    restoreLastPlay();
  } catch (err) {
    el("error-detail").textContent = err.message || String(err);
    showScreen("error");
  }
}
el("btn-retry").addEventListener("click", performScan);
el("btn-rescan").addEventListener("click", performScan);

function afterUnlock() {
  const cached = loadCache();
  if (cached && cached.tree) {
    state.tree = cached.tree;
    state.allBooks = [];
    collectBooks(state.tree, state.allBooks);
    showHome();
    restoreLastPlay();
  } else {
    performScan();
  }
}

/* ---------------------------------------------------------
   9) DOMOVSKÁ OBRAZOVKA
   --------------------------------------------------------- */
function getLastPlay() {
  try {
    const raw = localStorage.getItem(CONFIG.LASTPLAY_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}
function renderHome() {
  /* Tlačítko "Pokračovat" bylo nahrazeno mini-přehrávačem, který se obnoví automaticky. */
}
function showHome() { renderHome(); showScreen("home"); }

/** Po načtení knihovny obnoví naposledy přehrávanou pohádku do mini-přehrávače
    (nepřehrává automaticky, jen ji připraví — uživatel pokračuje klepnutím na mini-přehrávač). */
function restoreLastPlay() {
  if (state.currentBook) return; // už něco hraje v rámci téhle session, nepřepisovat
  const last = getLastPlay();
  if (!last) return;
  const book = findBookById(last.bookId);
  if (!book || book.audioFiles.length === 0) return;

  state.currentBook = book;
  state.currentMode = last.mode || "sequential";
  state.currentChapterIndex = Math.max(0, Math.min(last.chapterIndex || 0, book.audioFiles.length - 1));
  const file = book.audioFiles[state.currentChapterIndex];

  pendingStartTime = last.currentTime || 0;
  audio.src = mediaUrl(file.id);
  el("player-book-title").textContent = bookLabel(book);
  el("player-chapter-title").textContent = `${state.currentChapterIndex + 1}/${book.audioFiles.length} — ${stripExt(file.name)}`;

  const coverImg = el("player-cover");
  const fallback = el("player-cover-fallback");
  if (book.coverId) {
    coverImg.src = mediaUrl(book.coverId);
    coverImg.style.display = "block";
    fallback.style.display = "none";
  } else {
    coverImg.removeAttribute("src");
    coverImg.style.display = "none";
    fallback.style.display = "block";
  }
  renderChaptersList();
  updateMiniPlayer();
}

el("btn-go-browse").addEventListener("click", () => {
  state.browseStack = [state.tree];
  renderBrowseGrid();
  showScreen("browse");
});
el("btn-go-random").addEventListener("click", () => {
  if (state.allBooks.length === 0) return;
  runLottery((book) => {
    state.returnScreen = "home";
    openPlayer(book, { chapterIndex: 0, startTime: 0, mode: "random", forceInfinite: true });
  });
});

/** Krátká "losovací" animace — chvíli střídá náhodné názvy, pak se zastaví na vylosované pohádce. */
function runLottery(callback) {
  const finalBook = pickRandomBook();
  if (!finalBook) return;
  const overlay = el("lottery-overlay");
  const text = el("lottery-text");
  const icon = el("lottery-icon");

  icon.classList.remove("lottery__icon--settle");
  text.classList.remove("lottery__text--final");
  overlay.classList.remove("lottery--hidden");

  const ticks = 14;
  let i = 0;
  function tick() {
    const showBook = i < ticks - 1 ? pickRandomBook() : finalBook;
    text.textContent = bookLabel(showBook);
    i++;
    if (i < ticks) {
      setTimeout(tick, 60 + i * 16); // postupné zpomalování — jako u kostky/ruletky
    } else {
      text.classList.add("lottery__text--final");
      icon.classList.add("lottery__icon--settle");
      setTimeout(() => {
        overlay.classList.add("lottery--hidden");
        callback(finalBook);
      }, 550);
    }
  }
  tick();
}

/* ---------------------------------------------------------
   10) PROCHÁZENÍ KATALOGU
   --------------------------------------------------------- */
el("btn-browse-home").addEventListener("click", () => showScreen("home"));

function renderBreadcrumb() {
  const wrap = el("breadcrumb");
  wrap.innerHTML = "";
  state.browseStack.forEach((node, i) => {
    if (i > 0) {
      const sep = document.createElement("span");
      sep.className = "breadcrumb__sep";
      sep.textContent = "›";
      wrap.appendChild(sep);
    }
    const btn = document.createElement("button");
    btn.textContent = node.name;
    btn.addEventListener("click", () => {
      state.browseStack = state.browseStack.slice(0, i + 1);
      renderBrowseGrid();
    });
    wrap.appendChild(btn);
  });
}

function makeCardArt(node) {
  if (node.isBook && node.coverId) {
    const img = document.createElement("img");
    img.className = "card__art card__art--book";
    img.loading = "lazy";
    img.alt = node.name;
    img.src = thumbUrl(node.coverId);
    img.onerror = () => img.replaceWith(makeFallbackIcon(node.isBook));
    return img;
  }
  return makeFallbackIcon(node.isBook);
}
function makeFallbackIcon(isBook) {
  const div = document.createElement("div");
  div.className = "card__art " + (isBook ? "card__art--book" : "card__art--folder");
  div.appendChild(svgUse(isBook ? "icon-cassette" : "icon-folder"));
  return div;
}

function pluralPohadek(n) {
  if (n === 1) return `${n} pohádka`;
  if (n >= 2 && n <= 4) return `${n} pohádky`;
  return `${n} pohádek`;
}

function renderBrowseGrid() {
  renderBreadcrumb();
  const node = state.browseStack[state.browseStack.length - 1];
  const grid = el("browse-grid");
  grid.innerHTML = "";

  const allHere = [];
  collectBooks(node, allHere);
  el("browse-count").textContent = `${pluralPohadek(allHere.length)} v této složce`;

  const items = [];
  if (node.audioFiles.length > 0) items.push({ kind: "book", refNode: node });
  node.children.forEach((child) => items.push({ kind: child.isBook ? "book" : "folder", refNode: child }));
  el("browse-empty").classList.toggle("empty-msg--hidden", items.length > 0);

  items.forEach((item) => {
    const card = document.createElement("button");
    card.className = "card";
    card.appendChild(makeCardArt(item.refNode));
    const label = document.createElement("span");
    label.className = "card__label";
    label.textContent = item.kind === "book" ? bookLabel(item.refNode) : item.refNode.name;
    card.appendChild(label);
    card.addEventListener("click", () => {
      if (item.kind === "book") {
        state.returnScreen = "browse";
        openPlayer(item.refNode, { chapterIndex: 0, startTime: 0, mode: "sequential" });
      } else {
        state.browseStack.push(item.refNode);
        renderBrowseGrid();
      }
    });
    grid.appendChild(card);
  });
}

/* ---------------------------------------------------------
   11) HLEDÁNÍ
   --------------------------------------------------------- */
el("btn-browse-search").addEventListener("click", () => {
  el("search-input").value = "";
  renderSearchResults("");
  openSheet("sheet-search");
  setTimeout(() => el("search-input").focus(), 50);
});
el("btn-search-close").addEventListener("click", () => closeSheet("sheet-search"));
el("sheet-search-backdrop").addEventListener("click", () => closeSheet("sheet-search"));
el("search-input").addEventListener("input", (e) => renderSearchResults(e.target.value));

function renderSearchResults(query) {
  const wrap = el("search-results");
  wrap.innerHTML = "";
  const q = normalizeSearch(query.trim());
  if (!q) {
    const p = document.createElement("p");
    p.className = "search-hint";
    p.textContent = "Začni psát název pohádky…";
    wrap.appendChild(p);
    return;
  }
  const matches = state.allBooks.filter((b) =>
    normalizeSearch(b.name + " " + bookLabel(b) + " " + b.path.join(" ")).includes(q)
  );
  if (matches.length === 0) {
    const p = document.createElement("p");
    p.className = "search-hint";
    p.textContent = "Nic jsme nenašli.";
    wrap.appendChild(p);
    return;
  }
  matches.forEach((book) => {
    const row = document.createElement("button");
    row.className = "search-row";
    let art;
    if (book.coverId) {
      art = document.createElement("img");
      art.className = "search-row__art";
      art.src = thumbUrl(book.coverId);
      art.onerror = () => art.replaceWith(makeFallbackSearchIcon());
    } else {
      art = makeFallbackSearchIcon();
    }
    const texts = document.createElement("span");
    const name = document.createElement("span");
    name.className = "search-row__name";
    name.textContent = bookLabel(book);
    const path = document.createElement("span");
    path.className = "search-row__path";
    path.textContent = book.path.slice(0, -1).join(" › ");
    texts.appendChild(name);
    texts.appendChild(document.createElement("br"));
    texts.appendChild(path);
    row.appendChild(art);
    row.appendChild(texts);
    row.addEventListener("click", () => {
      closeSheet("sheet-search");
      state.returnScreen = "browse";
      openPlayer(book, { chapterIndex: 0, startTime: 0, mode: "sequential" });
    });
    wrap.appendChild(row);
  });
}
function makeFallbackSearchIcon() {
  const div = document.createElement("div");
  div.className = "search-row__art";
  div.appendChild(svgUse("icon-cassette"));
  return div;
}

/* ---------------------------------------------------------
   12) NÁHODNÝ A DALŠÍ VÝBĚR KNÍŽKY
   --------------------------------------------------------- */
function pickRandomBook(excludeId) {
  const pool = state.allBooks;
  if (pool.length === 0) return null;
  if (pool.length === 1) return pool[0];
  let pick, tries = 0;
  do {
    pick = pool[Math.floor(Math.random() * pool.length)];
    tries++;
  } while (pick.id === excludeId && tries < 8);
  return pick;
}
function pickNextSequentialBook(currentId) {
  const pool = state.allBooks;
  if (pool.length === 0) return null;
  const idx = pool.findIndex((b) => b.id === currentId);
  return pool[(idx + 1 + pool.length) % pool.length];
}

/* ---------------------------------------------------------
   13) PŘEHRÁVAČ
   --------------------------------------------------------- */
el("btn-player-back").addEventListener("click", () => {
  if (state.returnScreen === "browse") { renderBrowseGrid(); showScreen("browse"); }
  else showHome();
});

function openPlayer(bookNode, opts) {
  opts = opts || {};
  state.currentBook = bookNode;
  state.currentMode = opts.mode || "sequential";
  if (opts.forceInfinite) { state.infinitePlay = true; syncInfiniteButton(); }

  el("player-book-title").textContent = bookLabel(bookNode);
  const coverImg = el("player-cover");
  const fallback = el("player-cover-fallback");
  if (bookNode.coverId) {
    coverImg.src = mediaUrl(bookNode.coverId);
    coverImg.style.display = "block";
    fallback.style.display = "none";
  } else {
    coverImg.removeAttribute("src");
    coverImg.style.display = "none";
    fallback.style.display = "block";
  }

  state.fadeFactor = 1;
  state.audioErrorRetries = 0;
  hidePlaybackToast();
  applyVolume();
  loadChapter(opts.chapterIndex || 0, opts.startTime || 0, true);
  renderChaptersList();
  showScreen("player");
}

let pendingStartTime = 0;
function loadChapter(index, startTime, autoplay) {
  const book = state.currentBook;
  if (!book || book.audioFiles.length === 0) return;
  index = Math.max(0, Math.min(index, book.audioFiles.length - 1));
  state.currentChapterIndex = index;
  const file = book.audioFiles[index];

  pendingStartTime = startTime || 0;
  audio.src = mediaUrl(file.id);
  el("player-chapter-title").textContent = `${index + 1}/${book.audioFiles.length} — ${stripExt(file.name)}`;

  if (autoplay) audio.play().catch(() => {});
  renderChaptersList();
  savePlaybackState();
}

audio.addEventListener("loadedmetadata", () => {
  if (pendingStartTime > 0 && pendingStartTime < audio.duration) audio.currentTime = pendingStartTime;
  pendingStartTime = 0;
  el("time-total").textContent = fmtTime(audio.duration);
});
audio.addEventListener("timeupdate", () => {
  if (!state.isScrubbing && audio.duration) {
    el("seek").value = Math.floor((audio.currentTime / audio.duration) * 1000);
    el("time-current").textContent = fmtTime(audio.currentTime);
  }
  state.lastKnownTime = audio.currentTime;
  if (Math.floor(audio.currentTime) % 5 === 0) savePlaybackState();
});
audio.addEventListener("play", () => {
  el("icon-play-use").querySelector("use").setAttribute("href", "#icon-pause");
  el("reel-left").classList.add("reel--spin");
  el("reel-right").classList.add("reel--spin");
  updateMiniPlayer();
});
audio.addEventListener("pause", () => {
  el("icon-play-use").querySelector("use").setAttribute("href", "#icon-play");
  el("reel-left").classList.remove("reel--spin");
  el("reel-right").classList.remove("reel--spin");
  savePlaybackState();
  updateMiniPlayer();
});
audio.addEventListener("ended", handleChapterEnded);
audio.addEventListener("playing", () => {
  state.audioErrorRetries = 0;
  hidePlaybackToast();
});
audio.addEventListener("error", () => {
  // Nejčastější příčina: Disk dočasně odmítl požadavek (např. krátké přetížení API,
  // když je appka otevřená na více zařízeních najednou). Zkusíme to automaticky znovu.
  scheduleAudioRecovery();
});

function showPlaybackToast(text) {
  el("playback-toast-text").textContent = text;
  el("playback-toast").classList.remove("toast--hidden");
}
function hidePlaybackToast() {
  el("playback-toast").classList.add("toast--hidden");
}
function scheduleAudioRecovery() {
  if (!state.currentBook) return;
  state.audioErrorRetries = (state.audioErrorRetries || 0) + 1;
  if (state.audioErrorRetries > 4) {
    showPlaybackToast("Přehrávání se nedaří obnovit. Zkuste to prosím manuálně.");
    return;
  }
  showPlaybackToast(`Přehrávání se přerušilo, zkouším to znovu… (${state.audioErrorRetries}/4)`);
  const delay = [1500, 3000, 6000, 10000][state.audioErrorRetries - 1];
  setTimeout(() => {
    if (!state.currentBook) return;
    loadChapter(state.currentChapterIndex, state.lastKnownTime || 0, true);
  }, delay);
}
el("playback-toast-retry").addEventListener("click", () => {
  state.audioErrorRetries = 0;
  hidePlaybackToast();
  if (state.currentBook) loadChapter(state.currentChapterIndex, state.lastKnownTime || 0, true);
});

/** Mini-přehrávač — viditelný vždy, když hraje/je nahraná kniha a NEJSME na obrazovce přehrávače. */
function updateMiniPlayer(activeScreenName) {
  const mp = el("mini-player");
  const activeScreen = activeScreenName || SCREENS.find((s) => !el(`screen-${s}`).classList.contains("screen--hidden"));
  const shouldShow = !!state.currentBook && !["player", "pin", "loading", "error"].includes(activeScreen);

  mp.classList.toggle("mini-player--hidden", !shouldShow);
  document.body.classList.toggle("has-miniplayer", shouldShow);
  if (!shouldShow) return;

  const book = state.currentBook;
  el("mini-player-title").textContent = bookLabel(book);
  const file = book.audioFiles[state.currentChapterIndex];
  el("mini-player-chapter").textContent = file
    ? `${state.currentChapterIndex + 1}/${book.audioFiles.length} — ${stripExt(file.name)}`
    : "";

  const art = el("mini-player-art");
  art.innerHTML = "";
  if (book.coverId) {
    const img = document.createElement("img");
    img.src = thumbUrl(book.coverId);
    img.alt = "";
    img.style.width = "100%";
    img.style.height = "100%";
    img.style.objectFit = "cover";
    img.onerror = () => { art.innerHTML = ""; art.appendChild(svgUse("icon-cassette")); };
    art.appendChild(img);
  } else {
    art.appendChild(svgUse("icon-cassette"));
  }
  el("mini-icon-play-use").querySelector("use").setAttribute("href", audio.paused ? "#icon-play" : "#icon-pause");
}

el("mini-player").addEventListener("click", (e) => {
  if (e.target.closest("#mini-player-play")) return;
  showScreen("player");
});
el("mini-player-play").addEventListener("click", (e) => {
  e.stopPropagation();
  if (audio.paused) audio.play();
  else audio.pause();
});

function handleChapterEnded() {
  const book = state.currentBook;
  if (state.currentChapterIndex + 1 < book.audioFiles.length) loadChapter(state.currentChapterIndex + 1, 0, true);
  else if (state.infinitePlay) goToNextBook();
  else savePlaybackState();
}
function goToNextBook() {
  const current = state.currentBook;
  const next = state.currentMode === "random" ? pickRandomBook(current.id) : pickNextSequentialBook(current.id);
  if (!next) return;
  openPlayer(next, { chapterIndex: 0, startTime: 0, mode: state.currentMode });
}

el("btn-playpause").addEventListener("click", () => { if (audio.paused) audio.play(); else audio.pause(); });
el("btn-prev").addEventListener("click", () => {
  if (state.currentChapterIndex > 0) loadChapter(state.currentChapterIndex - 1, 0, true);
  else audio.currentTime = 0;
});
el("btn-next").addEventListener("click", () => {
  const book = state.currentBook;
  if (state.currentChapterIndex + 1 < book.audioFiles.length) loadChapter(state.currentChapterIndex + 1, 0, true);
  else if (state.infinitePlay) goToNextBook();
});

const seek = el("seek");
seek.addEventListener("input", () => {
  state.isScrubbing = true;
  if (audio.duration) el("time-current").textContent = fmtTime((seek.value / 1000) * audio.duration);
});
seek.addEventListener("change", () => {
  if (audio.duration) audio.currentTime = (seek.value / 1000) * audio.duration;
  state.isScrubbing = false;
});

/* ---------- hlasitost ---------- */
function applyVolume() {
  audio.volume = Math.max(0, Math.min(1, state.userVolume * state.fadeFactor));
}
const volumeSlider = el("volume");
volumeSlider.value = Math.round(state.userVolume * 100);
volumeSlider.addEventListener("input", () => {
  state.userVolume = volumeSlider.value / 100;
  localStorage.setItem(CONFIG.VOLUME_KEY, String(state.userVolume));
  applyVolume();
});

/* ---------------------------------------------------------
   14) PANEL S KAPITOLAMI
   --------------------------------------------------------- */
function renderChaptersList() {
  const book = state.currentBook;
  if (!book) return;
  const list = el("chapters-list");
  list.innerHTML = "";
  book.audioFiles.forEach((file, i) => {
    const row = document.createElement("button");
    row.className = "chapter-row" + (i === state.currentChapterIndex ? " chapter-row--active" : "");
    const num = document.createElement("span");
    num.className = "chapter-row__num";
    num.textContent = i + 1;
    const name = document.createElement("span");
    name.className = "chapter-row__name";
    name.textContent = stripExt(file.name);
    row.appendChild(num);
    row.appendChild(name);
    row.addEventListener("click", () => { loadChapter(i, 0, true); closeSheet("sheet-chapters"); });
    list.appendChild(row);
  });
}
el("btn-player-chapters").addEventListener("click", () => { renderChaptersList(); openSheet("sheet-chapters"); });
el("sheet-backdrop").addEventListener("click", () => closeSheet("sheet-chapters"));

/* ---------------------------------------------------------
   15) NEKONEČNÉ PŘEHRÁVÁNÍ
   --------------------------------------------------------- */
function syncInfiniteButton() {
  el("btn-infinite").setAttribute("aria-pressed", state.infinitePlay ? "true" : "false");
}
el("btn-infinite").addEventListener("click", () => {
  state.infinitePlay = !state.infinitePlay;
  localStorage.setItem(CONFIG.INFINITE_KEY, state.infinitePlay ? "1" : "0");
  syncInfiniteButton();
});
syncInfiniteButton();

/* ---------------------------------------------------------
   16) ČASOVAČ USÍNÁNÍ — otočná minutka (fade-out)
   --------------------------------------------------------- */
function minutesToAngle(min) { return (min / 60) * 360; } // 0..360°, 0 = nahoře, po směru hodin
function setSleepMinutes(minutes, { start = true } = {}) {
  minutes = Math.max(0, Math.min(60, Math.round(minutes)));
  state.sleepMinutes = minutes;
  if (minutes > 0 && start) state.sleepDeadline = Date.now() + minutes * 60000;
  if (minutes === 0) { state.sleepDeadline = null; state.fadeFactor = 1; applyVolume(); }
  renderSleepDial();
  syncSleepToggle();
}
function renderSleepDial() {
  const frac = state.sleepMinutes / 60;
  const dash = frac * DIAL_CIRCUMFERENCE;
  el("dial-progress").style.strokeDasharray = `${dash} ${DIAL_CIRCUMFERENCE}`;
  const angleDeg = minutesToAngle(state.sleepMinutes);
  const angleRad = (angleDeg * Math.PI) / 180;
  const cx = 110 + DIAL_RADIUS * Math.cos(angleRad);
  const cy = 110 + DIAL_RADIUS * Math.sin(angleRad);
  el("dial-handle").setAttribute("cx", cx);
  el("dial-handle").setAttribute("cy", cy);
  el("dial-value").textContent = state.sleepMinutes > 0 ? `${state.sleepMinutes} min` : "Vypnuto";
  el("sleep-dial").setAttribute("aria-valuenow", String(state.sleepMinutes));
}
function syncSleepToggle() {
  const btn = el("btn-sleep");
  btn.setAttribute("aria-pressed", state.sleepDeadline ? "true" : "false");
  if (state.sleepDeadline) {
    const remainMin = Math.max(0, Math.ceil((state.sleepDeadline - Date.now()) / 60000));
    el("sleep-label").textContent = `Vypnutí za ${remainMin} min`;
  } else {
    el("sleep-label").textContent = "Časovač usínání";
  }
}

const dial = el("sleep-dial");
const dialCenter = el("dial-center");
const CENTER_HIT_RADIUS = 82; // px, odpovídá vizuální velikosti středu (inset:28px na 220px kolečku)

function angleFromEvent(clientX, clientY) {
  const rect = dial.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const dx = clientX - cx;
  const dy = clientY - cy;
  let angle = Math.atan2(dx, -dy); // 0 = nahoru, po směru hodin
  if (angle < 0) angle += 2 * Math.PI;
  const dist = Math.sqrt(dx * dx + dy * dy);
  return { minutes: Math.round((angle / (2 * Math.PI)) * 60), dist };
}

dial.addEventListener("pointerdown", (e) => {
  const { minutes, dist } = angleFromEvent(e.clientX, e.clientY);
  if (dist < CENTER_HIT_RADIUS) {
    setSleepMinutes(0);
    return;
  }
  state.isDraggingDial = true;
  dial.setPointerCapture(e.pointerId);
  setSleepMinutes(minutes);
});
dial.addEventListener("pointermove", (e) => {
  if (!state.isDraggingDial) return;
  const { minutes } = angleFromEvent(e.clientX, e.clientY);
  setSleepMinutes(minutes);
});
function endDialDrag(e) {
  if (!state.isDraggingDial) return;
  state.isDraggingDial = false;
  try { dial.releasePointerCapture(e.pointerId); } catch (err) {}
}
dial.addEventListener("pointerup", endDialDrag);
dial.addEventListener("pointercancel", endDialDrag);
dial.addEventListener("keydown", (e) => {
  if (e.key === "ArrowUp" || e.key === "ArrowRight") { e.preventDefault(); setSleepMinutes(state.sleepMinutes + 1); }
  else if (e.key === "ArrowDown" || e.key === "ArrowLeft") { e.preventDefault(); setSleepMinutes(state.sleepMinutes - 1); }
  else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSleepMinutes(0); }
});
dialCenter.addEventListener("click", () => setSleepMinutes(0));

el("btn-sleep").addEventListener("click", () => { renderSleepDial(); syncSleepToggle(); openSheet("sheet-sleep"); });
el("sheet-sleep-backdrop").addEventListener("click", () => closeSheet("sheet-sleep"));

setInterval(() => {
  if (!state.sleepDeadline) return;
  const remaining = state.sleepDeadline - Date.now();
  if (remaining <= 0) {
    audio.pause();
    state.sleepDeadline = null;
    state.sleepMinutes = 0;
    state.fadeFactor = 1;
    applyVolume();
    syncSleepToggle();
    return;
  }
  state.fadeFactor = remaining <= 60000 ? Math.max(0, Math.min(1, remaining / 60000)) : 1;
  applyVolume();
  syncSleepToggle();
}, 500);

/* ---------------------------------------------------------
   17) UKLÁDÁNÍ ROZEHRANÉ POZICE ("Pokračovat")
   --------------------------------------------------------- */
function savePlaybackState() {
  if (!state.currentBook) return;
  try {
    localStorage.setItem(CONFIG.LASTPLAY_KEY, JSON.stringify({
      bookId: state.currentBook.id,
      bookName: bookLabel(state.currentBook),
      chapterIndex: state.currentChapterIndex,
      currentTime: audio.currentTime || 0,
      mode: state.currentMode,
    }));
  } catch (e) {}
}
window.addEventListener("beforeunload", savePlaybackState);

/* ---------------------------------------------------------
   18) START APPKY
   --------------------------------------------------------- */
function init() {
  if (sessionStorage.getItem("pohadky_unlocked") === "1") {
    showScreen("loading");
    afterUnlock();
  } else {
    showScreen("pin");
  }
}
init();
