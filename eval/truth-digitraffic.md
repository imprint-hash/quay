# Truth test: Quay vs Finland's official AIS feed

Run: `python3 eval/truth-digitraffic.py 60` (no keys needed). Raw rows: [`truth-digitraffic.json`](truth-digitraffic.json).

**Method.** Take ships that [Digitraffic](https://www.digitraffic.fi/en/marine-traffic/) (Fintraffic, the Finnish government's open AIS service, an independent receiver network) heard in the last 10 minutes. Pick 60 at random. Ask Quay where each one is, by MMSI. Compare positions (km apart), speed, name, and how old each fix is. A Quay answer counts as correct when it is within 1 km plus the distance the ship could have sailed between the two fixes.

**Result (25 Nov 2026, 09:07 UTC, 60 ships):**

| | |
|---|---|
| Answered with a position | 39 of 60 |
| Answered "vessel_not_seen" (honest: no terrestrial receiver heard it) | 21 of 60 |
| **Answers heard in the last hour** | **23, all 23 correct, median 1 m from Digitraffic** |
| Answers heard in the last 30 min | 20, all 20 correct, median 0 m |
| Answers 1–6 h old | 8, 6 correct; 2 had sailed on (a ferry and a coaster) |
| Answers over 6 h old | 8, all marked `"status": "stale"` |
| Ship name matches Digitraffic | 39 of 39 |
| Made-up positions | 0 |

**What changed after this test.** Two answers 2–3 hours old were still labelled `live`. Quay now says `live` only for fixes heard in the last hour, `recent` for 1–6 hours and `stale` after that, alongside `age_minutes`, so a buyer agent can decide for itself how fresh is fresh enough.

**Coverage, honestly.** Quay hears ships through terrestrial AIS receivers (aisstream.io). In the Gulf of Bothnia and the Finnish archipelago, 21 of 60 ships were out of range of those receivers; Quay says so instead of guessing. Digitraffic-based miners cover Finland well and nothing else; Quay covers the world's major ports and shipping lanes (60,000+ ships tracked at once).
