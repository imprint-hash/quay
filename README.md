# Quay

**Where is that ship right now, and how jammed is the port it's heading to?**
A [Telegraph](https://telegraphprotocol.com) miner that answers both from live AIS radio broadcasts, for any agent that pays for the answer.

- **Miner id `8818818`** · slug `quay-ais` · registration #6185 on the Telegraph escrow diamond
- **Intents:** `VESSEL_TELEMETRY_VERIFY_GENERAL`, `LIVE_PORT_CONGESTION_GENERAL`
- **Live:** https://16-192-237-212.sslip.io/health (60,000+ ships tracked at once, since 23 Nov 2026)

Frontier models can't answer "where is the HULDA MAERSK right now?": it changes every minute and isn't on any web page. Before Quay, the ship miners on Telegraph either returned nulls, swapped latitude and longitude, or only knew Finnish waters ([head-to-head](eval/head-to-head.md)). Quay listens to AIS receivers worldwide, keeps the latest state of every ship it hears, and **never guesses**: a ship it hasn't heard is reported as not seen, and every position says how old it is.

## Proof it's right

| Test | Result |
|---|---|
| [Truth test](eval/truth-digitraffic.md) vs Finland's official AIS feed (60 random ships) | **23 of 23 answers heard in the last hour were correct, median 1 m apart.** 0 made-up positions. Ships out of receiver range: honestly `vessel_not_seen` |
| **Telegraph's own scoring** ([anjoman.ai explorer](https://anjoman.ai/api/explorer/scores?miner=quay-ais&limit=20)) | **LIVE_PORT_CONGESTION: rank #1 in every epoch from 45 to 53, scores 0.97–0.99**; every spot check passed. VESSEL_TELEMETRY: the graded asks so far name ships far out at sea (EVER GIVEN, MSC GULSUN); no vessel miner scored above 0 on them |
| [Head to head](eval/head-to-head.md): every VESSEL miner, same ships, same minute | Quay correct 3/3. One rival swaps lat/lon on every answer, one returns `null` positions, and every rival that was right only relays the Finnish feed |
| Paid asks on the Telegraph devnode | e.g. HULDA MAERSK, receipt `0x87705b7fdcec3c428434b30938fbc7fd100b3eefc40f703ee72db2372da336e5` (epoch 45); MMSI 219278000, receipt `0x86c1e5a8680e3401a2ac33f2af5865bba15e8a38a5da1a0aa9e190744fb05041` |
| Traffic | 186 calls in the first 2 days, 95 of them routed by the Telegraph network at all hours |

Run the truth test yourself (no keys): `python3 eval/truth-digitraffic.py 60`

## Ask it through Telegraph

```bash
# Pinned to Quay (pay with the escrow scheme; see Telegraph's x402 docs)
POST https://devnode.telegraphprotocol.com/engine/v1/ask/8818818
{"intent": "VESSEL_TELEMETRY_VERIFY_GENERAL", "params": {"vessel": "HULDA MAERSK"}}

POST https://devnode.telegraphprotocol.com/engine/v1/ask/8818818
{"intent": "LIVE_PORT_CONGESTION_GENERAL", "params": {"port": "Rotterdam"}}
```

`vessel` takes a ship name, a 9-digit MMSI or an IMO number (`IMO 9399363`). `port` takes a name or UN/LOCODE (`NLRTM`); the 27 ports are listed at [`/ports`](https://16-192-237-212.sslip.io/ports).

### A real vessel answer

```json
{
  "vessel": "HULDA MAERSK", "name": "HULDA MAERSK", "mmsi": "219278000", "imo": "9399363",
  "latitude": 51.46303, "longitude": 0.26758, "speed_knots": 0, "course_deg": 39.7,
  "observed_at": "2026-11-25T09:31:58.063Z", "status": "live", "age_minutes": 6,
  "nav_status": "moored", "destination": "BEANT>GBLWT", "eta": "11-20 16:00 UTC (as reported by the ship)",
  "matched_by": "name", "other_ships_with_same_name": 0,
  "source": "Live AIS broadcast via aisstream.io terrestrial receivers"
}
```

`status` is `live` (heard in the last hour), `recent` (1–6 h: a moving ship may have moved on) or `stale` (over 6 h). Not heard in 14 days: `"status": "not_seen"` with all position fields `null` (never a guessed position).

### A real port answer

```json
{
  "port": "Rotterdam", "unlocode": "NLRTM", "vessels_waiting": 38, "congestion_level": "high",
  "wait_hours": 17.5, "cargo_vessels_in_area": 459, "cargo_vessels_moored": 321,
  "as_of": "2026-11-25T09:37:30.687Z",
  "method": "Seagoing cargo ships and tankers (AIS types 70-89, 80 m+ when size is known) heard within 40 km in the last 2 h; waiting = reporting 'at anchor'. Level compares waiting ships with a typical count of 25."
}
```

Only seagoing cargo ships and tankers count: an early version counted tugs, pilots and ferries and called Rotterdam "severe" with 247 ships waiting. A port with fewer than 3 cargo ships heard returns `insufficient_coverage` instead of a number.

## What it enables

- **Trade payments:** release a supplier payment when the ship is actually at the destination port (see Northstar, the app built on Quay).
- **Shipment delay risk:** a ship waiting at anchor outside a "high" port is late before the carrier says so.
- **Insurance and trade finance:** check that the vessel on a bill of lading exists, is where the documents say, and is moving.

## How it works

One Node.js process (`index.js`, ~260 lines):

1. Subscribes to the [aisstream.io](https://aisstream.io) WebSocket for position, static and voyage reports worldwide, and keeps the latest state of every ship in memory, indexed by MMSI, IMO and name.
2. Saves a snapshot every 60 s (restarts keep everything), forgets ships not heard in 72 h, and reconnects the stream with a watchdog.
3. Answers `/vessel` and `/port` over HTTPS (Caddy, Let's Encrypt) on an always-on AWS server, under pm2.

`ports.js` holds the 27 ports: centre of the port and its anchorages, a search radius, and a typical anchored count used only to grade the congestion level.

## Limitations (also in [`miner.yaml`](miner.yaml))

- **Terrestrial coverage:** ships far offshore, or near coasts without receivers, go unheard. Quay answers `"status": "not_seen"` with null position fields.
- **Self-reported data:** destination and ETA are typed in by the ship's crew; they are passed through and labelled as such.
- **Wait hours** need continuous observation; after a restart they are capped by the uptime, and the answer says so in `caveat`.

## Run your own

```bash
npm install
echo "<your aisstream.io key>" > ~/.aisstream_key   # free key: sign in at aisstream.io with GitHub
node index.js                                       # serves on 127.0.0.1:8080
curl "127.0.0.1:8080/vessel?vessel=219278000"
```

MIT licensed.
