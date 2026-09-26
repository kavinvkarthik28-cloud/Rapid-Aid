const socket = io({ transports: ["polling"] });

// ---- Map Initialization ----
const map = L.map("map", {
  zoomControl: true,
  fadeAnimation: true,
  zoomAnimation: true
}).setView([11.0168, 76.9558], 13);

// ---- Map Tile Layers (Real Google Maps + Satellite + Dark Mode) ----
const gmapsStreets = L.tileLayer("https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}", {
  attribution: "&copy; Google Maps",
  maxZoom: 20,
  subdomains: ["mt0", "mt1", "mt2", "mt3"]
});

const gmapsHybrid = L.tileLayer("https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}", {
  attribution: "&copy; Google Maps Satellite",
  maxZoom: 20,
  subdomains: ["mt0", "mt1", "mt2", "mt3"]
});

const darkCanvas = L.layerGroup([
  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}", {
    attribution: "Tiles &copy; Esri",
    maxZoom: 16
  }),
  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}", {
    attribution: "",
    maxZoom: 16,
    opacity: 0.8
  })
]);

// Set Google Maps Streets as default
gmapsStreets.addTo(map);

// Add modern layer switcher
const baseMaps = {
  "🗺️ Google Streets": gmapsStreets,
  "🛰️ Satellite Hybrid": gmapsHybrid,
  "🌙 Dark Mode": darkCanvas
};

L.control.layers(baseMaps, null, { position: "topright" }).addTo(map);

// Invalidate size on container layout calculation
function refreshMapSize() {
  if (map) {
    map.invalidateSize();
  }
}
window.addEventListener("resize", refreshMapSize);
document.addEventListener("DOMContentLoaded", refreshMapSize);
setTimeout(refreshMapSize, 100);
setTimeout(refreshMapSize, 300);
setTimeout(refreshMapSize, 800);

const ambulanceMarkers = {};
const hospitalMarkers = {};
const patientMarkers = {}; // incidentId -> marker
const knownAmbulanceIds = new Set();
let pendingIncidentLatLng = null;
let incidentMarker = null;
let routeLines = [];
let totalIncidents = 0;

// Register this dispatcher to receive privacy-scoped patient location updates
socket.emit("dispatcher:join");

function clearRoutes() {
  routeLines.forEach((line) => map.removeLayer(line));
  routeLines = [];
}

function drawRoute(latlngPairs, color) {
  if (!latlngPairs || latlngPairs.length < 2) return;
  const line = L.polyline(latlngPairs, { color, weight: 4, opacity: 0.85 }).addTo(map);
  routeLines.push(line);
}

function createDivIcon(emoji, glowColor, size = 26) {
  return L.divIcon({
    className: "map-marker-pin",
    html: `<span style="font-size:${size}px;line-height:1;display:inline-block;filter:drop-shadow(0 0 8px ${glowColor});">${emoji}</span>`,
    iconSize: [size, size],
    iconAnchor: [Math.floor(size / 2), Math.floor(size / 2)]
  });
}

function fitToAllMarkers() {
  const allMarkers = [
    ...Object.values(ambulanceMarkers),
    ...Object.values(hospitalMarkers),
    ...Object.values(patientMarkers)
  ];
  if (pendingIncidentLatLng && incidentMarker) allMarkers.push(incidentMarker);
  if (allMarkers.length === 0) return;
  const group = L.featureGroup(allMarkers);
  map.fitBounds(group.getBounds().pad(0.25));
}

// ---- Map Click: Place Incident Marker & Open Panel ----
map.on("click", (e) => {
  pendingIncidentLatLng = e.latlng;
  if (incidentMarker) map.removeLayer(incidentMarker);

  incidentMarker = L.marker(e.latlng, {
    icon: createDivIcon("🚨", "rgba(239, 68, 68, 0.9)", 30)
  }).addTo(map);

  openIncidentPanel();
  showToast("📍 Incident marker set — configure & dispatch below");
});

function openIncidentPanel() {
  document.getElementById("incidentPanel").classList.remove("hidden");
  document.getElementById("mapHint").classList.add("hidden");
  const noteInput = document.getElementById("dispNote");
  if (noteInput) noteInput.focus();
}

function closeIncidentPanel() {
  document.getElementById("incidentPanel").classList.add("hidden");
  document.getElementById("mapHint").classList.remove("hidden");
}

document.getElementById("ipClose").onclick = closeIncidentPanel;

// ---- Severity Selector ----
document.querySelectorAll(".dsev-opt").forEach((opt) => {
  opt.addEventListener("click", () => {
    document.querySelectorAll(".dsev-opt").forEach((o) => o.classList.remove("selected"));
    opt.classList.add("selected");
    document.getElementById("dispSeverity").value = opt.getAttribute("data-value");
  });
});

