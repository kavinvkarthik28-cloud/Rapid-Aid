"""
extract_graph.py
Pulls a real road network for Coimbatore using OpenStreetMap data (via OSMnx)
and exports it as a simple JSON graph: nodes (with lat/lng) and edges
(with real distances) that your Node.js backend / A* implementation can load.

Run:
    pip install osmnx networkx
    python extract_graph.py

Output:
    coimbatore_graph.json
"""

import osmnx as ox
import networkx as nx
import json

PLACE = "Coimbatore, Tamil Nadu, India"

print(f"Downloading road network for: {PLACE} ... (this can take a minute)")
G = ox.graph_from_place(PLACE, network_type="drive")

print(f"Graph downloaded: {len(G.nodes)} nodes, {len(G.edges)} edges")

nodes = {}
for node_id, data in G.nodes(data=True):
    nodes[str(node_id)] = {
        "lat": data["y"],
        "lng": data["x"],
    }

edges = []
for u, v, data in G.edges(data=True):
    # length is in meters, provided by OSMnx automatically
    edges.append({
        "from": str(u),
        "to": str(v),
        "distance_m": data.get("length", 0),
    })

output = {
    "place": PLACE,
    "node_count": len(nodes),
    "edge_count": len(edges),
    "nodes": nodes,
    "edges": edges,
}

with open("coimbatore_graph.json", "w") as f:
    json.dump(output, f)

print(f"Saved coimbatore_graph.json ({len(nodes)} nodes, {len(edges)} edges)")
print("Next step: load this JSON in server.js and build A* over it.")
