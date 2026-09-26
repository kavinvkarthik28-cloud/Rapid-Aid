const socket = io({ transports: ["polling"] });

// Parse incident ID from URL query string
const urlParams = new URLSearchParams(window.location.search);
const incidentId = urlParams.get('id') || 'INC1';

document.getElementById('incIdDisplay').innerText = '#' + incidentId;
document.getElementById('incidentSub').innerText = `Live Tracking for Incident #${incidentId}`;

// ---- Initialize Leaflet Map ----
const map = L.map('trackMap', {
  zoomControl: true,
  fadeAnimation: true
}).setView([11.0168, 76.9558], 13);

// Google Maps Tile Layers
const gmapsStreets = L.tileLayer("https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}", {
  attribution: "&copy; Google Maps",
  maxZoom: 20,
  subdomains: ["mt0", "mt1", "mt2", "mt3"]
}).addTo(map);

const gmapsHybrid = L.tileLayer("https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}", {
  attribution: "&copy; Google Maps Satellite",
  maxZoom: 20,
  subdomains: ["mt0", "mt1", "mt2", "mt3"]
});

L.control.layers({
  "🗺️ Google Streets": gmapsStreets,
  "🛰️ Satellite": gmapsHybrid
}, null, { position: "topright" }).addTo(map);

function refreshMapSize() {
  if (map) map.invalidateSize();
}
window.addEventListener("resize", refreshMapSize);
setTimeout(refreshMapSize, 150);
setTimeout(refreshMapSize, 600);

let ambMarker = null;
let hospMarker = null;
let patientMarker = null;
let routeLine = null;

function createDivIcon(emoji, glowColor, size = 28) {
  return L.divIcon({
    className: "map-marker-pin",
    html: `<span style="font-size:${size}px;line-height:1;display:inline-block;filter:drop-shadow(0 0 10px ${glowColor});">${emoji}</span>`,
    iconSize: [size, size],
    iconAnchor: [Math.floor(size / 2), Math.floor(size / 2)]
  });
}

// Join tracking room for this incident
socket.emit('track:join', { incidentId });

socket.on('track:init', (data) => {
  if (!data || !data.found) {
    showToast(`⚠️ No active dispatch found for #${incidentId}`);
    return;
  }

  const { incident, ambulance, hospital, route, etaMinutes, status } = data;

  // Hospital UI
  document.getElementById('hospName').innerText = hospital.name || "Designated Hospital";
  document.getElementById('hospBeds').innerText = `${hospital.beds || 12} Beds Available`;
  document.getElementById('incSeverity').innerText = `Level ${incident.severity}/10 (${incident.severity >= 8 ? 'Critical' : 'Urgent'})`;
  document.getElementById('ambId').innerText = `Unit ${ambulance.id || 'A1'}`;
  document.getElementById('etaBadge').innerText = `ETA: ~${etaMinutes || 8} min`;

  // Set Navigation Link
  if (hospital.lat && hospital.lng) {
    document.getElementById('navBtn').href = `https://www.google.com/maps/dir/?api=1&destination=${hospital.lat},${hospital.lng}`;
  }

  // Draw Hospital Marker
  if (hospital.lat && hospital.lng) {
    hospMarker = L.marker([hospital.lat, hospital.lng], {
      icon: createDivIcon("🏥", "rgba(16, 185, 129, 0.9)", 30)
    }).addTo(map).bindTooltip(`Destination: ${hospital.name}`);
  }

  // Draw Patient Marker
  if (incident.lat && incident.lng) {
    patientMarker = L.marker([incident.lat, incident.lng], {
      icon: createDivIcon("🧍", "rgba(245, 158, 11, 0.9)", 26)
    }).addTo(map).bindTooltip(`Patient Pickup Location`);
  }

  // Draw Ambulance Marker
  if (ambulance.lat && ambulance.lng) {
    ambMarker = L.marker([ambulance.lat, ambulance.lng], {
      icon: createDivIcon("🚑", "rgba(239, 68, 68, 0.95)", 32)
    }).addTo(map).bindTooltip(`Ambulance Unit ${ambulance.id} (Live)`);
  }

  // Draw Route Polyline
  const fullPath = [...(route.ambPath || []), ...(route.hospPath || [])];
  if (fullPath.length > 1) {
    routeLine = L.polyline(fullPath, { color: "#3b82f6", weight: 5, opacity: 0.8 }).addTo(map);
  }

  // Fit bounds to show route
  const markers = [ambMarker, hospMarker, patientMarker].filter(Boolean);
  if (markers.length > 0) {
    const group = L.featureGroup(markers);
    map.fitBounds(group.getBounds().pad(0.3));
  }

  if (status === "arrived") {
    markAsArrived(hospital.name);
  }
});

// Real-time GPS location updates from the moving ambulance
socket.on('track:location', ({ ambulanceId, lat, lng }) => {
  if (!lat || !lng) return;

  if (ambMarker) {
    ambMarker.setLatLng([lat, lng]);
  } else {
    ambMarker = L.marker([lat, lng], {
      icon: createDivIcon("🚑", "rgba(239, 68, 68, 0.95)", 32)
    }).addTo(map).bindTooltip(`Ambulance Unit ${ambulanceId} (Live)`);
  }

  document.getElementById('gpsStatus').innerText = `Live (${new Date().toLocaleTimeString()})`;
});

// Arrival notification
socket.on('track:arrived', ({ hospital }) => {
  markAsArrived(hospital ? hospital.name : "Destination Hospital");
});

function markAsArrived(hospName) {
  document.getElementById('transitStatusText').innerText = "ARRIVED AT EMERGENCY WARD";
  document.getElementById('transitStatusText').parentElement.style.color = "var(--success)";
  document.getElementById('etaBadge').innerText = "ARRIVED ✓";
  document.getElementById('etaBadge').style.color = "var(--success)";

  document.getElementById('tlLineDest').classList.add('completed');
  document.getElementById('tlArrived').classList.add('completed');

  showToast(`🏥 Ambulance has arrived at ${hospName}`);
}

// ---- Share Action ----
document.getElementById('shareBtn').onclick = () => {
  const shareData = {
    title: `RapidAid Live Tracker - Incident #${incidentId}`,
    text: `🚨 Track the live ambulance location and destination hospital here:`,
    url: window.location.href
  };

  if (navigator.share) {
    navigator.share(shareData).catch(() => {});
  } else {
    navigator.clipboard.writeText(window.location.href).then(() => {
      showToast("📋 Live tracking link copied to clipboard!");
    });
    // Open WhatsApp Web share as fallback
    const whatsappUrl = `https://api.whatsapp.com/send?text=${encodeURIComponent(shareData.text + ' ' + shareData.url)}`;
    window.open(whatsappUrl, '_blank');
  }
};

// Toast helper
let toastTimer = null;
function showToast(msg) {
  const toast = document.getElementById('trackToast');
  toast.innerText = msg;
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.add('hidden');
  }, 3500);
}
