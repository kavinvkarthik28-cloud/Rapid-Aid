const socket = io({ transports: ["polling"] });

// Coimbatore default center
const map = L.map("map").setView([11.0168, 76.9558], 13);
L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
  attribution: "© OpenStreetMap contributors, © CartoDB",
  subdomains: "abcd",
  maxZoom: 20
}).addTo(map);

const ambulanceMarkers = {};
const hospitalMarkers = {};
const knownAmbulanceIds = new Set();
let pendingIncidentLatLng = null;
let incidentMarker = null;

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

socket.on("state:update", ({ ambulances, hospitals }) => {
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
});

socket.on("log:event", (msg) => {
  const feed = document.getElementById("logFeed");
  const line = document.createElement("div");
  line.innerText = `[${new Date().toLocaleTimeString()}] ${msg}`;
  feed.prepend(line);
});
