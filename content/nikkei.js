(() => {
  "use strict";

  const BUTTON_ID = "t-kong-button";
  const APP_BUTTON_ID = "t-kong-open-app-button";
  const TOAST_ID = "t-kong-toast";
  const { ARTICLE_KEY, PHASE_KEY, getSettings, normalizeTitle } = TKongSettings;
  const { tryOpenBrokerApp } = TKongBroker;
  const MSG_OPEN_BROKER = "tKongOpenBrokerApp";

  function getHeadlineText(settings) {
    const candidates = [
      document.querySelector("h1")?.textContent,
      document.querySelector('[data-testid="article-title"]')?.textContent,
      document.querySelector("article h1")?.textContent,
      document.querySelector(".article-title, .title-article")?.textContent,
    ];
    for (const text of candidates) {
      const cleaned = normalizeTitle(text, settings);
      if (cleaned && cleaned.length >= 4) return cleaned;
    }
    return "";
  }

  async function getArticleInfo() {
    const match = location.pathname.match(/^\/article\/([^/?#]+)\/?/);
    if (!match) return null;
    const settings = await getSettings();
    const articleId = match[1];
    const ogTitle = document.querySelector('meta[property="og:title"]')?.content?.trim();
    const headline = settings.preferHeadline !== false ? getHeadlineText(settings) : "";
    const title =
      headline ||
      normalizeTitle(ogTitle, settings) ||
      normalizeTitle(document.title, settings);
    return { articleId, title, url: location.href, capturedAt: new Date().toISOString() };
  }

  function showToast(message) {
    document.getElementById(TOAST_ID)?.remove();
    const toast = document.createElement("div");
    toast.id = TOAST_ID;
    toast.textContent = message;
    document.documentElement.appendChild(toast);
    setTimeout(() => toast.remove(), 3600);
  }

  function mountOpenAppButton() {
    document.getElementById(APP_BUTTON_ID)?.remove();
    const button = document.createElement("button");
    button.id = APP_BUTTON_ID;
    button.type = "button";
    button.textContent = "楽天証券アプリを開く";
    button.setAttribute(
      "aria-label",
      "楽天証券アプリを開き、日経テレコンへ進む"
    );
    button.addEventListener("click", () => {
      tryOpenBrokerApp();
      showToast(
        "開かない場合は手動: iSPEED → メニュー → マーケット → 日経テレコン"
      );
    });
    document.documentElement.appendChild(button);
    setTimeout(() => button.remove(), 12000);
  }

  async function saveArticle() {
    const article = await getArticleInfo();
    if (!article) return showToast("記事IDを取得できませんでした");
    if (!article.title) return showToast("タイトルを取得できませんでした");
    await browser.storage.local.set({ [ARTICLE_KEY]: article });
    await browser.storage.local.remove(PHASE_KEY);
    showToast(`保存しました: ${article.title}`);
    console.info("[T-Kong] saved", { articleId: article.articleId, title: article.title });

    const settings = await getSettings();
    if (settings.openBrokerAppAfterSave === false) return;

    mountOpenAppButton();
    // ユーザー操作直後なので Intent 起動を試す（失敗しても手動ボタンが残る）
    setTimeout(() => {
      tryOpenBrokerApp();
    }, 250);
  }

  async function mountButton() {
    if (document.getElementById(BUTTON_ID)) return;
    if (!(await getArticleInfo())) return;
    const button = document.createElement("button");
    button.id = BUTTON_ID;
    button.type = "button";
    button.textContent = "📰 テレコンで読む";
    button.setAttribute("aria-label", "この記事を日経テレコンで読むために保存");
    button.addEventListener("click", saveArticle);
    document.documentElement.appendChild(button);
  }

  browser.runtime.onMessage.addListener((message) => {
    if (message?.type !== MSG_OPEN_BROKER) return;
    mountOpenAppButton();
    tryOpenBrokerApp();
    showToast("iSPEED → メニュー → マーケット → 日経テレコン → 同意 のあと、きょうの新聞を開きます");
    return true;
  });

  mountButton();
  new MutationObserver(() => {
    mountButton();
  }).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
})();
