// Quay: live vessel positions and port congestion from real-time AIS, for Telegraph.
// One process: listens to the aisstream.io WebSocket, keeps the latest state of every ship it hears,
// and answers VESSEL_TELEMETRY_VERIFY and LIVE_PORT_CONGESTION over HTTP.
"use strict";
const fs = require("fs");
const http = require("http");
const path = require("path");
const WebSocket = require("ws");
const PORTS = require("./ports");

const HOME = process.env.HOME;
const KEY = fs.readFileSync(path.join(HOME, ".aisstream_key"), "utf8").trim();
const LISTEN_PORT = Number(process.env.PORT || 8080);
const SNAPSHOT = path.join(__dirname, "state.json");
const STALE_HOURS = 6;          // older than this: still answered, but marked stale
const LIVE_HOURS = 1;           // heard within the hour: live; 1-6 h: recent (a moving ship may have moved on)
const FORGET_HOURS = 336;       // 14 days: older than this is dropped from memory (last-known positions are still useful, labelled stale)
const STARTED = Date.now();

// ---------- state ----------
const ships = new Map();        // mmsi -> record
const byName = new Map();       // normalized name -> Set(mmsi)
const byImo = new Map();        // imo -> mmsi
let stats = { messages: 0, connects: 0, lastMessageAt: 0, lastError: null };

const norm = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();

function indexName(mmsi, name) {
  const n = norm(name);
  if (!n) return;
  if (!byName.has(n)) byName.set(n, new Set());
  byName.get(n).add(mmsi);
}

function load() {
  try {
    const data = JSON.parse(fs.readFileSync(SNAPSHOT, "utf8"));
    const cutoff = Date.now() - FORGET_HOURS * 3600e3;
    for (const r of data.ships || []) {
      if ((r.seenAt || 0) < cutoff) continue;
      ships.set(r.mmsi, r);
      indexName(r.mmsi, r.name);
      if (r.imo) byImo.set(String(r.imo), r.mmsi);
    }
    console.log(`loaded ${ships.size} ships from snapshot`);
  } catch { console.log("no snapshot yet"); }
}

function save() {
  const cutoff = Date.now() - FORGET_HOURS * 3600e3;
  for (const [k, r] of ships) if ((r.seenAt || 0) < cutoff) ships.delete(k);
  const tmp = SNAPSHOT + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ savedAt: new Date().toISOString(), ships: [...ships.values()] }));
  fs.renameSync(tmp, SNAPSHOT);
}

// AIS time "2026-11-23 13:43:48.306558121 +0000 UTC" -> ms
function aisTime(s) {
  if (!s) return Date.now();
  const m = String(s).match(/^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)(\.\d+)?/);
  return m ? Date.parse(`${m[1]}T${m[2]}${m[3] ? m[3].slice(0, 4) : ""}Z`) : Date.now();
}

function onMessage(msg) {
  const md = msg.MetaData || {};
  const mmsi = String(md.MMSI || "");
  if (!/^\d{9}$/.test(mmsi)) return;
  stats.messages++; stats.lastMessageAt = Date.now();
  let r = ships.get(mmsi);
  if (!r) { r = { mmsi }; ships.set(mmsi, r); }
  const name = String(md.ShipName || "").trim();
  if (name && name !== r.name) { r.name = name; indexName(mmsi, name); }
  const t = aisTime(md.time_utc);
  const m = msg.Message || {};

  const pos = m.PositionReport || m.StandardClassBPositionReport || m.ExtendedClassBPositionReport;
  if (pos && pos.Valid !== false) {
    const lat = pos.Latitude ?? md.latitude, lon = pos.Longitude ?? md.longitude;
    if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0) && t >= (r.posAt || 0)) {
      const sog = pos.Sog >= 102.3 ? null : pos.Sog;          // 102.3 = not available
      const cog = pos.Cog >= 360 ? null : pos.Cog;            // 360 = not available
      const nav = m.PositionReport ? pos.NavigationalStatus : null;
      const stopped = sog != null && sog < 0.5;
      if (stopped && !r.stoppedSince) r.stoppedSince = t;
      if (!stopped) r.stoppedSince = null;
      Object.assign(r, { lat, lon, sog, cog, heading: pos.TrueHeading === 511 ? null : pos.TrueHeading, nav, posAt: t });
    }
  }
  const st = m.ShipStaticData;
  if (st) {
    if (st.ImoNumber) { r.imo = String(st.ImoNumber); byImo.set(r.imo, mmsi); }
    if (st.CallSign) r.callsign = st.CallSign.trim();
    if (st.Destination) r.destination = st.Destination.trim();
    if (st.Type) r.shipType = st.Type;
    if (st.Eta && st.Eta.Month) r.eta = st.Eta;
    if (st.Dimension) r.length = (st.Dimension.A || 0) + (st.Dimension.B || 0);
    r.staticAt = t;
  }
  r.seenAt = Math.max(r.seenAt || 0, t);
}

