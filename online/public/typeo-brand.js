(function (global) {
  const MARKUP = '<span class="brand-typeo-type">TYPE</span><span class="brand-typeo-o">O</span>';

  function html(suffix = "") {
    return `${MARKUP}${suffix}`;
  }

  global.TypeoBrand = {
    html,
    plain: "TYPEO",
    wrap(className = "brand-typeo") {
      return `<span class="${className}">${MARKUP}</span>`;
    },
    wrapWith(suffix = "", className = "brand-typeo") {
      return `<span class="${className}">${html(suffix)}</span>`;
    },
  };
})(window);
