// content_script.js
// XのDOMを監視し、画像URLを取得・変換してダウンロードボタンを注入する

const XIV_ATTR = 'data-xiv-processed';
const XIV_BTN_CLASS = 'xiv-dl-btn';
const XIV_SAVED_BADGE_CLASS = 'xiv-saved-badge';

// ホバー・フォーカス状態を追跡する
const state = {
  hoveredArticle: null,
  hoveredImg: null,
  focusedArticle: null,
  settings: {
    showOverlay: true,
    skipSavedImages: false,
  },
  savedMediaKeys: new Set(),
  videoUrlsByTweetId: new Map(),
  recentVideoUrls: [],
};

// 選択言語のメッセージを保持する
let _csMessages = {};

function csT(key) {
  return _csMessages[key]?.message || key;
}

async function loadCsMessages(lang) {
  try {
    const url = chrome.runtime.getURL(`_locales/${lang}/messages.json`);
    const res = await fetch(url);
    _csMessages = await res.json();
  } catch (_) {}
}

// 設定を読み込む
async function loadSettings() {
  const s = await chrome.storage.sync.get({ showOverlay: true, skipSavedImages: false, language: 'ja' });
  state.settings = s;
  await loadCsMessages(s.language || 'ja');
  // showOverlay 変更時にオーバーレイの表示/非表示を切り替え
  document.querySelectorAll(`.${XIV_BTN_CLASS}-wrap`).forEach((el) => {
    updateSavedMarker(el, el.classList.contains('xiv-is-saved'));
  });
  scheduleSavedMarkerRefresh();
}

// ============================================================
// 画像URL変換
// ============================================================
function toOriginalUrl(src) {
  if (!src || !src.includes('pbs.twimg.com')) return src;
  try {
    const url = new URL(src);
    if (url.searchParams.has('name')) {
      url.searchParams.set('name', 'orig');
      return url.toString();
    }
    // コロン形式のフォールバック
    return src.replace(/:(?:thumb|small|medium|large|\d+x\d+)$/, ':orig');
  } catch (_) {
    return src;
  }
}

function getMediaKey(src) {
  if (!src) return '';
  try {
    const url = new URL(src);
    if (url.hostname.includes('pbs.twimg.com')) {
      return `${url.hostname}${url.pathname}`;
    }
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch (_) {
    return src.replace(/([:?&]name=)(?:thumb|small|medium|large|orig|\d+x\d+)/, '$1orig');
  }
}

function requestSavedStatus(images) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'GET_SAVED_IMAGE_STATUS', payload: images }, (response) => {
      if (chrome.runtime.lastError) {
        resolve([]);
        return;
      }
      resolve(response?.saved || []);
    });
  });
}

function rememberVideoUrls(urls, tweetIds = []) {
  const cleanUrls = chooseBestVideoUrls([...(urls || [])].filter(Boolean));
  if (!cleanUrls.length) return;

  state.recentVideoUrls = chooseBestVideoUrls([...new Set([...cleanUrls, ...state.recentVideoUrls])]).slice(0, 20);
  (tweetIds || []).forEach((tweetId) => {
    if (!tweetId) return;
    const existing = state.videoUrlsByTweetId.get(tweetId) || [];
    state.videoUrlsByTweetId.set(tweetId, chooseBestVideoUrls([...new Set([...cleanUrls, ...existing])]));
  });
}

function getCachedVideoUrls(tweetId) {
  return [...(state.videoUrlsByTweetId.get(tweetId) || []), ...state.recentVideoUrls];
}

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (event.data?.source !== 'x-image-viewer' || event.data?.type !== 'XIV_VIDEO_URLS') return;
  rememberVideoUrls(event.data.urls || [], event.data.tweetIds || []);
});

function requestBridgeVideoUrls() {
  window.postMessage({
    source: 'x-image-viewer',
    type: 'XIV_REQUEST_VIDEO_URLS',
  }, '*');
}

