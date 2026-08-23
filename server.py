# server.py
# Python Flask + Flask-SocketIO Backend for the Disaster Response Coordination app.
# Directly replaces server.js, keeping the exact same state management, KB logic,
# CSP matching, and event handlers.

import os
import math
from datetime import datetime
from flask import Flask, request
from flask_socketio import SocketIO, emit

app = Flask(__name__, static_folder='public', static_url_path='')
app.config['SECRET_KEY'] = 'secret_key_disaster_response'

# Allow CORS so external clients (e.g. mobile phones) can connect easily
socketio = SocketIO(app, cors_allowed_origins="*")

# Serve the main landing page
@app.route('/')
def index():
    return app.send_static_file('index.html')

# ---------------------------------------------------------------
# DUMMY DATA — replace/extend with real Coimbatore coordinates
# ---------------------------------------------------------------
hospitals = [
    { "id": "H1", "name": "City General Hospital", "lat": 11.0168, "lng": 76.9558, "beds": 3, "icuBeds": 1, "roadBlocked": False },
    { "id": "H2", "name": "Amrita Hospital", "lat": 11.0916, "lng": 76.9950, "beds": 5, "icuBeds": 2, "roadBlocked": False },
    { "id": "H3", "name": "St. Mary's Medical Center", "lat": 11.0040, "lng": 76.9612, "beds": 0, "icuBeds": 0, "roadBlocked": False },
]

# live state
ambulances = {}  # id -> { id, lat, lng, status, socketId }
incidents = []   # log of triggered incidents
last_incident = None
last_assignment = None  # { incident, ambulance, hospital }
socket_data = {}  # request.sid -> { role, ambulance_id, hospital_id }

# ---------------------------------------------------------------
# KNOWLEDGE BASE — explicit facts + forward-chaining rules
# Unit 3: KB Agents, Propositional Logic, Forward Chaining
# ---------------------------------------------------------------
KB_RULES = [
    {
        "name": "no-beds",
        "check": lambda hospital, incident: hospital.get("beds", 0) <= 0,
        "reason": lambda h: f"{h['name']} excluded — 0 general beds available"
    },
    {
        "name": "no-icu-for-critical",
        "check": lambda hospital, incident: int(incident.get("severity", 0)) >= 8 and hospital.get("icuBeds", 0) <= 0,
        "reason": lambda h: f"{h['name']} excluded — severity requires ICU, 0 ICU beds available"
    },
    {
        "name": "road-blocked",
        "check": lambda hospital, incident: hospital.get("roadBlocked") is True,
        "reason": lambda h: f"{h['name']} excluded — access road currently marked blocked"
    }
]

# Runs forward chaining: apply every rule to every hospital,
# return only hospitals with zero rule violations, plus a log
# of every exclusion reason fired (for the explainability panel).
def apply_kb_rules(hospital_list, incident):
    reasons = []
    eligible = []
    for h in hospital_list:
        excluded = False
        for rule in KB_RULES:
            if rule["check"](h, incident):
                reasons.append(rule["reason"](h))
                excluded = True
                break
        if not excluded:
            eligible.append(h)
    return eligible, reasons

# ---------------------------------------------------------------
# CSP — Constraint Satisfaction with Backtracking
# Unit 3: CSP, Inference in CSP, Backtracking Search
# ---------------------------------------------------------------
MAX_DISTANCE_DEG = 0.5  # ~50km in lat/lng degrees — generous cap for demo

def straight_line_dist(a, b):
    if a.get("lat") is None or a.get("lng") is None or b.get("lat") is None or b.get("lng") is None:
        return float('inf')
    return math.sqrt((float(a["lat"]) - float(b["lat"])) ** 2 + (float(a["lng"]) - float(b["lng"])) ** 2)

