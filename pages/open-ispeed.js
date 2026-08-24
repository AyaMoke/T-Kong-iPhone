(() => {
  "use strict";

  const button = document.getElementById("open-app");
  button?.addEventListener("click", () => {
    TKongBroker.tryOpenBrokerApp();
  });

  setTimeout(() => {
    TKongBroker.tryOpenBrokerApp();
  }, 250);
})();
