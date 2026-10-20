# Instructor guide

## Your tools

- **Instructor panel** (top bar, *Instructor* button). Visible to instructor and admin accounts on the unit server. On a standalone laptop, open the app with `?instructor` at the end of the address (changes then stay in that browser).
- **Readiness board** (debrief → *Unit readiness*): mastery per operator and condition; *Who can I put on the console?* answers for tonight's conditions.

## Change doctrine and settings (no code)

In the instructor panel:

| Section | What you can change |
|---|---|
| Weapons | Reach, minimum range, time to effect, stock |
| Doctrine points | Defeat points per threat class and weapon; urban-gun, late-engagement and priority penalties |
| Training & certification | Pass mark, mastery thresholds, clue timings, drill length, threat speeds and heights |

Press **Validate and save**. Invalid settings are refused with a plain explanation (for example *"jam has min >= range"*). Every save on the unit server is a **new version** with your name and a note; trainees get it when they reload. *Reset to defaults* restores the shipped values.

Detection + identification + defeat points must total 100. Values are training values for the simulation; set them to match your unit's doctrine.

## Scripted drills (exams, set scenarios)

In *Scripted drills*: give it a name, choose day/night, terrain and sensor fault, and add contacts (type, time it enters, bearing, distance). Saved drills appear for every trainee on the brief under **Instructor drills**. They are scored and count toward the record, so use them for exams: every trainee faces exactly the same raid.

## Reading results

- **Server verified** in a debrief means the unit server re-ran the drill from its seed and decision log and got the same score. *Score corrected* means the client's claimed score was wrong; the server's score is the one stored.
- Drills flagged **superhuman-reaction-times** (most tracks started within 0.4 s of the first radar paint) are worth a conversation: the drill may have been scripted.
- Mastery comes from a standard learning model (Bayesian knowledge tracing). One drill can move it but never certify anyone on its own.

## Gun drills, live-fire procedure and the classroom library

- **Words of command, checklists and gun values** live in `config/guns.json`:
  - `orders`: the words of command.
  - `lfx`: the live-fire checks.
  - `guns[*].reload`: the reload steps.
  - `procedure`: the time standards.
  - `uav`: the UAV drill.

  Replace the placeholders with your unit's exact drill wording. Validate with `npm run validate:config`, or ship the change as a signed pack.
- **Crew drill over the LAN:** on the unit server, one trainee creates a crew drill in the gun lobby and reads out the code; each person takes a seat (Control Room or gun); anyone seated starts it. An empty seat is played by the AI.
- **Unit gun readiness** (gun lobby, instructors and admins): drills, last On Ground and Control Room scores, and the weakest gun skill for each person.
- **Classroom library** (Home → *Classroom library*): add videos or notes (PDF, PNG/JPEG, text) under a course: Control Room, On Ground (gun), UAV GCS, Live-fire safety, and others.

## Running a session

1. New operators: Academy lessons 1–4.
2. Three or four scored drills each; the enemy AI adapts each one to the operator's weak spots.
3. A scripted exam drill under the conditions you need (for example night + swarm).
4. Check the readiness board and *Who can I put on the console?*
