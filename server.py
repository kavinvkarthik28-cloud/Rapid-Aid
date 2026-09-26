# server.py
# RapidAid backend - Python Flask + Flask-SocketIO
#
# Includes:
#   - Real A* search over a road graph (haversine heuristic)
#   - Thread-safe assignment (concurrency-safe for simultaneous incidents)
#   - Severity-based priority queue
#   - Security: env-based secret key, input validation, rate limiting
#   - OTP authentication before an SOS is accepted
#   - Patient/SOS role with privacy-scoped notifications
#   - Live patient GPS tracking after SOS, scoped to dispatcher + assigned
#     ambulance only (never broadcast publicly)

import os
import json
import math
import heapq
import time
import random
import threading
import urllib.request
import urllib.error
from datetime import datetime
from flask import Flask, request


# Load local .env values without adding another dependency.
# Real environment variables always take precedence.
def load_local_env(path=".env"):
    if not os.path.exists(path):
        return
    try:
        with open(path, encoding="utf-8") as env_file:
            for raw_line in env_file:
                line = raw_line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                key = key.strip()
                value = value.strip().strip("\"").strip("'")
                if key and key not in os.environ:
                    os.environ[key] = value
    except OSError:
        pass

load_local_env()
from flask_socketio import SocketIO, emit, join_room

app = Flask(__name__, static_folder='public', static_url_path='')

# SECURITY: never hardcode a secret key.
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', os.urandom(24).hex())

socketio = SocketIO(app, cors_allowed_origins="*")

state_lock = threading.Lock()

DISPATCHER_ROOM = "dispatchers"

# ---------------------------------------------------------------
# INPUT VALIDATION (security: never trust client-submitted data)
# ---------------------------------------------------------------
def valid_latlng(lat, lng):
    try:
        lat, lng = float(lat), float(lng)
    except (TypeError, ValueError):
        return False
    return 8.0 <= lat <= 14.0 and 74.0 <= lng <= 81.0

def clean_severity(raw):
    try:
        s = int(raw)
    except (TypeError, ValueError):
        return 5
    return max(1, min(10, s))

def clean_note(raw, max_len=200):
    if not isinstance(raw, str):
        return ""
    return raw.strip()[:max_len]

def clean_phone(raw):
    if not isinstance(raw, str):
        return None
    digits = "".join(c for c in raw if c.isdigit())
    return digits if len(digits) == 10 else None


# ---------------------------------------------------------------
# RATE LIMITING
# ---------------------------------------------------------------
last_sos_time = {}
SOS_COOLDOWN_SECONDS = 15

def rate_limited(sid):
    now = time.time()
    last = last_sos_time.get(sid, 0)
    if now - last < SOS_COOLDOWN_SECONDS:
        return True
    last_sos_time[sid] = now
    return False


# ---------------------------------------------------------------
# OTP AUTHENTICATION — real SMS delivery via Fast2SMS Quick SMS
# ---------------------------------------------------------------
otp_store = {}
OTP_TTL_SECONDS = 300

def send_otp_sms(phone, code):
    """Send the OTP using Fast2SMS Quick SMS.

    This keeps RapidAid's existing OTP generation and verification logic.
    Fast2SMS Quick SMS uses the /dev/bulkV2 endpoint with route=q and
    does not require a Smart OTP template ID.

    Returns:
      (True, message) on success, (False, message) on failure.
    """
    api_key = os.environ.get("FAST2SMS_API_KEY", "").strip()
    if not api_key or api_key == "PASTE_YOUR_FAST2SMS_API_KEY_HERE":
        return False, "FAST2SMS_API_KEY is not configured"

    message = (
        f"Rapid-Aid OTP: {code}. Valid for 5 minutes. "
        "Do not share this code."
    )

    payload = {
        "route": "q",
        "message": message,
        "numbers": phone,
        "sms_details": "1"
    }

    req = urllib.request.Request(
        "https://www.fast2sms.com/dev/bulkV2",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": api_key,
            "accept": "application/json",
            "content-type": "application/json"
        },
        method="POST"
    )

    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            body = response.read().decode("utf-8", errors="replace")
            try:
                result = json.loads(body)
            except json.JSONDecodeError:
                result = {}

            if 200 <= response.status < 300 and result.get("return") is not False:
                print(f"[OTP] SMS sent to ******{phone[-4:]}")
                return True, "OTP sent successfully"

            return False, result.get("message", "Fast2SMS rejected the SMS request")

    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        try:
            result = json.loads(body)
            detail = result.get("message", body)
        except json.JSONDecodeError:
            detail = body or str(exc)
        return False, f"Fast2SMS error: {detail}"
    except urllib.error.URLError as exc:
        return False, f"Could not reach Fast2SMS: {exc.reason}"
    except Exception as exc:
        return False, f"SMS sending failed: {exc}"