// ---------- stream ----------
let ws, backoff = 1000;
function connect() {
  stats.connects++;
  ws = new WebSocket("wss://stream.aisstream.io/v0/stream", { perMessageDeflate: true });
  ws.on("open", () => {
    ws.send(JSON.stringify({
      APIKey: KEY,
      BoundingBoxes: [[[-90, -180], [90, 180]]],
      FilterMessageTypes: ["PositionReport", "StandardClassBPositionReport", "ExtendedClassBPositionReport", "ShipStaticData"],
    }));
  });
  ws.on("message", (d) => {
    try {
      const msg = JSON.parse(d.toString());
      if (msg.MessageType === "SubscriptionConfirmation") { backoff = 1000; console.log("subscribed", JSON.stringify(msg.Message)); return; }
      if (msg.error) { stats.lastError = msg.error; console.log("stream error", msg.error); return; }
      onMessage(msg);
    } catch (e) { stats.lastError = e.message; }
  });
  const retry = (why) => {
    stats.lastError = why; console.log("stream closed:", why, "retry in", backoff, "ms");
    setTimeout(connect, backoff + Math.random() * 1000); backoff = Math.min(backoff * 2, 60000);
  };
  ws.on("close", (c, reason) => retry(`close ${c} ${reason}`));
  ws.on("error", (e) => { stats.lastError = e.message; });
}
// Watchdog: if nothing arrives for 2 minutes, force a reconnect.
setInterval(() => { if (stats.lastMessageAt && Date.now() - stats.lastMessageAt > 120e3 && ws) { console.log("watchdog: no messages, reconnecting"); ws.terminate(); } }, 30e3);

// ---------- answers ----------
const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
const hoursAgo = (ms) => (Date.now() - ms) / 3600e3;

function resolveVessel(q) {
  const raw = String(q || "").trim();
  const digits = raw.replace(/\D/g, "");
  if (/^\d{9}$/.test(digits) && ships.has(digits)) return { mmsi: digits, by: "mmsi" };
  const imo = (raw.match(/IMO\s*:?\s*(\d{7})/i) || [])[1] || (/^\d{7}$/.test(digits) ? digits : null);
  if (imo && byImo.has(imo)) return { mmsi: byImo.get(imo), by: "imo" };
  const n = norm(raw.replace(/^(MV|M\/V|MS|M\/S|SS)\s+/i, ""));
  if (byName.has(n)) {
    const c = [...byName.get(n)].filter((m) => ships.has(m)).sort((a, b) => (ships.get(b).posAt || 0) - (ships.get(a).posAt || 0));
    if (c.length) return { mmsi: c[0], by: "name", alsoNamed: c.length - 1 };
  }
  return null;
}

