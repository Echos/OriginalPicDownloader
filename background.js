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
const pendingSavedImageKeys = new Set();

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
    getSavedImageStatus(message.payload || []).then((saved) => {
      sendResponse({ saved });
    });
    return true;
  }

  return false;
});

// ダウンロード処理
async function handleDownloads(images) {
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  const savedImages = await getSavedImages();
  const newlySavedKeys = [];
  let skipped = 0;

  for (let i = 0; i < images.length; i++) {
    const imageKey = getImageKey(images[i].url);
    if (settings.skipSavedImages && imageKey && (savedImages[imageKey] || pendingSavedImageKeys.has(imageKey))) {
      skipped++;
      continue;
    }
    if (settings.skipSavedImages && imageKey) {
      pendingSavedImageKeys.add(imageKey);
    }

    const filename = buildFilename(settings, images[i], i, images.length);
    const url = toPreferredUrl(images[i].url, settings.preferFormat);

    await new Promise((resolve) => {
      setTimeout(() => {
        chrome.downloads.download(
          {
            url,
            filename,
            conflictAction: 'uniquify',
            saveAs: settings.askBeforeSave,
          },
          (downloadId) => {
            if (chrome.runtime.lastError) {
              console.warn('[XIVb] download error:', chrome.runtime.lastError.message);
              if (imageKey) pendingSavedImageKeys.delete(imageKey);
            } else if (downloadId && imageKey) {
              savedImages[imageKey] = Date.now();
              newlySavedKeys.push(imageKey);
            }
            resolve();
          }
        );
      }, i * 150); // 複数画像を150ms間隔で逐次ダウンロード
    });
  }

  if (newlySavedKeys.length > 0) {
    await chrome.storage.local.set({ [SAVED_IMAGES_KEY]: savedImages });
    notifySavedImagesUpdated(newlySavedKeys);
  }
  newlySavedKeys.forEach((key) => pendingSavedImageKeys.delete(key));

  return { saved: newlySavedKeys.length, skipped };
}

async function getSavedImages() {
  const result = await chrome.storage.local.get({ [SAVED_IMAGES_KEY]: {} });
  return result[SAVED_IMAGES_KEY] || {};
}

async function getSavedImageStatus(images) {
  const savedImages = await getSavedImages();
  return images.map((image) => {
    const key = getImageKey(typeof image === 'string' ? image : image.url);
    return Boolean(key && savedImages[key]);
  });
}

async function notifySavedImagesUpdated(keys) {
  const tabs = await chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] });
  for (const tab of tabs) {
    if (!tab.id) continue;
    chrome.tabs.sendMessage(tab.id, { type: 'SAVED_IMAGES_UPDATED', keys }).catch(() => {});
  }
}

function getImageKey(src) {
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

// ファイル名を生成する
function buildFilename(settings, info, index, total) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const padWidth = total >= 10 ? 2 : 1;
  const ext = getExtFromUrl(info.url);

  const name = settings.pattern
    .replace(/{username}/g, sanitizeFilename(info.username || 'unknown'))
    .replace(/{tweetId}/g, info.tweetId || Date.now().toString())
    .replace(/{index}/g, String(index + 1).padStart(padWidth, '0'))
    .replace(/{timestamp}/g, timestamp);

  const dir = settings.saveDir.replace(/[/\\]+$/, ''); // 末尾スラッシュを除去
  return `${dir}/${name}.${ext}`;
}

// URLから拡張子を取得する
function getExtFromUrl(url) {
  try {
    const u = new URL(url);
    const fmt = u.searchParams.get('format');
    if (fmt) return fmt === 'png' ? 'png' : 'jpg';
    const path = u.pathname;
    const match = path.match(/\.(jpg|jpeg|png|webp|gif)$/i);
    if (match) return match[1].toLowerCase();
  } catch (_) {}
  return 'jpg';
}

// 設定に応じてURLのformatを調整する
function toPreferredUrl(src, preferFormat) {
  try {
    const url = new URL(src);
    if (!url.hostname.includes('pbs.twimg.com')) return src;

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
