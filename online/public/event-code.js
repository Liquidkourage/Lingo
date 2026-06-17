(function (global) {
  const STORAGE_KEY = "lingo_join_code";
  const LEGACY_STORAGE_KEY = "lingo_event_code";
  const DEFAULT_EVENT_CODE = "default";

  function normalizeJoinCode(value) {
    return String(value || "").trim().toLowerCase();
  }

  function isJoinCodeFormat(value) {
    const code = normalizeJoinCode(value);
    return code === DEFAULT_EVENT_CODE || /^[a-z]{5}$/.test(code);
  }

  function resolveJoinCodeFromUrl() {
    const params = new URLSearchParams(global.location.search);
    const fromJoin = params.get("join") || params.get("code") || params.get("event");
    if (fromJoin && fromJoin.trim()) {
      return normalizeJoinCode(fromJoin);
    }
    const match = String(global.location.pathname || "").match(/^\/join\/([a-z]{5})$/i);
    if (match) {
      return normalizeJoinCode(match[1]);
    }
    return "";
  }

  function rememberJoinCode(code) {
    const normalized = normalizeJoinCode(code);
    if (!normalized || normalized === DEFAULT_EVENT_CODE) {
      return normalized;
    }
    try {
      global.localStorage.setItem(STORAGE_KEY, normalized);
      global.localStorage.setItem(LEGACY_STORAGE_KEY, normalized);
    } catch (_error) {
      // Ignore storage failures.
    }
    return normalized;
  }

  function storedJoinCode() {
    try {
      return normalizeJoinCode(
        global.localStorage.getItem(STORAGE_KEY)
        || global.localStorage.getItem(LEGACY_STORAGE_KEY),
      );
    } catch (_error) {
      return "";
    }
  }

  function hasExplicitJoinCode() {
    return Boolean(resolveJoinCodeFromUrl());
  }

  function currentEventCode() {
    const fromUrl = resolveJoinCodeFromUrl();
    if (fromUrl) {
      return rememberJoinCode(fromUrl);
    }
    const stored = storedJoinCode();
    if (stored && stored !== DEFAULT_EVENT_CODE) {
      return stored;
    }
    return DEFAULT_EVENT_CODE;
  }

  function withJoinQuery(url, code = currentEventCode()) {
    const normalized = normalizeJoinCode(code);
    if (!normalized || normalized === DEFAULT_EVENT_CODE) {
      return url;
    }
    const separator = url.includes("?") ? "&" : "?";
    return `${url}${separator}join=${encodeURIComponent(normalized)}`;
  }

  function withEventQuery(url) {
    return withJoinQuery(url);
  }

  function eventJson(body, code = currentEventCode()) {
    const normalized = normalizeJoinCode(code);
    if (!normalized || normalized === DEFAULT_EVENT_CODE) {
      return body || {};
    }
    return { ...(body || {}), join: normalized, eventCode: normalized };
  }

  function applyJoinCode(code, options = {}) {
    const normalized = normalizeJoinCode(code);
    if (!isJoinCodeFormat(normalized)) {
      throw new Error("Join code must be exactly 5 letters.");
    }
    rememberJoinCode(normalized);
    if (options.updateUrl === false) {
      return normalized;
    }
    const url = new URL(global.location.href);
    if (normalized === DEFAULT_EVENT_CODE) {
      url.searchParams.delete("join");
      url.searchParams.delete("event");
      url.searchParams.delete("code");
    } else {
      url.searchParams.set("join", normalized);
      url.searchParams.delete("event");
      url.searchParams.delete("code");
    }
    global.history.replaceState({}, "", url);
    return normalized;
  }

  function formatJoinCodeDisplay(code = currentEventCode()) {
    const normalized = normalizeJoinCode(code);
    if (!normalized || normalized === DEFAULT_EVENT_CODE) {
      return "";
    }
    return normalized.toUpperCase();
  }

  global.TypeoEvent = {
    DEFAULT_EVENT_CODE,
    applyJoinCode,
    current: currentEventCode,
    eventJson,
    formatJoinCodeDisplay,
    hasExplicitJoinCode,
    isJoinCodeFormat,
    rememberJoinCode,
    resolveJoinCodeFromUrl,
    storedJoinCode,
    withEventQuery,
    withJoinQuery,
  };
})(window);
