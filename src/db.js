const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const cfg = require('./config');

fs.mkdirSync(cfg.dataDir, { recursive: true });
const dbPath = path.join(cfg.dataDir, 'werewolf.db');
const isNewDb = !fs.existsSync(dbPath);
const db = new Database(dbPath);
console.log(`[db] ${dbPath} (${isNewDb ? 'database BARU' : 'database lama dipakai'})`);
if (isNewDb && process.env.RAILWAY_ENVIRONMENT && !process.env.DATA_DIR) {
  console.warn('[db] PERINGATAN: DATA_DIR belum diisi di Railway. Statistik akan hilang tiap redeploy. Pasang Volume di /data dan set DATA_DIR=/data.');
}
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS stats (
    guild_id   TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    games      INTEGER NOT NULL DEFAULT 0,
    wins       INTEGER NOT NULL DEFAULT 0,
    wolf_games INTEGER NOT NULL DEFAULT 0,
    wolf_wins  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_stats_wins ON stats (guild_id, wins DESC);
`);

module.exports = { db };
