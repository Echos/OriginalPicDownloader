// options.js - 設定画面の読み書き

const DEFAULT_SETTINGS = {
  pattern: '{username}_{tweetId}_{index}',
  saveDir: 'X-Images',
  askBeforeSave: false,
  showOverlay: true,
  preferFormat: 'orig',
};

const form = document.getElementById('settings-form');
const savedMsg = document.getElementById('saved-msg');

// 設定をフォームに反映する
async function loadSettings() {
  const settings = await chrome.storage.sync.get({ ...DEFAULT_SETTINGS, language: DEFAULT_LANG });

  document.getElementById('pattern').value = settings.pattern;
  document.getElementById('saveDir').value = settings.saveDir;
  document.getElementById('preferFormat').value = settings.preferFormat;
  document.getElementById('showOverlay').checked = settings.showOverlay;
  document.getElementById('askBeforeSave').checked = settings.askBeforeSave;
  document.getElementById('language').value = SUPPORTED_LANGS.includes(settings.language)
    ? settings.language
    : DEFAULT_LANG;
}

// フォームの値を保存する
form.addEventListener('submit', async (e) => {
  e.preventDefault();

  const settings = {
    pattern: document.getElementById('pattern').value.trim() || DEFAULT_SETTINGS.pattern,
    saveDir: document.getElementById('saveDir').value.trim() || DEFAULT_SETTINGS.saveDir,
    preferFormat: document.getElementById('preferFormat').value,
    showOverlay: document.getElementById('showOverlay').checked,
    askBeforeSave: document.getElementById('askBeforeSave').checked,
    language: document.getElementById('language').value,
  };

  await chrome.storage.sync.set(settings);

  // アクティブなタブの content_script に設定更新を通知
  const tabs = await chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] });
  for (const tab of tabs) {
    chrome.tabs.sendMessage(tab.id, { type: 'SETTINGS_UPDATED' }).catch(() => {});
  }

  // 保存完了メッセージを表示
  savedMsg.hidden = false;
  setTimeout(() => { savedMsg.hidden = true; }, 2000);
});

// 言語セレクタ変更時に即時リロードして反映
document.getElementById('language').addEventListener('change', async (e) => {
  await chrome.storage.sync.set({ language: e.target.value });
  location.reload();
});

// トークンクリックでカーソル位置に挿入する
document.querySelectorAll('.token').forEach((token) => {
  token.addEventListener('click', () => {
    const input = document.getElementById('pattern');
    const val = token.dataset.token;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    input.value = input.value.slice(0, start) + val + input.value.slice(end);
    input.selectionStart = input.selectionEnd = start + val.length;
    input.focus();
  });
});

// i18n 初期化後に描画・設定ロード
(async () => {
  await i18nInit();
  applyI18n();
  await loadSettings();
})();