def solve_csp(available_ambulances, eligible_hospitals, incident):
    # Rank ambulances by proximity to incident (best domain values first)
    amb_candidates = sorted(available_ambulances, key=lambda a: straight_line_dist(a, incident))
    # Rank hospitals by proximity to incident
    hosp_candidates = sorted(eligible_hospitals, key=lambda h: straight_line_dist(h, incident))

    # Backtracking search over the (ambulance, hospital) assignment space
    for amb in amb_candidates:
        amb_dist = straight_line_dist(amb, incident)
        if amb_dist > MAX_DISTANCE_DEG:
            continue  # constraint violated, backtrack to next ambulance

        for hosp in hosp_candidates:
            # constraint satisfied for this (ambulance, hospital) pair — accept it
            return {
                "ambulance": amb,
                "hospital": hosp,
                "ambDist": amb_dist
            }
    return None  # no assignment satisfies all constraints — CSP has no solution

# ---------------------------------------------------------------
# MAIN DECISION PIPELINE
# ---------------------------------------------------------------
def select_best_ambulance_and_hospital(incident, log_fn):
    # Step 1: CSP domain restriction — only available ambulances qualify
    available_ambulances = [
        a for a in ambulances.values()
        if a.get("status") == "available" and a.get("lat") is not None
    ]
    if not available_ambulances:
        log_fn("No available ambulances — CSP has no solution")
        return None

    # Step 2: Forward-chaining KB rules filter hospitals
    eligible, reasons = apply_kb_rules(hospitals, incident)
    for r in reasons:
        log_fn(r)

    if not eligible:
        log_fn("No eligible hospitals after KB rule filtering — CSP has no solution")
        return None

    # Step 3: CSP backtracking search over the remaining candidates
    result = solve_csp(available_ambulances, eligible, incident)
    if not result:
        log_fn("No (ambulance, hospital) pair satisfies distance constraint — backtracking exhausted")
        return None

    log_fn(
        f"CSP solution found — Ambulance {result['ambulance']['id']} (dist {result['ambDist']:.3f}) → {result['hospital']['name']}"
    )
    return {
        "ambulance": result["ambulance"],
        "hospital": result["hospital"]
    }

# ---------------------------------------------------------------
# SOCKET.IO EVENTS
# ---------------------------------------------------------------
@socketio.on('connect')
def handle_connect():
    print(f"New connection: {request.sid}")

@socketio.on('ambulance:join')
def handle_ambulance_join(data):
    amb_id = data.get('id')
    if not amb_id:
        return
    ambulances[amb_id] = {
        "id": amb_id,
        "lat": None,
        "lng": None,
        "status": "available",
        "socketId": request.sid
    }
    socket_data[request.sid] = {
        "role": "ambulance",
        "ambulance_id": amb_id
    }
    emit("state:update", {"ambulances": ambulances, "hospitals": hospitals}, broadcast=True)
    print(f"Ambulance {amb_id} joined")

@socketio.on('ambulance:location')
def handle_ambulance_location(data):
    amb_id = data.get('id')
    lat = data.get('lat')
    lng = data.get('lng')
    if amb_id in ambulances:
        ambulances[amb_id]["lat"] = lat
        ambulances[amb_id]["lng"] = lng
        emit("state:update", {"ambulances": ambulances, "hospitals": hospitals}, broadcast=True)

@socketio.on('hospital:join')
def handle_hospital_join(data):
    hosp_id = data.get('id')
    socket_data[request.sid] = {
        "role": "hospital",
        "hospital_id": hosp_id
    }
    emit("state:update", {"ambulances": ambulances, "hospitals": hospitals}, broadcast=True)
    print(f"Hospital {hosp_id} joined")

