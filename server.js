// server.js
// Backend for the Disaster Response Coordination demo.
// Node.js + Express + Socket.io — real-time layer connecting
// Dispatcher, Ambulance, and Hospital screens.

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static("public"));

// ---------------------------------------------------------------
// DUMMY DATA — replace/extend with real Coimbatore coordinates
// ---------------------------------------------------------------
const hospitals = [
  { id: "H1", name: "City General Hospital", lat: 11.0168, lng: 76.9558, beds: 3, icuBeds: 1 },
  { id: "H2", name: "Amrita Hospital", lat: 11.0916, lng: 76.9950, beds: 5, icuBeds: 2 },
  { id: "H3", name: "St. Mary's Medical Center", lat: 11.0040, lng: 76.9612, beds: 0, icuBeds: 0 },
];

// live state
const ambulances = {}; // id -> { id, lat, lng, status, socketId }
const incidents = [];  // log of triggered incidents
let lastIncident = null;
let lastAssignment = null; // { incident, ambulance, hospital }

// ---------------------------------------------------------------
// KNOWLEDGE BASE — explicit facts + forward-chaining rules
// Unit 3: KB Agents, Propositional Logic, Forward Chaining
//
// Each rule is a function: (hospital, incident) -> { fails, reason }
// "fails: true" means the rule EXCLUDES this hospital for this incident.
// This is genuine forward chaining: incoming facts (the incident,
// each hospital's live state) are matched against rule conditions,
// and matching rules fire to exclude/flag candidates.
// ---------------------------------------------------------------
const KB_RULES = [
  {
    name: "no-beds",
    check: (hospital) => hospital.beds <= 0,
    reason: (h) => `${h.name} excluded — 0 general beds available`,
  },
  {
    name: "no-icu-for-critical",
    check: (hospital, incident) => incident.severity >= 8 && hospital.icuBeds <= 0,
    reason: (h) => `${h.name} excluded — severity requires ICU, 0 ICU beds available`,
  },
  {
    name: "road-blocked",
    check: (hospital) => hospital.roadBlocked === true,
    reason: (h) => `${h.name} excluded — access road currently marked blocked`,
  },
];

// Runs forward chaining: apply every rule to every hospital,
// return only hospitals with zero rule violations, plus a log
// of every exclusion reason fired (for the explainability panel).
function applyKBRules(hospitalList, incident) {
  const reasons = [];
  const eligible = hospitalList.filter((h) => {
    for (const rule of KB_RULES) {
      if (rule.check(h, incident)) {
        reasons.push(rule.reason(h));
        return false; // excluded — stop checking further rules for this hospital
      }
    }
    return true; // survived every rule
  });
  return { eligible, reasons };
}

// ---------------------------------------------------------------
// CSP — Constraint Satisfaction with Backtracking
// Unit 3: CSP, Inference in CSP, Backtracking Search
//
// Variables: (ambulance, hospital) pair for this incident
// Domains:   ambulance ∈ available ambulances
//            hospital  ∈ hospitals that survived KB filtering
// Constraint: distance(ambulance, incident) must be within MAX_DISTANCE
// Backtracking: if the top-ranked (ambulance, hospital) pair fails
// the distance constraint, try the next candidate pair instead of
// just returning the closest ones blindly.
// ---------------------------------------------------------------
const MAX_DISTANCE_DEG = 0.5; // ~50km in lat/lng degrees — generous cap for demo

function straightLineDist(a, b) {
  return Math.sqrt((a.lat - b.lat) ** 2 + (a.lng - b.lng) ** 2);
}

function solveCSP(availableAmbulances, eligibleHospitals, incident) {
  // Rank ambulances by proximity to incident (best domain values first)
  const ambCandidates = [...availableAmbulances].sort(
    (a, b) => straightLineDist(a, incident) - straightLineDist(b, incident)
  );
  // Rank hospitals by proximity to incident
  const hospCandidates = [...eligibleHospitals].sort(
    (a, b) => straightLineDist(a, incident) - straightLineDist(b, incident)
  );

  // Backtracking search over the (ambulance, hospital) assignment space
  for (const amb of ambCandidates) {
    const ambDist = straightLineDist(amb, incident);
    if (ambDist > MAX_DISTANCE_DEG) continue; // constraint violated, backtrack to next ambulance

    for (const hosp of hospCandidates) {
      // constraint satisfied for this (ambulance, hospital) pair — accept it
      return { ambulance: amb, hospital: hosp, ambDist };
    }
  }
  return null; // no assignment satisfies all constraints — CSP has no solution
}

// ---------------------------------------------------------------
// MAIN DECISION PIPELINE
// This replaces the old placeholder. Same function name/signature,
// so nothing else in server.js needs to change.
// ---------------------------------------------------------------
function selectBestAmbulanceAndHospital(incident, logFn) {
  // Step 1: CSP domain restriction — only available ambulances qualify
  const availableAmbulances = Object.values(ambulances).filter(
    (a) => a.status === "available" && a.lat != null
  );
  if (availableAmbulances.length === 0) {
    logFn("No available ambulances — CSP has no solution");
    return null;
  }

  // Step 2: Forward-chaining KB rules filter hospitals
  const { eligible, reasons } = applyKBRules(hospitals, incident);
  reasons.forEach((r) => logFn(r)); // every exclusion reason is logged, visibly

  if (eligible.length === 0) {
    logFn("No eligible hospitals after KB rule filtering — CSP has no solution");
    return null;
  }

  // Step 3: CSP backtracking search over the remaining candidates
  const result = solveCSP(availableAmbulances, eligible, incident);
  if (!result) {
    logFn("No (ambulance, hospital) pair satisfies distance constraint — backtracking exhausted");
    return null;
  }

  logFn(
    `CSP solution found — Ambulance ${result.ambulance.id} (dist ${result.ambDist.toFixed(3)}) → ${result.hospital.name}`
  );
  return { ambulance: result.ambulance, hospital: result.hospital };
}