function vesselAnswer(q) {
  const hit = resolveVessel(q);
  // Not heard: a complete, honest answer (all position fields null, status "not_seen"), not an error.
  if (!hit) return [200, { vessel: q, speed_knots: null, latitude: null, longitude: null, course_deg: null, observed_at: null, status: "not_seen",
    summary: `No AIS report heard for "${q}" in the last ${FORGET_HOURS / 24} days. Coverage is terrestrial: ships far offshore can go unheard. Quay does not guess a position.` }];
  const r = ships.get(hit.mmsi);
  if (r.posAt == null) return [200, { vessel: q, speed_knots: null, latitude: null, longitude: null, course_deg: null, observed_at: null, status: "not_seen", mmsi: r.mmsi, imo: r.imo || null, name: r.name || null, summary: "Ship identified from its static report, but no position heard yet." }];
  const age = hoursAgo(r.posAt);
  return [200, {
    vessel: q,
    speed_knots: r.sog,
    latitude: r.lat,
    longitude: r.lon,
    course_deg: r.cog,
    observed_at: iso(r.posAt),
    status: age > STALE_HOURS ? "stale" : age > LIVE_HOURS ? "recent" : "live",
    age_minutes: Math.round(age * 60),
    last_heard: age > STALE_HOURS ? `${age >= 48 ? Math.round(age / 24) + " days" : Math.round(age) + " h"} ago` : null,
    mmsi: r.mmsi, imo: r.imo || null, name: r.name || null, callsign: r.callsign || null,
    heading_deg: r.heading ?? null,
    nav_status: navText(r.nav),
    destination: r.destination || null,
    eta: r.eta ? `${String(r.eta.Month).padStart(2, "0")}-${String(r.eta.Day).padStart(2, "0")} ${String(r.eta.Hour).padStart(2, "0")}:${String(r.eta.Minute).padStart(2, "0")} UTC (as reported by the ship)` : null,
    matched_by: hit.by,
    other_ships_with_same_name: hit.alsoNamed || 0,
    source: "Live AIS broadcast via aisstream.io terrestrial receivers",
  }];
}

const NAV = ["under way using engine", "at anchor", "not under command", "restricted manoeuvrability", "constrained by draught", "moored", "aground", "engaged in fishing", "under way sailing"];
const navText = (n) => (n == null ? null : NAV[n] || "not defined");