// ---- Submit Incident Report ----
function submitIncident() {
  if (!pendingIncidentLatLng) {
    showToast("⚠️ Click on the map first to set incident location");
    return;
  }

  const severity = Number(document.getElementById("dispSeverity").value) || 9;
  const note = document.getElementById("dispNote").value.trim() || "Emergency Dispatch Incident";

  socket.emit("incident:report", {
    lat: pendingIncidentLatLng.lat,
    lng: pendingIncidentLatLng.lng,
    severity,
    note,
  });

  totalIncidents++;
  document.getElementById("cntInc").innerText = totalIncidents;

  showToast(`🚨 Incident dispatched (Severity ${severity}/10)`);
  closeIncidentPanel();
  document.getElementById("dispNote").value = "";
}

document.getElementById("submitIncidentBtn").onclick = submitIncident;
document.getElementById("incidentBtn").onclick = () => {
  if (!pendingIncidentLatLng) {
    showToast("🗺️ Click on the map to pick an incident location");
  } else {
    openIncidentPanel();
  }
};

document.getElementById("dispNote").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    submitIncident();
  }
});

document.getElementById("fitAllBtn").onclick = () => {
  fitToAllMarkers();
  refreshMapSize();
};

document.getElementById("blockRoadBtn").onclick = () => {
  socket.emit("demo:block-road");
  showToast("🚧 Roadblock simulated — recalculating routes");
};

// ---- Toast Helper ----
let toastTimeout = null;
function showToast(msg) {
  const toast = document.getElementById("incidentToast");
  toast.innerHTML = msg;
  toast.classList.remove("hidden");
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    toast.classList.add("hidden");
  }, 3500);
}

// ---- Clear Log Feed ----
document.getElementById("clearLogBtn").onclick = () => {
  document.getElementById("logFeed").innerHTML = "";
  document.getElementById("logEmpty").classList.remove("hidden");
};

// ---- Socket Updates ----
socket.on("state:update", ({ ambulances, hospitals, activeRoute }) => {
  let newAmbulanceAppeared = false;

  // ambulances
  const ambList = Object.values(ambulances || {});
  document.getElementById("cntAmb").innerText = ambList.length;

  ambList.forEach((a) => {
    if (a.lat == null) return;
    const isEnRoute = a.status === "en-route";
    const glow = isEnRoute ? "rgba(245,158,11,0.9)" : "rgba(16,185,129,0.9)";

    if (ambulanceMarkers[a.id]) {
      ambulanceMarkers[a.id].setLatLng([a.lat, a.lng]);
      ambulanceMarkers[a.id].setTooltipContent(`Unit ${a.id} • ${a.status ? a.status.toUpperCase() : 'ONLINE'}`);
    } else {
      ambulanceMarkers[a.id] = L.marker([a.lat, a.lng], {
        icon: createDivIcon("🚑", glow, 26),
      })
        .addTo(map)
        .bindTooltip(`Unit ${a.id} • ${a.status ? a.status.toUpperCase() : 'ONLINE'}`);
      if (!knownAmbulanceIds.has(a.id)) {
        knownAmbulanceIds.add(a.id);
        newAmbulanceAppeared = true;
      }
    }
  });

  // hospitals
  const hospList = hospitals || [];
  document.getElementById("cntHosp").innerText = hospList.length;

  hospList.forEach((h) => {
    if (!hospitalMarkers[h.id]) {
      hospitalMarkers[h.id] = L.marker([h.lat, h.lng], {
        icon: createDivIcon("🏥", "rgba(52,211,153,0.9)", 26),
      })
        .addTo(map)
        .bindTooltip(`${h.name} — ${h.beds} beds available`);
    } else {
      hospitalMarkers[h.id].setTooltipContent(`${h.name} — ${h.beds} beds available`);
    }
  });

  if (newAmbulanceAppeared) fitToAllMarkers();

  if (activeRoute) {
    clearRoutes();
    drawRoute(activeRoute.ambPath, "#ef4444");
    drawRoute(activeRoute.hospPath, "#3b82f6");
  }
});

// Live patient location update
socket.on("patient:location-update", ({ incidentId, lat, lng }) => {
  if (patientMarkers[incidentId]) {
    patientMarkers[incidentId].setLatLng([lat, lng]);
  } else {
    patientMarkers[incidentId] = L.marker([lat, lng], {
      icon: createDivIcon("🧍", "rgba(245,158,11,0.9)", 24),
    }).addTo(map).bindTooltip(`Patient #${incidentId} (Live)`);
    fitToAllMarkers();
  }
});

// Event feed log
socket.on("log:event", (msg) => {
  const feed = document.getElementById("logFeed");
  const empty = document.getElementById("logEmpty");
  if (empty) empty.classList.add("hidden");

  const line = document.createElement("div");
  const time = new Date().toLocaleTimeString();
  line.innerHTML = `<span style="color:#60a5fa;font-weight:700;">[${time}]</span> ${msg}`;
  feed.prepend(line);
});
