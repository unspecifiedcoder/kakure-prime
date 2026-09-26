const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;

async function send(message: unknown): Promise<any> {
  const response = await chrome.runtime.sendMessage(message);
  if (!response.ok) throw new Error(response.error);
  return response.result;
}

function short(address: string): string { return `${address.slice(0, 5)}…${address.slice(-5)}`; }

async function render(message = "") {
  const state = await send({ type: "status" });
  $("#onboarding").hidden = state.exists;
  $("#locked").hidden = !state.exists || state.unlocked;
  $("#wallet").hidden = !state.unlocked;
  $("#message").textContent = message;
  if (state.address) { $("#address").textContent = short(state.address); $("#address").title = state.address; }
  $("#network").textContent = state.network === "mainnet-beta" ? "MAINNET" : "DEVNET";
  $("#network-select").setAttribute("value", state.network);
  (document.querySelector<HTMLSelectElement>("#network-select")!).value = state.network;
  if (state.unlocked) {
    void send({ type: "balance" }).then((result) => { $("#balance").textContent = Number(result.balance).toLocaleString(undefined, { maximumFractionDigits: 6 }); }).catch(() => { $("#balance").textContent = "—"; });
  }
}

$("#create").addEventListener("submit", (event) => {
  event.preventDefault();
  const passphrase = (document.querySelector<HTMLInputElement>("#create-passphrase")!).value;
  const confirm = (document.querySelector<HTMLInputElement>("#confirm-passphrase")!).value;
  if (passphrase !== confirm) { void render("Passphrases do not match."); return; }
  void send({ type: "create", passphrase }).then(() => render("Wallet created and unlocked.")).catch((error) => render(error.message));
});

$("#unlock").addEventListener("submit", (event) => {
  event.preventDefault();
  const passphrase = (document.querySelector<HTMLInputElement>("#unlock-passphrase")!).value;
  void send({ type: "unlock", passphrase }).then(() => render("Wallet unlocked for 15 minutes.")).catch((error) => render(error.message));
});

$("#lock").addEventListener("click", () => void send({ type: "lock" }).then(() => render("Wallet locked.")));
$("#network-select").addEventListener("change", (event) => void send({ type: "network", network: (event.target as HTMLSelectElement).value }).then(() => render("Network updated.")));
$("#copy").addEventListener("click", () => void send({ type: "status" }).then((state) => navigator.clipboard.writeText(state.address)).then(() => render("Address copied.")));
$("#send-toggle").addEventListener("click", () => { $("#send-panel").hidden = false; $("#send-toggle").hidden = true; });
$("#send-panel").addEventListener("submit", (event) => {
  event.preventDefault();
  $("#review-amount").textContent = (document.querySelector<HTMLInputElement>("#amount")!).value;
  $("#review-recipient").textContent = (document.querySelector<HTMLInputElement>("#recipient")!).value;
  $("#send-panel").hidden = true;
  $("#send-review").hidden = false;
});
$("#send-cancel").addEventListener("click", () => { $("#send-review").hidden = true; $("#send-panel").hidden = false; });
$("#send-confirm").addEventListener("click", () => {
  const recipient = (document.querySelector<HTMLInputElement>("#recipient")!).value;
  const amount = (document.querySelector<HTMLInputElement>("#amount")!).value;
  $("#send-confirm").textContent = "Sending…";
  void send({ type: "sendSol", recipient, amount }).then((result) => {
    $("#send-review").hidden = true;
    $("#send-success").hidden = false;
    const link = document.querySelector<HTMLAnchorElement>("#explorer-link")!;
    link.href = result.explorer;
    link.textContent = `${result.signature.slice(0, 8)}…${result.signature.slice(-8)} ↗`;
    return render("Signed and broadcast. Verify confirmation in Explorer.");
  }).catch((error) => { $("#send-confirm").textContent = "Confirm & send →"; void render(error.message); });
});

void render();
