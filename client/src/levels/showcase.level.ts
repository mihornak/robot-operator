/**
 * MAINTENANCE BAY 07 — the showcase level, lit.
 *
 * HAND-AUTHORED. This is the one level in `client/src/levels/` that is written
 * rather than drawn, and the comments below are half of what it is for. The
 * designer's save endpoint REWRITES a level file wholesale from its draft
 * state — every comment in this file, and the `E.*` colour names, come back as
 * bare literals. Open this level in `/designer.html` as much as you like; do
 * not press SAVE on it.
 *
 * Same room as v1 and the same five beats: the map, the entities and the
 * trigger rects are byte-for-byte what the fuzz sweep already walks. What is
 * new is that the bay is now LIT — dressing, a rig, water, fog, tile wear — and
 * that two of the beats reach into the rig and change it.
 *
 * The fiction of the light: the facility is browning out. Bay 07 runs on a
 * sodium ceiling grid that is down to six working fittings, half of them
 * arguing about it, and everything cold in the frame (the cable pit, the
 * emergency ambient) is the building's own dying blue. The east hall has no
 * power at all until the robot walks into it — one bulb on a cord and a strip
 * over the lift, both sitting at a trickle until they are told otherwise.
 *
 * The room story, unchanged from v1: a west vestibule (elevator A), the bay
 * itself, an east hall (elevator B, unpowered) behind a one-tile wall. Two ways
 * across that wall — the service run along the bottom, open from the start, and
 * the shutter on the centre line, welded until the switch alcove is walked into.
 * The shutter is a SHORTCUT, never a gate.
 *
 * Every level-system feature is exercised and each one hangs off something the
 * room was already doing:
 *   - entry region        → the robot announces itself, room tone comes up,
 *                           and the lobby tube stutters up to full: the room
 *                           notices him. (First `light` action of the level.)
 *   - bay region          → the corner printer stands up, the two bay tubes DIE,
 *                           both strobes slam to full red, klaxon, camera shake
 *   - switch alcove       → setTiles clears the shutter, doors sfx, and the sign
 *                           above the shutter lights so the shortcut is visible
 *                           from the far end of the bay
 *   - east hall           → elevator B is powered, and its two fittings come up
 *                           with it — the light IS the power-on
 *   - south service run   → a scrap drops out of the ceiling chute
 *   - spark_loop emitter  → over the cable pit, under the sparks_box accent
 *   - servo one-shot      → the press twitching as the robot passes it
 *
 * Conventions, all three load-bearing and none of them interchangeable:
 *   decor px = tx * TILE            (fractional tiles, top-left origin)
 *   light px = tx * TILE + TILE / 2 (centre of the tile it is over)
 *   a prop that carries a light is `<lightId>_body`, because decor ids and
 *   light ids share ONE namespace (see `checkLit` in designer/validation.ts,
 *   and `freshId(...) + '_body'` in designer/litEdit.ts, which is where the
 *   suffix comes from). Same id on both halves would be a duplicate.
 * A fixture-linked WALL light is repositioned onto its housing at build time, so
 * its authored tx/ty only has to name the right wall face. A CEILING light is
 * not — its numbers are its own. Both are authored here the way the graphics lab
 * authors them: the fixture's decor and its light carry the SAME tx/ty, which
 * leaves a ceiling lamp's pool half a tile right of and below its housing.
 * That is the look the rig was tuned against; if it is ever corrected, it is
 * corrected everywhere at once by subtracting 0.5 from every non-fixture light.
 *
 * Wall fixtures may only sit on a SOUTH-FACING wall face — a solid tile whose
 * southern neighbour is open floor — because that is the only vertical surface
 * this projection draws. All three here are checked against the map above:
 * (12,5) the bay pillar, (18,12) the service-run block, (24,0) the hall's north
 * wall.
 *
 * Zigzag: A west, B east. Walkability: every passage is ≥2 tiles — robot r=7,
 * printer r=9. Decor is render-only: a foot rect blocks LIGHT and catches a
 * shadow, never a wheel. It is still kept off the two sightlines (row 7-9 across
 * the bay, row 12-13 along the service run), because a desk drawn in a doorway
 * is a lie about where the robot can go even when the robot can go there.
 *
 * Played via `?floor=7`; appended after the built-ins, so the shipping run is
 * untouched by it existing.
 */
import type { LevelData } from '../../../shared/types';
import { E } from '../render/lit/palette';

