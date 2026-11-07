// background.js - Service Worker
// ショートカットキー受信・ダウンロード処理を担当

const DEFAULT_SETTINGS = {
  pattern: '{username}_{tweetId}_{index}',
  saveDir: 'X-Images',
  askBeforeSave: false,
  showOverlay: true,
  preferFormat: 'orig',
  skipSavedImages: false,
};

const SAVED_IMAGES_KEY = 'savedImages';
const SAVED_MEDIA_KEY = 'savedMedia';
const DOWNLOAD_INTERVAL_MS = 150;
const pendingSavedMediaKeys = new Set();
let savedMediaWriteQueue = Promise.resolve();

// 開始後に中断したダウンロードは保存済みの記録から取り消す
chrome.downloads.onChanged.addListener(async (delta) => {
  if (delta.state?.current !== 'interrupted') return;
  const [item] = await chrome.downloads.search({ id: delta.id });
  if (item?.byExtensionId !== chrome.runtime.id) return;

  const mediaKey = getMediaKey(item.url);
  const startedAt = Date.parse(item.startTime);
  let removed = false;
  // 今回より前に保存を完了している場合は記録を残す
  await updateSavedMedia((savedMedia) => {
    if (savedMedia[mediaKey] >= startedAt) {
      delete savedMedia[mediaKey];
      removed = true;
    }
  });
  if (removed) notifyTabs('SAVED_IMAGES_REMOVED', [mediaKey]);
});

// ショートカットキーのコマンドを受信
chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  let messageType = null;
  if (command === 'download-hovered-image') messageType = 'DOWNLOAD_HOVERED';
  if (command === 'download-all-images-in-post') messageType = 'DOWNLOAD_ALL_IN_POST';
  if (!messageType) return;

  chrome.tabs.sendMessage(tab.id, { type: messageType }, (response) => {
    if (chrome.runtime.lastError) {
      console.warn('[XIVb] sendMessage error:', chrome.runtime.lastError.message);
      return;
    }
    if (!response?.images?.length) return;
    handleDownloads(response.images);
  });
});

// content_script からのメッセージを受信
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'START_DOWNLOAD') {
    handleDownloads(message.payload).then((result) => {
      sendResponse({ ok: true, ...result });
    });
    return true;
  }

  if (message.type === 'GET_SAVED_IMAGE_STATUS') {
    getSavedMediaStatus(message.payload || []).then((saved) => {
      sendResponse({ saved });
    });
    return true;
  }

  if (message.type === 'GET_TWEET_VIDEO_URLS') {
    getTweetVideoUrls(message.tweetId).then((urls) => {
      sendResponse({ urls });
    });
    return true;
  }

  return false;
});

// ダウンロード処理
async function handleDownloads(images) {
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  let saved = 0;
  let skipped = 0;
  let started = 0;

  for (let i = 0; i < images.length; i++) {
    const mediaKey = getMediaKey(images[i].url);
    if (settings.skipSavedImages && mediaKey) {
      const savedMedia = await getSavedMedia();
      if (savedMedia[mediaKey] || pendingSavedMediaKeys.has(mediaKey)) {
        skipped++;
        continue;
      }
      pendingSavedMediaKeys.add(mediaKey);
    }

    // 複数画像を一定間隔で逐次ダウンロード
    if (started++ > 0) await new Promise((resolve) => setTimeout(resolve, DOWNLOAD_INTERVAL_MS));

    const filename = buildFilename(settings, images[i], i, images.length);
    const url = toPreferredUrl(images[i].url, settings.preferFormat, images[i].type);
    const downloadId = await new Promise((resolve) => {
      chrome.downloads.download(
        {
          url,
          filename,
          conflictAction: 'uniquify',
          saveAs: settings.askBeforeSave,
        },
        (id) => {
          if (chrome.runtime.lastError) {
            console.warn('[XIVb] download error:', chrome.runtime.lastError.message);
            resolve(null);
            return;
          }
          resolve(id);
        }
      );
    });

    if (downloadId) saved++;
    if (mediaKey) {
      // 全件の完了を待たず、1件ごとに記録して画面へ反映する
      if (downloadId) {
        await updateSavedMedia((savedMedia) => {
          savedMedia[mediaKey] ||= Date.now();
        });
      }
      notifyTabs(downloadId ? 'SAVED_IMAGES_UPDATED' : 'SAVED_IMAGES_REMOVED', [mediaKey]);
      pendingSavedMediaKeys.delete(mediaKey);
    }
  }

  return { saved, skipped };
}