@socketio.on('incident:report')
def handle_incident_report(data):
    global last_incident, last_assignment
    lat = data.get('lat')
    lng = data.get('lng')
    severity = int(data.get('severity', 5))
    note = data.get('note', '')

    incident = {
        "id": f"INC{len(incidents) + 1}",
        "lat": lat,
        "lng": lng,
        "severity": severity,
        "note": note,
        "time": datetime.now().strftime("%I:%M:%S %p")
    }
    incidents.append(incident)
    last_incident = incident

    emit("log:event", f"Incident {incident['id']} reported (severity {severity})", broadcast=True)

    def log_fn(msg):
        emit("log:event", msg, broadcast=True)

    result = select_best_ambulance_and_hospital(incident, log_fn)

    if not result:
        emit("log:event", f"No available ambulance/hospital for {incident['id']}", broadcast=True)
        return

    ambulance = result["ambulance"]
    hospital = result["hospital"]
    last_assignment = {
        "incident": incident,
        "ambulance": ambulance,
        "hospital": hospital
    }

    # mark ambulance busy, decrement hospital capacity
    ambulances[ambulance["id"]]["status"] = "en-route"
    for h in hospitals:
        if h["id"] == hospital["id"]:
            h["beds"] = max(0, h["beds"] - 1)
            break

    emit(
        "log:event",
        f"{incident['id']} → Ambulance {ambulance['id']} assigned → Routing to {hospital['name']} (ETA calc pending real A*)",
        broadcast=True
    )

    # notify the specific ambulance
    emit("assignment:new", {
        "incident": incident,
        "hospital": hospital
    }, to=ambulance["socketId"])

    # notify all hospital screens
    emit("hospital:incoming", {
        "hospitalId": hospital["id"],
        "incident": incident,
        "ambulanceId": ambulance["id"]
    }, broadcast=True)

    emit("state:update", {"ambulances": ambulances, "hospitals": hospitals}, broadcast=True)

@socketio.on('demo:block-road')
def handle_block_road():
    global last_assignment
    if not last_assignment:
        emit("log:event", "⚠ No active assignment to replan — trigger an incident first", broadcast=True)
        return

    incident = last_assignment["incident"]
    blocked_hospital = last_assignment["hospital"]
    previous_ambulance = last_assignment["ambulance"]

    emit("log:event", f"⚠ Road to {blocked_hospital['name']} marked blocked — replanning required", broadcast=True)

    # Update the fact base: this hospital's access is now blocked
    for h in hospitals:
        if h["id"] == blocked_hospital["id"]:
            h["roadBlocked"] = True
            break

    # Free the previously assigned ambulance back to available so the CSP can reconsider it
    if previous_ambulance["id"] in ambulances:
        ambulances[previous_ambulance["id"]]["status"] = "available"

    def log_fn(msg):
        emit("log:event", msg, broadcast=True)

    result = select_best_ambulance_and_hospital(incident, log_fn)

    if not result:
        emit("log:event", "Replanning failed — no valid (ambulance, hospital) pair after road block", broadcast=True)
        return

    ambulance = result["ambulance"]
    hospital = result["hospital"]
    last_assignment = {
        "incident": incident,
        "ambulance": ambulance,
        "hospital": hospital
    }

    ambulances[ambulance["id"]]["status"] = "en-route"
    for h in hospitals:
        if h["id"] == hospital["id"]:
            h["beds"] = max(0, h["beds"] - 1)
            break

    emit("log:event", f"✅ Replanned: Ambulance {ambulance['id']} → {hospital['name']} (new plan after road block)", broadcast=True)

    emit("assignment:new", {"incident": incident, "hospital": hospital}, to=ambulance["socketId"])
    emit("hospital:incoming", {"hospitalId": hospital["id"], "incident": incident, "ambulanceId": ambulance["id"]}, broadcast=True)
    emit("state:update", {"ambulances": ambulances, "hospitals": hospitals}, broadcast=True)

@socketio.on('disconnect')
def handle_disconnect():
    sid = request.sid
    if sid in socket_data:
        data = socket_data[sid]
        if data.get("role") == "ambulance":
            amb_id = data.get("ambulance_id")
            if amb_id in ambulances:
                del ambulances[amb_id]
                emit("state:update", {"ambulances": ambulances, "hospitals": hospitals}, broadcast=True)
                print(f"Ambulance {amb_id} disconnected")
        del socket_data[sid]
    print(f"Connection closed: {sid}")

if __name__ == '__main__':
    PORT = int(os.environ.get('PORT', 3000))
    print(f"Starting server on http://localhost:{PORT}")
    socketio.run(app, host='0.0.0.0', port=PORT, debug=False, allow_unsafe_werkzeug=True)