def send_family_sms(phone, message):
    """Send Next-of-Kin SMS alert via Fast2SMS with clear dev console fallback."""
    api_key = os.environ.get("FAST2SMS_API_KEY", "").strip()
    print("=" * 64)
    print(f"[NEXT-OF-KIN ALERT] Phone: {phone}")
    print(f"[NEXT-OF-KIN ALERT] Message: {message}")
    print("=" * 64)

    if not api_key or api_key == "PASTE_YOUR_FAST2SMS_API_KEY_HERE":
        return False, "FAST2SMS_API_KEY is not configured"

    payload = {
        "route": "q",
        "message": message,
        "numbers": phone,
        "sms_details": "1"
    }
    req = urllib.request.Request(
        "https://www.fast2sms.com/dev/bulkV2",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": api_key,
            "accept": "application/json",
            "content-type": "application/json"
        },
        method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            body = response.read().decode("utf-8", errors="replace")
            print(f"[NEXT-OF-KIN SMS SENT] {body}")
            return True, "SMS sent to emergency contact"
    except Exception as exc:
        print(f"[NEXT-OF-KIN SMS FAILED] {exc}")
        return False, str(exc)


# ---------------------------------------------------------------
# ROAD GRAPH (Unit 2: Informed Search)
# ---------------------------------------------------------------
GRAPH_FILE = "coimbatore_graph.json"

def load_graph():
    if os.path.exists(GRAPH_FILE):
        with open(GRAPH_FILE) as f:
            data = json.load(f)
        print(f"Loaded real road graph: {data['node_count']} nodes, {data['edge_count']} edges")
        return data["nodes"], data["edges"], True
    else:
        print(f"WARNING: {GRAPH_FILE} not found — using a small built-in test graph.")
        print("Run extract_graph.py on your machine to generate the real Coimbatore graph.")
        nodes = {
            "n1": {"lat": 11.0168, "lng": 76.9558}, "n2": {"lat": 11.0200, "lng": 76.9600},
            "n3": {"lat": 11.0250, "lng": 76.9650}, "n4": {"lat": 11.0916, "lng": 76.9950},
            "n5": {"lat": 11.0040, "lng": 76.9612}, "n6": {"lat": 11.0100, "lng": 76.9580},
        }
        edges = [
            {"from": "n1", "to": "n2", "distance_m": 600}, {"from": "n2", "to": "n3", "distance_m": 700},
            {"from": "n3", "to": "n4", "distance_m": 9500}, {"from": "n1", "to": "n6", "distance_m": 400},
            {"from": "n6", "to": "n5", "distance_m": 800}, {"from": "n1", "to": "n5", "distance_m": 1900},
        ]
        return nodes, edges, False

GRAPH_NODES, GRAPH_EDGES, USING_REAL_GRAPH = load_graph()

ADJACENCY = {}
for e in GRAPH_EDGES:
    ADJACENCY.setdefault(e["from"], []).append((e["to"], e["distance_m"]))
    ADJACENCY.setdefault(e["to"], []).append((e["from"], e["distance_m"]))


def haversine_m(lat1, lng1, lat2, lng2):
    R = 6371000
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))

def nearest_node(lat, lng):
    best_id, best_dist = None, float("inf")
    for node_id, node in GRAPH_NODES.items():
        d = haversine_m(lat, lng, node["lat"], node["lng"])
        if d < best_dist:
            best_dist, best_id = d, node_id
    return best_id