async function getSavedMedia() {
  const result = await chrome.storage.local.get({ [SAVED_IMAGES_KEY]: {}, [SAVED_MEDIA_KEY]: {} });
  return { ...(result[SAVED_IMAGES_KEY] || {}), ...(result[SAVED_MEDIA_KEY] || {}) };
}

// 並行する保存が互いの記録を上書きしないよう、読み書きを直列化する
function updateSavedMedia(mutate) {
  const task = savedMediaWriteQueue.then(async () => {
    const savedMedia = await getSavedMedia();
    mutate(savedMedia);
    await chrome.storage.local.set({ [SAVED_MEDIA_KEY]: savedMedia });
  });
  savedMediaWriteQueue = task.catch(() => {});
  return task;
}

async function getSavedMediaStatus(images) {
  const savedMedia = await getSavedMedia();
  return images.map((image) => {
    const key = getMediaKey(typeof image === 'string' ? image : image.url);
    return Boolean(key && savedMedia[key]);
  });
}

async function notifyTabs(type, keys) {
  const tabs = await chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] });
  for (const tab of tabs) {
    if (!tab.id) continue;
    chrome.tabs.sendMessage(tab.id, { type, keys }).catch(() => {});
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

async function getTweetVideoUrls(tweetId) {
  if (!tweetId) return [];
  try {
    const res = await fetch(`https://cdn.syndication.twimg.com/tweet-result?id=${encodeURIComponent(tweetId)}&lang=ja`);
    if (!res.ok) return [];
    const data = await res.json();
    return extractVideoUrlsFromObject(data);
  } catch (_) {
    return [];
  }
}

function extractVideoUrlsFromObject(value, urls = new Set()) {
  if (!value) return [];
  if (typeof value === 'string') {
    addVideoUrl(urls, value);
    return chooseBestVideoUrls([...urls]);
  }
  if (Array.isArray(value)) {
    value.forEach((item) => extractVideoUrlsFromObject(item, urls));
    return chooseBestVideoUrls([...urls]);
  }
  if (typeof value === 'object') {
    Object.values(value).forEach((item) => extractVideoUrlsFromObject(item, urls));
  }
  return chooseBestVideoUrls([...urls]);
}

function addVideoUrl(urls, src) {
  try {
    const url = new URL(src);
    if (url.hostname.includes('video.twimg.com') && url.pathname.match(/\.mp4$/i)) {
      url.hash = '';
      urls.add(url.toString());
    }
  } catch (_) {}
}

function chooseBestVideoUrls(urls) {
  return urls.sort((a, b) => getVideoScore(b) - getVideoScore(a));
}

function getVideoScore(url) {
  const match = url.match(/\/(\d+)x(\d+)\//);
  if (!match) return 0;
  return Number(match[1]) * Number(match[2]);
}

// ファイル名を生成する
function buildFilename(settings, info, index, total) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const padWidth = total >= 10 ? 2 : 1;
  const ext = getExtFromUrl(info.url, info.type);

  const name = settings.pattern
    .replace(/{username}/g, sanitizeFilename(info.username || 'unknown'))
    .replace(/{tweetId}/g, info.tweetId || Date.now().toString())
    .replace(/{index}/g, String(index + 1).padStart(padWidth, '0'))
    .replace(/{timestamp}/g, timestamp);

  const dir = settings.saveDir.replace(/[/\\]+$/, ''); // 末尾スラッシュを除去
  return `${dir}/${name}.${ext}`;
}

// URLから拡張子を取得する
function getExtFromUrl(url, type = 'image') {
  if (type === 'video') return 'mp4';
  try {
    const u = new URL(url);
    const fmt = u.searchParams.get('format');
    if (fmt) return fmt === 'png' ? 'png' : 'jpg';
    const path = u.pathname;
    const match = path.match(/\.(jpg|jpeg|png|webp|gif|mp4|mov|webm)$/i);
    if (match) return match[1].toLowerCase();
  } catch (_) {}
  return 'jpg';
}

// 設定に応じてURLのformatを調整する
function toPreferredUrl(src, preferFormat, type = 'image') {
  try {
    const url = new URL(src);
    if (type === 'video' || !url.hostname.includes('pbs.twimg.com')) return src;

    // name パラメータを orig に固定
    url.searchParams.set('name', 'orig');

    // preferFormat が orig 以外の場合はフォーマットを変換
    if (preferFormat === 'jpg') {
      url.searchParams.set('format', 'jpg');
    } else if (preferFormat === 'png') {
      url.searchParams.set('format', 'png');
    }
    return url.toString();
  } catch (_) {
    return src;
  }
}

// ファイル名に使えない文字を除去する
function sanitizeFilename(str) {
  return str.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 64);
}
