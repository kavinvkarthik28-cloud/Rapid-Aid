const socket = io({ transports: ["polling"] });
let ambId = null;

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

function joinAsAmbulance() {
  ambId = document.getElementById("ambIdInput").value.trim();
  const pin = document.getElementById("ambPinInput").value.trim();
  const errEl = document.getElementById("ambAuthError");
  errEl.innerText = "";

  if (!ambId || !pin) {
    errEl.innerText = "Please enter both Ambulance ID and Duty PIN";
    const box = document.getElementById("setupStep");
    box.classList.remove("shake");
    void box.offsetWidth;
    box.classList.add("shake");
    return;
  }

  socket.emit("ambulance:join", { id: ambId, pin });
}

socket.on("ambulance:join-ok", () => {
  document.getElementById("unitLabel").innerText = "Ambulance Unit " + ambId;
  show("onDutyStep");
  startGPS();
});

socket.on("auth:error", (msg) => {
  const errEl = document.getElementById("ambAuthError");
  errEl.innerText = msg;
  const box = document.getElementById("setupStep");
  box.classList.remove("shake");
  void box.offsetWidth;
  box.classList.add("shake");
});

document.getElementById("joinBtn").onclick = joinAsAmbulance;

document.getElementById("ambPinInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    joinAsAmbulance();
  }
});

document.getElementById("ambIdInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    document.getElementById("ambPinInput").focus();
  }
});

// Coimbatore-area base points to simulate movement around, per ambulance ID.
const SIM_BASE_POINTS = [
  { lat: 11.0168, lng: 76.9558 },
  { lat: 11.0916, lng: 76.9950 },
  { lat: 11.0040, lng: 76.9612 },
  { lat: 11.0300, lng: 76.9700 },
];

function startGPS() {
  const gpsDot = document.getElementById("gpsDot");
  const gpsText = document.getElementById("gpsText");

  if (!navigator.geolocation) {
    console.warn("Geolocation not supported — using simulated GPS instead");
    startSimulatedGPS();
    return;
  }

  let receivedRealFix = false;

  navigator.geolocation.watchPosition(
    (pos) => {
      receivedRealFix = true;
      if (gpsDot) gpsDot.classList.remove("simulated");
      if (gpsText) gpsText.innerText = "Live GPS Active (Accuracy ±" + Math.round(pos.coords.accuracy || 10) + "m)";
      socket.emit("ambulance:location", {
        id: ambId,
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
      });
    },
    (err) => {
      console.error("GPS error:", err);
      if (!receivedRealFix) startSimulatedGPS();
    },
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 8000 }
  );

  setTimeout(() => {
    if (!receivedRealFix) startSimulatedGPS();
  }, 8000);
}

let simInterval = null;
function startSimulatedGPS() {
  if (simInterval) return;
  const gpsDot = document.getElementById("gpsDot");
  const gpsText = document.getElementById("gpsText");
  if (gpsDot) gpsDot.classList.add("simulated");
  if (gpsText) gpsText.innerText = "Simulated GPS Active (Coimbatore Region)";

  const idx = Math.abs(hashCode(ambId)) % SIM_BASE_POINTS.length;
  let { lat, lng } = SIM_BASE_POINTS[idx];

  simInterval = setInterval(() => {
    lat += (Math.random() - 0.5) * 0.0015;
    lng += (Math.random() - 0.5) * 0.0015;
    socket.emit("ambulance:location", { id: ambId, lat, lng });
  }, 2000);
}

function hashCode(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h << 5) - h + str.charCodeAt(i);
  return h;
}

// Assignment received from dispatcher / AI engine
socket.on("assignment:new", ({ incident, hospital }) => {
  const chip = document.getElementById("statusChip");
  const ring = document.getElementById("statusRing");
  const ringIcon = document.getElementById("ringIcon");
  const dutyDesc = document.getElementById("dutyDesc");

  chip.innerText = "DISPATCHED / EN ROUTE";
  chip.className = "status-chip en-route";
  if (ring) ring.classList.add("en-route");
  if (ringIcon) ringIcon.innerText = "🚨";
  if (dutyDesc) dutyDesc.innerText = "Active emergency response in progress. Proceed to incident location.";

  const card = document.getElementById("assignmentCard");
  card.classList.remove("hidden");
  document.getElementById("assignIncident").innerHTML =
    `<strong>Incident:</strong> #${incident.id} <span style="color:#f87171">(Severity ${incident.severity}/10)</span>`;
  document.getElementById("assignHospital").innerHTML =
    `<strong>Destination:</strong> ${hospital.name}`;
});

// Trip complete
document.getElementById("completeBtn").onclick = () => {
  socket.emit("ambulance:complete", { id: ambId });

  const chip = document.getElementById("statusChip");
  const ring = document.getElementById("statusRing");
  const ringIcon = document.getElementById("ringIcon");
  const dutyDesc = document.getElementById("dutyDesc");

  chip.innerText = "AVAILABLE";
  chip.className = "status-chip available";
  if (ring) ring.classList.remove("en-route");
  if (ringIcon) ringIcon.innerText = "🚑";
  if (dutyDesc) dutyDesc.innerText = "On duty and broadcasting your live location. Standby for assignment.";

  document.getElementById("assignmentCard").classList.add("hidden");
};