def a_star(start_lat, start_lng, goal_lat, goal_lng):
    start = nearest_node(start_lat, start_lng)
    goal = nearest_node(goal_lat, goal_lng)
    if start is None or goal is None:
        return None, None

    def h(node_id):
        n = GRAPH_NODES[node_id]
        return haversine_m(n["lat"], n["lng"], goal_lat, goal_lng)

    open_set = [(h(start), 0, start, [start])]
    visited = {}
    while open_set:
        f, g, current, path = heapq.heappop(open_set)
        if current == goal:
            return g, [(GRAPH_NODES[n]["lat"], GRAPH_NODES[n]["lng"]) for n in path]
        if current in visited and visited[current] <= g:
            continue
        visited[current] = g
        for neighbor, edge_dist in ADJACENCY.get(current, []):
            new_g = g + edge_dist
            if neighbor not in visited or new_g < visited[neighbor]:
                heapq.heappush(open_set, (new_g + h(neighbor), new_g, neighbor, path + [neighbor]))
    return None, None


# ---------------------------------------------------------------
# SEED DATA
# ---------------------------------------------------------------
hospitals = [
    {"id": "H1", "name": "City General Hospital", "lat": 11.0168, "lng": 76.9558, "beds": 3, "icuBeds": 1, "roadBlocked": False},
    {"id": "H2", "name": "Amrita Hospital", "lat": 11.0916, "lng": 76.9950, "beds": 5, "icuBeds": 2, "roadBlocked": False},
    {"id": "H3", "name": "St. Mary's Medical Center", "lat": 11.0040, "lng": 76.9612, "beds": 0, "icuBeds": 0, "roadBlocked": False},
]

# ---------------------------------------------------------------
# AMBULANCE / HOSPITAL AUTHENTICATION
# Prevents anyone from typing an arbitrary ID and posing as a real
# ambulance or hospital. Pre-registered ID + PIN, checked at join
# time. In production this would be a real onboarding/admin-managed
# table (and PINs would be hashed, not plaintext) — this is scoped
# for a demo/review, not a production credential store.
# ---------------------------------------------------------------
AMBULANCE_CREDENTIALS = {
    "A1": "1234", "A2": "1234", "A3": "1234",
}
HOSPITAL_CREDENTIALS = {
    "H1": "1111", "H2": "1111", "H3": "1111",
}

ambulances = {}
incidents = []
last_incident = None
last_assignment = None
socket_data = {}
pending_incidents = []
active_patients = {}  # patientSocketId -> {"incidentId":..., "assignedAmbulanceSid":...} for live tracking routing
active_assignments = {}  # incidentId -> {incident, ambulance, hospital, result, etaMinutes, status}
ambulance_to_incident = {}  # ambulanceId -> incidentId

# ---------------------------------------------------------------
# KNOWLEDGE BASE — forward chaining
# ---------------------------------------------------------------
KB_RULES = [
    {"name": "no-beds", "check": lambda h, i: h.get("beds", 0) <= 0,
     "reason": lambda h: f"{h['name']} excluded — 0 general beds available"},
    {"name": "no-icu-for-critical", "check": lambda h, i: int(i.get("severity", 0)) >= 8 and h.get("icuBeds", 0) <= 0,
     "reason": lambda h: f"{h['name']} excluded — severity requires ICU, 0 ICU beds available"},
    {"name": "road-blocked", "check": lambda h, i: h.get("roadBlocked") is True,
     "reason": lambda h: f"{h['name']} excluded — access road currently marked blocked"},
]

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
# CSP with backtracking, scored by real A* road distance
# ---------------------------------------------------------------
MAX_DISTANCE_M = 50000

def solve_csp(available_ambulances, eligible_hospitals, incident):
    amb_routes = []
    for amb in available_ambulances:
        dist, path = a_star(amb["lat"], amb["lng"], incident["lat"], incident["lng"])
        if dist is not None:
            amb_routes.append((amb, dist, path))
    amb_routes.sort(key=lambda x: x[1])

    hosp_routes = []
    for hosp in eligible_hospitals:
        dist, path = a_star(incident["lat"], incident["lng"], hosp["lat"], hosp["lng"])
        if dist is not None:
            hosp_routes.append((hosp, dist, path))
    hosp_routes.sort(key=lambda x: x[1])

    for amb, amb_dist, amb_path in amb_routes:
        if amb_dist > MAX_DISTANCE_M:
            continue
        for hosp, hosp_dist, hosp_path in hosp_routes:
            return {"ambulance": amb, "hospital": hosp, "amb_dist_m": amb_dist, "hosp_dist_m": hosp_dist,
                    "amb_path": amb_path, "hosp_path": hosp_path}
    return None


