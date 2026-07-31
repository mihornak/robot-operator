# FIRST MINUTES — director's script for the teaser (floors 1–5)

How the game must FEEL from power-on to cliffhanger. This is the probe's actual deliverable: these ~7 minutes, nailed. Systems detail in `GAME_SPEC.md`; where they disagree on feel, THIS file wins.

## The four feel rules

1. **There is never a menu.** No title screen, no settings, no buttons. The console turning on IS the game starting. Everything the player ever does is: hold space, talk.
2. **The robot teaches, nothing else does.** No tutorial text, no tooltips, no arrows. The robot asks for what it needs ("WHAT ROBOT DO?") and the player's instinct to answer IS the tutorial.
3. **Silence is content.** Every gap where the player doesn't speak has a timed idle beat (robot hums, spins, narrates nothing happening). Dead air is the only bug.
4. **Failure must be funnier than success.** Wall bumps, wrong targets, deaths — each has a voiced payoff. The player should half-want to fail.

## The voice — toddler-speak bible

Robot speaks like a confident 2-year-old. Rules for every line ever written:
- Third person, always: "ROBOT…" never "I".
- ≤ 7 words per line. No subordinate clauses.
- Misapplied abstractions are the joke: "WALL IS RUDE." "FLOOR IS SPICY." "ELEVATOR IS TIRED."
- Overconfident, never sad. Failure reframed as intent: "ROBOT MEANT THAT."
- All lines TTS on `eleven_flash_v2_5`, no tags. Small beep/servo layer UNDER the voice sells the robot.

---

## Beat 0 — Power on (0:00–0:20)

Black. Faint 50Hz hum. One dim line, barely readable: `PRESS [SPACE]`.

Space → **CRT bloom flash** → scanlines settle → we're looking at a security feed. Dark, near-monochrome, amber OSD in the corner: `CAM 01 · FLOOR 01 · REC ●`. Occasional jitter line rolls the frame.

Taped over the monitor's corner, a handwritten sticky note (screen-space, not in-world):

> *"IF BROKEN: turn the main computer OFF and ON.*
> *It's on floor 15.*
> *— M."*

That note is the entire plot, the tone, and the objective in nine words. It never leaves the screen edge until floor 15 (full game).

After ~3s of stillness: `HOLD [SPACE] TO TALK` fades in. Nothing else will ever be explained.

## Beat 1 — The robot wakes (0:20–0:50)

On the feed: a small storage room. A round wheel-bot (R2D2 silhouette, no legs, one status light) asleep in the corner — **the only saturated-color thing on screen**, forever.

Player holds space and says literally anything → radio click → the robot's light blinks on → **its head swivels up toward the security camera. It looks at YOU.** This is the relationship beat; do not cut it.

> "HELLO? … YOU ARE VOICE? … ROBOT WAS SLEEPING."
> "ROBOT HAS NO NAME. VOICE GIVES NAME?"

**The naming beat.** Player says a name → "ROBOT IS [NAME]. [NAME] IS GOOD AT THINGS." Refuse or stay silent → "ROBOT NAMES ROBOT: ROBOT." (also fine, also funny). The name goes into every bark from here on. Then:

> "WHAT [NAME] DO?"

…and it WAITS. If silent 5s: "ROBOT STILL HERE." 10s: slow celebratory spin, humming. 20s: "ROBOT PRACTICES WAITING. ROBOT IS GOOD AT IT."

Tier 0 controls only: up / down / left / right / stop / shoot. First command with a direction → it GOES — and keeps going. First guaranteed comedy is scripted by physics: it reaches the wall and keeps driving. Bump. Bump. Bump. "ROBOT IS WALKING." (it is not) … "WALL IS RUDE."

## Beat 2 — Floor 1: the zigzag lesson (0:50–2:00)

Room layout: elevator A (behind robot) → simple L-shaped room → elevator B (lit). No threats. One scrap pickup ("ROBOT FOUND SHINY. ROBOT KEEPS."). Pure steering practice with one corner.

Robot enters elevator B → doors close → **static burst → CAM 02**. Camera-cut IS the scene transition; every floor change is a security-feed switch.

The gag lands here: "ELEVATOR SAYS NO MORE. ELEVATOR IS TIRED." — one floor at a time, cross the room to the other shaft, all the way to 15. The player now understands the whole game's structure without a single word of UI.

## Beat 3 — Floor 2: first triad (2:00–3:15)

Floor 2 opens with the **forgetting gag** — establishing MEMORY as an axis before it's ever offered:

> "WHO IS [NAME]? … OH. IS ROBOT."

Three service crates on charging pedestals, each with a glyph. **Voice-only selection, taught diegetically — the robot reads them:**

> "CRATE SAYS… MAGNET. CRATE SAYS… RAGE. CRATE SAYS… SCARED. WHICH?"

