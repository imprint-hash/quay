# Head to head: every VESSEL_TELEMETRY miner, same ships, same minute

25 Nov 2026, 09:05–09:15 UTC. Paid, pinned asks through the Telegraph devnode (`/engine/v1/ask/<minerId>`, escrow payment) for three ships that Finland's official AIS feed (Digitraffic) heard in the previous 10 minutes. Raw answers: [`head-to-head.json`](head-to-head.json) and [`head-to-head.raw.txt`](head-to-head.raw.txt).

| Miner | id | Position | Problem seen |
|---|---|---|---|
| **Quay** | 8818818 | correct on 3/3 | – |
| VesselWire Vessel Telemetry Verify | 7603 | correct on 3/3 | Finland/Baltic source |
| TxLens | 9002 | correct on 3/3 | relays Digitraffic |
| PREFLIGHT Infrastructure Signals | 20260828 | correct on 3/3 | relays Digitraffic |
| ChainSight | 302 | correct on 3/3 | relays Digitraffic, 8.7–14 s |
| Digitraffic AIS by MMSI | 93003 | **wrong on 3/3** | latitude and longitude swapped (puts a Gulf of Bothnia ship at 20° N, 63° E); one answer had latitude = longitude |
| Fintraffic Digitraffic AIS | 170068 | **none on 3/3** | latitude and longitude are `null` |
| ADSB.lol Singapore | 93006 | **none** | `no_compatible_miner` |

Every miner that answered correctly here relays the same Finnish government feed, so it only knows ships in Finnish waters. Quay listens to terrestrial AIS receivers worldwide: at the time of this test it was tracking 60,000+ ships (Rotterdam, Singapore, Los Angeles, Durban, the Thames...). A fourth, non-Finnish ship (HULDA MAERSK, Thames estuary) was asked of every miner too, but the devnode timed out for all miners during that minute; see the [truth test](truth-digitraffic.md) for Quay's accuracy, and the README for global coverage.
