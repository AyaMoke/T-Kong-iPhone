"use strict";

const TELECON_HOST = "t21.nikkei.co.jp";
const NIKKEI_HOST = "www.nikkei.com";
const OPEN_TODAY_KEY = "tKongOpenTodayNewspaper";
const MSG_OPEN_TODAY = "tKongOpenTodayNewspaper";
const MSG_OPEN_BROKER = "tKongOpenBrokerApp";
const HELPER_PATH = "/pages/open-ispeed.html";

function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch (_error) {
    return "";
  }
}

function helperUrl() {
  return browser.runtime.getURL(HELPER_PATH);
}

async function sendToTab(tabId, type) {
  try {
    await browser.tabs.sendMessage(tabId, { type });
    return true;
  } catch (_error) {
    return false;
  }
}

async function openHelperPage(tab) {
  const url = helperUrl();
  const current = tab?.url || "";
  if (
    tab?.id != null &&
    (current === "" ||
      current === "about:blank" ||
      current.startsWith("about:") ||
      current.startsWith("moz-extension:"))
  ) {
    await browser.tabs.update(tab.id, { url });
    return;
  }
  await browser.tabs.create({ url });
}

browser.action.onClicked.addListener(async (tab) => {
  await browser.storage.local.set({ [OPEN_TODAY_KEY]: true });

  const host = hostnameOf(tab?.url || "");
  if (tab?.id != null && host === TELECON_HOST) {
    const delivered = await sendToTab(tab.id, MSG_OPEN_TODAY);
    if (delivered) return;
    await browser.tabs.reload(tab.id);
    return;
  }

  if (tab?.id != null && host === NIKKEI_HOST) {
    const delivered = await sendToTab(tab.id, MSG_OPEN_BROKER);
    if (delivered) return;
  }

  await openHelperPage(tab);
});
