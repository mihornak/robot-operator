/**
 * The pregenerated voice bank. Every FIXED robot line lives here; lines that
 * embed the robot's name are realtime-TTS'd (fallback: caption-only).
 *
 * Toddler-speak bible (CLAUDE.md rule 7): third person, ≤7 words, no
 * subordinate clauses, overconfident never sad, misapplied abstractions.
 * Files: /assets/voice/<id>.mp3 (scripts/genVoiceBank.ts).
 */

export interface BankLine {
  id: string;
  text: string;
}

export const VOICE_BANK: BankLine[] = [
  // --- wake / naming (beat 1) ---
  { id: 'wake_hello', text: 'Hello? … You are voice?' },
  { id: 'wake_sleep', text: 'Robot was sleeping.' },
  { id: 'wake_name_ask', text: 'Robot has no name. Voice gives name?' },
  { id: 'wake_self_name', text: 'Robot names robot: Robot.' },
  { id: 'what_do', text: 'What robot do?' },

  // --- waiting idles ---
  { id: 'idle_here', text: 'Robot still here.' },
  { id: 'idle_waiting', text: 'Robot practices waiting. Robot is good at it.' },
  { id: 'idle_spin', text: 'Robot spins. For reasons.' },
  { id: 'idle_guard', text: 'Robot guards this spot. Spot is safe.' },
  { id: 'idle_hum', text: 'Hmm hmm hmm. Hm.' },

  // --- walls & driving ---
  { id: 'walk_claim', text: 'Robot is walking.' },
  { id: 'wall_rude', text: 'Wall is rude.' },
  { id: 'wall_again', text: 'Wall again. Walls are everywhere.' },
  { id: 'wall_meant', text: 'Robot meant that.' },
  { id: 'wall_move', text: 'Wall does not move. Robot respects that.' },
  { id: 'go_go', text: 'Robot goes. Robot is going.' },
  { id: 'stop_ok', text: 'Robot stops. Stopping is easy.' },

  // --- scrap / pickups ---
  { id: 'scrap_shiny', text: 'Robot found shiny. Robot keeps.' },
  { id: 'scrap_more', text: 'More shiny. Robot is rich.' },

  // --- elevators / floors ---
  { id: 'elev_tired', text: 'Elevator says no more. Elevator is tired.' },
  { id: 'elev_up', text: 'Robot goes up. Up is good.' },
  { id: 'elev_other', text: 'Other elevator. Robot finds it.' },
  { id: 'forgot_gag', text: 'Who is…? … Oh. Is robot.' },

  // --- triads / ceremonies ---
  { id: 'crate_magnet', text: 'Crate says… magnet.' },
  { id: 'crate_rage', text: 'Crate says… rage.' },
  { id: 'crate_scared', text: 'Crate says… scared.' },
  { id: 'crate_memory', text: 'Crate says… memory.' },
  { id: 'crate_zap', text: 'Crate says… zap.' },
  { id: 'crate_tough', text: 'Crate says… tough.' },
  { id: 'crate_which', text: 'Which?' },
  { id: 'crate_again', text: 'Robot reads again. Listen better.' },
  { id: 'install_magnet', text: 'Shiny things come to robot now.' },
  { id: 'install_rage', text: 'Robot feels spicy inside.' },
  { id: 'install_scared', text: 'Robot is fast now. For running away.' },
  { id: 'install_memory', text: 'Robot remembers things now. All the things.' },
  { id: 'install_zap', text: 'More pew pew. Robot approves.' },
  { id: 'install_tough', text: 'Robot is tough now. Hit robot. No wait.' },
  { id: 'pick_taste', text: 'Robot picks. Robot has taste.' },

  // --- hazards / combat ---
  { id: 'floor_spicy', text: 'Floor is spicy.' },
  { id: 'floor_bit', text: 'Floor bit robot. Rude floor.' },
  { id: 'new_ears', text: 'New ears! Robot understands things now.' },
  { id: 'say_thing', text: 'Say thing, robot go thing.' },
  { id: 'enemy_spot', text: 'Machine is angry. Robot fixes it.' },
  { id: 'enemy_dead', text: 'Machine sleeps now. Forever.' },
  { id: 'wrong_target', text: 'Robot shot wrong thing. Thing deserved it.' },
  { id: 'ouch', text: 'Ow. Robot is fine. Mostly fine.' },
  { id: 'low_hp', text: 'Robot is leaking. Is fine.' },
  { id: 'pew', text: 'Pew pew.' },
  { id: 'flee', text: 'Robot leaves now. Fast. Bye.' },

  // --- carry / fuse (floor 4) ---
  { id: 'fuse_grab', text: 'Robot carries. No pew pew now.' },
  { id: 'fuse_need', text: 'Door wants fuse. Robot saw fuse somewhere.' },
  { id: 'fuse_in', text: 'Fuse goes in. Robot is electrician.' },
  { id: 'cant_shoot', text: 'Hands are full. Robot has no hands.' },

  // --- parser / mic trouble ---
  { id: 'mumbly', text: 'Voice is mumbly. Again?' },
  { id: 'teletype', text: 'Type on teletype. Robot reads good.' },
  { id: 'sulk', text: 'Voice is mean. Robot sulks now.' },
  { id: 'praise', text: 'Robot knows. Robot is great.' },
  { id: 'refuse', text: 'No. Robot does not want.' },

  // --- death / restart ---
  { id: 'death_regret_none', text: 'Robot regrets nothing.' },
  { id: 'death_regret_all', text: 'Robot regrets one thing: everything.' },
  { id: 'death_elevator', text: 'Tell elevator… robot tried.' },
  { id: 'death_dark', text: 'Robot takes small nap now.' },
  { id: 'back_again', text: 'Robot is back. Robot remembers nothing. What robot do?' },

  // --- cliffhanger (beat 6) ---
  { id: 'cliff_voice1', text: '…Voice? … It is dark here.' },
  { id: 'cliff_voice2', text: 'Robot is not scared.' },
  { id: 'cliff_voice3', text: '…Voice?' },
];

export const BANK_BY_ID: Record<string, BankLine> = Object.fromEntries(
  VOICE_BANK.map((l) => [l.id, l]),
);

/** Random-variant groups the director rolls from (presentation rng, not sim). */
export const LINE_GROUPS = {
  wallBump: ['wall_rude', 'wall_again', 'wall_meant', 'wall_move'],
  idle: ['idle_here', 'idle_waiting', 'idle_spin', 'idle_guard', 'idle_hum'],
  scrap: ['scrap_shiny', 'scrap_more'],
  deathWords: ['death_regret_none', 'death_regret_all', 'death_elevator', 'death_dark'],
  hurt: ['ouch', 'floor_bit'],
} as const;
