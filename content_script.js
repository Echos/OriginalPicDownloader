// content_script.js
// XのDOMを監視し、画像URLを取得・変換してダウンロードボタンを注入する

const XIV_ATTR = 'data-xiv-processed';
const XIV_BTN_CLASS = 'xiv-dl-btn';

// ホバー・フォーカス状態を追跡する
const state = {
  hoveredArticle: null,
  hoveredImg: null,
  focusedArticle: null,
  settings: {
    showOverlay: true,
  },
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
  const s = await chrome.storage.sync.get({ showOverlay: true, language: 'ja' });
  state.settings = s;
  await loadCsMessages(s.language || 'ja');
  // showOverlay 変更時にオーバーレイの表示/非表示を切り替え
  document.querySelectorAll(`.${XIV_BTN_CLASS}-wrap`).forEach((el) => {
    el.style.display = s.showOverlay ? '' : 'none';
  });
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

// article 内の全画像情報を収集する
function collectImages(article) {
  const info = extractTweetInfo(article);
  const imgs = [];

  article.querySelectorAll('div[data-testid="tweetPhoto"] img').forEach((img) => {
    const orig = toOriginalUrl(img.src || img.currentSrc || '');
    if (orig && orig.includes('pbs.twimg.com')) {
      imgs.push({ url: orig, username: info.username, tweetId: info.tweetId });
    }
  });

  return imgs;
}

// ============================================================
// ダウンロードボタンのオーバーレイを注入する
// ============================================================
function injectOverlay(article) {
  if (article.hasAttribute(XIV_ATTR)) return;
  article.setAttribute(XIV_ATTR, 'true');

  const photoContainers = article.querySelectorAll('div[data-testid="tweetPhoto"]');
  photoContainers.forEach((container, idx) => {
    // コンテナが既に position: relative でなければ設定
    const cs = getComputedStyle(container);
    if (cs.position === 'static') {
      container.style.position = 'relative';
    }


    const wrap = document.createElement('div');
    wrap.className = `${XIV_BTN_CLASS}-wrap`;
    wrap.style.cssText = `
      position: absolute;
      top: 6px;
      right: 6px;
      z-index: 9999;
      display: ${state.settings.showOverlay ? '' : 'none'};
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
      display: flex;
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

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const img = container.querySelector('img');
      if (!img) return;
      const info = extractTweetInfo(article);
      const orig = toOriginalUrl(img.src || img.currentSrc || '');
      if (!orig) return;
      chrome.runtime.sendMessage({
        type: 'START_DOWNLOAD',
        payload: [{ url: orig, username: info.username, tweetId: info.tweetId }],
      });
    });

    wrap.appendChild(btn);
    container.appendChild(wrap);
  });
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

  const img = document.createElement('img');
  img.src = imgInfo.url;
  img.style.cssText = `
    max-height: 90vh;
    max-width: 90vw;
    object-fit: contain;
    border-radius: 4px;
    cursor: default;
    box-shadow: 0 4px 24px rgba(0,0,0,0.6);
  `;
  img.addEventListener('click', (e) => e.stopPropagation());
  overlay.appendChild(img);

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

  if (e.key === 'd' && overlayOpen) {
    chrome.runtime.sendMessage({ type: 'START_DOWNLOAD', payload: overlayImages });
    return;
  }
  if (e.key === 'b') {
    const article = state.focusedArticle;
    if (!article) return;
    const images = collectImages(article);
    if (images.length > 0) {
      chrome.runtime.sendMessage({ type: 'START_DOWNLOAD', payload: images });
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

  const article = e.target.closest('article[data-testid="tweet"]');
  if (!article) return;

  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();

  const images = collectImages(article);
  if (images.length === 0) return;

  // クリックした画像のインデックスを特定して初期表示位置に使う
  const photoContainers = [...article.querySelectorAll('div[data-testid="tweetPhoto"]')];
  const clickedIndex = photoContainers.indexOf(container);
  showImageOverlay(images, clickedIndex >= 0 ? clickedIndex : 0);
}, { capture: true });

// ============================================================
// イベントリスナー
// ============================================================
document.addEventListener('mouseover', (e) => {
  const img = e.target.closest('div[data-testid="tweetPhoto"] img');
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
      const orig = toOriginalUrl(state.hoveredImg.src || state.hoveredImg.currentSrc || '');
      sendResponse({
        images: orig ? [{ url: orig, username: info.username, tweetId: info.tweetId }] : [],
      });
    } else {
      sendResponse({ images: collectImages(target) });
    }
    return false;
  }

  if (message.type === 'DOWNLOAD_ALL_IN_POST') {
    const target = state.hoveredArticle || state.focusedArticle;
    sendResponse({ images: target ? collectImages(target) : [] });
    return false;
  }

  if (message.type === 'GET_CURRENT_IMAGES') {
    const target = state.hoveredArticle || state.focusedArticle;
    sendResponse({ images: target ? collectImages(target) : [] });
    return false;
  }

  if (message.type === 'SETTINGS_UPDATED') {
    loadSettings();
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
