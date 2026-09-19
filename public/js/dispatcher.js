const socket = io({ transports: ["polling"] });

// Coimbatore default center
const map = L.map("map").setView([11.0168, 76.9558], 13);
L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/dark_matter/{z}/{x}/{y}{r}.png", {
  attribution: "© OpenStreetMap contributors, © CartoDB",
  subdomains: "abcd",
  maxZoom: 20
}).addTo(map);

const ambulanceMarkers = {};
const hospitalMarkers = {};
const patientMarkers = {}; // incidentId -> marker, for privacy-scoped live patient tracking
const knownAmbulanceIds = new Set();
let pendingIncidentLatLng = null;
let incidentMarker = null;
let routeLines = [];

// Register this dispatcher to receive privacy-scoped patient location
// updates — only clients that explicitly join this room ever see them.
socket.emit("dispatcher:join");

function clearRoutes() {
  routeLines.forEach((line) => map.removeLayer(line));
  routeLines = [];
}

function drawRoute(latlngPairs, color) {
  if (!latlngPairs || latlngPairs.length < 2) return;
  const line = L.polyline(latlngPairs, { color, weight: 4, opacity: 0.75 }).addTo(map);
  routeLines.push(line);
}

function fitToAllMarkers() {
  const allMarkers = [...Object.values(ambulanceMarkers), ...Object.values(hospitalMarkers)];
  if (allMarkers.length === 0) return;
  const group = L.featureGroup(allMarkers);
  map.fitBounds(group.getBounds().pad(0.3)); // 30% padding so markers aren't at the very edge
}

// click map to set incident location
map.on("click", (e) => {
  pendingIncidentLatLng = e.latlng;
  if (incidentMarker) map.removeLayer(incidentMarker);
  incidentMarker = L.marker(e.latlng, {
    icon: L.divIcon({ className: "", html: "🚨", iconSize: [24, 24] }),
  }).addTo(map);
});

document.getElementById("incidentBtn").onclick = () => {
  if (!pendingIncidentLatLng) {
    alert("Click a location on the map first to place the incident.");
    return;
  }
  const severity = prompt("Severity (1-10)?", "7");
  const note = prompt("Short note (e.g. road accident)?", "Road accident");

  socket.emit("incident:report", {
    lat: pendingIncidentLatLng.lat,
    lng: pendingIncidentLatLng.lng,
    severity: Number(severity) || 5,
    note,
  });
};

document.getElementById("fitAllBtn").onclick = fitToAllMarkers;

document.getElementById("blockRoadBtn").onclick = () => {
  socket.emit("demo:block-road");
};

socket.on("state:update", ({ ambulances, hospitals, activeRoute }) => {
  let newAmbulanceAppeared = false;

  // ambulances
  Object.values(ambulances).forEach((a) => {
    if (a.lat == null) return;
    if (ambulanceMarkers[a.id]) {
      ambulanceMarkers[a.id].setLatLng([a.lat, a.lng]);
      ambulanceMarkers[a.id].setTooltipContent(`${a.id} (${a.status})`);
    } else {
      ambulanceMarkers[a.id] = L.marker([a.lat, a.lng], {
        icon: L.divIcon({ className: "", html: "🚑", iconSize: [24, 24] }),
      })
        .addTo(map)
        .bindTooltip(`${a.id} (${a.status})`);
      if (!knownAmbulanceIds.has(a.id)) {
        knownAmbulanceIds.add(a.id);
        newAmbulanceAppeared = true;
      }
    }
  });

  // hospitals (static, shown once)
  hospitals.forEach((h) => {
    if (!hospitalMarkers[h.id]) {
      hospitalMarkers[h.id] = L.marker([h.lat, h.lng], {
        icon: L.divIcon({ className: "", html: "🏥", iconSize: [24, 24] }),
      })
        .addTo(map)
        .bindTooltip(`${h.name} — beds: ${h.beds}`);
    } else {
      hospitalMarkers[h.id].setTooltipContent(`${h.name} — beds: ${h.beds}`);
    }
  });

  // Auto zoom/pan to include every marker whenever a NEW ambulance
  // shows up, so an ambulance far from Coimbatore city center
  // (e.g. in Pollachi) is never silently off-screen.
  if (newAmbulanceAppeared) fitToAllMarkers();

  if (activeRoute) {
    clearRoutes();
    drawRoute(activeRoute.ambPath, "#dc2626");
    drawRoute(activeRoute.hospPath, "#2563eb");
  }
});

// Live patient location — only arrives because this dispatcher
// explicitly joined the privacy-scoped room above.
socket.on("patient:location-update", ({ incidentId, lat, lng }) => {
  if (patientMarkers[incidentId]) {
    patientMarkers[incidentId].setLatLng([lat, lng]);
  } else {
    patientMarkers[incidentId] = L.marker([lat, lng], {
      icon: L.divIcon({ className: "", html: "🧍", iconSize: [22, 22] }),
    }).addTo(map).bindTooltip(`Patient — ${incidentId}`);
  }
});

socket.on("log:event", (msg) => {
  const feed = document.getElementById("logFeed");
  const line = document.createElement("div");
  line.innerText = `[${new Date().toLocaleTimeString()}] ${msg}`;
  feed.prepend(line);
});