function getImageUrlFromTarget(el) {
  const container = el.closest?.('div[data-testid="tweetPhoto"]');
  const img = container?.querySelector('img');
  if (!img) return el.dataset.mediaUrl || el.dataset.imageUrl || '';
  return toOriginalUrl(img.src || img.currentSrc || '');
}

function refreshTargetImageUrl(el) {
  if (el.dataset.mediaType === 'video') return el.dataset.mediaUrl || '';
  const mediaUrl = getImageUrlFromTarget(el);
  if (mediaUrl) {
    el.dataset.mediaUrl = mediaUrl;
    el.dataset.imageUrl = mediaUrl;
  }
  return mediaUrl;
}

let savedMarkerRefreshTimer = null;

function scheduleSavedMarkerRefresh() {
  clearTimeout(savedMarkerRefreshTimer);
  savedMarkerRefreshTimer = setTimeout(refreshSavedMarkers, 100);
}

async function refreshSavedMarkers() {
  const targets = [
    ...document.querySelectorAll(`.${XIV_BTN_CLASS}-wrap[data-media-url]`),
    ...document.querySelectorAll(`#${XIV_OVERLAY_ID} [data-media-url]`),
  ].filter((el) => refreshTargetImageUrl(el));
  if (!targets.length) return;

  const images = targets.map((el) => ({ url: el.dataset.mediaUrl, type: el.dataset.mediaType || 'image' }));
  const saved = await requestSavedStatus(images);
  targets.forEach((el, idx) => {
    const key = getMediaKey(el.dataset.mediaUrl);
    if (saved[idx]) state.savedMediaKeys.add(key);
    updateSavedMarker(el, saved[idx]);
  });
}

function updateSavedMarker(el, isSaved) {
  el.classList.toggle('xiv-is-saved', Boolean(isSaved));
  const badge = el.matches?.(`.${XIV_SAVED_BADGE_CLASS}`)
    ? el
    : el.querySelector(`.${XIV_SAVED_BADGE_CLASS}`);
  if (badge) {
    badge.hidden = !isSaved;
    badge.style.display = isSaved ? 'flex' : 'none';
    badge.title = csT('savedImageBadgeTitle');
  }
  if (el.classList.contains(`${XIV_BTN_CLASS}-wrap`)) {
    const btn = el.querySelector(`.${XIV_BTN_CLASS}`);
    if (btn) btn.style.display = state.settings.showOverlay ? 'flex' : 'none';
    el.style.display = state.settings.showOverlay || isSaved ? 'flex' : 'none';
  }
}

// ============================================================
// Tweet情報の抽出
// ============================================================
function extractTweetInfo(article) {
  // ステータスリンク "/{username}/status/{tweetId}" から取得
  const links = article.querySelectorAll('a[href*="/status/"]');
  for (const link of links) {
    const match = link.href.match(/\/([^/?#]+)\/status\/(\d+)/);
    if (match) {
      return { username: match[1], tweetId: match[2] };
    }
  }
  return { username: 'unknown', tweetId: Date.now().toString() };
}

// tweetPhoto コンテナが動画（GIF含む）を含むか判定する
function isVideoContainer(container) {
  return container.querySelector('video') !== null;
}

function getMediaContainers(article) {
  const containers = [
    ...article.querySelectorAll('div[data-testid="tweetPhoto"], div[data-testid="videoPlayer"]'),
  ];
  return containers.filter((container, idx) => {
    if (containers.some((other, otherIdx) => otherIdx !== idx && other.contains(container))) return false;
    return container.querySelector('img, video');
  });
}

function getVideoUrlFromTarget(video, article) {
  const candidates = new Set();
  const mediaId = getVideoMediaId(video) || getVideoMediaId(video.closest('div[data-testid="tweetPhoto"], div[data-testid="videoPlayer"]')) || getVideoMediaId(article);

  addVideoCandidate(candidates, video.currentSrc || video.src);
  video.querySelectorAll('source').forEach((source) => addVideoCandidate(candidates, source.src));

  [video, video.closest('div[data-testid="tweetPhoto"], div[data-testid="videoPlayer"]'), article].filter(Boolean).forEach((root) => {
    ['src', 'href', 'poster'].forEach((attr) => addVideoCandidate(candidates, root.getAttribute?.(attr)));
    root.querySelectorAll?.('[src], [href], [poster]').forEach((el) => {
      ['src', 'href', 'poster'].forEach((attr) => addVideoCandidate(candidates, el.getAttribute(attr)));
    });
  });

  getPerformanceVideoUrls(mediaId).forEach((url) => addVideoCandidate(candidates, url));
  return chooseBestVideoUrl([...candidates]);
}

async function getSyndicationVideoUrls(tweetId) {
  if (!tweetId) return [];
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'GET_TWEET_VIDEO_URLS', tweetId }, (response) => {
      if (chrome.runtime.lastError) {
        resolve([]);
        return;
      }
      resolve(response?.urls || []);
    });
  });
}