// ---------------------------------------------------------------
// SOCKET.IO EVENTS
// ---------------------------------------------------------------
io.on("connection", (socket) => {
  console.log("New connection:", socket.id);

  // Ambulance registers itself
  socket.on("ambulance:join", ({ id }) => {
    ambulances[id] = {
      id,
      lat: null,
      lng: null,
      status: "available",
      socketId: socket.id,
    };
    socket.data.role = "ambulance";
    socket.data.ambulanceId = id;
    io.emit("state:update", { ambulances, hospitals });
    console.log(`Ambulance ${id} joined`);
  });

  // Ambulance streams live GPS
  socket.on("ambulance:location", ({ id, lat, lng }) => {
    if (ambulances[id]) {
      ambulances[id].lat = lat;
      ambulances[id].lng = lng;
      io.emit("state:update", { ambulances, hospitals });
    }
  });

  // Hospital registers itself
  socket.on("hospital:join", ({ id }) => {
    socket.data.role = "hospital";
    socket.data.hospitalId = id;
    io.emit("state:update", { ambulances, hospitals });
  });

  // Dispatcher triggers a new incident
  socket.on("incident:report", ({ lat, lng, severity, note }) => {
    const incident = {
      id: "INC" + (incidents.length + 1),
      lat,
      lng,
      severity,
      note,
      time: new Date().toLocaleTimeString(),
    };
    incidents.push(incident);
    lastIncident = incident;

    io.emit("log:event", `Incident ${incident.id} reported (severity ${severity})`);

    const logFn = (msg) => io.emit("log:event", msg);
    const result = selectBestAmbulanceAndHospital(incident, logFn);

    if (!result) {
      io.emit("log:event", `No available ambulance/hospital for ${incident.id}`);
      return;
    }

    const { ambulance, hospital } = result;
    lastAssignment = { incident, ambulance, hospital };

    // mark ambulance busy, decrement hospital capacity
    ambulances[ambulance.id].status = "en-route";
    hospital.beds = Math.max(0, hospital.beds - 1);

    io.emit(
      "log:event",
      `${incident.id} → Ambulance ${ambulance.id} assigned → Routing to ${hospital.name} (ETA calc pending real A*)`
    );

    // notify the specific ambulance
    io.to(ambulance.socketId).emit("assignment:new", {
      incident,
      hospital,
    });

    // notify all hospital screens (simple demo — filter by hospital.id in frontend)
    io.emit("hospital:incoming", {
      hospitalId: hospital.id,
      incident,
      ambulanceId: ambulance.id,
    });

    io.emit("state:update", { ambulances, hospitals });
  });

  // Manual "block road" toggle — triggers REAL adaptive replanning
  // (Unit 4: Planning and Acting in Nondeterministic Domains)
  socket.on("demo:block-road", () => {
    if (!lastAssignment) {
      io.emit("log:event", "⚠ No active assignment to replan — trigger an incident first");
      return;
    }

    const { incident, hospital: blockedHospital, ambulance: previousAmbulance } = lastAssignment;
    io.emit("log:event", `⚠ Road to ${blockedHospital.name} marked blocked — replanning required`);

    // Update the fact base: this hospital's access is now blocked
    blockedHospital.roadBlocked = true;

    // Free the previously assigned ambulance back to available so the CSP can reconsider it
    if (ambulances[previousAmbulance.id]) {
      ambulances[previousAmbulance.id].status = "available";
    }

    const logFn = (msg) => io.emit("log:event", msg);
    const result = selectBestAmbulanceAndHospital(incident, logFn);

    if (!result) {
      io.emit("log:event", "Replanning failed — no valid (ambulance, hospital) pair after road block");
      return;
    }

    const { ambulance, hospital } = result;
    lastAssignment = { incident, ambulance, hospital };
    ambulances[ambulance.id].status = "en-route";
    hospital.beds = Math.max(0, hospital.beds - 1);

    io.emit("log:event", `✅ Replanned: Ambulance ${ambulance.id} → ${hospital.name} (new plan after road block)`);

    io.to(ambulance.socketId).emit("assignment:new", { incident, hospital });
    io.emit("hospital:incoming", { hospitalId: hospital.id, incident, ambulanceId: ambulance.id });
    io.emit("state:update", { ambulances, hospitals });
  });

  socket.on("disconnect", () => {
    const id = socket.data.ambulanceId;
    if (id && ambulances[id]) {
      delete ambulances[id];
      io.emit("state:update", { ambulances, hospitals });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running: http://localhost:${PORT}`);
  console.log(`On your phone (same WiFi), use your laptop's local IP, e.g. http://192.168.x.x:${PORT}`);
});
