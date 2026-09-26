const id = new URLSearchParams(location.search).get("id");
const send = async (message: unknown) => chrome.runtime.sendMessage(message);
if (!id) throw new Error("Missing request id");

void send({ type: "pending:get", id }).then((response) => {
  if (!response.ok || !response.result) throw new Error(response.error ?? "Signing request expired.");
  document.querySelector("#origin")!.textContent = response.result.origin;
  document.querySelector("#detail")!.textContent = response.result.detail;
  document.querySelector("#method")!.textContent = response.result.method === "signMessage" ? "MESSAGE SIGNATURE" : "SOLANA TRANSACTION";
}).catch((error) => { document.querySelector("#detail")!.textContent = error.message; });

document.querySelector("#approve")!.addEventListener("click", () => void send({ type: "pending:approve", id }).then(() => window.close()));
document.querySelector("#reject")!.addEventListener("click", () => void send({ type: "pending:reject", id }).then(() => window.close()));
