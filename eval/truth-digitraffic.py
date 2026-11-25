"""Quay vs an independent truth source: Finland's Digitraffic AIS (Fintraffic, official, open).
For ships Digitraffic heard in the last 10 minutes, ask Quay where the same ship is and compare
position (km apart), speed and how fresh each answer is. Run: python3 eval/truth-digitraffic.py [n]"""
import gzip, json, math, random, sys, time, urllib.request
N = int(sys.argv[1]) if len(sys.argv) > 1 else 60
QUAY = "https://16-192-237-212.sslip.io"
H = {"Digitraffic-User": "quay-eval", "Accept-Encoding": "gzip"}
def get(url, h=None):
    req = urllib.request.Request(url, headers=h or {})
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            b = r.read(); b = gzip.decompress(b) if r.headers.get("Content-Encoding") == "gzip" else b
            return r.status, json.loads(b)
    except urllib.error.HTTPError as e:
        b = e.read()
        try: return e.code, json.loads(b or b"{}")
        except ValueError: return e.code, {"raw": b[:200].decode("utf8", "replace")}
def km(a, b, c, d):
    p = math.pi / 180; x = math.sin((c - a) * p / 2) ** 2 + math.cos(a * p) * math.cos(c * p) * math.sin((d - b) * p / 2) ** 2
    return 12742 * math.asin(math.sqrt(x))
_, locs = get("https://meri.digitraffic.fi/api/ais/v1/locations", H)
_, meta = get("https://meri.digitraffic.fi/api/ais/v1/vessels", H)
names = {v["mmsi"]: v for v in meta}
now = time.time() * 1000
fresh = [f for f in locs["features"] if now - f["properties"]["timestampExternal"] < 600_000 and f["mmsi"] in names]
random.seed(7); sample = random.sample(fresh, min(N, len(fresh)))
rows = []
for f in sample:
    p = f["properties"]; lon, lat = f["geometry"]["coordinates"]; v = names[f["mmsi"]]
    st, q = get(f"{QUAY}/vessel?vessel={f['mmsi']}")
    row = {"mmsi": f["mmsi"], "name": v.get("name"), "ship_type": v.get("shipType"), "truth": {"lat": lat, "lon": lon, "sog": p["sog"], "at": p["timestampExternal"]}, "quay_status": st}
    if st == 200 and q.get("latitude") is not None:
        qa = time.mktime(time.strptime(q["observed_at"][:19], "%Y-%m-%dT%H:%M:%S")) * 1000 - time.timezone * 1000
        row.update(quay={k: q.get(k) for k in ("latitude", "longitude", "speed_knots", "observed_at", "status", "name")},
                   km_apart=round(km(lat, lon, q["latitude"], q["longitude"]), 3), quay_age_min=round((now - qa) / 60000, 1),
                   minutes_between=round(abs(qa - p["timestampExternal"]) / 60000, 1), sog_diff=None if q.get("speed_knots") is None else round(abs(q["speed_knots"] - p["sog"]), 1),
                   name_match=(q.get("name") or "").strip().upper() == (v.get("name") or "").strip().upper())
    rows.append(row); print(f"{f['mmsi']} {str(v.get('name'))[:22]:22} quay={st} " + (f"{row['km_apart']} km apart, {row['minutes_between']} min between fixes, speed diff {row['sog_diff']} kn" if 'km_apart' in row else str(q)[:80]))
ans = [r for r in rows if "km_apart" in r]
close = [r for r in ans if r["km_apart"] <= 1 + r["minutes_between"] * (r["truth"]["sog"] * 1.852 / 60)]
summary = {"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "truth_source": "Digitraffic AIS (Fintraffic) /api/ais/v1/locations", "asked": len(rows), "answered": len(ans),
           "not_seen": sum(r["quay_status"] == 404 or "km_apart" not in r for r in rows), "within_expected_distance": len(close),
           "median_km_apart": sorted(r["km_apart"] for r in ans)[len(ans) // 2] if ans else None,
           "median_minutes_between_fixes": sorted(r["minutes_between"] for r in ans)[len(ans) // 2] if ans else None,
           "name_match": sum(r["name_match"] for r in ans), "wrong_answers": len(ans) - len(close)}
print(json.dumps(summary, indent=1))
json.dump({"summary": summary, "rows": rows}, open("eval/truth-digitraffic.json", "w"), indent=1)
