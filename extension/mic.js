// Janelinha de permissão do microfone. Pede assim que abre (não precisa de clique);
// ao liberar, avisa o background, que liga o mic na gravação em andamento, e fecha.
const show = (id) => {
  for (const s of document.querySelectorAll("section")) s.hidden = s.id !== id;
};

async function ask() {
  show("asking");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    show("ok");
    await chrome.runtime.sendMessage({ target: "background", type: "mic-granted" });
    setTimeout(() => window.close(), 1200);
  } catch (e) {
    document.getElementById("reason").textContent =
      e.name === "NotFoundError" ? "Nenhum microfone foi encontrado neste computador." : "O Chrome não liberou o microfone.";
    show("denied");
  }
}

document.getElementById("retry").addEventListener("click", ask);
document.getElementById("skip").addEventListener("click", () => window.close());
ask();
