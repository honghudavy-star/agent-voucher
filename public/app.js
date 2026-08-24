document.addEventListener("htmx:responseError", (event) => {
  const message = event.detail?.xhr?.responseText || "请求失败，请刷新后重试";
  const region = document.querySelector("[data-flash]");
  if (region) {
    region.textContent = message;
    region.hidden = false;
  }
});

document.addEventListener("submit", (event) => {
  const form = event.target instanceof HTMLFormElement ? event.target : null;
  const message = form?.dataset.confirm;
  if (message && !window.confirm(message)) event.preventDefault();
});
