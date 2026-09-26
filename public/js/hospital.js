const socket = io({ transports: ["polling"] });
let hospId = null;

// ---- Smooth Step Transitions ----
function show(stepId) {
  const current = document.querySelector(".wizard-step.active");
  const next = document.getElementById(stepId);
  if (!next || current === next) return;

  if (current) {
    current.classList.remove("active");
    current.classList.add("slide-exit");
    setTimeout(() => {
      current.classList.remove("slide-exit");
      next.classList.add("active");
    }, 240);
  } else {
    next.classList.add("active");
  }
}

function joinAsHospital() {
  hospId = document.getElementById("hospIdInput").value;
  const pin = document.getElementById("hospPinInput").value.trim();
  const errEl = document.getElementById("hospAuthError");
  errEl.innerText = "";

  if (!pin) {
    errEl.innerText = "Please enter your 4-digit Staff PIN";
    const box = document.getElementById("setupStep");
    box.classList.remove("shake");
    void box.offsetWidth;
    box.classList.add("shake");
    return;
  }

  socket.emit("hospital:join", { id: hospId, pin });
}

document.getElementById("joinBtn").onclick = joinAsHospital;

document.getElementById("hospPinInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    joinAsHospital();
  }
});

socket.on("hospital:join-ok", () => {
  const hospSelect = document.getElementById("hospIdInput");
  const selectedText = hospSelect.options[hospSelect.selectedIndex].text;
  document.getElementById("hospName").innerText = selectedText;
  show("mainStep");
});

socket.on("auth:error", (msg) => {
  const errEl = document.getElementById("hospAuthError");
  errEl.innerText = msg;
  const box = document.getElementById("setupStep");
  box.classList.remove("shake");
  void box.offsetWidth;
  box.classList.add("shake");
});

socket.on("hospital:incoming", ({ hospitalId, incident, ambulanceId }) => {
  if (hospitalId !== hospId) return; // not for this hospital

  document.getElementById("idleState").classList.add("hidden");
  document.getElementById("ackState").classList.add("hidden");

  const card = document.getElementById("incomingCard");
  card.classList.remove("hidden");

  document.getElementById("incAmb").innerText = "Unit " + ambulanceId;
  document.getElementById("incSeverity").innerText = `${incident.severity}/10 (${incident.severity >= 8 ? "Critical" : incident.severity >= 5 ? "Serious" : "Moderate"})`;
  document.getElementById("incNote").innerText = incident.note || "Emergency patient transit";
  document.getElementById("incTime").innerText = incident.time || new Date().toLocaleTimeString();
});

document.getElementById("ackBtn").onclick = () => {
  document.getElementById("incomingCard").classList.add("hidden");
  document.getElementById("ackState").classList.remove("hidden");

  // After 10s, return gently back to idle standing-by state if no new incoming
  setTimeout(() => {
    if (document.getElementById("incomingCard").classList.contains("hidden")) {
      document.getElementById("ackState").classList.add("hidden");
      document.getElementById("idleState").classList.remove("hidden");
    }
  }, 10000);
};
