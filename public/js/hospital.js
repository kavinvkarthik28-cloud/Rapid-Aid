const socket = io({ transports: ["polling"] });
let hospId = null;

document.getElementById("joinBtn").onclick = () => {
  hospId = document.getElementById("hospIdInput").value;
  socket.emit("hospital:join", { id: hospId });

  document.getElementById("setup").classList.add("hidden");
  document.getElementById("mainScreen").classList.remove("hidden");
  document.getElementById("hospName").innerText =
    document.getElementById("hospIdInput").selectedOptions[0].text;
};

socket.on("hospital:incoming", ({ hospitalId, incident, ambulanceId }) => {
  if (hospitalId !== hospId) return; // not for this hospital

  document.getElementById("idleNote").classList.add("hidden");
  const card = document.getElementById("incomingCard");
  card.classList.remove("hidden");
  document.getElementById("incAmb").innerText = ambulanceId;
  document.getElementById("incSeverity").innerText = incident.severity;
  document.getElementById("incNote").innerText = incident.note || "—";
  document.getElementById("incTime").innerText = incident.time;
});

document.getElementById("ackBtn").onclick = () => {
  alert("Acknowledged — prepare bed & staff for incoming patient.");
};
