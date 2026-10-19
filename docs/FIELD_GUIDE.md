# Field guide (printable)

**Decision order:** friendly check → radio signal → behaviour and camera → weapon in reach?

1. **Friendly check: "Matches flight plan"** → ours. Identify Friendly UAV, **Hold**. Never fire.
2. **RF: control link (2.4 GHz)** → recon drone → **RF jam**.
3. **RF: video link (5.8 GHz)** → FPV attack drone → **RF jam now**.
4. **RF: no emission, slow, erratic** → bird → **Hold**.
5. **RF: no emission, fast, straight in, wing** → loitering munition → **GNSS spoof** (or interceptor). Jamming fails.
6. **RF: no emission, several moving together** → swarm → **GNSS spoof** (hits neighbours too).
7. **RF: no emission, but flies like an FPV (fast, low, weaving)** → fibre-optic FPV → **Interceptor** (or gun when close). Jamming and spoofing fail.
8. **RF: no emission, small wing, low and straight in** → AI-guided attack drone → **Interceptor**. Jamming and spoofing fail.
9. **RF: no emission, wing, very fast** → jet one-way attack drone → **GNSS spoof** (or interceptor). Act early: it closes in about half a minute.
10. **RF: 2.4 GHz, bigger echo, does not stop** → payload-drop drone → **RF jam** before it reaches the asset.
11. **RF: control link (1.4 GHz or 868–900 MHz, or a datalink), flies in then hovers or circles at a distance** → VTOL ISR, tactical ISR wing or large military UAV → **RF jam**. Do not leave it watching.
12. **Weapon greyed out?** Not in reach yet. Watch its bar; handle the most urgent contact first.

| Contact | Speed | Height | Echo | Radio | Behaviour | Camera | Do this |
|---|---|---|---|---|---|---|---|
| Friendly UAV | ~58 km/h | 150–300 m | Medium | Own-force link | Circles a set route | Fixed wing | Hold |
| Bird / clutter | ~29 km/h | 20–180 m | Very small | None | Erratic | Flapping wings | Hold |
| Recon quad | ~43 km/h | 60–150 m | Small | 2.4 GHz control | Slow approach, then hovers | 4 rotors | RF jam |
| FPV attack | ~115 km/h | 15–60 m | Very small | 5.8 GHz video | Fast, low, weaving | 4 rotors | RF jam |
| Loitering munition | ~151 km/h | 250–500 m | Medium | None | Fast, straight at the asset | Fixed wing | GNSS spoof |
| Swarm drone | ~72 km/h | 60–120 m | Very small | None | Moves with others | 4 rotors | GNSS spoof |
| Fibre-optic FPV | ~101 km/h | 10–50 m | Very small | None (fibre-optic cable) | Fast, low, weaving | 4 rotors | Interceptor |
| AI-guided attack | ~130 km/h | 40–150 m | Small | None | Low and straight in | Fixed wing | Interceptor |
| Jet attack drone | ~306 km/h | 300–1200 m | Medium | None | Very fast, straight at the asset | Fixed wing | GNSS spoof |
| Payload dropper | ~43 km/h | 40–120 m | Medium | 2.4 GHz control | Slow, heavy, straight for the asset | 4 rotors | RF jam |
| VTOL ISR | ~86 km/h | 100–400 m | Small | 1.4 GHz control | Flies in like a plane, then hovers | Fixed wing | RF jam |
| Tactical ISR wing | ~101 km/h | 300–1000 m | Small | 868–900 MHz control | Flies in, then circles at a distance | Fixed wing | RF jam |
| Large mil. UAV (MALE) | ~180 km/h | 1500–3000 m | Large | Satellite / LOS datalink | Flies in high, then circles at standoff | Fixed wing | RF jam |

**Look-alikes:** friendly UAV vs loitering munition (both wings: friendly check and behaviour decide) · bird vs swarm vs FPV (all tiny: speed, radio and grouping decide) · recon vs FPV (both rotors and radio: speed and frequency decide) · FPV vs fibre-optic FPV (same flight: only the radio differs) · loitering munition vs jet attack drone vs AI-guided attack (all silent wings: speed and height decide; GNSS spoof fails on the AI-guided one) · recon vs payload dropper (both 2.4 GHz: the dropper's echo is bigger and it never stops) · tactical ISR wing vs friendly UAV (both circle: the friendly check decides).

**Confidence:** Certain only when friendly check, radio and behaviour all agree; if a sensor is down, say Confident.

Values are training values set by your unit (`config/`), not equipment specifications. Speeds vary by about ±12%.
