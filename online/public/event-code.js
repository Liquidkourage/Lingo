(function (global) {
  const STORAGE_KEY = "lingo_event_code";
  const DEFAULT_EVENT_CODE = "default";

  function normalizeEventCode(value) {
    const code = String(value || "").trim().toLowerCase();
    return code || DEFAULT_EVENT_CODE;
  }

  function currentEventCode() {
    const fromUrl = new URLSearchParams(global.location.search).get("event");
    if (fromUrl && fromUrl.trim()) {
      const code = normalizeEventCode(fromUrl);
      try {
        global.localStorage.setItem(STORAGE_KEY, code);
      } catch (_error) {
        // Ignore storage failures.
      }
      return code;
    }
    try {
      return normalizeEventCode(global.localStorage.getItem(STORAGE_KEY));
    } catch (_error) {
      return DEFAULT_EVENT_CODE;
    }
  }

  function withEventQuery(url) {
    const code = currentEventCode();
    if (code === DEFAULT_EVENT_CODE) {
      return url;
    }
    const separator = url.includes("?") ? "&" : "?";
    return `${url}${separator}event=${encodeURIComponent(code)}`;
  }

  function eventJson(body) {
    const code = currentEventCode();
    if (code === DEFAULT_EVENT_CODE) {
      return body || {};
    }
    return { ...(body || {}), eventCode: code };
  }

  global.LingoEvent = {
    DEFAULT_EVENT_CODE,
    current: currentEventCode,
    withEventQuery,
    eventJson,
  };
})(window);