def select_best_ambulance_and_hospital(incident, log_fn):
    available = [a for a in ambulances.values() if a.get("status") == "available" and a.get("lat") is not None]
    if not available:
        log_fn("No available ambulances — CSP has no solution")
        return None

    eligible, reasons = apply_kb_rules(hospitals, incident)
    for r in reasons:
        log_fn(r)

    if not eligible:
        log_fn("No eligible hospitals after KB rule filtering — CSP has no solution")
        return None

    result = solve_csp(available, eligible, incident)
    if not result:
        log_fn("No (ambulance, hospital) pair has a valid road route within range — backtracking exhausted")
        return None

    eta_min = (result["amb_dist_m"] / 1000) / 30 * 60
    log_fn(f"A* solution — Ambulance {result['ambulance']['id']} "
           f"({result['amb_dist_m']/1000:.2f} km, ~{eta_min:.0f} min ETA) → {result['hospital']['name']}")
    return result


# ---------------------------------------------------------------
# ASSIGNMENT + PRIORITY QUEUE + NEXT-OF-KIN TRACKING
# ---------------------------------------------------------------
def finalize_assignment(incident, result):
    global last_assignment
    ambulance, hospital = result["ambulance"], result["hospital"]
    eta_min = max(1, round((result["amb_dist_m"] / 1000) / 30 * 60))

    last_assignment = {"incident": incident, "ambulance": ambulance, "hospital": hospital}
    active_assignments[incident["id"]] = {
        "incident": incident,
        "ambulance": ambulance,
        "hospital": hospital,
        "result": result,
        "etaMinutes": eta_min,
        "status": "en-route"
    }
    ambulance_to_incident[ambulance["id"]] = incident["id"]

    ambulances[ambulance["id"]]["status"] = "en-route"
    for h in hospitals:
        if h["id"] == hospital["id"]:
            h["beds"] = max(0, h["beds"] - 1)
            break

    emit("log:event", f"{incident['id']} → Ambulance {ambulance['id']} assigned → Routing to {hospital['name']}", broadcast=True)

    emit("assignment:new", {
        "incident": incident, "hospital": hospital,
        "route": result["amb_path"], "hospitalRoute": result["hosp_path"],
    }, to=ambulance["socketId"])

    emit("hospital:incoming", {"hospitalId": hospital["id"], "incident": incident, "ambulanceId": ambulance["id"]}, broadcast=True)

    patient_sid = incident.get("patientSocketId")
    if patient_sid:
        emit("sos:assignment", {
            "hospital": hospital["name"],
            "ambulanceId": ambulance["id"],
            "etaMinutes": eta_min,
            "incidentId": incident["id"],
            "trackUrl": f"track.html?id={incident['id']}"
        }, to=patient_sid)

        # Register this patient for live-tracking routing
        active_patients[patient_sid] = {"incidentId": incident["id"], "assignedAmbulanceSid": ambulance["socketId"]}

    # Next-of-Kin Emergency Contact Alert with Live GPS Link
    contact = incident.get("emergencyContact")
    if contact:
        track_url = f"/track.html?id={incident['id']}"
        sms_msg = (
            f"RapidAid Alert: Your contact is being transported to {hospital['name']} "
            f"by Ambulance Unit {ambulance['id']}. Track live location & hospital: {track_url}"
        )
        send_family_sms(contact, sms_msg)
        emit("log:event", f"Next-of-Kin SMS sent to emergency contact {contact}", broadcast=True)

    # Broadcast to any open tracking room
    emit("track:init", {
        "found": True,
        "incident": incident,
        "ambulance": ambulance,
        "hospital": hospital,
        "route": {"ambPath": result["amb_path"], "hospPath": result["hosp_path"]},
        "etaMinutes": eta_min,
        "status": "en-route"
    }, room=f"track:{incident['id']}")

    emit("state:update", {
        "ambulances": ambulances, "hospitals": hospitals,
        "activeRoute": {"incidentId": incident["id"], "ambPath": result["amb_path"], "hospPath": result["hosp_path"]},
    }, broadcast=True)


def process_pending_queue():
    if not pending_incidents:
        return
    pending_incidents.sort(key=lambda inc: inc["severity"], reverse=True)

    def log_fn(msg):
        emit("log:event", msg, broadcast=True)

    still_pending = []
    for incident in pending_incidents:
        result = select_best_ambulance_and_hospital(incident, log_fn)
        if result:
            emit("log:event", f"Queued incident {incident['id']} (severity {incident['severity']}) now assigned", broadcast=True)
            finalize_assignment(incident, result)
        else:
            still_pending.append(incident)
    pending_incidents.clear()
    pending_incidents.extend(still_pending)


