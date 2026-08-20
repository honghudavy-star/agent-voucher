document.addEventListener("DOMContentLoaded", () => {
  const setupToken = document.querySelector("input[name=token][data-from-fragment]");
  if (setupToken) {
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    setupToken.value = fragment.get("token") || "";
    if (setupToken.value) history.replaceState(null, "", window.location.pathname);
  }
});

document.addEventListener("htmx:responseError", (event) => {
  const message = event.detail?.xhr?.responseText || "请求失败，请刷新后重试";
  const region = document.querySelector("[data-flash]");
  if (region) {
    region.textContent = message;
    region.hidden = false;
  }
});
