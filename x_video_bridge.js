(() => {
  const MESSAGE_TYPE = 'XIV_VIDEO_URLS';
  const REQUEST_TYPE = 'XIV_REQUEST_VIDEO_URLS';
  const knownUrls = new Set();
  const knownTweetIds = new Set();

  function postVideoUrls(payload) {
    const urls = collectVideoUrls(payload);
    if (!urls.length) return;
    urls.forEach((url) => knownUrls.add(url));
    collectTweetIds(payload).forEach((tweetId) => knownTweetIds.add(tweetId));
    window.postMessage({
      source: 'x-image-viewer',
      type: MESSAGE_TYPE,
      urls: [...knownUrls],
      tweetIds: [...knownTweetIds],
    }, '*');
  }

  function collectVideoUrls(value, urls = new Set()) {
    if (!value) return [];
    if (typeof value === 'string') {
      addVideoUrl(urls, value);
      return [...urls];
    }
    if (Array.isArray(value)) {
      value.forEach((item) => collectVideoUrls(item, urls));
      return [...urls];
    }
    if (typeof value === 'object') {
      Object.values(value).forEach((item) => collectVideoUrls(item, urls));
    }
    return [...urls];
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

  function collectTweetIds(value, ids = new Set()) {
    if (!value || typeof value !== 'object') return [...ids];
    if (Array.isArray(value)) {
      value.forEach((item) => collectTweetIds(item, ids));
      return [...ids];
    }

    ['rest_id', 'conversation_id_str', 'id_str'].forEach((key) => {
      if (typeof value[key] === 'string' && /^\d{10,}$/.test(value[key])) {
        ids.add(value[key]);
      }
    });

    Object.values(value).forEach((item) => collectTweetIds(item, ids));
    return [...ids];
  }

  function inspectText(text) {
    if (!text || !text.includes('video.twimg.com')) return;
    try {
      postVideoUrls(JSON.parse(text));
    } catch (_) {
      postVideoUrls(text);
    }
  }

  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = async (...args) => {
      const response = await originalFetch.apply(window, args);
      try {
        response.clone().text().then(inspectText).catch(() => {});
      } catch (_) {}
      return response;
    };
  }

  const OriginalXHR = window.XMLHttpRequest;
  if (typeof OriginalXHR === 'function') {
    window.XMLHttpRequest = function XMLHttpRequest() {
      const xhr = new OriginalXHR();
      xhr.addEventListener('load', () => {
        try {
          if (typeof xhr.responseText === 'string') inspectText(xhr.responseText);
        } catch (_) {}
      });
      return xhr;
    };
    window.XMLHttpRequest.prototype = OriginalXHR.prototype;
    Object.setPrototypeOf(window.XMLHttpRequest, OriginalXHR);
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.source !== 'x-image-viewer' || event.data?.type !== REQUEST_TYPE) return;
    if (!knownUrls.size) return;
    window.postMessage({
      source: 'x-image-viewer',
      type: MESSAGE_TYPE,
      urls: [...knownUrls],
      tweetIds: [...knownTweetIds],
    }, '*');
  });
})();
