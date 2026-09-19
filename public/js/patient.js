const socket = io({ transports: ["polling"] });
let verifiedPhone = null;
let liveTrackingWatchId = null;

function show(id) {
  ["phoneStep", "otpStep", "sosStep", "waitingStep", "assignedStep"].forEach((s) => {
    document.getElementById(s).classList.toggle("hidden", s !== id);
  });
}

document.getElementById("sendOtpBtn").onclick = () => {
  const phone = document.getElementById("phoneInput").value.trim();
  if (phone.length !== 10) {
    document.getElementById("phoneError").innerText = "Enter a valid 10-digit number";
    return;
  }
  socket.emit("auth:request-otp", { phone });
};

socket.on("auth:otp-sent", ({ phone }) => {
  verifiedPhone = phone;
  show("otpStep");
});

document.getElementById("verifyOtpBtn").onclick = () => {
  const code = document.getElementById("otpInput").value.trim();
  socket.emit("auth:verify-otp", { phone: verifiedPhone, code });
};

socket.on("auth:verified", () => show("sosStep"));

socket.on("auth:error", (msg) => {
  document.getElementById("phoneError").innerText = msg;
  document.getElementById("otpError").innerText = msg;
});

document.getElementById("sosBtn").onclick = () => {
  const contact = document.getElementById("contactInput").value.trim();
  const severity = document.getElementById("severityInput").value;
  document.getElementById("sosNote").innerText = "Getting your location…";

  if (!navigator.geolocation) {
    sendSOSFallback(severity, contact);
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      socket.emit("sos:report", {
        lat: pos.coords.latitude, lng: pos.coords.longitude,
        severity, emergencyContact: contact || undefined,
      });
      show("waitingStep");
    },
    () => sendSOSFallback(severity, contact),
    { enableHighAccuracy: true, timeout: 8000 }
  );
};

function sendSOSFallback(severity, contact) {
  document.getElementById("sosNote").innerText = "Using approximate location (GPS unavailable)";
  socket.emit("sos:report", { lat: 11.0168, lng: 76.9558, severity, emergencyContact: contact || undefined });
  show("waitingStep");
}

socket.on("sos:assignment", ({ hospital, ambulanceId, etaMinutes }) => {
  document.getElementById("assignedHospital").innerText = `Hospital: ${hospital}`;
  document.getElementById("assignedAmbulance").innerText = `Ambulance: ${ambulanceId}`;
  document.getElementById("assignedEta").innerText = `ETA: ~${etaMinutes} min`;
  show("assignedStep");
  startLiveTracking();
});

socket.on("sos:queued", ({ message }) => {
  document.getElementById("waitingMsg").innerText = message;
});

function startLiveTracking() {
  if (liveTrackingWatchId || !navigator.geolocation) return;
  liveTrackingWatchId = navigator.geolocation.watchPosition(
    (pos) => socket.emit("patient:location", { lat: pos.coords.latitude, lng: pos.coords.longitude }),
    (err) => console.warn("Live tracking GPS error:", err),
    { enableHighAccuracy: true, maximumAge: 3000, timeout: 8000 }
  );
}