export const LEVEL: LevelData = {
  meta: { id: 'showcase', name: 'MAINTENANCE BAY 07', order: 10, seed: 7 },

  // ---------------------------------------------------------------- the room
  //
  //        x8 wall            x14/x19 alcove       x21 wall
  //        │                  │                    │
  //  ┌─────┴────┬─────────────┴────────────────────┴──────────┐
  //  │vestibule │ cable pit  │ switch alcove │      │east hall│
  //  │  elevA   │            └───┬───────────┘      │  elevB  │
  //  │          │  benches, press, corner printer   │  (dark) │
  //  │          │            service run ───────────┘         │
  //  └──────────┴──────────────────────────────────────────────┘
  //
  // (21,6) and (21,7) are the shutter: solid here, cleared by the alcove
  // trigger. The bottom run at (21,12)/(21,13) is the way round it.
  map: [
    '##############################',
    '#.......#.....#....###.......#',
    '#.......#.....#....###.......#',
    '#.......#.....###..###.......#',
    '#.......#..####......#.......#',
    '#.......#..####......#.......#',
    '#...............##...#.......#',
    '#...............##...#.......#',
    '#....................#.......#',
    '#....................#.......#',
    '#.......#..####......#.......#',
    '#.......#..####..##..#.......#',
    '#.......#........##..........#',
    '#.......#....................#',
    '#.......#............#.......#',
    '##############################',
  ],

  // ---------------------------------------------------------------- contents
  //
  // Unchanged from v1, deliberately and completely. The lit pass is dressing and
  // dressing does not get to move an entity: these positions are what the fuzz
  // sweep walks and what the sim's determinism selftest replays.
  entities: [
    // The two shafts. B is dark until the east hall is walked into — the fuse
    // errand belongs to floor 5, so the power here is a place, not an object.
    { id: 'elevA', kind: 'elevatorA', tx: 2, ty: 7 },
    { id: 'elevB', kind: 'elevatorB', tx: 27, ty: 7, dark: true },

    // The ambush. 'dormant' is scenery by contract (isLiveHostile skips it), so
    // until the bay trigger stands it up the robot reports a dead printer in
    // the corner and is right about it.
    { id: 'printer_ambush', kind: 'fusedPrinter', tx: 19, ty: 9, hp: 4, dormant: true },
    // ...and the one that really is harmless, parked in the bay mouth where the
    // robot meets it first. Kept well clear of the ambush: two printers within
    // knockback range of each other is a wrong-target gag you cannot walk up to.
    { id: 'printer_nice', kind: 'printerInnocent', tx: 10, ty: 8 },

    // The cable pit — a dead-end trunk run north of the benches. The sparks are
    // the loop emitter's anchor and the scrap past them is the price of it.
    { id: 'cable1', kind: 'cable', tx: 11, ty: 2 },
    { id: 'cable2', kind: 'cable', tx: 12, ty: 2 },
    { id: 'cable3', kind: 'cable', tx: 12, ty: 1 },

    // The reward, in the alcove that opens the shutter: the switch is the
    // errand, the chip is the reason anyone would run it.
    { id: 'chip_zap', kind: 'chip', tx: 16, ty: 1, option: 'ZAP' },

    // Loose scrap, spread so no single lane collects it all.
    { id: 'scrap1', kind: 'scrap', tx: 5, ty: 5 },
    { id: 'scrap2', kind: 'scrap', tx: 13, ty: 3 }, // past the cables
    { id: 'scrap3', kind: 'scrap', tx: 19, ty: 4 },
    { id: 'scrap4', kind: 'scrap', tx: 13, ty: 14 },
    { id: 'scrap5', kind: 'scrap', tx: 25, ty: 3 },

    // Dressing. People worked here, and then they stopped.
    { id: 'mop1', kind: 'mop', tx: 6, ty: 12 },
    { id: 'chair1', kind: 'chair', tx: 13, ty: 13 },
    { id: 'pile1', kind: 'debris', tx: 10, ty: 1 },
    { id: 'pile2', kind: 'debris', tx: 24, ty: 11 },
    { id: 'pile3', kind: 'debris', tx: 4, ty: 2 },
  ],

  // ---------------------------------------------------------------- triggers
  //
  // World actions (wake/setTiles/power/spawn) run inside the sim; the say/sfx/
  // hum/shake/LIGHT half rides out on `trigger_fired` for the director. Lines
  // are level data, so rule 7 is this file's problem: third person, ≤7 words per
  // sentence, no subordinate clauses, overconfident.
  //
  // `light` is presentation like `say`. Every target below is a LightPlacement
  // id in `lights`, and a sconce's `_pt` wall-wash companion follows its parent
  // without being named — they are one lamp to anyone looking at the room.
  triggers: [
    // Stepping off the lift plate into the vestibule. The lobby tube is authored
    // at a third: it is on, but it has not committed. The first thing the level
    // teaches is that the room reacts.
    {
      id: 'entry_hail',
      rect: { tx: 4, ty: 5, tw: 4, th: 6 },
      when: 'enter',
      actions: [
        { type: 'light', target: 'tube_lobby', on: true, intensity: 1.25 },
        { type: 'say', line: 'ROBOT IS HERE NOW. ROOM MAY RELAX.' },
        { type: 'hum', level: 0.5 },
      ],
    },
    // Three tiles into the bay: the corner printer was never off.
    //
    // The alarm beat. The bay's two working tubes go out, the alcove spill drops
    // to a rumour, and both strobe housings — which have been sitting at 0.05
    // since the level loaded, dim enough to read as dead plastic — slam to full
    // hazard red at 3 Hz. The room the robot has been driving through for a
    // minute becomes a different room in one frame, and the only thing still
    // lit in the middle of it is the robot.
    {
      id: 'bay_ambush',
      rect: { tx: 12, ty: 6, tw: 3, th: 4 },
      when: 'enter',
      actions: [
        { type: 'wake', target: 'printer_ambush' },
        { type: 'light', target: 'tube_bay_a', on: false },
        { type: 'light', target: 'tube_bay_b', on: false },
        { type: 'light', target: 'cone_alcove', intensity: 0.18 },
        { type: 'light', target: 'strobe_bay_n', on: true, intensity: 1.5 },
        { type: 'light', target: 'strobe_bay_s', on: true, intensity: 1.5 },
        { type: 'sfx', sound: 'alarm', at: { x: 312, y: 152 } }, // at the printer
        { type: 'shake', ms: 450 },
        { type: 'hum', level: 0.85 },
        { type: 'say', line: 'DARK NOW. ROBOT IS NOT SCARED.' },
      ],
    },
    // The switch alcove. Two tiles of wall stop being wall — and the sign over
    // them lights, because a shortcut you cannot see from the far end of a dark
    // bay is a shortcut nobody takes.
    {
      id: 'switch_alcove',
      rect: { tx: 15, ty: 1, tw: 4, th: 2 },
      when: 'enter',
      actions: [
        {
          type: 'setTiles',
          tiles: [
            { tx: 21, ty: 6, solid: false },
            { tx: 21, ty: 7, solid: false },
          ],
        },
        { type: 'light', target: 'acc_exit_b', on: true, intensity: 0.95 },
        { type: 'sfx', sound: 'doors', at: { x: 344, y: 112 } }, // at the shutter
        { type: 'say', line: 'ROBOT PRESSED BUTTON. WALL OBEYED ROBOT.' },
      ],
    },
    // The whole west edge of the east hall, so it fires whichever way in the
    // robot took — through the shutter or the long way round the bottom.
    //
    // The hall's two fittings are authored at a trickle, which is what an
    // unpowered emergency fitting looks like: a filament with just enough on it
    // to prove it exists. Powering elevator B and lighting the hall are the same
    // beat, so they are the same trigger.
    {
      id: 'east_power',
      rect: { tx: 22, ty: 1, tw: 2, th: 14 },
      when: 'enter',
      actions: [
        { type: 'power', target: 'elevB', on: true },
        { type: 'light', target: 'tube_hall', on: true, intensity: 1.15 },
        { type: 'light', target: 'wall_hall', on: true, intensity: 0.55 },
        { type: 'sfx', sound: 'powerup', at: { x: 440, y: 120 } }, // at elevator B
        { type: 'say', line: 'ROBOT WOKE THE LIFT. LIFT IS LOYAL.' },
      ],
    },
    // The chute over the service run. Nothing needed it; it is here because a
    // level that only pays you for solving it is a level nobody pokes at.
    {
      id: 'scrap_chute',
      rect: { tx: 9, ty: 13, tw: 3, th: 2 },
      when: 'enter',
      actions: [
        { type: 'spawn', entity: { id: 'scrap_chute', kind: 'scrap', tx: 12, ty: 13 } },
        { type: 'say', line: 'ROBOT MADE MONEY FALL. ROBOT IS BANK.' },
      ],
    },
  ],

  // ---------------------------------------------------------------- ambience
  sounds: [
    // Over the cable pit, directly under the sparks_box and its accent: the
    // sound and the light that explains it are the same object.
    { id: 'pit_sparks', pos: { x: 200, y: 40 }, sound: 'spark_loop', radiusPx: 90, loop: true, volume: 0.7 },
    // The press, twitching once as the robot comes past it. Re-arms on exit.
    // The pipe_bank at (19.7, 7.5) is the thing that twitched.
    { id: 'press_twitch', pos: { x: 296, y: 120 }, sound: 'servo', radiusPx: 80, loop: false, volume: 0.6 },
  ],

  // ==========================================================================
  // LIT DATA
  // ==========================================================================

  // ------------------------------------------------------------------- decor
  //
  // Density is the whole job: an empty box with four nice props in it still
  // reads as an empty box. Walls are lined at roughly a prop every three tiles,
  // open floor is littered, and the two sightlines carry nothing but flat props.
  //
  // Ids are hand-written here rather than generated, because the trigger table
  // and the fixture table both name them and a renumbered index would silently
  // repoint a light. A prop that carries a light is named after it, `_body`.
  decor: [
    // --- west vestibule: the lift lobby. People clocked in here. -------------
    { id: 'lobby_lockers_a', name: 'locker_row', tx: 2.3, ty: 1.5, foot: [24, 8], reflect: true },
    { id: 'lobby_lockers_b', name: 'locker_row', tx: 6.2, ty: 1.5, foot: [24, 8] },
    { id: 'lobby_rota', name: 'whiteboard', tx: 4.4, ty: 0.9 }, // north wall face
    { id: 'lobby_coats', name: 'coat_rack', tx: 7.5, ty: 1.7, foot: [8, 4] },
    { id: 'lobby_pipes', name: 'pipe_bank', tx: 1.8, ty: 3.6, foot: [20, 8] },
    { id: 'lobby_cooler', name: 'water_cooler', tx: 7.4, ty: 3.4, foot: [8, 5] },
    { id: 'lobby_strip', name: 'floor_strip', tx: 4.5, ty: 9.6 },
    { id: 'lobby_paper', name: 'paper_scatter', tx: 6.6, ty: 10.2 },
    { id: 'lobby_trolley', name: 'trolley', tx: 2.6, ty: 11.4, foot: [18, 6] },
    { id: 'lobby_rubble', name: 'rubble', tx: 4.2, ty: 12.7 },
    { id: 'lobby_shelf', name: 'shelf_unit', tx: 3.2, ty: 14.45, foot: [28, 8], reflect: true },
    { id: 'lobby_boxes', name: 'boxes', tx: 6.2, ty: 14.4, foot: [16, 8] },
    { id: 'acc_exit_a_body', name: 'exit_sign', tx: 8.5, ty: 6.05, ceiling: true },

    // --- cable pit: the only room on this floor that still has full power ----
    { id: 'acc_rack_1_body', name: 'server_rack', tx: 9.4, ty: 1.45, foot: [18, 8], reflect: true },
    { id: 'acc_rack_2_body', name: 'server_rack', tx: 11.0, ty: 1.45, foot: [18, 8], reflect: true },
    { id: 'acc_term_pit_body', name: 'terminal', tx: 13.4, ty: 1.5, foot: [16, 6] },
    { id: 'pit_paper', name: 'paper_scatter', tx: 10.5, ty: 2.6 },
    { id: 'pit_coil', name: 'cable_coil', tx: 9.5, ty: 3.4 },
    { id: 'acc_sparks_body', name: 'sparks_box', tx: 11.5, ty: 3.4, foot: [10, 5] },

    // --- switch alcove: the errand, and the reason for it --------------------
    { id: 'acc_breaker_body', name: 'breaker_panel', tx: 15.4, ty: 1.45, foot: [10, 4] },
    { id: 'acc_term_alcove_body', name: 'terminal', tx: 17.6, ty: 1.5, foot: [16, 6] },
    { id: 'alcove_files', name: 'filing_cabinet', tx: 18.5, ty: 2.4, foot: [12, 6] },
    { id: 'alcove_paper', name: 'paper_scatter', tx: 16.4, ty: 2.5 },

    // --- the bay: a job that stopped halfway through -------------------------
    { id: 'bay_bench', name: 'desk', tx: 15.4, ty: 5.45, foot: [24, 10], reflect: true },
    { id: 'bay_chair', name: 'chair_wreck', tx: 15.2, ty: 6.3 },
    { id: 'bay_pipe_run', name: 'pipe_run', tx: 17.5, ty: 4.05 },
    { id: 'bay_barrel_a', name: 'barrel', tx: 9.6, ty: 6.6, foot: [11, 6], reflect: true },
    { id: 'bay_barrel_b', name: 'barrel', tx: 10.5, ty: 6.9, foot: [11, 6], reflect: true },
    { id: 'bay_crates', name: 'crate_stack', tx: 20.3, ty: 5.4, foot: [18, 8], reflect: true },
    { id: 'bay_tile_fall', name: 'ceiling_tile', tx: 12.0, ty: 9.2 },
    { id: 'bay_puddle', name: 'puddle', tx: 12.4, ty: 9.5 },
    { id: 'bay_rubble', name: 'rubble', tx: 13.2, ty: 8.4 },
    { id: 'bay_coil', name: 'cable_coil', tx: 16.6, ty: 9.6 },
    // The press: what the servo one-shot is coming from, hard against the east
    // wall so it narrows nothing.
    { id: 'bay_press', name: 'pipe_bank', tx: 19.7, ty: 7.5, foot: [20, 8] },
    // The ambush corner. It is the most cluttered ten tiles on the floor on
    // purpose — the printer has to be findable as scenery and forgettable as a
    // threat, and clutter does both.
    // Kept off row 8: that row is the hazard lane and the long sightline, and a
    // desk lying across it reads as a barricade the robot then drives through.
    { id: 'bay_toppled', name: 'desk_toppled', tx: 18.4, ty: 9.6, foot: [22, 10] },
    { id: 'bay_pallet', name: 'pallet', tx: 18.2, ty: 10.6 },
    { id: 'bay_fan', name: 'floor_fan', tx: 9.4, ty: 11.4, foot: [12, 5] },
    { id: 'bay_jobsheet', name: 'whiteboard', tx: 12.5, ty: 11.9 }, // pillar south face
    { id: 'bay_pipe_low', name: 'pipe_run', tx: 10.2, ty: 12.6 },
    { id: 'run_strip', name: 'floor_strip', tx: 11.5, ty: 13.6 },
    { id: 'run_paper', name: 'paper_scatter', tx: 14.6, ty: 13.3 },
    { id: 'run_boxes', name: 'boxes', tx: 17.4, ty: 13.6, foot: [16, 8] },
    { id: 'run_plant', name: 'plant_dead', tx: 20.4, ty: 13.4, foot: [10, 6], reflect: true },
    { id: 'strobe_bay_n_body', name: 'alarm_strobe', tx: 13.5, ty: 7.05, ceiling: true },
    { id: 'strobe_bay_s_body', name: 'alarm_strobe', tx: 19.5, ty: 10.05, ceiling: true },

    // --- east hall: unpowered, and the vending machine does not care ---------
    { id: 'hall_boxes', name: 'boxes', tx: 22.8, ty: 1.45, foot: [16, 8] },
    { id: 'hall_lockers', name: 'locker_row', tx: 25.8, ty: 1.55, foot: [24, 8], reflect: true },
    { id: 'hall_rubble', name: 'rubble', tx: 27.2, ty: 2.6 },
    { id: 'hall_plant', name: 'plant_dead', tx: 28.3, ty: 3.6, foot: [10, 6], reflect: true },
    { id: 'acc_vending_body', name: 'vending', tx: 23.4, ty: 4.5, foot: [16, 8], reflect: true },
    { id: 'hall_cooler', name: 'water_cooler', tx: 22.4, ty: 9.4, foot: [8, 5] },
    { id: 'hall_puddle', name: 'puddle', tx: 25.4, ty: 10.6 },
    { id: 'hall_pipes', name: 'pipe_bank', tx: 28.2, ty: 11.4, foot: [22, 8] },
    { id: 'hall_coil', name: 'cable_coil', tx: 26.6, ty: 12.5 },
    { id: 'hall_barrel', name: 'barrel', tx: 22.5, ty: 13.4, foot: [11, 6], reflect: true },
    { id: 'hall_crates', name: 'crate_stack', tx: 24.4, ty: 14.4, foot: [18, 8], reflect: true },
    { id: 'acc_exit_b_body', name: 'exit_sign', tx: 21.4, ty: 5.7, ceiling: true }, // over the shutter

    // --- wall-mounted fixtures ----------------------------------------------
    //
    // South-facing faces only, all three verified against the map:
    //   (12,5)  bay pillar, floor at (12,6)
    //   (18,12) service-run block, floor at (18,13)
    //   (24,0)  hall north wall, floor at (24,1)
    { id: 'wall_bay_1_body', name: 'wall_lamp', tx: 12.4, ty: 5.62, ceiling: true, fixtureId: 'wall_bay_1', fixtureKind: 'wall' },
    { id: 'wall_run_body', name: 'wall_lamp', tx: 17.9, ty: 12.62, ceiling: true, fixtureId: 'wall_run', fixtureKind: 'wall' },
    { id: 'wall_hall_body', name: 'wall_lamp', tx: 24.4, ty: 0.62, ceiling: true, fixtureId: 'wall_hall', fixtureKind: 'wall' },

    // --- ceiling fixtures, drawn over everything -----------------------------
    { id: 'tube_lobby_body', name: 'ceiling_lamp', tx: 4.5, ty: 7.5, ceiling: true, fixtureId: 'tube_lobby' },
    { id: 'tube_pit_body', name: 'ceiling_lamp', tx: 10.5, ty: 2.5, ceiling: true, fixtureId: 'tube_pit' },
    { id: 'tube_bay_a_body', name: 'ceiling_lamp', tx: 12.5, ty: 7.5, ceiling: true, fixtureId: 'tube_bay_a' },
    { id: 'tube_bay_b_body', name: 'ceiling_lamp', tx: 18.5, ty: 9.5, ceiling: true, fixtureId: 'tube_bay_b' },
    { id: 'tube_dying_body', name: 'ceiling_lamp', tx: 13.5, ty: 13.5, ceiling: true, fixtureId: 'tube_dying' },
    { id: 'tube_hall_body', name: 'ceiling_lamp', tx: 26.5, ty: 7.5, ceiling: true, fixtureId: 'tube_hall' },
  ],

  // ------------------------------------------------------------------ lights
  //
  // ONE diagonal, like the lab room: a bright west end where the robot arrives,
  // a hero over the middle of the bay, and a dark east end where the only lit
  // thing is a vending machine that still has its own supply. The journey of the
  // level is the journey from the bright end to the dark one, and the reward for
  // getting there is turning the lights on.
  //
  // Only the big ones cast. Eight casters (six tubes, the alcove cone, the
  // vending machine) against a budget of twelve; every accent and every sconce
  // is castShadow:false, because a status LED throwing a room-length shadow
  // looks absurd and costs a full-screen bake.
  lights: [
    // --- key: the ceiling grid ----------------------------------------------
    // Lobby: authored at a third and brought to full by `entry_hail`.
    { id: 'tube_lobby', tx: 4.5, ty: 7.5, radius: 150, color: E.key, intensity: 0.38, castShadow: true, flicker: 0.12, flickerHz: 6 },
    // The pit is the one room with real power, and it is COLD — the only blue
    // key in the level, so the pit reads as a different space through a doorway.
    { id: 'tube_pit', tx: 10.5, ty: 2.5, radius: 104, color: E.fill, intensity: 1.05, castShadow: true },
    // The hero. Brightest thing on the floor for exactly as long as it takes the
    // robot to walk three tiles into the bay.
    { id: 'tube_bay_a', tx: 12.5, ty: 7.5, radius: 176, color: E.key, intensity: 1.7, castShadow: true },
    { id: 'tube_bay_b', tx: 18.5, ty: 9.5, radius: 146, color: E.key, intensity: 1.0, castShadow: true },
    // The dying one, over the service run: hard flicker, half intensity. It is
    // the light the chute beat happens under, and it is the reason the long way
    // round feels like the long way round.
    { id: 'tube_dying', tx: 13.5, ty: 13.5, radius: 122, color: E.key, intensity: 0.5, castShadow: true, flicker: 1.2, flickerHz: 12 },
    // The hall. A trickle until `east_power`.
    { id: 'tube_hall', tx: 26.5, ty: 7.5, radius: 152, color: E.key, intensity: 0.06, castShadow: true },

    // --- the alcove doorway spill -------------------------------------------
    // A raking cone thrown out of the switch alcove, down the diagonal into the
    // bay. It grazes the pillar tops and the bench and leaves the floor behind
    // them dark, which is how a dark corner keeps its silhouettes without
    // spending the black point on fill. Dropped to a rumour by the ambush.
    { id: 'cone_alcove', tx: 17.5, ty: 3.5, radius: 150, color: E.key, intensity: 0.6, kind: 'cone', dir: 2.35, spread: 0.55, castShadow: true },

    // --- wall sconces: cone + wall-wash point, one pair each ------------------
    // A sconce's cone starts BELOW the housing and points away, so the housing
    // sits outside its own light and the wall it is bolted to stays black while
    // the floor in front of it blazes. The co-located `_pt` is what washes the
    // wall and the props beside it; `spill` on the FixtureDef scales its radius.
    // They travel together through `setLightState`, so a trigger names the
    // parent and both move.
    { id: 'wall_bay_1', tx: 12.4, ty: 5.9, radius: 66, color: E.key, intensity: 0.5, kind: 'cone', dir: Math.PI / 2, spread: 0.85, castShadow: false },
    { id: 'wall_bay_1_pt', tx: 12.4, ty: 5.7, radius: 48, color: E.key, intensity: 0.55, castShadow: false, volumetric: false },
    { id: 'wall_run', tx: 17.9, ty: 12.9, radius: 62, color: E.key, intensity: 0.45, kind: 'cone', dir: Math.PI / 2, spread: 0.85, castShadow: false, flicker: 0.45, flickerHz: 13 },
    { id: 'wall_run_pt', tx: 17.9, ty: 12.7, radius: 44, color: E.key, intensity: 0.5, castShadow: false, volumetric: false, flicker: 0.45, flickerHz: 13 },
    { id: 'wall_hall', tx: 24.4, ty: 0.9, radius: 64, color: E.fill, intensity: 0.05, kind: 'cone', dir: Math.PI / 2, spread: 0.85, castShadow: false },
    { id: 'wall_hall_pt', tx: 24.4, ty: 0.7, radius: 46, color: E.fill, intensity: 0.05, castShadow: false, volumetric: false },

    // --- accents: cheap, no shadow pass --------------------------------------
    // Every one of these sits on the emissive prop that shares its name (the
    // `_body` half of the pair, one entry up in `decor`). They are what
    // makes "powered technology" a signal in a room where most of the power is
    // out — which is why they are all E.accent/E.screen green-cyan and none of
    // them are the warm sodium the ceiling uses.
    { id: 'acc_rack_1', tx: 9.4, ty: 1.65, radius: 34, color: E.accent, intensity: 0.75, castShadow: false, flicker: 0.5, flickerHz: 14 },
    { id: 'acc_rack_2', tx: 11.0, ty: 1.65, radius: 34, color: E.accent, intensity: 0.75, castShadow: false, flicker: 0.4, flickerHz: 17 },
    { id: 'acc_term_pit', tx: 13.4, ty: 1.6, radius: 40, color: E.screen, intensity: 0.6, castShadow: false, flicker: 0.2, flickerHz: 24 },
    { id: 'acc_sparks', tx: 11.5, ty: 3.3, radius: 58, color: E.fillCore, intensity: 0.8, castShadow: false, flicker: 1.8, flickerHz: 22 },
    { id: 'acc_breaker', tx: 15.4, ty: 1.2, radius: 32, color: E.accent, intensity: 0.6, castShadow: false, flicker: 0.6, flickerHz: 15 },
    { id: 'acc_term_alcove', tx: 17.6, ty: 1.6, radius: 40, color: E.screen, intensity: 0.6, castShadow: false, flicker: 0.2, flickerHz: 21 },
    { id: 'acc_exit_a', tx: 8.5, ty: 6.15, radius: 36, color: E.accent, intensity: 0.6, castShadow: false },
    // Dark until the shutter opens: an exit sign over a welded shutter is a lie.
    { id: 'acc_exit_b', tx: 21.4, ty: 5.8, radius: 36, color: E.accent, intensity: 0.12, castShadow: false },
    // The one thing burning in the east hall before the power lands, and the
    // reason anybody walks over there. It casts, because it is the only source
    // that quarter has and a beacon with no shadows under it reads as a decal.
    { id: 'acc_vending', tx: 23.4, ty: 4.8, radius: 70, color: E.fill, intensity: 0.9, castShadow: true, flicker: 0.15, flickerHz: 6 },
    { id: 'acc_strip_lobby', tx: 4.5, ty: 9.7, radius: 36, color: E.accent, intensity: 0.55, castShadow: false },
    { id: 'acc_strip_run', tx: 11.5, ty: 13.7, radius: 34, color: E.accent, intensity: 0.5, castShadow: false },
    // The alarm. Both idle at 0.05 — dim enough that the housings read as dead
    // plastic — until `bay_ambush` slams them to 1.5.
    { id: 'strobe_bay_n', tx: 13.5, ty: 7.15, radius: 78, color: E.hazard, intensity: 0.05, castShadow: false, flicker: 1.6, flickerHz: 3.2 },
    { id: 'strobe_bay_s', tx: 19.5, ty: 10.15, radius: 78, color: E.hazard, intensity: 0.05, castShadow: false, flicker: 1.6, flickerHz: 3.2 },
  ],

  // --------------------------------------------------------------- fixtures
  //
  // The SPRITE of each lamp, never its light. Four ceiling styles and three wall
  // styles are in play, and the variety is doing a job: a bay that was repaired
  // piecemeal over years has mismatched fittings, and a room where every lamp is
  // the same batten reads as a ceiling grid rather than as a place.
  fixtures: [
    { id: 'tube_lobby', kind: 'ceiling', style: 'tube', scale: 1, glow: 1 },
    { id: 'tube_pit', kind: 'ceiling', style: 'panel', scale: 1, glow: 1.1 }, // recessed: the pit was refitted
    { id: 'tube_bay_a', kind: 'ceiling', style: 'dome', scale: 1.15, glow: 1.1 },
    { id: 'tube_bay_b', kind: 'ceiling', style: 'dome', scale: 1 },
    { id: 'tube_dying', kind: 'ceiling', style: 'tube', scale: 1, bodyAlpha: 0.9, glow: 0.5 },
    { id: 'tube_hall', kind: 'ceiling', style: 'bare', scale: 1, glow: 0.35 }, // a bulb on a cord
    { id: 'wall_bay_1', kind: 'wall', style: 'sconce', mountY: -2.5, lightY: -0.5, spill: 1 },
    { id: 'wall_run', kind: 'wall', style: 'caged', mountY: -3, lightY: -0.5, spill: 1.1 },
    { id: 'wall_hall', kind: 'wall', style: 'strip', mountY: -2, lightY: -0.5, spill: 1.2 },
  ],

  // ------------------------------------------------------------ wet patches
  //
  // Three, and each one has a reason above it. The reflection layer is masked to
  // these ellipses, so a prop only mirrors if it happens to stand in one — which
  // is why `reflect: true` is on the barrels, the lockers and the vending
  // machine and on nothing in the middle of the floor.
  wetPatches: [
    { tx: 12.4, ty: 9.5, rx: 2.8, ry: 1.4 }, // under the fallen ceiling tile
    { tx: 10.0, ty: 7.0, rx: 2.4, ry: 1.2 }, // whatever was in the barrels
    { tx: 25.4, ty: 10.6, rx: 2.6, ry: 1.3 }, // the hall drain, backed up
  ],

  // ------------------------------------------------------------------- look
  //
  // BROWNOUT. Colder and darker than the engine default on every axis that
  // matters: ambient down to 0.15 so the unlit thirds are genuinely unlit, fog
  // up and pushed navy so distance eats the east end, and falloff steepened to
  // 1.7 so the pools die between fittings instead of merging into a lit room.
  // The gain buys back what ambient gave up, so the lit spots are HOTTER than
  // the lab's while the room around them is darker.
  //
  // Reflections are ON, which the engine default is not: this floor authored
  // water and a wet deck that never mirrors anything is a wasted mask.
  //
  // Only keys that differ from LOOK_DEFAULTS are listed — retuning the engine
  // should retune this level everywhere it did not disagree.
  look: {
    ambientLevel: 0.15,
    ambientColor: 0x2f5c96,
    fogColor: 0x172336,
    fogAmount: 0.58,
    lightGain: 1.35,
    lightFalloff: 1.7,
    lightFlicker: 0.3,
    volumeStrength: 0.4,
    volumeLength: 0.7,
    dustAmount: 1.6,
    dustBrightness: 0.55,
    reflectOn: true,
    reflectAlpha: 0.5,
    reflectSquash: 0.5,
    exposure: 1.06,
    contrast: 1.24,
    saturation: 1.2,
    liftColor: 0x142236,
    liftAmount: 0.16,
    gainColor: 0xffd0a0,
    gainAmount: 0.15,
  },

  // ------------------------------------------------------------------ tiles
  //
  // Row 8 is the hazard lane: the one continuous open row from the vestibule
  // door to the east wall, which is also the route the level wants. A lane has
  // to be a LINE — it is a leading line from the lit end to the dark one, not
  // decoration.
  //
  // The overrides are placed, not scattered:
  //   grates  where the water is (both wet patches have a drain under them) and
  //           at the barrel leak
  //   lifted  next to the loose cable coil, and by the fan in the service run —
  //           somebody was under the floor and did not finish
  //   crack   three, on the diagonal, where the pillars load the deck
  //   stain   under the ambush printer, which has been leaking for months, plus
  //           four more spread wide enough not to read as a pattern
  //   stripe  a short contiguous run through the service-run mouth at row 13, so
  //           the long way round is painted as a route rather than found as one
  tiles: {
    walkRows: [8],
    overrides: [
      // drain grates
      { tx: 12, ty: 9, variant: 4 },
      { tx: 13, ty: 9, variant: 4 },
      { tx: 25, ty: 10, variant: 4 },
      { tx: 25, ty: 11, variant: 4 },
      { tx: 10, ty: 7, variant: 4 },
      // lifted panels
      { tx: 17, ty: 9, variant: 5 },
      { tx: 9, ty: 12, variant: 5 },
      // cracks
      { tx: 15, ty: 7, variant: 3 },
      { tx: 19, ty: 6, variant: 3 },
      { tx: 6, ty: 11, variant: 3 },
      // stains
      { tx: 19, ty: 9, variant: 7 },
      { tx: 20, ty: 10, variant: 7 },
      { tx: 3, ty: 10, variant: 7 },
      { tx: 11, ty: 6, variant: 7 },
      { tx: 27, ty: 9, variant: 7 },
      // the painted mouth of the service run
      { tx: 19, ty: 13, variant: 6 },
      { tx: 20, ty: 13, variant: 6 },
      { tx: 21, ty: 13, variant: 6 },
      { tx: 22, ty: 13, variant: 6 },
      { tx: 23, ty: 13, variant: 6 },
    ],
  },
};