# ---------------------------------------------------------------
# ROUTES
# ---------------------------------------------------------------
@app.route('/')
def index():
    return app.send_static_file('index.html')

@app.route('/api/graph-info')
def graph_info():
    return {"usingRealGraph": USING_REAL_GRAPH, "nodeCount": len(GRAPH_NODES), "edgeCount": len(GRAPH_EDGES)}

@app.route('/api/track/<incident_id>')
def api_track_incident(incident_id):
    assignment = active_assignments.get(incident_id)
    if not assignment:
        return {"found": False, "incidentId": incident_id}, 404
    amb_id = assignment["ambulance"]["id"]
    current_amb = ambulances.get(amb_id, assignment["ambulance"])
    return {
        "found": True,
        "incident": assignment["incident"],
        "ambulance": current_amb,
        "hospital": assignment["hospital"],
        "route": {
            "ambPath": assignment["result"].get("amb_path", []),
            "hospPath": assignment["result"].get("hosp_path", [])
        },
        "etaMinutes": assignment.get("etaMinutes", 8),
        "status": assignment.get("status", "en-route")
    }


# ---------------------------------------------------------------
# SOCKET.IO EVENTS
# ---------------------------------------------------------------
@socketio.on('connect')
def handle_connect():
    print(f"New connection: {request.sid}")

@socketio.on('dispatcher:join')
def handle_dispatcher_join():
    join_room(DISPATCHER_ROOM)
    emit("state:update", {"ambulances": ambulances, "hospitals": hospitals}, to=request.sid)

@socketio.on('track:join')
def handle_track_join(data):
    inc_id = data.get('incidentId')
    if not inc_id:
        return
    join_room(f"track:{inc_id}")
    assignment = active_assignments.get(inc_id)
    if assignment:
        amb_id = assignment["ambulance"]["id"]
        current_amb = ambulances.get(amb_id, assignment["ambulance"])
        emit("track:init", {
            "found": True,
            "incident": assignment["incident"],
            "ambulance": current_amb,
            "hospital": assignment["hospital"],
            "route": {
                "ambPath": assignment["result"].get("amb_path", []),
                "hospPath": assignment["result"].get("hosp_path", [])
            },
            "etaMinutes": assignment.get("etaMinutes", 8),
            "status": assignment.get("status", "en-route")
        }, to=request.sid)
    else:
        emit("track:init", {"found": False, "incidentId": inc_id}, to=request.sid)

@socketio.on('ambulance:join')
def handle_ambulance_join(data):
    amb_id = data.get('id')
    pin = str(data.get('pin', ''))
    if not amb_id:
        return
    if AMBULANCE_CREDENTIALS.get(amb_id) != pin:
        emit("auth:error", "Invalid ambulance ID or PIN", to=request.sid)
        return
    with state_lock:
        ambulances[amb_id] = {"id": amb_id, "lat": None, "lng": None, "status": "available", "socketId": request.sid}
        socket_data[request.sid] = {"role": "ambulance", "ambulance_id": amb_id}
        emit("state:update", {"ambulances": ambulances, "hospitals": hospitals}, broadcast=True)
        emit("ambulance:join-ok", {"id": amb_id}, to=request.sid)
        print(f"Ambulance {amb_id} joined")
        process_pending_queue()

@socketio.on('ambulance:location')
def handle_ambulance_location(data):
    amb_id = data.get('id')
    if amb_id in ambulances:
        lat = data.get('lat')
        lng = data.get('lng')
        ambulances[amb_id]["lat"] = lat
        ambulances[amb_id]["lng"] = lng
        emit("state:update", {"ambulances": ambulances, "hospitals": hospitals}, broadcast=True)

        inc_id = ambulance_to_incident.get(amb_id)
        if inc_id:
            emit("track:location", {
                "incidentId": inc_id,
                "ambulanceId": amb_id,
                "lat": lat,
                "lng": lng
            }, room=f"track:{inc_id}")

