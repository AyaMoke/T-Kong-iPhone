(() => {
  "use strict";

  const PACKAGE = "jp.co.rakuten_sec.ispeed";
  const PLAY_URL = "https://play.google.com/store/apps/details?id=" + PACKAGE;
  const INTENT =
    "intent://launch#Intent;scheme=ispeed;package=" +
    PACKAGE +
    ";S.browser_fallback_url=" +
    encodeURIComponent(PLAY_URL) +
    ";end";

  function tryOpenBrokerApp() {
    try {
      const anchor = document.createElement("a");
      anchor.href = INTENT;
      anchor.rel = "noopener";
      anchor.setAttribute("aria-hidden", "true");
      document.documentElement.appendChild(anchor);
      anchor.click();
      anchor.remove();
      console.info("[T-Kong] broker app open requested");
      return true;
    } catch (_error) {
      console.info("[T-Kong] broker app open failed");
      return false;
    }
  }

  globalThis.TKongBroker = {
    PACKAGE,
    PLAY_URL,
    INTENT,
    tryOpenBrokerApp,
  };
})();
