const { SlashCommandBuilder, EmbedBuilder, ChannelType, MessageFlags, PermissionFlagsBits } = require('discord.js');
const cfg = require('./config');
const { db } = require('./db');
const { ROLES } = require('./logic');
const { createLobby, getGame } = require('./game');

const EPH = MessageFlags.Ephemeral;
const NO_PING = { parse: [] };

const commands = new Map();
const def = (data, execute) => commands.set(data.name, { data, execute });

def(
  new SlashCommandBuilder()
    .setName('werewolf')
    .setDescription('Main game Werewolf bareng teman-teman')
    .setContexts(0) // hanya di server
    .setIntegrationTypes(0) // hanya guild install
    .addSubcommand((s) => s.setName('start').setDescription('Buat lobby Werewolf di channel ini'))
    .addSubcommand((s) => s.setName('stop').setDescription('Hentikan game yang sedang berjalan di channel ini (host / Manage Server)'))
    .addSubcommand((s) => s.setName('rules').setDescription('Lihat aturan dan daftar role'))
    .addSubcommand((s) =>
      s
        .setName('stats')
        .setDescription('Lihat statistik Werewolf')
        .addUserOption((o) => o.setName('user').setDescription('Pemain (kosong = kamu)'))
    )
    .addSubcommand((s) => s.setName('top').setDescription('Leaderboard Werewolf server ini')),
  async (i) => {
    if (!i.guildId) return i.reply({ content: '❌ Command ini hanya bisa dipakai di server.', flags: EPH });
    const sub = i.options.getSubcommand();

    // ------------------------------------------------ start
    if (sub === 'start') {
      if (i.channel?.type !== ChannelType.GuildText) {
        return i.reply({ content: '❌ Pakai command ini di channel teks biasa (bukan thread / forum).', flags: EPH });
      }
      if (getGame(i.channelId)) return i.reply({ content: '❌ Sudah ada game/lobby di channel ini. Pakai `/werewolf stop` kalau mau menghentikannya.', flags: EPH });

      const perms = i.channel.permissionsFor(i.guild.members.me);
      const missing = ['ViewChannel', 'SendMessages', 'EmbedLinks'].filter((p) => !perms?.has(p));
      if (missing.length) return i.reply({ content: `❌ Bot kekurangan izin di channel ini: ${missing.join(', ')}`, flags: EPH });
      const canThread = Boolean(perms.has('CreatePrivateThreads') && perms.has('SendMessagesInThreads'));

      await createLobby(i, { canThread });
      return i.reply({ content: '✅ Lobby dibuat. Ajak temanmu klik **Gabung**!', flags: EPH });
    }

    // ------------------------------------------------ stop
    if (sub === 'stop') {
      const g = getGame(i.channelId);
      if (!g) return i.reply({ content: '❌ Tidak ada game di channel ini.', flags: EPH });
      if (!g.isManager(i)) return i.reply({ content: '❌ Hanya host atau yang punya izin Manage Server yang bisa menghentikan game.', flags: EPH });
      g.abort(`Dihentikan oleh ${i.user}.`);
      return i.reply({ content: '🛑 Game dihentikan.', flags: EPH });
    }

    // ------------------------------------------------ rules
    if (sub === 'rules') {
      const roles = Object.values(ROLES)
        .map((r) => `${r.emoji} **${r.name}**: ${r.desc}`)
        .join('\n');
      const embed = new EmbedBuilder()
        .setColor(cfg.accent)
        .setTitle('🐺 Aturan Werewolf')
        .setDescription(
          [
            `Minimal **${cfg.minPlayers}** pemain, maksimal **${cfg.maxPlayers}**. Bot membagikan role secara rahasia.`,
            '',
            '**Alur permainan**',
            '🌙 **Malam**: tiap pemain klik **Aksi Malam**. Werewolf memilih korban, Seer menerawang, Dokter melindungi. Warga biasa tetap klik (aksinya tidak berpengaruh).',
            '☀️ **Pagi**: korban diumumkan, lalu semua berdiskusi di channel.',
            '🗳️ **Voting**: pemain hidup memilih siapa yang digantung. Suara seri atau Skip = tidak ada yang digantung.',
            '',
            '**Menang**',
            '🏆 Warga menang kalau semua Werewolf mati.',
            '🐺 Werewolf menang kalau jumlahnya sama dengan atau lebih banyak dari pemain lain.',
            '',
            '**Role**',
            roles,
            '',
            '**Etika**: pemain yang sudah mati tidak boleh membocorkan informasi lewat chat. Jangan tunjukkan layar role-mu ke orang lain.',
          ].join('\n')
        );
      return i.reply({ embeds: [embed], flags: EPH });
    }

    // ------------------------------------------------ stats
    if (sub === 'stats') {
      const user = i.options.getUser('user') || i.user;
      const s = db.prepare('SELECT games, wins, wolf_games, wolf_wins FROM stats WHERE guild_id=? AND user_id=?').get(i.guildId, user.id);
      if (!s) return i.reply({ content: `${user} belum pernah main Werewolf di server ini.`, flags: EPH, allowedMentions: NO_PING });
      const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
      const embed = new EmbedBuilder()
        .setColor(cfg.accent)
        .setTitle(`📊 Statistik ${user.displayName || user.username}`)
        .addFields(
          { name: 'Total main', value: String(s.games), inline: true },
          { name: 'Menang', value: `${s.wins} (${pct(s.wins, s.games)}%)`, inline: true },
          { name: 'Jadi Werewolf', value: `${s.wolf_games}× • menang ${s.wolf_wins}`, inline: true }
        );
      return i.reply({ embeds: [embed], flags: EPH });
    }

    // ------------------------------------------------ top
    const rows = db.prepare('SELECT user_id, games, wins FROM stats WHERE guild_id=? ORDER BY wins DESC, games ASC LIMIT 10').all(i.guildId);
    const medal = ['🥇', '🥈', '🥉'];
    const lines = rows.map((r, k) => `${medal[k] || `**${k + 1}.**`} <@${r.user_id}> — **${r.wins}** menang dari ${r.games} game`);
    const embed = new EmbedBuilder()
      .setColor(cfg.accent)
      .setTitle('🏆 Leaderboard Werewolf')
      .setDescription(lines.join('\n') || '_Belum ada data. Ayo main dulu!_');
    return i.reply({ embeds: [embed], allowedMentions: NO_PING });
  }
);

module.exports = { commands };
