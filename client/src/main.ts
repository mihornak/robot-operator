/**
 * Entry point. Boots the director, which owns everything.
 * Kept tiny on purpose — game/director.ts is the only wiring point.
 */

import { startGame } from './game/director';

const host = document.getElementById('app');
if (!host) throw new Error('missing #app');
void startGame(host);