function addVideoCandidate(candidates, src) {
  if (!src || src.startsWith('blob:')) return;
  try {
    const url = new URL(src, location.href);
    if (url.hostname.includes('video.twimg.com') && url.pathname.match(/\.mp4$/i)) {
      url.hash = '';
      candidates.add(url.toString());
    }
  } catch (_) {}
}

function getVideoMediaId(root) {
  if (!root) return '';
  const values = [];
  ['src', 'currentSrc', 'href', 'poster'].forEach((prop) => {
    if (root[prop]) values.push(root[prop]);
    const attr = root.getAttribute?.(prop);
    if (attr) values.push(attr);
  });
  root.querySelectorAll?.('[src], [href], [poster]').forEach((el) => {
    ['src', 'href', 'poster'].forEach((attr) => {
      const value = el.getAttribute(attr);
      if (value) values.push(value);
    });
  });

  for (const value of values) {
    const match = value.match(/\/(?:ext_tw_video|amplify_video|tweet_video)(?:_thumb)?\/([^/?#]+)/);
    if (match) return match[1];
  }
  return '';
}

function getPerformanceVideoUrls(mediaId) {
  if (!mediaId) return [];
  if (!performance?.getEntriesByType) return [];
  return performance.getEntriesByType('resource')
    .map((entry) => entry.name)
    .filter((name) => name.includes('video.twimg.com') && name.match(/\.mp4(?:[?#]|$)/i))
    .filter((name) => !mediaId || name.includes(`/${mediaId}/`));
}

function chooseBestVideoUrl(urls) {
  return chooseBestVideoUrls(urls)[0] || '';
}

function chooseBestVideoUrls(urls) {
  return urls.sort((a, b) => getVideoScore(b) - getVideoScore(a));
}

function getVideoScore(url) {
  const match = url.match(/\/(\d+)x(\d+)\//);
  if (!match) return 0;
  return Number(match[1]) * Number(match[2]);
}

function collectMediaFromContainer(article, container) {
  const info = extractTweetInfo(article);
  const video = container.querySelector('video');
  if (video) {
    const url = getVideoUrlFromTarget(video, article);
    return url ? [{ type: 'video', url, username: info.username, tweetId: info.tweetId }] : [];
  }

  const img = container.querySelector('img');
  const orig = toOriginalUrl(img?.src || img?.currentSrc || '');
  if (orig && orig.includes('pbs.twimg.com')) {
    return [{ type: 'image', url: orig, username: info.username, tweetId: info.tweetId }];
  }
  return [];
}

async function collectMediaFromContainerAsync(article, container, fallbackVideoUrls = []) {
  const media = collectMediaFromContainer(article, container);
  if (media.length || !isVideoContainer(container)) return media;

  const info = extractTweetInfo(article);
  const url = fallbackVideoUrls.shift();
  return url ? [{ type: 'video', url, username: info.username, tweetId: info.tweetId }] : [];
}

// article 内の全メディア情報を収集する
function collectMedia(article) {
  const info = extractTweetInfo(article);
  const media = [];
  const seen = new Set();

  getMediaContainers(article).forEach((container) => {
    collectMediaFromContainer(article, container).forEach((item) => {
      const key = `${item.type}:${item.url}`;
      if (seen.has(key)) return;
      seen.add(key);
      media.push({ ...item, username: info.username, tweetId: info.tweetId });
    });
  });

  return media;
}

async function collectMediaAsync(article) {
  const info = extractTweetInfo(article);
  requestBridgeVideoUrls();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const fallbackVideoUrls = chooseBestVideoUrls([
    ...getCachedVideoUrls(info.tweetId),
    ...(await getSyndicationVideoUrls(info.tweetId)),
  ]);
  const media = [];
  const seen = new Set();

  const containers = getMediaContainers(article);
  for (const container of containers) {
    const items = await collectMediaFromContainerAsync(article, container, fallbackVideoUrls);
    items.forEach((item) => {
      const key = `${item.type}:${item.url}`;
      if (seen.has(key)) return;
      seen.add(key);
      media.push({ ...item, username: info.username, tweetId: info.tweetId });
    });
  }

  return media;
}

// ============================================================
// ダウンロードボタンのオーバーレイを注入する
// ============================================================
function injectOverlay(article) {
  article.setAttribute(XIV_ATTR, 'true');

  const photoContainers = getMediaContainers(article);
  photoContainers.forEach((container, idx) => {
    if (container.querySelector(`.${XIV_BTN_CLASS}-wrap`)) return;
    // コンテナが既に position: relative でなければ設定
    const cs = getComputedStyle(container);
    if (cs.position === 'static') {
      container.style.position = 'relative';
    }


    const wrap = document.createElement('div');
    wrap.className = `${XIV_BTN_CLASS}-wrap`;
    const initialMedia = collectMediaFromContainer(article, container)[0];
    const imageUrl = initialMedia?.url || '';
    wrap.dataset.mediaUrl = imageUrl;
    wrap.dataset.mediaType = initialMedia?.type || (isVideoContainer(container) ? 'video' : 'image');
    wrap.dataset.imageUrl = imageUrl;
    wrap.style.cssText = `
      position: absolute;
      top: 6px;
      right: 6px;
      z-index: 9999;
      display: ${state.settings.showOverlay ? 'flex' : 'none'};
      align-items: center;
      gap: 4px;
    `;

    const badge = document.createElement('span');
    badge.className = XIV_SAVED_BADGE_CLASS;
    badge.hidden = true;
    badge.textContent = '✓';
    badge.title = csT('savedImageBadgeTitle');
    badge.style.cssText = `
      min-width: 24px;
      height: 24px;
      border-radius: 9999px;
      background: rgba(22,163,74,0.92);
      color: #fff;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 15px;
      font-weight: 800;
      box-shadow: 0 1px 5px rgba(0,0,0,0.35);
      pointer-events: none;
      display: none;
    `;

    const btn = document.createElement('button');
    btn.className = XIV_BTN_CLASS;
    btn.title = csT('btnSaveImageTitle');
    btn.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
        <polyline points="7 10 12 15 17 10"/>
        <line x1="12" y1="15" x2="12" y2="3"/>
      </svg>
    `;
    btn.style.cssText = `
      background: rgba(0,0,0,0.65);
      border: none;
      border-radius: 6px;
      padding: 4px 6px;
      cursor: pointer;
      color: #fff;
      display: ${state.settings.showOverlay ? 'flex' : 'none'};
      align-items: center;
      justify-content: center;
      transition: background 0.15s;
    `;
    btn.addEventListener('mouseenter', () => {
      btn.style.background = 'rgba(0,0,0,0.9)';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.background = 'rgba(0,0,0,0.65)';
    });

    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const info = extractTweetInfo(article);
      requestBridgeVideoUrls();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const fallbackUrls = chooseBestVideoUrls([
        ...getCachedVideoUrls(info.tweetId),
        ...(await getSyndicationVideoUrls(info.tweetId)),
      ]);
      const media = await collectMediaFromContainerAsync(article, container, fallbackUrls);
      if (!media.length) return;
      wrap.dataset.mediaUrl = media[0].url;
      wrap.dataset.mediaType = media[0].type || 'image';
      wrap.dataset.imageUrl = media[0].url;
      chrome.runtime.sendMessage({
        type: 'START_DOWNLOAD',
        payload: media,
      });
    });

    wrap.appendChild(badge);
    wrap.appendChild(btn);
    container.appendChild(wrap);
    updateSavedMarker(wrap, state.savedMediaKeys.has(getMediaKey(refreshTargetImageUrl(wrap) || imageUrl)));
  });
  scheduleSavedMarkerRefresh();
}

// ============================================================
// 画像プレビューオーバーレイ
// ============================================================
const XIV_OVERLAY_ID = 'xiv-preview-overlay';
let overlayImages = [];
let currentOverlayIndex = 0;

function renderOverlay() {
  document.getElementById(XIV_OVERLAY_ID)?.remove();

  const images = overlayImages;
  const index = currentOverlayIndex;
  const imgInfo = images[index];
  const isMultiple = images.length > 1;

  const overlay = document.createElement('div');
  overlay.id = XIV_OVERLAY_ID;
  overlay.style.cssText = `
    position: fixed;
    inset: 0;
    z-index: 999999;
    background: rgba(0,0,0,0.88);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 20px;
    box-sizing: border-box;
    overflow: hidden;
    cursor: zoom-out;
  `;

  const mediaEl = document.createElement(imgInfo.type === 'video' ? 'video' : 'img');
  mediaEl.src = imgInfo.url;
  if (imgInfo.type === 'video') {
    mediaEl.controls = true;
    mediaEl.autoplay = true;
    mediaEl.loop = true;
  } else {
    mediaEl.alt = '';
  }
  mediaEl.style.cssText = `
    max-height: 90vh;
    max-width: 90vw;
    object-fit: contain;
    border-radius: 4px;
    cursor: default;
    box-shadow: 0 4px 24px rgba(0,0,0,0.6);
  `;
  mediaEl.addEventListener('click', (e) => e.stopPropagation());
  overlay.appendChild(mediaEl);

  const savedBadge = document.createElement('div');
  savedBadge.className = XIV_SAVED_BADGE_CLASS;
  savedBadge.dataset.mediaUrl = imgInfo.url;
  savedBadge.dataset.mediaType = imgInfo.type || 'image';
  savedBadge.hidden = !state.savedMediaKeys.has(getMediaKey(imgInfo.url));
  savedBadge.title = csT('savedImageBadgeTitle');
  savedBadge.textContent = '✓';
  savedBadge.style.cssText = `
    position: absolute;
    top: 16px;
    right: 16px;
    width: 34px;
    height: 34px;
    border-radius: 9999px;
    background: rgba(22,163,74,0.92);
    color: #fff;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 20px;
    font-weight: 800;
    box-shadow: 0 2px 12px rgba(0,0,0,0.35);
    pointer-events: none;
    display: none;
  `;
  overlay.appendChild(savedBadge);

  if (isMultiple) {
    // 画像カウンター
    const counter = document.createElement('div');
    counter.style.cssText = `
      position: absolute;
      top: 16px;
      left: 50%;
      transform: translateX(-50%);
      color: #fff;
      font-size: 14px;
      background: rgba(0,0,0,0.5);
      padding: 4px 12px;
      border-radius: 12px;
      pointer-events: none;
      user-select: none;
    `;
    counter.textContent = `${index + 1} / ${images.length}`;
    overlay.appendChild(counter);

    // ドットインジケーター
    const dots = document.createElement('div');
    dots.style.cssText = `
      position: absolute;
      bottom: 20px;
      left: 50%;
      transform: translateX(-50%);
      display: flex;
      gap: 8px;
      pointer-events: none;
    `;
    images.forEach((_, i) => {
      const dot = document.createElement('div');
      dot.style.cssText = `
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: ${i === index ? '#fff' : 'rgba(255,255,255,0.4)'};
      `;
      dots.appendChild(dot);
    });
    overlay.appendChild(dots);

    // キーヒント
    const hint = document.createElement('div');
    hint.style.cssText = `
      position: absolute;
      bottom: 44px;
      left: 50%;
      transform: translateX(-50%);
      color: rgba(255,255,255,0.5);
      font-size: 12px;
      pointer-events: none;
      user-select: none;
      white-space: nowrap;
    `;
    hint.textContent = 'j: 次の画像  k: 前の画像';
    overlay.appendChild(hint);
  }

  overlay.addEventListener('click', closeImageOverlay);
  document.body.appendChild(overlay);
  scheduleSavedMarkerRefresh();
}

function showImageOverlay(images, startIndex = 0) {
  closeImageOverlay();
  overlayImages = images;
  currentOverlayIndex = startIndex;
  renderOverlay();
}

function navigateOverlay(delta) {
  if (!document.getElementById(XIV_OVERLAY_ID) || overlayImages.length <= 1) return;
  currentOverlayIndex = (currentOverlayIndex + delta + overlayImages.length) % overlayImages.length;
  renderOverlay();
}

function closeImageOverlay() {
  document.getElementById(XIV_OVERLAY_ID)?.remove();
  overlayImages = [];
  currentOverlayIndex = 0;
}

function isTyping() {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
}

document.addEventListener('keydown', (e) => {
  const overlayOpen = !!document.getElementById(XIV_OVERLAY_ID);

  if (e.key === 'Escape') {
    closeImageOverlay();
    return;
  }

  // オーバーレイ表示中はj/kのデフォルト動作（Xのスクロール）を防止
  if (overlayOpen && (e.key === 'j' || e.key === 'k')) {
    e.preventDefault();
    e.stopPropagation();
    navigateOverlay(e.key === 'j' ? 1 : -1);
    return;
  }

  if (isTyping()) return;

  if (e.key === 'a' && !overlayOpen) {
    const article = state.focusedArticle;
    if (!article) return;
    const containers = getMediaContainers(article);
    const firstContainer = containers.find((c) => collectMediaFromContainer(article, c).length > 0 || isVideoContainer(c));
    if (!firstContainer) return;
    e.preventDefault();
    e.stopPropagation();
    collectMediaAsync(article).then((images) => {
      if (!images.length) return;
      const clickedIndex = containers.indexOf(firstContainer);
      showImageOverlay(images, clickedIndex >= 0 ? clickedIndex : 0);
    });
    return;
  }

  if (e.key === 'd') {
    if (overlayOpen) {
      chrome.runtime.sendMessage({ type: 'START_DOWNLOAD', payload: overlayImages });
    } else {
      const article = state.focusedArticle;
      if (!article) return;
      collectMediaAsync(article).then((images) => {
        if (images.length > 0) {
          chrome.runtime.sendMessage({ type: 'START_DOWNLOAD', payload: images });
        }
      });
    }
  }
}, { capture: true });

// documentレベルのキャプチャでXのリスナーより先に処理する
document.addEventListener('click', (e) => {
  // オーバーレイ内のクリックは別途処理
  if (e.target.closest(`#${XIV_OVERLAY_ID}`)) return;
  // ダウンロードボタンのクリックは除外
  if (e.target.closest(`.${XIV_BTN_CLASS}`)) return;

  const container = e.target.closest('div[data-testid="tweetPhoto"]');
  if (!container) return;
  if (isVideoContainer(container)) return;

  const article = e.target.closest('article[data-testid="tweet"]');
  if (!article) return;

  const images = collectMedia(article);
  if (images.length === 0 || !collectMediaFromContainer(article, container).length) return;

  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();

  // クリックした画像のインデックスを特定して初期表示位置に使う
  const mediaContainers = getMediaContainers(article);
  const clickedIndex = mediaContainers.indexOf(container);
  showImageOverlay(images, clickedIndex >= 0 ? clickedIndex : 0);
}, { capture: true });

// ============================================================
// イベントリスナー
// ============================================================
document.addEventListener('mouseover', (e) => {
  const img = e.target.closest('div[data-testid="tweetPhoto"] img, div[data-testid="tweetPhoto"] video, div[data-testid="videoPlayer"] video');
  state.hoveredImg = img || null;

  const article = e.target.closest('article[data-testid="tweet"]');
  state.hoveredArticle = article || null;
});

document.addEventListener('mouseout', (e) => {
  if (!e.relatedTarget || !e.relatedTarget.closest('article[data-testid="tweet"]')) {
    state.hoveredArticle = null;
    state.hoveredImg = null;
  }
});

document.addEventListener('focusin', (e) => {
  const article = e.target.closest('article[data-testid="tweet"]');
  if (article) state.focusedArticle = article;
});

// ============================================================
// background.js からのメッセージを処理
// ============================================================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'DOWNLOAD_HOVERED') {
    const target = state.hoveredArticle || state.focusedArticle;
    if (!target) {
      sendResponse({ images: [] });
      return false;
    }
    // ホバー中の画像が1枚だけの場合はそれだけ返す
    if (state.hoveredImg) {
      const info = extractTweetInfo(target);
      const container = state.hoveredImg.closest('div[data-testid="tweetPhoto"], div[data-testid="videoPlayer"]');
      requestBridgeVideoUrls();
      new Promise((resolve) => setTimeout(resolve, 100)).then(() => getSyndicationVideoUrls(info.tweetId)).then((fallbackUrls) => {
        fallbackUrls = chooseBestVideoUrls([...getCachedVideoUrls(info.tweetId), ...fallbackUrls]);
        const orig = state.hoveredImg.tagName === 'IMG' ? toOriginalUrl(state.hoveredImg.src || state.hoveredImg.currentSrc || '') : '';
        return container
          ? collectMediaFromContainerAsync(target, container, fallbackUrls)
          : Promise.resolve(orig ? [{ type: 'image', url: orig, username: info.username, tweetId: info.tweetId }] : []);
      }).then((media) => {
        sendResponse({ images: media });
      });
      return true;
    } else {
      collectMediaAsync(target).then((images) => sendResponse({ images }));
      return true;
    }
  }

  if (message.type === 'DOWNLOAD_ALL_IN_POST') {
    const target = state.hoveredArticle || state.focusedArticle;
    if (!target) {
      sendResponse({ images: [] });
      return false;
    }
    collectMediaAsync(target).then((images) => sendResponse({ images }));
    return true;
  }

  if (message.type === 'GET_CURRENT_IMAGES') {
    const target = state.hoveredArticle || state.focusedArticle;
    if (!target) {
      sendResponse({ images: [] });
      return false;
    }
    collectMediaAsync(target).then((images) => sendResponse({ images }));
    return true;
  }

  if (message.type === 'SETTINGS_UPDATED') {
    loadSettings();
    return false;
  }

  if (message.type === 'SAVED_IMAGES_UPDATED') {
    (message.keys || []).forEach((key) => state.savedMediaKeys.add(key));
    document.querySelectorAll('[data-media-url]').forEach((el) => {
      refreshTargetImageUrl(el);
      updateSavedMarker(el, state.savedMediaKeys.has(getMediaKey(el.dataset.mediaUrl)));
    });
    scheduleSavedMarkerRefresh();
    return false;
  }
});

// ============================================================
// MutationObserver でDOMの変化を監視してオーバーレイを注入
// ============================================================
function processNewArticles(root) {
  // root 自体が article の場合
  if (root.matches?.('article[data-testid="tweet"]')) {
    injectOverlay(root);
  }
  root.closest?.('article[data-testid="tweet"]') && injectOverlay(root.closest('article[data-testid="tweet"]'));
  // root 配下の article を探索
  root.querySelectorAll?.('article[data-testid="tweet"]').forEach((article) => {
    injectOverlay(article);
  });
}

const observer = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      processNewArticles(node);
    }
  }
});

observer.observe(document.body, { childList: true, subtree: true });

// ページ遷移時にホバー状態をリセット（X は SPA）
window.addEventListener('popstate', () => {
  state.hoveredArticle = null;
  state.hoveredImg = null;
  state.focusedArticle = null;
});

// 初期化: 言語ロード完了後に既存 article を処理
loadSettings().then(() => {
  processNewArticles(document.body);
});