function km(a, b, c, d) {
  const R = 6371, t = Math.PI / 180, x = (c - a) * t, y = (d - b) * t;
  const h = Math.sin(x / 2) ** 2 + Math.cos(a * t) * Math.cos(c * t) * Math.sin(y / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function findPort(q) {
  const n = norm(q);
  return PORTS.find((p) => norm(p.code) === n || p.names.some((x) => norm(x) === n))
      || PORTS.find((p) => p.names.some((x) => n.includes(norm(x)) || norm(x).includes(n)));
}

function portAnswer(q) {
  const p = findPort(q);
  if (!p) return [404, { error: "port_not_covered", port: q, summary: "Port not in the covered list.", covered: PORTS.map((x) => `${x.names[0]} (${x.code})`) }];
  const recent = Date.now() - 2 * 3600e3;
  let inArea = 0, moored = 0; const waiting = [];
  for (const r of ships.values()) {
    if (r.lat == null || (r.posAt || 0) < recent) continue;
    if (km(p.lat, p.lon, r.lat, r.lon) > p.radiusKm) continue;
    // Only seagoing cargo ships and tankers (AIS ship types 70-89) count: barges, tugs, pilots,
    // ferries and service craft sit still in every port and are not "waiting".
    if (!(r.shipType >= 70 && r.shipType <= 89)) continue;
    if (r.length && r.length < 80) continue;
    inArea++;
    if (r.nav === 5) { moored++; continue; }
    // Waiting = the ship itself reports "at anchor". A stopped ship with no status is not counted:
    // it is more often alongside a berth than queuing.
    if (r.nav === 1) waiting.push(r);
  }
  const observedHours = hoursAgo(STARTED);
  if (inArea < 3) return [404, { error: "insufficient_coverage", port: p.names[0], unlocode: p.code, cargo_vessels_in_area: inArea, summary: "Too few cargo ships or tankers heard near this port in the last 2 hours to give an honest reading." }];
  const waits = waiting.map((r) => hoursAgo(r.stoppedSince || r.posAt)).filter((h) => h >= 0);
  const avg = waits.length ? waits.reduce((a, b) => a + b, 0) / waits.length : 0;
  const ratio = waiting.length / Math.max(1, p.typicalAnchored);
  const level = ratio < 0.75 ? "low" : ratio < 1.25 ? "moderate" : ratio < 2 ? "high" : "severe";
  return [200, {
    port: p.names[0], unlocode: p.code,
    vessels_waiting: waiting.length,
    wait_hours: Math.round(avg * 10) / 10,
    congestion_level: level,
    as_of: new Date().toISOString(),
    cargo_vessels_in_area: inArea, cargo_vessels_moored: moored,
    method: `Seagoing cargo ships and tankers (AIS types 70-89, 80 m+ when size is known) heard within ${p.radiusKm} km in the last 2 h; waiting = reporting 'at anchor'. Level compares waiting ships with a typical count of ${p.typicalAnchored}.`,
    caveat: observedHours < 24 ? `Wait times are capped by this miner's ${observedHours.toFixed(1)} h of continuous observation.` : null,
  }];
}

// Ships inbound to a port right now: cargo ships and tankers heard in the last 30 min, outside the
// port area but within 4x its radius, moving at 3+ kn with a course pointing at the port.
// Not a Telegraph intent: a helper for apps (Northstar uses it to pick live demo voyages).
function bearing(a, b, c, d) {
  const p = Math.PI / 180, y = Math.sin((d - b) * p) * Math.cos(c * p);
  const x = Math.cos(a * p) * Math.sin(c * p) - Math.sin(a * p) * Math.cos(c * p) * Math.cos((d - b) * p);
  return (Math.atan2(y, x) / p + 360) % 360;
}
function approachingAnswer(q, limit = 10) {
  const p = findPort(q);
  if (!p) return [404, { error: "port_not_covered", port: q }];
  const fresh = Date.now() - 30 * 60e3, out = [];
  for (const r of ships.values()) {
    if (r.lat == null || (r.posAt || 0) < fresh || !(r.shipType >= 70 && r.shipType <= 89) || (r.sog ?? 0) < 3 || r.cog == null) continue;
    const d = km(r.lat, r.lon, p.lat, p.lon);
    if (d <= p.radiusKm || d > p.radiusKm * 4) continue;
    const diff = Math.abs(((bearing(r.lat, r.lon, p.lat, p.lon) - r.cog) + 540) % 360 - 180);
    if (diff > 35) continue;
    const toEdge = d - p.radiusKm;
    out.push({ name: r.name || null, mmsi: r.mmsi, imo: r.imo || null, distance_km: Math.round(d), speed_knots: r.sog, destination: r.destination || null,
      hours_to_port_area: Math.round((toEdge / (r.sog * 1.852)) * 10) / 10, heard_minutes_ago: Math.round((Date.now() - r.posAt) / 60000) });
  }
  out.sort((a, b) => a.hours_to_port_area - b.hours_to_port_area);
  return [200, { port: p.names[0], unlocode: p.code, inbound: out.filter((x) => x.name).slice(0, limit), as_of: new Date().toISOString() }];
}

// ---------- http ----------
function send(res, code, body, type = "application/json") {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}
http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  try {
    if (u.pathname === "/health") {
      return send(res, 200, { ok: Date.now() - stats.lastMessageAt < 120e3, ships_tracked: ships.size, messages: stats.messages,
        last_message_at: iso(stats.lastMessageAt), uptime_hours: +hoursAgo(STARTED).toFixed(2), reconnects: stats.connects - 1, last_error: stats.lastError });
    }
    if (u.pathname === "/vessel") {
      const q = u.searchParams.get("vessel");
      if (!q) return send(res, 400, { error: "invalid_request", summary: "vessel is required (name, 9-digit MMSI or IMO)" });
      const [c, b] = vesselAnswer(q); return send(res, c, b);
    }
    if (u.pathname === "/port") {
      const q = u.searchParams.get("port");
      if (!q) return send(res, 400, { error: "invalid_request", summary: "port is required (name or UN/LOCODE)" });
      const [c, b] = portAnswer(q); return send(res, c, b);
    }
    if (u.pathname === "/approaching") { const [c, b] = approachingAnswer(u.searchParams.get("port"), Number(u.searchParams.get("limit") || 10)); return send(res, c, b); }
    if (u.pathname === "/ports") return send(res, 200, PORTS.map((p) => ({ port: p.names[0], unlocode: p.code })));
    if (u.pathname === "/miner.yaml") return send(res, 200, fs.readFileSync(path.join(__dirname, "miner.yaml"), "utf8"), "text/yaml");
    send(res, 404, { error: "not_found" });
  } catch (e) { send(res, 500, { error: "internal", summary: e.message }); }
}).listen(LISTEN_PORT, "127.0.0.1", () => console.log("listening on", LISTEN_PORT));

load();
connect();
setInterval(() => { try { save(); } catch (e) { console.log("save failed", e.message); } }, 60e3);
process.on("SIGTERM", () => { try { save(); } catch {} process.exit(0); });
process.on("SIGINT", () => { try { save(); } catch {} process.exit(0); });
