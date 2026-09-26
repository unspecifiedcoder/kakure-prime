window.addEventListener("kakure:request", ((event: CustomEvent) => {
  const { id, method, params } = event.detail;
  void chrome.runtime.sendMessage({ type: "kakure-page-request", method, params }).then((response) => {
    window.dispatchEvent(new CustomEvent("kakure:response", { detail: { id, ...response } }));
  });
}) as EventListener);
