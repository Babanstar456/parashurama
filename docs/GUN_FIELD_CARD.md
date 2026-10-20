# Air defence gun drills: field card

For trainees on the **On Ground** and **Control Room** gun drills and the **UAV strike drill**. Print on one sheet.

> **Training values only.** These are not equipment specifications or official drill. The words of command are placeholders until the unit's exact drill wording is loaded into `config/guns.json`. Weapon Control Status and Air Defence Warning use NATO terms; the Indian equivalents are to be confirmed by DSSC.

## Fire-order sequence (Control Room)

**RANGE CLEAR** (only after the range safety checks) → **ALERT** → **TARGET** (bearing, range, height, type) → **METHOD** → **FIRE** → **CEASE FIRE** (stop firing, keep tracking) → **UNLOAD, MAKE SAFE** → range sweep → **RANGE GREEN**.

- **HOLD FIRE** is the emergency stop on everything. Give it at once if a friendly or civil aircraft enters the line of fire.
- **Weapon Control Status:**
  - WEAPONS TIGHT: fire only at positively identified hostiles.
  - WEAPONS HOLD: fire only in self-defence (target within 20 s of the asset).
  - WEAPONS FREE: fire at anything not identified as friendly.
- **Safe arcs:** never order fire into one.
- **Priority:** the threat with the least time to the asset comes first.

## Gun detachment drill (On Ground)

1. Pre-firing checks: barrels, mounting, levelling, sight zero, ammunition count.
2. Acknowledge every order.
3. Man the gun. Under ADW WHITE or YELLOW this takes time.
4. Load (reload drill below).
5. Lay on the indicated target (ZU-23-2), or lock the radar (ZSU-23-4).
6. ZU-23-2 only: set **speed, course and range** on the sight.
7. On **FIRE**: safety off, then short bursts of 5–15 rounds per barrel. Watch the tracer.
8. Report the kill.
9. On CEASE FIRE: safety on.
10. On UNLOAD: unload, clear the gun, and report the rounds expended (issued minus remaining).

**Points are lost for:**
- firing without FIRE, or after HOLD FIRE;
- firing into a safe arc;
- firing at a friendly or civil aircraft;
- long bursts;
- firing beyond effective range.

## ZU-23-2 manual lead (training model)

- **Speed:** the target's ground speed, in 5 m/s steps on the sight.
- **Course:** 0° means coming straight at you; + means crossing to the right; −90° means crossing right to left. Steps of 15°.
- **Range:** your best estimate, in 100 m steps.
- The sight works out the lead from these three settings. Keep the target on the crosshair, and the barrel points ahead by the lead.
- **Weaving targets:** set the mean course, not each swerve.
- **When to open fire:** small drones only at short range. The training values are very small about 800 m, small about 1,200 m, medium about 2,000 m.

| Range | Time of flight | Superelevation (23 mm HEI-T, training model) |
|---|---|---|
| 1,000 m | 1.23 s | 6.3 mil |
| 1,500 m | 2.06 s | 11.3 mil |
| 2,000 m | 3.10 s | 18.0 mil |

The figures come from the trainer's ballistics test. A crossing target at 30 m/s and 1,500 m needs about 2.4° of lead.

## Reload drill (in order)

- **ZU-23-2:** open the feed cover → fit a full ammunition box → lay the belt on the feed tray → close the feed cover → cock the gun.
- **ZSU-23-4:** switch to the next ammunition box → feed the belts → charge the guns.

A step out of order is counted. The time standard is the sum of the step times: 10.5 s (ZU-23-2) and 10 s (ZSU-23-4).

## Live-fire range checks

- **Before RANGE CLEAR:**
  - danger area clear;
  - flags up, sentries posted;
  - met message received;
  - airspace clear, own-drone schedule checked;
  - joint pre-brief done.
- **After firing:** locate every round that failed to self-destruct, for EOD, before **RANGE GREEN**.

## UAV strike drill (extension beyond the counter-drone PS)

1. Pre-flight checks.
2. Load the mission plan.
3. Request take-off clearance; take off only when cleared.
4. Stay in the safe corridor; never cut over the no-fly zone.
5. Find and lock the target. Never lock a civil object.
6. Request **CLEAR TO ENGAGE**.
7. Master Arm ON.
8. Attack run: steer the impact point (CCIP) onto the target, then release.
9. Master Arm **SAFE** at once.
10. Report the damage assessment.
11. Return on the inbound corridor.
12. Land, recover, clear the payload.
