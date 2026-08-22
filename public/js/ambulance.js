const socket = io({ transports: ["polling"] });
let ambId = null;

function joinAsAmbulance() {
  ambId = document.getElementById("ambIdInput").value.trim();
  if (!ambId) return alert("Enter an ambulance ID");

  socket.emit("ambulance:join", { id: ambId });

  document.getElementById("setup").classList.add("hidden");
  document.getElementById("statusScreen").classList.remove("hidden");
  document.getElementById("idLabel").innerText = "Ambulance " + ambId;

  startGPS();
}

document.getElementById("joinBtn").onclick = joinAsAmbulance;

document.getElementById("ambIdInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    joinAsAmbulance();
  }
});

// Coimbatore-area base points to simulate movement around, per ambulance ID.
// Falls back deterministically so the same ID always starts near the same spot.
const SIM_BASE_POINTS = [
  { lat: 11.0168, lng: 76.9558 },
  { lat: 11.0916, lng: 76.9950 },
  { lat: 11.0040, lng: 76.9612 },
  { lat: 11.0300, lng: 76.9700 },
];

function startGPS() {
  if (!navigator.geolocation) {
    console.warn("Geolocation not supported — using simulated GPS instead");
    startSimulatedGPS();
    return;
  }

  let receivedRealFix = false;

  navigator.geolocation.watchPosition(
    (pos) => {
      receivedRealFix = true;
      socket.emit("ambulance:location", {
        id: ambId,
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
      });
    },
    (err) => {
      console.error("GPS error:", err);
      // Common cause: page loaded over plain http:// on a non-localhost
      // address — browsers block real geolocation there. Fall back
      // automatically so the demo still works.
      if (!receivedRealFix) startSimulatedGPS();
    },
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 8000 }
  );

  // Safety net: if no real fix arrives within 8s (permission blocked
  // silently, no error fired), fall back anyway.
  setTimeout(() => {
    if (!receivedRealFix) startSimulatedGPS();
  }, 8000);
}

let simInterval = null;
function startSimulatedGPS() {
  if (simInterval) return; // already running
  document.querySelector(".gps-note").innerText = "Using simulated GPS (real GPS unavailable)";

  const idx = Math.abs(hashCode(ambId)) % SIM_BASE_POINTS.length;
  let { lat, lng } = SIM_BASE_POINTS[idx];

  simInterval = setInterval(() => {
    // small random walk so the marker visibly drifts on the map
    lat += (Math.random() - 0.5) * 0.002;
    lng += (Math.random() - 0.5) * 0.002;
    socket.emit("ambulance:location", { id: ambId, lat, lng });
  }, 2000);
}

function hashCode(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h << 5) - h + str.charCodeAt(i);
  return h;
}

socket.on("assignment:new", ({ incident, hospital }) => {
  const badge = document.getElementById("statusBadge");
  badge.innerText = "EN ROUTE";
  badge.className = "status-badge en-route";

  const card = document.getElementById("assignmentCard");
  card.classList.remove("hidden");
  document.getElementById("assignIncident").innerText =
    `Incident: ${incident.id} (severity ${incident.severity})`;
  document.getElementById("assignHospital").innerText =
    `Destination: ${hospital.name}`;
});
