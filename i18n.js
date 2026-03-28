// i18n.js - 言語設定ユーティリティ (popup / options 共通)

const SUPPORTED_LANGS = ['ja', 'en'];
const DEFAULT_LANG = 'ja';

let _messages = {};

async function i18nInit() {
  const { language } = await chrome.storage.sync.get({ language: DEFAULT_LANG });
  const lang = SUPPORTED_LANGS.includes(language) ? language : DEFAULT_LANG;
  await _loadMessages(lang);
  return lang;
}

async function _loadMessages(lang) {
  const url = chrome.runtime.getURL(`_locales/${lang}/messages.json`);
  const res = await fetch(url);
  _messages = await res.json();
}

// chrome.i18n 互換: $PLACEHOLDER$ 形式の置換に対応
function t(key, substitutions = []) {
  const entry = _messages[key];
  if (!entry) return key;
  let msg = entry.message;
  if (entry.placeholders) {
    for (const [name, ph] of Object.entries(entry.placeholders)) {
      const idx = parseInt(ph.content.replace('$', '')) - 1;
      if (substitutions[idx] !== undefined) {
        msg = msg.replace(new RegExp(`\\$${name.toUpperCase()}\\$`, 'g'), substitutions[idx]);
      }
    }
  }
  return msg;
}

function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const msg = t(el.dataset.i18n);
    if (msg) el.textContent = msg;
  });
  document.querySelectorAll('[data-i18n-html]').forEach((el) => {
    const msg = t(el.dataset.i18nHtml);
    if (msg) el.innerHTML = msg;
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    const msg = t(el.dataset.i18nPlaceholder);
    if (msg) el.placeholder = msg;
  });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    const msg = t(el.dataset.i18nTitle);
    if (msg) el.title = msg;
  });
}
