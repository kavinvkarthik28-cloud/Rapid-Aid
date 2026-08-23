# Disaster Response Coordination — Starter App

Team 11 — Fundamentals of AI

## What this is
A working skeleton: Dispatcher dashboard (live map), Ambulance view (streams real GPS),
and Hospital view (gets notified on assignment) — all connected in real time via Socket.io.
The AI decision logic currently uses a simple placeholder (nearest-available matching) —
this is deliberate, so the plumbing is provable *before* the real CSP/A*/KB logic goes in.

## How to run it (on your laptop)
```
pip install -r requirements.txt
python server.py
```
Server starts at http://localhost:3000

## How to test with phones (same WiFi)
1. Find your laptop's local IP (Windows: `ipconfig`, Mac: `ifconfig`) — looks like 192.168.x.x
2. On each phone browser, go to: http://<your-ip>:3000
3. Pick "I'm an Ambulance" on 2-3 phones, "I'm a Hospital" on one, and open
   "Dispatcher View" on your laptop/projector.
4. On the dispatcher map, click a location, then click "Report Incident."
   Watch the assignment push live to the ambulance + hospital screens.

If phones can't reach your laptop, your WiFi may have client isolation enabled —
see the Risks section in the project blueprint doc for the fallback (hotspot or ngrok).

## Where the real AI goes
Open `server.py` and find `selectBestAmbulanceAndHospital()`. Replace the naive
distance sort with:
- Real CSP filtering (capacity, compatibility constraints)
- A* over the real Coimbatore road graph (OSMnx-extracted) instead of straight-line distance
- KB forward-chaining rules for eligibility (currently just checks beds > 0)
- Hook the "Simulate Road Block" button to trigger actual replanning

## File map
- `server.py` — backend, all AI/decision logic lives here
- `public/index.html` — landing/role select
- `public/dispatcher.html` + `js/dispatcher.js` — map, incident trigger, reasoning log
- `public/ambulance.html` + `js/ambulance.js` — GPS streaming, assignment alert
- `public/hospital.html` + `js/hospital.js` — incoming patient notification