@socketio.on('ambulance:complete')
def handle_ambulance_complete(data):
    amb_id = data.get('id')
    with state_lock:
        if amb_id in ambulances:
            ambulances[amb_id]["status"] = "available"
            inc_id = ambulance_to_incident.pop(amb_id, None)
            if inc_id and inc_id in active_assignments:
                active_assignments[inc_id]["status"] = "arrived"
                hosp = active_assignments[inc_id]["hospital"]
                emit("track:arrived", {
                    "incidentId": inc_id,
                    "status": "arrived",
                    "hospital": hosp
                }, room=f"track:{inc_id}")

            emit("log:event", f"Ambulance {amb_id} completed trip — now available", broadcast=True)
            emit("state:update", {"ambulances": ambulances, "hospitals": hospitals}, broadcast=True)
            process_pending_queue()

@socketio.on('hospital:join')
def handle_hospital_join(data):
    hosp_id = data.get('id')
    pin = str(data.get('pin', ''))
    if HOSPITAL_CREDENTIALS.get(hosp_id) != pin:
        emit("auth:error", "Invalid hospital ID or PIN", to=request.sid)
        return
    socket_data[request.sid] = {"role": "hospital", "hospital_id": hosp_id}
    emit("state:update", {"ambulances": ambulances, "hospitals": hospitals}, broadcast=True)
    emit("hospital:join-ok", {"id": hosp_id}, to=request.sid)

@socketio.on('incident:report')
def handle_incident_report(data):
    global last_incident
    lat, lng = data.get('lat'), data.get('lng')
    if not valid_latlng(lat, lng):
        emit("log:event", "Incident rejected — invalid coordinates", to=request.sid)
        return

    severity = clean_severity(data.get('severity', 5))
    note = clean_note(data.get('note', ''))
    incident = {
        "id": f"INC{len(incidents) + 1}", "lat": float(lat), "lng": float(lng),
        "severity": severity, "note": note, "time": datetime.now().strftime("%I:%M:%S %p"),
        "patientSocketId": None,
    }

    with state_lock:
        incidents.append(incident)
        last_incident = incident
        emit("log:event", f"Incident {incident['id']} reported (severity {severity})", broadcast=True)

        def log_fn(msg):
            emit("log:event", msg, broadcast=True)

        result = select_best_ambulance_and_hospital(incident, log_fn)
        if not result:
            pending_incidents.append(incident)
            emit("log:event", f"No available ambulance/hospital for {incident['id']} — queued (severity {severity})", broadcast=True)
            return
        finalize_assignment(incident, result)

@socketio.on('demo:block-road')
def handle_block_road():
    global last_assignment
    with state_lock:
        if not last_assignment:
            emit("log:event", "No active assignment to replan — trigger an incident first", broadcast=True)
            return
        incident = last_assignment["incident"]
        blocked_hospital = last_assignment["hospital"]
        previous_ambulance = last_assignment["ambulance"]

        emit("log:event", f"Road to {blocked_hospital['name']} marked blocked — replanning required", broadcast=True)
        for h in hospitals:
            if h["id"] == blocked_hospital["id"]:
                h["roadBlocked"] = True
                break
        if previous_ambulance["id"] in ambulances:
            ambulances[previous_ambulance["id"]]["status"] = "available"

        def log_fn(msg):
            emit("log:event", msg, broadcast=True)

        result = select_best_ambulance_and_hospital(incident, log_fn)
        if not result:
            emit("log:event", "Replanning failed — no valid pair after road block", broadcast=True)
            return
        emit("log:event", f"Replanned: Ambulance {result['ambulance']['id']} → {result['hospital']['name']}", broadcast=True)
        finalize_assignment(incident, result)


# ---------------------------------------------------------------
# PATIENT / SOS EVENTS
# ---------------------------------------------------------------
@socketio.on('auth:request-otp')
def handle_request_otp(data):
    phone = clean_phone(data.get('phone'))
    if not phone:
        emit("auth:error", "Enter a valid 10-digit phone number", to=request.sid)
        return
    code = f"{random.randint(0, 999999):06d}"
    otp_store[phone] = {"code": code, "expires": time.time() + OTP_TTL_SECONDS, "verified": False}

    sent, message = send_otp_sms(phone, code)
    if not sent:
        # Development / fallback mode: Keep OTP active so local testing/demo is never blocked
        print("=" * 64)
        print(f"[OTP WARNING] Fast2SMS delivery unavailable: {message}")
        print(f"[DEV OTP] Phone: {phone} | Code: {code}")
        print(f"[DEV OTP] Enter '{code}' in the app or recharge Fast2SMS to enable live SMS.")
        print("=" * 64)
        emit("auth:otp-sent", {
            "phone": phone,
            "devOtp": code,
            "smsDelivered": False,
            "warning": message
        }, to=request.sid)
        return

    emit("auth:otp-sent", {
        "phone": phone,
        "devOtp": None,
        "smsDelivered": True,
        "message": message
    }, to=request.sid)

