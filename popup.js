// popup.js - ポップアップのプレビューとダウンロード

let currentImages = [];

const statusArea = document.getElementById('status-area');
const imageGrid = document.getElementById('image-grid');
const footer = document.getElementById('footer');
const downloadAllBtn = document.getElementById('download-all-btn');
const imageCount = document.getElementById('image-count');

// アクティブタブの content_script に画像一覧を問い合わせる
async function fetchImages() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    showStatus(t('statusNotXTab'));
    return;
  }

  const isXTab = tab.url?.includes('x.com') || tab.url?.includes('twitter.com');
  if (!isXTab) {
    showStatus(t('statusOpenX'));
    return;
  }

  chrome.tabs.sendMessage(tab.id, { type: 'GET_CURRENT_IMAGES' }, (response) => {
    if (chrome.runtime.lastError) {
      showStatus(t('statusLoading'));
      return;
    }
    renderImages(response?.images ?? []);
  });
}

function showStatus(msg) {
  statusArea.textContent = msg;
  statusArea.hidden = false;
  imageGrid.hidden = true;
  footer.hidden = true;
}

function renderImages(images) {
  currentImages = images;

  if (!images.length) {
    showStatus(t('statusHoverPrompt'));
    return;
  }

  statusArea.hidden = true;
  imageGrid.hidden = false;
  footer.hidden = false;
  imageGrid.innerHTML = '';
  imageCount.textContent = t('imageCount', [images.length.toString()]);
  downloadAllBtn.disabled = false;

  images.forEach((imgInfo, idx) => {
    const item = document.createElement('div');
    item.className = 'preview-item';

    const img = document.createElement('img');
    img.src = imgInfo.url;
    img.alt = t('imageAlt', [(idx + 1).toString()]);
    img.loading = 'lazy';

    const btn = document.createElement('button');
    btn.className = 'item-dl-btn';
    btn.title = t('btnSaveThis');
    btn.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
           fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
        <polyline points="7 10 12 15 17 10"/>
        <line x1="12" y1="15" x2="12" y2="3"/>
      </svg>
    `;
    btn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'START_DOWNLOAD', payload: [imgInfo] });
    });

    item.appendChild(img);
    item.appendChild(btn);
    imageGrid.appendChild(item);
  });
}

document.getElementById('support-btn').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://ko-fi.com/echos0507' });
});

downloadAllBtn.addEventListener('click', () => {
  if (!currentImages.length) return;
  chrome.runtime.sendMessage({ type: 'START_DOWNLOAD', payload: currentImages });
  downloadAllBtn.textContent = t('btnDownloading');
  downloadAllBtn.disabled = true;
  setTimeout(() => window.close(), 800);
});

// i18n 初期化後に描画・データ取得
(async () => {
  await i18nInit();
  applyI18n();
  fetchImages();
})();