(One-word names, phonetically distinct — an STT constraint promoted to a naming law. Internally these are the Hoarder / Bloodlust / Coward chips.)

**Anything works** — it all goes through the LLM in context: "magnet", "the first one", "the angry one", "I don't care", "yolo". Indifference means the robot chooses, with attitude: "ROBOT PICKS RAGE. ROBOT HAS TASTE." Genuinely unresolvable → it re-reads the options. There is no wrong way to answer, only funny ways.

Chosen crate → robot installs it → **visible new part on the sprite** + module glyph appears on the OSD strip.

Floor 2's hazard: a sparking floor cable. Tier 0 steering will absolutely drive through it if the player is sloppy. "FLOOR IS SPICY." — small damage, big lesson.

## Beat 4 — Floor 3: new ears, first enemy (3:15–4:30)

Level-3 starter crate is fixed (not a triad): the **controller upgrade to Tier 1**.

> "NEW EARS! … ROBOT UNDERSTANDS THINGS NOW. SAY THING, ROBOT GO THING."

Immediately made necessary: first hostile — a **printer melted onto a vacuum**, chasing while spitting crumpled paper. This sets the enemy tone (user-locked): **fused machines** — the computer being down is why the tech went feral; broken appliances merged into creatures. Threatening AND funny, industrial body horror for office equipment, never gore. "shoot the printer" now works. So does the debut of wrong-target comedy: a second, innocent printer sits peacefully in the corner.

Straight-line pathing caveat is live: told to fetch scrap across the sparky cable, it walks THROUGH the cable. It has ears now, not judgment (that's BRAIN, sold separately).

## Beat 5 — Floor 4: it can kill you (4:30–5:30)

No new powers. Composition floor: a fused machine + hazard + a fragile carryable (fuse for elevator B — carrying disables the shooter). Carry-or-fight decision under pressure, everything learned so far at once. Death is genuinely possible here — and death is a FULL restart (teaser permadeath).

**Death card** (the share artifact): black card, CRT-styled — robot portrait, floor reached, WHAT IT HEARD (its own words, never the transcript), what it did, last words:

> "ROBOT REGRETS NOTHING." … "ROBOT REGRETS ONE THING: EVERYTHING."

One key restarts. Restart is < 2 seconds to control (boot skipped, note already read, robot: "ROBOT IS BACK. ROBOT REMEMBERS NOTHING. WHAT ROBOT DO?").

## Beat 6 — Floor 5: second triad + cliffhanger (5:30–7:00)

Second triad — axis upgrades this time: **"CRATE SAYS… MEMORY. CRATE SAYS… ZAP. CRATE SAYS… TOUGH."** Memory-vs-firepower is a real choice with a feelable payoff: pick MEMORY and you get the emotional beat of the teaser —

> "…[NAME]! … ROBOT REMEMBERS! ROBOT IS [NAME]!"

(Skip it and he keeps forgetting — the comedy continues either way; no wrong pick.)

Then the floor plays as a victory lap with one twist, robot rolls into elevator B, doors close —

**CAM 06 is dead. Static.** Robot's voice over the static:

> "…VOICE? … IT IS DARK HERE. … ROBOT IS NOT SCARED. … VOICE?"

Hold 3 seconds. Title card over the static: **ROBOT OPERATOR** — then `TO BE CONTINUED`. That's the teaser's share moment and the wishlist/waitlist screen.

---

## Latency choreography (the RTS feel, restated as theatre)

1. Space released → radio click + head-swivel toward camera: **instant, local, always** — happens before any network call.
2. ≤1.5s → robot repeats back what it heard, in its own words. Raw transcript never shown, anywhere.
3. Action or loud refusal. Refusals cost seconds, not runs.

STT failure is in-fiction: "VOICE IS MUMBLY. AGAIN?" No mic / no support: a teletype line slides onto the OSD (text input, same parser) — "TYPE ON TELETYPE. ROBOT READS GOOD."

## CRT as a character

Baseline: dark near-monochrome, amber OSD, scanlines, occasional roll/jitter, slight barrel curve + vignette. The filter REACTS: jitter intensifies when enemies are close, one hard glitch-frame on robot damage, feed degrades slightly as the robot's HP drops (the camera is worried about him). Never green-phosphor, never horror — the room is dark, the game is not.

## Teaser kill criteria (adapted from spec §10 — the run-count criterion is deferred to the full game)

Instrumented from day 1:
- **Completion:** ≥ 60% of playtesters reach the floor-5 cliffhanger.
- **Re-instruct after failure ≥ 35%** (unchanged) — after a death/wall-fail, do they immediately talk to the robot again?
- **Laughs:** observed laugh-out-loud in ≥ half of sessions (playtest on Discord voice; count them).
- **Shares:** zero unprompted death-card/clip shares in week 1 → the thesis is dead → kill.
- Soft signal that outranks all numbers: does anyone ask "when can I play more?"
