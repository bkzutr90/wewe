require('dotenv').config();
const path = require('path');

const num = (v, d) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);

module.exports = {
  token: process.env.DISCORD_TOKEN,
  guildId: process.env.GUILD_ID || null,
  dataDir: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),
  accent: 0x6c5ce7,

  minPlayers: Math.max(3, num(process.env.MIN_PLAYERS, 5)),
  maxPlayers: Math.min(24, num(process.env.MAX_PLAYERS, 20)), // batas menu pilihan Discord = 25
  nightMs: num(process.env.NIGHT_SECONDS, 60) * 1000,
  dayMs: num(process.env.DAY_SECONDS, 90) * 1000,
  voteMs: num(process.env.VOTE_SECONDS, 45) * 1000,
  hunterMs: num(process.env.HUNTER_SECONDS, 30) * 1000,
  lobbyMs: num(process.env.LOBBY_MINUTES, 10) * 60_000,
  introMs: num(process.env.INTRO_SECONDS, 6) * 1000,
  revealRoles: process.env.REVEAL_ROLES !== '0',
};
