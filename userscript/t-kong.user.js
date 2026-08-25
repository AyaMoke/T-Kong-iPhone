// ==UserScript==
// @name         T-Kong for iPhone
// @namespace    https://github.com/AyaMoke/T-Kong-iPhone
// @version      0.5.6
// @description  iPhone向け。日経記事タイトルを端末内に一時記録し、楽天証券版日経テレコンでの同一記事検索を補助する非公式スクリプトです（Android拡張とは別）。
// @author       AyaMoke
// @match        https://www.nikkei.com/
// @match        https://www.nikkei.com/?*
// @match        https://www.nikkei.com/article/*
// @match        https://t21.nikkei.co.jp/*
// @match        https://member.rakuten-sec.co.jp/app/smt_info_jp_nikkei_telecom.do*
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.deleteValue
// @grant        GM.registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @run-at       document-idle
// ==/UserScript==

(() => {
  "use strict";

  const SETTINGS_KEY = "tKongSettings";
  const ARTICLE_KEY = "tKongPendingArticle";
  const PHASE_KEY = "tKongPhase";
  const OPEN_TODAY_KEY = "tKongOpenTodayNewspaper";
  const PENDING_ARTICLE_TTL_MS = 24 * 60 * 60 * 1000;
  const STORE_PREFIX = "tKong/";

  const DEFAULT_SETTINGS = {
    autoConsent: true,
    autoOpenAfterConsent: true,
    autoClickResult: true,
    stripTitlePrefixes: true,
    preferHeadline: true,
    showFloatingButton: true,
    openBrokerAppAfterSave: true,
  };

  const TITLE_PREFIXES =
    /^(決算|人事|速報|詳報|訂正|お詫び|社説|コラム|写真|動画|ニュース)[:：]\s*/u;

  const PACKAGE = "jp.co.rakuten_sec.ispeed";
  const LAUNCH_URL = "ispeed://launch";
  const PLAY_URL = "https://play.google.com/store/apps/details?id=" + PACKAGE;
  const APP_STORE_IPHONE =
    "https://apps.apple.com/jp/app/ispeed-%E6%A5%BD%E5%A4%A9%E8%A8%BC%E5%88%B8%E3%81%AE%E6%A0%AA%E3%82%A2%E3%83%97%E3%83%AA/id389339704";
  const APP_STORE_IPAD =
    "https://apps.apple.com/jp/app/ispeed-for-ipad-%E6%A5%BD%E5%A4%A9%E8%A8%BC%E5%88%B8%E3%81%AE%E6%A0%AA%E3%82%A2%E3%83%97%E3%83%AA/id421798565";
  const INTENT =
    "intent://launch#Intent;scheme=ispeed;package=" +
    PACKAGE +
    ";S.browser_fallback_url=" +
    encodeURIComponent(PLAY_URL) +
    ";end";

  const PHASE_SEARCH = "search";
  const PHASE_OPEN = "openResult";
  const PHASE_ASSIST = "assist";
  const PHASE_OPENING = "opening";

  // --- storage (GM 推奨: オリジンを跨ぐ。localStorage は同一オリジンのみ) ---

  function hasGmStorage() {
    return (
      (typeof GM !== "undefined" && typeof GM.getValue === "function") ||
      typeof GM_getValue === "function"
    );
  }

  async function gmGet(key, fallback) {
    if (typeof GM !== "undefined" && typeof GM.getValue === "function") {
      return GM.getValue(key, fallback);
    }
    if (typeof GM_getValue === "function") {
      return GM_getValue(key, fallback);
    }
    try {
      const raw = localStorage.getItem(key);
      if (raw == null) return fallback;
      return JSON.parse(raw);
    } catch (_error) {
      return fallback;
    }
  }

  async function gmSet(key, value) {
    if (typeof GM !== "undefined" && typeof GM.setValue === "function") {
      return GM.setValue(key, value);
    }
    if (typeof GM_setValue === "function") {
      GM_setValue(key, value);
      return;
    }
    localStorage.setItem(key, JSON.stringify(value));
  }

  async function gmDelete(key) {
    if (typeof GM !== "undefined" && typeof GM.deleteValue === "function") {
      return GM.deleteValue(key);
    }
    if (typeof GM_deleteValue === "function") {
      GM_deleteValue(key);
      return;
    }
    localStorage.removeItem(key);
  }

  async function storageGet(keys) {
    const list = Array.isArray(keys) ? keys : [keys];
    const out = {};
    for (const key of list) {
      out[key] = await gmGet(STORE_PREFIX + key, undefined);
    }
    return out;
  }

  async function storageSet(obj) {
    await Promise.all(
      Object.entries(obj).map(([key, value]) => gmSet(STORE_PREFIX + key, value))
    );
  }

  async function storageRemove(keys) {
    const list = Array.isArray(keys) ? keys : [keys];
    await Promise.all(list.map((key) => gmDelete(STORE_PREFIX + key)));
  }

  // --- settings ---

  function normalizeTitle(raw, settings = DEFAULT_SETTINGS) {
    let title = String(raw || "")
      .replace(/\s*[-－—–｜|/:：]\s*(日本経済新聞|日経新聞|Nikkei).*$/iu, "")
      .replace(/\s*(日本経済新聞|日経新聞)\s*$/u, "");

    if (settings.stripTitlePrefixes !== false) {
      title = title.replace(TITLE_PREFIXES, "");
    }

    return title.replace(/\s+/gu, " ").trim();
  }

  async function getSettings() {
    const data = await storageGet(SETTINGS_KEY);
    return { ...DEFAULT_SETTINGS, ...(data[SETTINGS_KEY] || {}) };
  }

  async function saveSettings(partial) {
    const current = await getSettings();
    const next = { ...current, ...partial };
    await storageSet({ [SETTINGS_KEY]: next });
    return next;
  }

  function isPendingFresh(article) {
    if (!article?.title) return false;
    const captured = Date.parse(article.capturedAt || "");
    if (Number.isNaN(captured)) return false;
    return Date.now() - captured <= PENDING_ARTICLE_TTL_MS;
  }

  async function getFreshPendingArticle() {
    const data = await storageGet([ARTICLE_KEY, PHASE_KEY]);
    const article = data[ARTICLE_KEY];
    if (!article?.title) return null;
    if (isPendingFresh(article)) return article;

    console.info("[T-Kong] pending expired, cleared");
    await storageRemove([ARTICLE_KEY, PHASE_KEY]);
    return null;
  }

  // --- broker ---

  function detectPlatform() {
    const ua = String(navigator.userAgent || "");
    const maxTouch = Number(navigator.maxTouchPoints || 0);
    const isIPad =
      /iPad/i.test(ua) || (/Macintosh/i.test(ua) && maxTouch > 1);
    const isIPhone = /iPhone|iPod/i.test(ua);
    const isIOS = isIPad || isIPhone;
    const isAndroid = /Android/i.test(ua);
    return { isIOS, isIPad, isIPhone, isAndroid };
  }

  function clickHref(href) {
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.rel = "noopener";
    anchor.setAttribute("aria-hidden", "true");
    document.documentElement.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }

  function storeUrlFor(platform) {
    if (platform.isIPad) return APP_STORE_IPAD;
    if (platform.isIOS) return APP_STORE_IPHONE;
    return PLAY_URL;
  }

  function tryOpenBrokerApp() {
    try {
      const platform = detectPlatform();
      if (platform.isIOS) {
        // App Store への自動フォールバックはしない。
        // iPad の分割表示などでは visibility が残ったままになり、
        // 起動成功後に「入手不可能」なストアページへ飛ばされることがある。
        clickHref(LAUNCH_URL);
        console.info("[T-Kong] broker app open requested (ios)", { launch: LAUNCH_URL });
        return true;
      }
      if (platform.isAndroid) {
        clickHref(INTENT);
        console.info("[T-Kong] broker app open requested (android intent)");
        return true;
      }
      clickHref(LAUNCH_URL);
      console.info("[T-Kong] broker app open requested (generic scheme)");
      return true;
    } catch (_error) {
      console.info("[T-Kong] broker app open failed");
      return false;
    }
  }

  function openBrokerStorePage() {
    clickHref(storeUrlFor(detectPlatform()));
  }

  // --- UI helpers ---

  function injectStyle(css) {
    if (typeof GM_addStyle === "function") {
      GM_addStyle(css);
      return;
    }
    const style = document.createElement("style");
    style.textContent = css;
    document.documentElement.appendChild(style);
  }

  function showToast(message, bottom = "78px") {
    document.getElementById("t-kong-toast")?.remove();
    const toast = document.createElement("div");
    toast.id = "t-kong-toast";
    toast.textContent = message;
    toast.style.bottom = `max(${bottom}, calc(env(safe-area-inset-bottom) + ${bottom}))`;
    document.documentElement.appendChild(toast);
    setTimeout(() => toast.remove(), 3200);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function registerMenu(title, fn) {
    if (typeof GM !== "undefined" && typeof GM.registerMenuCommand === "function") {
      GM.registerMenuCommand(title, fn);
      return;
    }
    if (typeof GM_registerMenuCommand === "function") {
      GM_registerMenuCommand(title, fn);
    }
  }

  // --- settings panel ---

  const SETTING_FIELDS = [
    ["openBrokerAppAfterSave", "一時記録のあと楽天証券アプリ（iSPEED）の起動を促す"],
    ["autoConsent", "許諾画面の「同意する」を自動クリック（推奨: ON）"],
    ["autoOpenAfterConsent", "同意後に一時記録した記事を自動オープン"],
    ["autoClickResult", "検索結果の一致見出しを自動クリック"],
    ["showFloatingButton", "テレコン画面に「記録した記事を開く」ボタンを表示"],
    ["preferHeadline", "記録時はページ見出し（h1）を優先"],
    ["stripTitlePrefixes", "「決算:」などの接頭辞と「日経新聞」末尾を除去"],
  ];

  async function openSettingsPanel() {
    document.getElementById("t-kong-settings")?.remove();
    const settings = await getSettings();
    const panel = document.createElement("div");
    panel.id = "t-kong-settings";
    panel.innerHTML =
      "<div class='t-kong-settings-card'>" +
      "<h2>T-Kong for iPhone</h2>" +
      "<p class='t-kong-settings-note'>記事の手がかりは端末内の一時記録のみ（目安24時間）。認証情報は扱いません。</p>" +
      SETTING_FIELDS.map(
        ([id, label]) =>
          `<label><input type="checkbox" data-key="${id}" ${
            settings[id] ? "checked" : ""
          }/> <span>${label}</span></label>`
      ).join("") +
      "<button type='button' class='t-kong-settings-close'>閉じる</button>" +
      "</div>";

    panel.addEventListener("click", async (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.classList.contains("t-kong-settings-close") || target === panel) {
        panel.remove();
        return;
      }
      if (target.matches("input[type='checkbox'][data-key]")) {
        const key = target.getAttribute("data-key");
        await saveSettings({ [key]: target.checked });
        showToast("設定を反映しました");
      }
    });

    document.documentElement.appendChild(panel);
  }

  async function requestOpenTodayNewspaper() {
    // 記事アシストとぶつからないよう phase だけ外す（一時記録自体は残す）
    await storageRemove(PHASE_KEY);
    await storageSet({ [OPEN_TODAY_KEY]: true });
    tryOpenBrokerApp();
    showToast(
      "iSPEED → メニュー → マーケット → 日経テレコン → 同意 のあと、ブラウザに戻ると「きょうの新聞」を開きます",
      "130px"
    );
  }

  // --- nikkei.com ---

  function isNikkeiTopPage() {
    const path = String(location.pathname || "/").replace(/\/+$/u, "") || "/";
    return path === "/";
  }

  function isNikkeiArticlePage() {
    return /^\/article\//u.test(location.pathname || "");
  }

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

  function mountOpenAppButton() {
    document.getElementById("t-kong-open-app-button")?.remove();
    const button = document.createElement("button");
    button.id = "t-kong-open-app-button";
    button.type = "button";
    button.textContent = "楽天証券アプリを開く";
    button.setAttribute("aria-label", "楽天証券アプリを開き、日経テレコンへ進む");
    button.addEventListener("click", () => {
      tryOpenBrokerApp();
      showToast(
        "開かない場合は手動: iSPEED → メニュー → マーケット → 日経テレコン",
        "130px"
      );
    });
    document.documentElement.appendChild(button);
    setTimeout(() => button.remove(), 12000);

    // 未インストール時だけユーザーが押す用（自動ではストアに行かない）
    if (!document.getElementById("t-kong-open-store-button")) {
      const storeButton = document.createElement("button");
      storeButton.id = "t-kong-open-store-button";
      storeButton.type = "button";
      storeButton.textContent = "ストアで iSPEED を見る";
      storeButton.setAttribute("aria-label", "App Store または Play ストアで iSPEED を開く");
      storeButton.addEventListener("click", () => {
        openBrokerStorePage();
      });
      document.documentElement.appendChild(storeButton);
      setTimeout(() => storeButton.remove(), 12000);
    }
  }

  async function saveArticle() {
    const article = await getArticleInfo();
    if (!article) return showToast("記事IDを取得できませんでした", "130px");
    if (!article.title) return showToast("タイトルを取得できませんでした", "130px");
    await storageSet({ [ARTICLE_KEY]: article });
    const settings = await getSettings();
    // テレコン到着後に手動ボタンなしで進めるよう、記録時点でアシストを構える
    if (settings.autoOpenAfterConsent !== false) {
      await storageSet({ [PHASE_KEY]: PHASE_ASSIST });
    } else {
      await storageRemove(PHASE_KEY);
    }
    showToast(`一時記録しました: ${article.title}`, "130px");
    console.info("[T-Kong] saved", { articleId: article.articleId, title: article.title });

    if (!hasGmStorage()) {
      showToast(
        "警告: GMストレージがありません。日経→テレコンで一時記録が引き継がれない可能性があります",
        "130px"
      );
    }

    if (settings.openBrokerAppAfterSave === false) return;

    mountOpenAppButton();
    setTimeout(() => {
      tryOpenBrokerApp();
    }, 250);
  }

  async function mountNikkeiButton() {
    if (document.getElementById("t-kong-button")) return;
    if (!(await getArticleInfo())) return;
    const button = document.createElement("button");
    button.id = "t-kong-button";
    button.type = "button";
    button.textContent = "📰 テレコンで読む";
    button.setAttribute("aria-label", "この記事を日経テレコンで読むために一時記録する");
    button.addEventListener("click", saveArticle);
    document.documentElement.appendChild(button);
  }

  function mountNikkeiTodayButton() {
    if (document.getElementById("t-kong-today-button")) return;
    const button = document.createElement("button");
    button.id = "t-kong-today-button";
    button.type = "button";
    button.textContent = "📰 きょうの新聞";
    button.setAttribute("aria-label", "日経テレコンできょうの新聞を開く");
    button.addEventListener("click", () => {
      requestOpenTodayNewspaper();
    });
    document.documentElement.appendChild(button);
  }

  function nikkeiButtonStyles() {
    return `
#t-kong-button{position:fixed;right:16px;bottom:max(20px,env(safe-area-inset-bottom));z-index:2147483647;border:0;border-radius:999px;padding:12px 16px;font:700 14px/1.2 system-ui;color:#fff;background:#222;box-shadow:0 4px 18px rgba(0,0,0,.22)}
#t-kong-today-button{position:fixed;right:16px;bottom:max(20px,env(safe-area-inset-bottom));z-index:2147483647;border:0;border-radius:999px;min-height:3.4rem;padding:16px 24px;font:750 18px/1.2 system-ui;color:#fff;background:#222;box-shadow:0 8px 28px rgba(0,0,0,.28)}
#t-kong-button:active,#t-kong-today-button:active{transform:translateY(1px)}
#t-kong-open-app-button{position:fixed;right:16px;bottom:max(72px,calc(env(safe-area-inset-bottom) + 72px));z-index:2147483647;border:0;border-radius:999px;padding:12px 16px;font:700 14px/1.2 system-ui;color:#fff;background:#0f7a6c;box-shadow:0 4px 18px rgba(0,0,0,.22)}
#t-kong-open-store-button{position:fixed;right:16px;bottom:max(124px,calc(env(safe-area-inset-bottom) + 124px));z-index:2147483647;border:0;border-radius:999px;padding:10px 14px;font:650 13px/1.2 system-ui;color:#fff;background:#5c6570;box-shadow:0 4px 18px rgba(0,0,0,.22)}
#t-kong-toast{position:fixed;left:50%;transform:translateX(-50%);z-index:2147483647;max-width:min(90vw,520px);padding:10px 14px;border-radius:10px;background:rgba(20,20,20,.94);color:#fff;font:500 13px/1.4 system-ui;box-shadow:0 4px 18px rgba(0,0,0,.25)}
`;
  }

  function initNikkeiArticle() {
    injectStyle(nikkeiButtonStyles());
    mountNikkeiButton();
    new MutationObserver(() => {
      mountNikkeiButton();
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  function initNikkeiTop() {
    injectStyle(nikkeiButtonStyles());
    mountNikkeiTodayButton();
    new MutationObserver(() => {
      mountNikkeiTodayButton();
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  // --- rakuten consent ---

  function isConsentPage() {
    return Boolean(
      document.querySelector("#nikkeiTelecomPolicyAgreement") ||
        document.querySelector('form[name="SmtInfoJpNikkeiTelecomForm"]') ||
        document.querySelector(".userFeedback.agree img[alt='同意する']")
    );
  }

  async function armAssistIfNeeded(settings) {
    if (settings.autoOpenAfterConsent === false) return;
    const article = await getFreshPendingArticle();
    if (!article?.title) return;
    await storageSet({ [PHASE_KEY]: PHASE_ASSIST });
  }

  async function toastForAgree(settings) {
    const data = await storageGet(OPEN_TODAY_KEY);
    if (data[OPEN_TODAY_KEY]) {
      showToast("許諾に同意し、きょうの新聞へ進みます…");
      return;
    }
    showToast(
      settings.autoOpenAfterConsent !== false
        ? "許諾に同意し、一時記録した記事のオープンへ進みます…"
        : "許諾に同意して進みます…"
    );
  }

  async function clickAgree() {
    const settings = await getSettings();
    if (settings.autoConsent === false) return true;
    if (!isConsentPage()) return false;

    const agreeImg =
      document.querySelector(".userFeedback.agree img[alt='同意する']") ||
      document.querySelector(".userFeedback.agree img");
    if (agreeImg) {
      await armAssistIfNeeded(settings);
      await toastForAgree(settings);
      agreeImg.click();
      return true;
    }

    const form = document.querySelector('form[name="SmtInfoJpNikkeiTelecomForm"]');
    const eventType = form?.querySelector('input[name="eventType"]');
    if (form && eventType) {
      await armAssistIfNeeded(settings);
      eventType.value = "agree";
      await toastForAgree(settings);
      form.submit();
      return true;
    }

    return false;
  }

  function initConsent() {
    injectStyle(`
#t-kong-toast{position:fixed;left:50%;transform:translateX(-50%);z-index:2147483647;max-width:min(90vw,520px);padding:10px 14px;border-radius:10px;background:rgba(20,20,20,.94);color:#fff;font:500 13px/1.4 system-ui;box-shadow:0 4px 18px rgba(0,0,0,.25)}
`);
    // 手動同意でもテレコン側自動オープンが続くよう、先にフラグを立てる
    getSettings().then((settings) => armAssistIfNeeded(settings));

    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      clickAgree().then((done) => {
        if (done || tries >= 8) clearInterval(timer);
      });
    }, 400);
  }

  // --- telecon ---

  function compactTitle(raw, settings) {
    return normalizeTitle(raw, settings).replace(/\s+/gu, "");
  }

  function isNewsSearchPage() {
    return Boolean(
      document.querySelector("#nwsKeyword") && document.querySelector("#nwsSearchBtn")
    );
  }

  function isTeleconArticlePage() {
    const href = location.href;
    if (/LATCA014\.do/i.test(href)) return true;
    if (href.includes("keyBody=") && !document.querySelector("ul.listNews")) return true;
    return false;
  }

  function getResultLinks() {
    return [
      ...document.querySelectorAll(
        "ul.listNews li.headlineTwoToneA a[href*='keyBody'], ul.listNews a[href*='LATCA014']"
      ),
    ];
  }

  function getGenreSelect() {
    return document.querySelector("select.js-dropdown-direct-transition");
  }

  function isAllNewsLabel(text) {
    return /^全ニュース/.test(String(text || "").trim());
  }

  function findAllNewsOption(select) {
    return [...select.options].find((option) => isAllNewsLabel(option.textContent));
  }

  function isAllNewsSelected() {
    const select = getGenreSelect();
    const selected = select?.selectedOptions?.[0];
    if (selected && isAllNewsLabel(selected.textContent)) return true;
    const genreInputs = [...document.querySelectorAll('input[name="genreCode"]')];
    if (genreInputs.some((input) => input.value === "ALL")) return true;
    const params = new URLSearchParams(location.search);
    return params.get("genreCode") === "ALL";
  }

  async function switchToAllNews() {
    const select = getGenreSelect();
    const option = select ? findAllNewsOption(select) : null;
    const link = [...document.querySelectorAll("a[href*='genreCode=ALL']")].find((anchor) =>
      isAllNewsLabel(anchor.textContent)
    );
    const target = option?.value || link?.getAttribute("href");
    if (!target) {
      showToast("「全ニュース」が見つかりませんでした");
      return false;
    }
    await storageSet({ [PHASE_KEY]: PHASE_SEARCH });
    showToast("全ニュースに切り替えます…");
    location.assign(target);
    return true;
  }

  async function findResultLink(article, settings) {
    const links = getResultLinks();
    if (!links.length) return null;
    const articleId = String(article.articleId || "");
    if (articleId) {
      const byId = links.find((anchor) => anchor.href.includes(articleId));
      if (byId) return byId;
    }
    const wanted = compactTitle(article.title, settings);
    if (!wanted) return null;
    const exact = links.find(
      (anchor) => compactTitle(anchor.textContent, settings) === wanted
    );
    if (exact) return exact;
    return (
      links.find((anchor) => {
        const text = compactTitle(anchor.textContent, settings);
        return text.includes(wanted) || wanted.includes(text);
      }) || null
    );
  }

  async function completePendingIfOpened() {
    const data = await storageGet([ARTICLE_KEY, PHASE_KEY]);
    const article = data[ARTICLE_KEY];
    const phase = data[PHASE_KEY];
    if (!article?.title || phase !== PHASE_OPENING) return false;
    if (!isTeleconArticlePage()) return false;
    await storageRemove([ARTICLE_KEY, PHASE_KEY]);
    console.info("[T-Kong] pending completed");
    return true;
  }

  async function openMatchingResult(article) {
    const settings = await getSettings();
    if (settings.autoClickResult === false) {
      showToast("検索まで完了しました（自動クリックはオフ）");
      await storageRemove([PHASE_KEY]);
      return false;
    }
    const links = getResultLinks();
    if (!links.length) {
      showToast("検索結果が見つかりませんでした");
      await storageRemove([PHASE_KEY]);
      return false;
    }
    const link = await findResultLink(article, settings);
    if (!link) {
      showToast("一致する見出しをクリックできませんでした");
      await storageRemove([PHASE_KEY]);
      return false;
    }
    await storageSet({ [PHASE_KEY]: PHASE_OPENING });
    showToast(`開きます: ${link.textContent.trim()}`);
    try {
      link.click();
    } catch (_error) {
      await storageSet({ [PHASE_KEY]: PHASE_OPEN });
      showToast("リンクのクリックに失敗しました。再試行できます");
      return false;
    }
    return true;
  }

  async function searchByTitle(article) {
    const input = document.querySelector("#nwsKeyword");
    const button = document.querySelector("#nwsSearchBtn");
    if (!input || !button) return false;
    const settings = await getSettings();
    const title = normalizeTitle(article.title, settings);
    if (!title) {
      showToast("検索用タイトルを作れませんでした");
      return false;
    }
    input.focus();
    input.value = title;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await storageSet({ [PHASE_KEY]: PHASE_OPEN });
    showToast(`タイトルで検索: ${title}`);
    button.click();
    return true;
  }

  async function runAssist({ auto } = { auto: false }) {
    const article = await getFreshPendingArticle();
    const data = await storageGet(PHASE_KEY);
    const phase = data[PHASE_KEY];

    if (!article?.title) {
      showToast("一時記録がありません。nikkei.comで先に記録してください");
      return;
    }
    if (phase === PHASE_OPEN && getResultLinks().length) {
      await openMatchingResult(article);
      return;
    }
    if (!isNewsSearchPage()) {
      showToast("ニュースの見出し一覧（検索欄がある画面）を開いてください");
      return;
    }
    if (!isAllNewsSelected()) {
      await switchToAllNews();
      return;
    }
    if (
      auto &&
      phase !== PHASE_SEARCH &&
      phase !== PHASE_OPEN &&
      phase !== PHASE_ASSIST
    ) {
      return;
    }
    await searchByTitle(article);
  }

  function normalizeMenuText(raw) {
    return String(raw || "").replace(/\s+/gu, "").trim();
  }

  function isTodayNewspaperText(raw) {
    const text = normalizeMenuText(raw);
    return text.includes("きょうの新聞") || text.includes("今日の新聞");
  }

  function findTodayNewspaperControl() {
    const byText = [
      ...document.querySelectorAll("a, button, [role='menuitem'], [role='link'], [role='button']"),
    ].find((el) => isTodayNewspaperText(el.textContent));
    if (byText) return byText;
    return (
      [
        ...document.querySelectorAll(
          "a[href*='ATCB012'], a[href*='atcb012'], a[href*='LATCA012'], a[href*='latca012']"
        ),
      ][0] || null
    );
  }

  function findMenuToggle() {
    const labeled = [
      ...document.querySelectorAll("button, a, [role='button'], summary"),
    ].find((el) => {
      const label = [el.getAttribute("aria-label"), el.getAttribute("title"), el.textContent]
        .filter(Boolean)
        .join(" ");
      if (isTodayNewspaperText(label)) return false;
      return /メニュー|menu|hamburger|nav/i.test(label);
    });
    if (labeled) return labeled;
    const headerCandidates = [
      ...document.querySelectorAll(
        "header button, header a, .header button, .header a, nav button"
      ),
    ].filter((el) => {
      const text = normalizeMenuText(el.textContent);
      return text.length <= 2 || /≡|☰|メニュー/.test(el.textContent || "");
    });
    return headerCandidates[headerCandidates.length - 1] || null;
  }

  async function openTodayNewspaper() {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      let link = findTodayNewspaperControl();
      if (!link) {
        const toggle = findMenuToggle();
        if (toggle) {
          try {
            toggle.click();
          } catch (_error) {
            // ignore
          }
          await sleep(450);
          link = findTodayNewspaperControl();
        }
      }
      if (link) {
        await storageRemove(OPEN_TODAY_KEY);
        showToast("きょうの新聞を開きます…");
        const href = link.getAttribute?.("href");
        if (
          link.tagName === "A" &&
          href &&
          href !== "#" &&
          !href.startsWith("javascript:")
        ) {
          location.assign(link.href);
          return true;
        }
        try {
          link.click();
          return true;
        } catch (_error) {
          showToast("「きょうの新聞」を開けませんでした");
          return false;
        }
      }
      await sleep(400);
    }
    showToast("「きょうの新聞」が見つかりませんでした。メニューから開いてください");
    return false;
  }

  async function consumeOpenTodayRequest() {
    if (isSessionExpiredPage()) {
      mountSessionReloginButton();
      return false;
    }
    const data = await storageGet(OPEN_TODAY_KEY);
    if (!data[OPEN_TODAY_KEY]) return false;
    return openTodayNewspaper();
  }

  function isSessionExpiredPage() {
    const text = String(document.body?.innerText || document.documentElement?.innerText || "");
    return text.includes("この操作を継続できません");
  }

  function findSessionReloginLink() {
    return (
      [...document.querySelectorAll("a")].find((anchor) => {
        const label = String(anchor.textContent || "").replace(/\s+/gu, "");
        return (
          label.includes("ログインページ") ||
          label.includes("ホームページ") ||
          /login|GWJD|ログイン/i.test(anchor.getAttribute("href") || "")
        );
      }) || null
    );
  }

  function promptSessionRelogin() {
    tryOpenBrokerApp();
    showToast(
      "セッション切れです。iSPEEDでログイン → メニュー → マーケット → 日経テレコン から入り直してください"
    );
    const link = findSessionReloginLink();
    if (link?.href) {
      // ブラウザ側のログイン導線もある場合は、アプリ起動のあとで辿れるよう控える
      console.info("[T-Kong] session expired; login link found", link.href);
    }
  }

  function mountSessionReloginButton() {
    const expired = isSessionExpiredPage();
    const existing = document.getElementById("t-kong-relogin-button");
    if (!expired) {
      existing?.remove();
      return false;
    }
    if (existing) return true;

    const button = document.createElement("button");
    button.id = "t-kong-relogin-button";
    button.type = "button";
    button.textContent = "🔑 再ログインする";
    button.setAttribute(
      "aria-label",
      "セッション切れのため、iSPEEDから日経テレコンへ再ログインする"
    );
    button.addEventListener("click", promptSessionRelogin);
    document.documentElement.appendChild(button);
    showToast("セッションが切れています。再ログインしてください");
    return true;
  }

  async function mountTeleconButton() {
    if (isSessionExpiredPage()) {
      document.getElementById("t-kong-telecon-button")?.remove();
      mountSessionReloginButton();
      return;
    }
    mountSessionReloginButton();

    const settings = await getSettings();
    const article = await getFreshPendingArticle();
    const hasPending = Boolean(article?.title);
    const existing = document.getElementById("t-kong-telecon-button");
    if (!hasPending || settings.showFloatingButton === false) {
      existing?.remove();
      return;
    }
    if (existing) return;
    const button = document.createElement("button");
    button.id = "t-kong-telecon-button";
    button.type = "button";
    button.textContent = "📰 記録した記事を開く";
    button.setAttribute("aria-label", "一時記録した日経記事をテレコンで検索して開く");
    button.addEventListener("click", () => {
      runAssist({ auto: false });
    });
    document.documentElement.appendChild(button);
  }

  async function continueAssistedFlow() {
    if (isSessionExpiredPage()) {
      mountSessionReloginButton();
      return;
    }
    for (let i = 0; i < 24; i += 1) {
      const settings = await getSettings();
      const article = await getFreshPendingArticle();
      const data = await storageGet(PHASE_KEY);
      const phase = data[PHASE_KEY];
      if (!article?.title) return;
      if (!phase) return;
      if (phase === PHASE_OPENING) {
        if (await completePendingIfOpened()) return;
        await sleep(500);
        continue;
      }
      if (phase === PHASE_ASSIST && settings.autoOpenAfterConsent === false) return;
      if (phase === PHASE_OPEN) {
        if (getResultLinks().length) {
          await openMatchingResult(article);
          return;
        }
        await sleep(500);
        continue;
      }
      if (phase === PHASE_SEARCH || phase === PHASE_ASSIST) {
        if (isNewsSearchPage()) {
          await runAssist({ auto: true });
          return;
        }
        await sleep(500);
        continue;
      }
      return;
    }
  }

  async function initTelecon() {
    injectStyle(`
#t-kong-telecon-button,#t-kong-relogin-button{position:fixed;right:16px;bottom:max(20px,env(safe-area-inset-bottom));z-index:2147483647;border:0;border-radius:999px;padding:12px 16px;font:700 14px/1.2 system-ui;color:#fff;background:#222;box-shadow:0 4px 18px rgba(0,0,0,.22)}
#t-kong-relogin-button{background:#8a1f1f}
#t-kong-telecon-button:active,#t-kong-relogin-button:active{transform:translateY(1px)}
#t-kong-toast{position:fixed;left:50%;transform:translateX(-50%);z-index:2147483647;max-width:min(90vw,520px);padding:10px 14px;border-radius:10px;background:rgba(20,20,20,.94);color:#fff;font:500 13px/1.4 system-ui;box-shadow:0 4px 18px rgba(0,0,0,.25)}
`);

    if (mountSessionReloginButton()) {
      new MutationObserver(() => {
        mountSessionReloginButton();
      }).observe(document.documentElement, { childList: true, subtree: true });
      return;
    }

    await completePendingIfOpened();
    await mountTeleconButton();

    if (!(await consumeOpenTodayRequest())) {
      const pendingToday = await storageGet(OPEN_TODAY_KEY);
      if (pendingToday[OPEN_TODAY_KEY]) {
        setTimeout(() => {
          if (isSessionExpiredPage()) {
            mountSessionReloginButton();
            return;
          }
          consumeOpenTodayRequest();
        }, 1500);
      }
    }

    if (isSessionExpiredPage()) {
      mountSessionReloginButton();
      return;
    }

    const article = await getFreshPendingArticle();
    const data = await storageGet(PHASE_KEY);
    const settings = await getSettings();

    // 一時記録があるのに phase が無い／許諾を挟まなかった場合も自動開始
    if (
      article?.title &&
      !data[PHASE_KEY] &&
      settings.autoOpenAfterConsent !== false &&
      !isTeleconArticlePage()
    ) {
      await storageSet({ [PHASE_KEY]: PHASE_ASSIST });
    }

    const phaseData = await storageGet(PHASE_KEY);
    if (article?.title && phaseData[PHASE_KEY]) {
      await continueAssistedFlow();
    }

    // SPA っぽい遅延描画向けに、検索欄が出るまでもう一度試す
    if (article?.title && settings.autoOpenAfterConsent !== false) {
      setTimeout(async () => {
        if (isSessionExpiredPage()) {
          mountSessionReloginButton();
          return;
        }
        const still = await getFreshPendingArticle();
        if (!still?.title) return;
        if (isTeleconArticlePage()) return;
        const again = await storageGet(PHASE_KEY);
        if (!again[PHASE_KEY]) {
          await storageSet({ [PHASE_KEY]: PHASE_ASSIST });
        }
        await continueAssistedFlow();
        await mountTeleconButton();
      }, 1200);
    }

    new MutationObserver(() => {
      mountTeleconButton();
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  // --- boot ---

  injectStyle(`
#t-kong-settings{position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,.45);display:flex;align-items:flex-end;justify-content:center;padding:12px}
#t-kong-settings .t-kong-settings-card{width:min(100%,420px);max-height:min(80vh,640px);overflow:auto;background:#fffdf8;color:#1a2332;border-radius:16px;padding:1rem 1rem 1.1rem;box-shadow:0 10px 40px rgba(0,0,0,.25)}
#t-kong-settings h2{margin:0 0 .35rem;font:700 1.1rem/1.3 system-ui}
#t-kong-settings .t-kong-settings-note{margin:0 0 .75rem;color:#5c6570;font:400 .85rem/1.4 system-ui}
#t-kong-settings label{display:grid;grid-template-columns:auto 1fr;gap:.65rem;align-items:start;padding:.55rem 0;border-top:1px solid #d9d2c5;font:400 .92rem/1.4 system-ui}
#t-kong-settings label:first-of-type{border-top:0}
#t-kong-settings .t-kong-settings-close{margin-top:.85rem;width:100%;min-height:2.6rem;border:0;border-radius:.65rem;background:#1a2332;color:#fff;font:650 .95rem/1 system-ui}
`);

  registerMenu("T-Kong for iPhone: 設定", () => {
    openSettingsPanel();
  });
  registerMenu("T-Kong for iPhone: きょうの新聞", () => {
    requestOpenTodayNewspaper();
  });

  const host = location.hostname;
  if (host === "www.nikkei.com") {
    if (isNikkeiArticlePage()) {
      initNikkeiArticle();
    } else if (isNikkeiTopPage()) {
      initNikkeiTop();
    }
  } else if (host === "t21.nikkei.co.jp") {
    initTelecon();
  } else if (host === "member.rakuten-sec.co.jp") {
    initConsent();
  }

  if (!hasGmStorage()) {
    console.warn(
      "[T-Kong] GM storage API が見つかりません。日経→テレコンの一時記録の引き継ぎには Violentmonkey / Tampermonkey / Userscripts 等の GM ストレージ対応マネージャが必要です。"
    );
  }
})();
