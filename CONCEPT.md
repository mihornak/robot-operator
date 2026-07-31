# Robot Operator (working title)

**One-liner:** You don't play the robot. You manage it. A voice-operated expedition roguelike where you shout instructions at a battle robot that has its own brain — and its own opinions.

**Status:** design locked for a 2-week probe (2026-07-31). Lives OUTSIDE Ringmaster deliberately — killable without touching it. Steal Ringmaster's server/room/ws + narration-bank patterns by copy, not import.

> **This file is rationale + history. The authoritative, buildable spec is [`GAME_SPEC.md`](./GAME_SPEC.md).** Later same-day decisions recorded there and NOT back-ported here: control capability ladder (tier 0 RC-tank → tier 4 policies) as the progression spine; RTS-feel talk-any-time ack contract; ALL voice on `eleven_flash_v2_5`, no audio tags, no v3 (supersedes bullet 10 below); canvas/Pixi locked; exactly 1 robot in probe ("Chad-9").

## Origin & evidence (read before re-litigating)

Started as "Fight of AI Machines" (one prompt → autonomous machine, agar.io shared map, emergent balance). 5-agent market research (2026-07-31, recorded in project memory `fight-of-ai-machines-decision.md`) killed that spec:

- One-decision-then-watch = Screeps/Gladiabots shape → niche ceiling (4–45 CCU). Retaining autobattlers deliver a decision every 30–120s in bounded 10–60s rounds.
- Emergent/UGC balance: zero precedent (Robocraft nerf-arms-race death); LLMs *homogenize* creativity (Science Advances 2024).
- LLM adjudication is exploitable (Death by AI one-string 100% winrate; Freysa $47k; ICLR 2025 null-response 86.5%). Promptables (broadcaster-funded LLM referee) sits at 35% positive.
- A winning 140-char prompt is a free copy-paste string; convergence faster than any precedent. Can't prevent copy-paste — make *context* unique instead.
- ~12 prompt-battler reinventions since 2022, all failed. AI-native = acquisition spike, not retention (Death by AI 6.9M users → frozen app; Suck Up 50M views → 18 CCU; Retail Mage cut inference 1000× and still peaked at 17 CCU). The loop retains or nothing does; the LLM only markets.
- Only LLM-core game with a RISING retention curve: AI Roguelite — single-player. Biggest die→learn→retry hits: solo roguelikes (Balatro, StS).

What survived: deterministic engine + LLM-as-compiler (Ringmaster's golden rule), the die→learn→re-instruct loop, HTML-composed part-based machines (kills the image-cost problem: text-only ≈ $0.001/DAU vs $0.02–0.05 ARPDAU), and the shareability bet — relocated from "wild prompts" to "the robot being an idiot on voice."

## The hook

Mechanize everyone's 2026 daily experience: an AI that is confident, semi-obedient, occasionally brilliant, and randomly ignores you. Pedigree (none are programming games): Black & White's creature, Football Manager, QWOP/Octodad (interface-as-antagonist comedy), Darkest Dungeon quirks, Lifeline (advise-don't-control). Framing: **literal genie / dumb hire** — misinterpretation is the joke, so the LLM's weakness is the feature.

## Core design decisions (locked for probe)

1. **Brain architecture:** behavior tree runs the robot every tick — zero LLM in the combat loop. LLM does exactly two jobs: (a) instruction → constrained standing-order JSON, (b) personality/flavor. Cheap fast model on purpose (funnier misreadings, ~$0.0002/parse, sub-second). Randomness lives in *interpretation*, never physics.
2. **Voice input, push-to-talk.** Hold-to-talk IS the diegetic controller (also prevents Discord-voice crosstalk). Browser SpeechRecognition for probe. STT errors are diegetically a bad microphone. Text input always available in parallel.
3. **Never show the raw transcript.** The robot repeats back what it heard *in its own words* ("Understood. Eating them."). Player can't tell mic from brain — that ambiguity is the comedy — but feedback stays legible.
4. **Disobedience is loud, legible, cheap.** Robot may refuse HOW you asked, never silently sabotage — it announces refusal. Refusals cost tempo, rarely the run. Obedience has levers (chips, mood), never raw RNG.
5. **Gameplay shape: expedition roguelike** (StS map × Archero rooms). 8–12 rooms/run, 5–8 min. ~6 situation archetypes for probe: ambush, hazard-loot, chokepoint, escort/carry, sneak-past, boss. Instruction moments = situation × personality collisions. Path choice = routing around your own robot's flaws.
6. **Deckbuild the communication channel, not just weapons.** Controller tier = input bandwidth/latency/static. Brain chips = power-vs-control axis (smarter = more willful). Personality chips are the jokers ("Coward: +30% speed, flees at half HP regardless of orders"). Probe: 1 robot, 3 chips, 2 controller tiers.
7. **Economy:** NO consumable instruction-token ledger (accounting = programming smell). Input bandwidth is equipment-gated, instructions cooldown-gated (radio recharge), pickups are plain scrap for the between-room shop.
8. **Randomize content, never physics.** Module drops, wave/room composition, layouts: random. Combat resolution + what an instruction compiles to: deterministic and stable.
9. **Rendering:** canvas (Pixi-class), machines still composed of parts that visibly break off. Probe art = programmer-art with personality; ugly fine, funny mandatory.
10. **Voice output:** ~40 pregenerated lines (refusals, repeat-backs, deaths, boss quips) on the Ringmaster Eleven v3 bank pipeline (audio tags OK, captions tag-stripped). No realtime TTS in probe.
11. **Structure:** authored intro levels (each introduces one archetype + one unlock, "figure it out with the bot") → seeded expedition mode → daily seed. Same content, three lifespans.
12. **Character select:** roster of robots, each = hidden masterprompt + visible quirk. Roster = live-ops-lite lever later (new robot occasionally, not weekly balance).

## Kill criteria (committed BEFORE building; instrument from day 1)

2-week timebox. Log every command + outcome.
- Re-instruct rate after a failed room/death < 35% → kill.
- Median session < 2 runs → kill.
- Zero playtesters share a clip unprompted in week 1 → the shareability thesis is dead → kill.

## Phase 2 (only if probe survives)

- **Black box persistence:** chassis dies, brain survives — grudges/quirks accumulate across runs ("Afraid of cranes since run 4"). Retention/attachment layer.
- **Shared talk button co-op:** anyone in the room can hold-to-talk at the SAME robot. Technically cheap (STT client-side, commands = ws messages, Ringmaster room infra). Twitch-Plays-Pokémon chaos as the Discord party mode.
- **Ghost duels / async PvP** (Backpack Battles ghosts; consumed-on-use per The Bazaar).
- Distribution: own URL first; post-probe: web portals (Poki 100M MAU) are the strongest free browser channel. **Discord DROPPED as a platform (2026-07-31): Activities cannot access the microphone (embedded-app-sdk #363) and voice is the game** — revisit only if Discord ever grants Activities mic permission.
- Monetization: Screeps pattern — the instruction/compute budget IS the subscription. Meter regeneration, never turns.
- Ringmaster Store tile: port in only if it earns it.

## Open items

- Name/brand (Ringmaster label vs standalone).
- Model pick for parser (Groq Llama 8B / gpt-5-nano / Gemini flash-lite class — cheapest that does constrained JSON reliably).
- Playtest protocol: who, when, how clips get captured.