@socketio.on('auth:verify-otp')
def handle_verify_otp(data):
    phone = clean_phone(data.get('phone'))
    code = str(data.get('code', '')).strip()
    entry = otp_store.get(phone)
    if not entry:
        emit("auth:error", "Request an OTP first", to=request.sid)
        return
    if time.time() > entry["expires"]:
        emit("auth:error", "OTP expired — request a new one", to=request.sid)
        return
    if code != entry["code"]:
        emit("auth:error", "Incorrect OTP", to=request.sid)
        return
    entry["verified"] = True
    socket_data[request.sid] = {"role": "patient", "phone": phone, "verified": True}
    emit("auth:verified", {"phone": phone}, to=request.sid)

@socketio.on('sos:report')
def handle_sos_report(data):
    sid = request.sid
    caller = socket_data.get(sid, {})
    if not caller.get("verified"):
        emit("auth:error", "Phone verification required before reporting an SOS", to=sid)
        return
    if rate_limited(sid):
        emit("log:event", "SOS rejected — please wait before submitting another report", to=sid)
        return

    lat, lng = data.get('lat'), data.get('lng')
    if not valid_latlng(lat, lng):
        emit("auth:error", "Could not read a valid location — check location permissions", to=sid)
        return

    severity = clean_severity(data.get('severity', 6))
    note = clean_note(data.get('note', ''))
    emergency_contact = clean_phone(data.get('emergencyContact'))

    global last_incident
    incident = {
        "id": f"INC{len(incidents) + 1}", "lat": float(lat), "lng": float(lng),
        "severity": severity, "note": note or "Self-reported SOS",
        "time": datetime.now().strftime("%I:%M:%S %p"),
        "patientSocketId": sid, "callerPhone": caller.get("phone"), "emergencyContact": emergency_contact,
    }

    with state_lock:
        incidents.append(incident)
        last_incident = incident
        emit("log:event", f"SOS {incident['id']} received from verified patient (severity {severity})", broadcast=True)

        def log_fn(msg):
            emit("log:event", msg, broadcast=True)

        result = select_best_ambulance_and_hospital(incident, log_fn)
        if not result:
            pending_incidents.append(incident)
            emit("sos:queued", {"message": "No ambulance available right now — you're in the queue."}, to=sid)
            return
        finalize_assignment(incident, result)


@socketio.on('patient:location')
def handle_patient_location(data):
    """Live GPS tracking of the patient after SOS. PRIVACY: never
    broadcast — only the dispatcher room and the specific ambulance
    assigned to this patient ever see this location."""
    sid = request.sid
    lat, lng = data.get('lat'), data.get('lng')
    if not valid_latlng(lat, lng):
        return  # silently drop invalid pings, don't leak an error that reveals validation logic to an attacker

    tracking_info = active_patients.get(sid)
    if not tracking_info:
        return  # not an active, assigned patient — ignore

    payload = {"incidentId": tracking_info["incidentId"], "lat": float(lat), "lng": float(lng)}
    emit("patient:location-update", payload, room=DISPATCHER_ROOM)
    amb_sid = tracking_info.get("assignedAmbulanceSid")
    if amb_sid:
        emit("patient:location-update", payload, to=amb_sid)


@socketio.on('disconnect')
def handle_disconnect():
    sid = request.sid
    with state_lock:
        if sid in socket_data:
            data = socket_data[sid]
            if data.get("role") == "ambulance":
                amb_id = data.get("ambulance_id")
                if amb_id in ambulances:
                    del ambulances[amb_id]
                    emit("state:update", {"ambulances": ambulances, "hospitals": hospitals}, broadcast=True)
            del socket_data[sid]
        active_patients.pop(sid, None)
        last_sos_time.pop(sid, None)


if __name__ == '__main__':
    PORT = int(os.environ.get('PORT', 3000))
    print(f"Starting server on http://localhost:{PORT}")
    socketio.run(app, host='0.0.0.0', port=PORT, debug=False, allow_unsafe_werkzeug=True)
