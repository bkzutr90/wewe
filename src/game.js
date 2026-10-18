const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
} = require('discord.js');
const cfg = require('./config');
const { db } = require('./db');
const { ROLES, shuffle, roleSet, checkWin, tally, topOf } = require('./logic');

const EPH = MessageFlags.Ephemeral;
const NO_PING = { parse: [] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mention = (id) => `<@${id}>`;
const inSeconds = (ms) => `<t:${Math.floor((Date.now() + ms) / 1000)}:R>`;

const btn = (id, label, style, emoji, disabled = false) => {
  const b = new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setDisabled(disabled);
  if (emoji) b.setEmoji(emoji);
  return b;
};
const row = (...components) => new ActionRowBuilder().addComponents(...components);
const clearButtons = (msg) => (msg ? msg.edit({ components: [] }).catch(() => {}) : Promise.resolve());

const games = new Map(); // channelId -> Game

const upsertStats = db.prepare(`
  INSERT INTO stats (guild_id, user_id, games, wins, wolf_games, wolf_wins) VALUES (?, ?, 1, ?, ?, ?)
  ON CONFLICT(guild_id, user_id) DO UPDATE SET
    games = games + 1,
    wins = wins + excluded.wins,
    wolf_games = wolf_games + excluded.wolf_games,
    wolf_wins = wolf_wins + excluded.wolf_wins
`);

class Game {
  constructor(channel, hostId, hostName) {
    this.channel = channel;
    this.guildId = channel.guildId;
    this.hostId = hostId;
    this.state = 'lobby'; // lobby | starting | night | resolving | day | discuss | vote | hunter | ended
    this.players = new Map(); // id -> { id, name, role, alive }
    this.round = 0;
    this.ended = false;
    this.lobbyMsg = null;
    this.thread = null;
    this.canThread = true;
    this.phase = null;
    this.night = null;
    this.skip = new Set();
    this.votes = new Map();
    this.voteMsg = null;
    this.lastProtect = null;
    this.hunter = null;
    this._hunterResolve = null;
    this._hunterTimer = null;

    this.players.set(hostId, { id: hostId, name: hostName, role: null, alive: true });
    this.lobbyTimer = setTimeout(() => this.abort('Lobby kedaluwarsa karena tidak dimulai.'), cfg.lobbyMs);
  }

  // ------------------------------------------------------------ helper
  alive() {
    return [...this.players.values()].filter((p) => p.alive);
  }
  aliveWolves() {
    return this.alive().filter((p) => p.role === 'werewolf');
  }
  isManager(i) {
    return i.user.id === this.hostId || Boolean(i.memberPermissions?.has(PermissionFlagsBits.ManageGuild));
  }
  reveal(p) {
    if (!cfg.revealRoles || !p.role) return '';
    return ` Ia adalah ${ROLES[p.role].emoji} **${ROLES[p.role].name}**.`;
  }
  aliveList() {
    return this.alive().map((p) => `• ${mention(p.id)}`).join('\n') || '-';
  }
  embed(title, description) {
    return new EmbedBuilder().setColor(cfg.accent).setTitle(title).setDescription(description);
  }
  send(payload) {
    return this.channel.send({ allowedMentions: NO_PING, ...payload });
  }

  waitPhase(ms) {
    return new Promise((resolve) => {
      this.phase = { resolve, timer: setTimeout(() => this._endPhase(), ms) };
    });
  }
  _endPhase() {
    if (!this.phase) return;
    clearTimeout(this.phase.timer);
    const { resolve } = this.phase;
    this.phase = null;
    resolve();
  }
  _hunterDone() {
    clearTimeout(this._hunterTimer);
    const r = this._hunterResolve;
    this._hunterResolve = null;
    r?.();
  }

  // ------------------------------------------------------------ lobby
  lobbyPayload() {
    const list = [...this.players.values()].map((p, k) => `${k + 1}. ${mention(p.id)}${p.id === this.hostId ? ' 👑' : ''}`).join('\n');
    const embed = this.embed(
      '🐺 Werewolf — Lobby',
      `Host: ${mention(this.hostId)}\n\n**Pemain (${this.players.size}/${cfg.maxPlayers})**\n${list}\n\nMinimal **${cfg.minPlayers}** pemain. Klik **Gabung** untuk ikut. Host menekan **Mulai** kalau sudah siap.`
    );
    if (!this.canThread) {
      embed.setFooter({ text: '⚠️ Bot tidak punya izin Create Private Threads, jadi Werewolf tidak dapat ruang diskusi rahasia.' });
    }
    return {
      embeds: [embed],
      components: [
        row(
          btn('ww:join', 'Gabung', ButtonStyle.Success, '✅'),
          btn('ww:leave', 'Keluar', ButtonStyle.Secondary, '🚪'),
          btn('ww:begin', 'Mulai', ButtonStyle.Primary, '▶️', this.players.size < cfg.minPlayers),
          btn('ww:cancel', 'Batal', ButtonStyle.Danger, '✖️')
        ),
      ],
      allowedMentions: NO_PING,
    };
  }

  async start() {
    clearTimeout(this.lobbyTimer);
    this.state = 'starting';

    const ids = shuffle([...this.players.keys()]);
    const roles = shuffle(roleSet(ids.length));
    ids.forEach((id, k) => {
      this.players.get(id).role = roles[k];
    });

    const counts = {};
    for (const r of roles) counts[r] = (counts[r] || 0) + 1;
    const comp = Object.entries(counts)
      .map(([r, c]) => `${ROLES[r].emoji} ${ROLES[r].name} ×${c}`)
      .join(' • ');

    await this.lobbyMsg?.edit({ embeds: [this.embed('🐺 Werewolf — Dimulai!', `${ids.length} pemain bergabung.`)], components: [] }).catch(() => {});
    await this.createThread();

    await this.send({
      content: ids.map(mention).join(' '),
      allowedMentions: { users: ids },
      embeds: [
        this.embed(
          '🎴 Role sudah dibagikan!',
          `Klik tombol di bawah untuk melihat role-mu (hanya kamu yang bisa melihatnya).\n\n**Komposisi:** ${comp}\n\nPermainan dimulai ${inSeconds(cfg.introMs)}.`
        ),
      ],
      components: [row(btn('ww:role', 'Lihat Role Saya', ButtonStyle.Primary, '👁️'))],
    });
    await sleep(cfg.introMs);
    if (!this.ended) this.run();
  }

  async createThread() {
    const wolves = this.aliveWolves();
    try {
      const t = await this.channel.threads.create({
        name: '🐺 sarang-werewolf',
        type: ChannelType.PrivateThread,
        invitable: false,
        autoArchiveDuration: 60,
        reason: 'Ruang diskusi rahasia Werewolf',
      });
      for (const w of wolves) await t.members.add(w.id);
      await t.send({
        content: `🐺 Selamat datang, Werewolf! Rekanmu: ${wolves.map((w) => mention(w.id)).join(', ')}\nDiskusikan korban di sini. Pilihan resmi tetap lewat tombol **Aksi Malam** di channel utama.`,
        allowedMentions: { users: wolves.map((w) => w.id) },
      });
      this.thread = t;
    } catch (err) {
      console.warn('[werewolf] gagal bikin private thread:', err.message);
      this.thread = null;
    }
  }

  async closeThread(text) {
    if (!this.thread) return;
    const t = this.thread;
    this.thread = null;
    await t.send(text).catch(() => {});
    await t.setArchived(true).catch(() => {});
  }

  // ------------------------------------------------------------ alur game
  async run() {
    try {
      while (!this.ended) {
        await this.nightPhase();
        if (this.ended) return;
        const victim = this.resolveNight();
        await this.dayAnnounce(victim);
        if (this.ended) return;
        if (await this.checkEnd()) return;
        await this.discussPhase();
        if (this.ended) return;
        await this.votePhase();
        if (this.ended) return;
        if (await this.checkEnd()) return;
      }
    } catch (err) {
      console.error('[werewolf] error di game:', err);
      this.abort('Terjadi error internal.');
    }
  }

  async checkEnd() {
    const winner = checkWin(this.players.values());
    if (!winner) return false;
    await this.finish(winner);
    return true;
  }

  // ---- malam
  async nightPhase() {
    this.round++;
    this.state = 'night';
    this.night = { wolfVotes: new Map(), seerDone: false, doctorDone: false, protect: null };

    const msg = await this.send({
      embeds: [
        this.embed(
          `🌙 Malam ke-${this.round}`,
          `Desa tertidur... Semua pemain **hidup** klik **Aksi Malam** (peran biasa pun tetap klik supaya tidak ketahuan).\nPagi tiba ${inSeconds(cfg.nightMs)}.\n\n**Pemain hidup (${this.alive().length}):**\n${this.aliveList()}`
        ),
      ],
      components: [row(btn('ww:night', 'Aksi Malam', ButtonStyle.Primary, '🎭'), btn('ww:role', 'Role Saya', ButtonStyle.Secondary, '👁️'))],
    });
    this.thread?.send(`🌙 Malam ke-${this.round}. Pilih korban lewat tombol **Aksi Malam** di channel utama.`).catch(() => {});

    await this.waitPhase(cfg.nightMs);
    this.state = 'resolving';
    await clearButtons(msg);
  }

  _nightDone() {
    if (this.state !== 'night' || !this.night) return;
    const n = this.night;
    const seer = this.alive().find((p) => p.role === 'seer');
    const doctor = this.alive().find((p) => p.role === 'doctor');
    const wolvesDone = this.aliveWolves().every((w) => n.wolfVotes.has(w.id));
    if (wolvesDone && (!seer || n.seerDone) && (!doctor || n.doctorDone)) this._endPhase();
  }

  resolveNight() {
    const n = this.night;
    const { top } = topOf(tally(n.wolfVotes));
    let victim = top.length ? top[Math.floor(Math.random() * top.length)] : null;
    this.lastProtect = n.doctorDone ? n.protect : null;
    if (victim && victim === n.protect) victim = null;
    return victim;
  }

  // ---- pagi
  async dayAnnounce(victimId) {
    this.state = 'day';
    const v = victimId ? this.players.get(victimId) : null;
    const text = v ? `💀 ${mention(v.id)} ditemukan tewas semalam.${this.reveal(v)}` : '🌅 Pagi tiba. Semalam **tidak ada korban**.';
    await this.send({ embeds: [this.embed(`☀️ Hari ke-${this.round}`, text)] });
    if (v) await this.kill(v.id);
  }

  async discussPhase() {
    this.state = 'discuss';
    this.skip = new Set();
    const need = Math.floor(this.alive().length / 2) + 1;
    const msg = await this.send({
      embeds: [
        this.embed(
          '💬 Diskusi',
          `Cari tahu siapa Werewolf-nya! Voting dimulai ${inSeconds(cfg.dayMs)}.\nKalau sudah yakin, klik **Lanjut Voting** (butuh ${need} pemain untuk mempercepat).\n\n**Pemain hidup (${this.alive().length}):**\n${this.aliveList()}`
        ),
      ],
      components: [row(btn('ww:skip', 'Lanjut Voting', ButtonStyle.Secondary, '⏭️'))],
    });
    await this.waitPhase(cfg.dayMs);
    await clearButtons(msg);
  }

  voteEmbed() {
    return this.embed(
      '🗳️ Voting',
      `Klik **Vote** lalu pilih siapa yang akan digantung. Voting selesai ${inSeconds(cfg.voteMs)} atau saat semua sudah vote.\n\n**Sudah vote:** ${this.votes.size}/${this.alive().length}`
    );
  }

  async votePhase() {
    this.state = 'vote';
    this.votes = new Map();
    this.voteMsg = await this.send({ embeds: [this.voteEmbed()], components: [row(btn('ww:votebtn', 'Vote', ButtonStyle.Primary, '🗳️'))] });
    await this.waitPhase(cfg.voteMs);
    await clearButtons(this.voteMsg);
    this.voteMsg = null;
    this.state = 'resolving';

    const counts = tally(this.votes);
    const { top } = topOf(counts);
    const lines = [...counts]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([t, vs]) => `${t === 'skip' ? '⏭️ Skip' : mention(t)} — **${vs.length}** (${vs.map(mention).join(', ')})`);

    let lynched = null;
    let result;
    if (!lines.length) result = 'Tidak ada yang vote. Tidak ada yang digantung.';
    else if (top.length === 1 && top[0] !== 'skip') {
      lynched = top[0];
      result = `🪢 ${mention(lynched)} digantung oleh warga.${this.reveal(this.players.get(lynched))}`;
    } else if (top.length > 1) result = '⚖️ Suara seri. Tidak ada yang digantung.';
    else result = '⏭️ Warga memilih skip. Tidak ada yang digantung.';

    await this.send({ embeds: [this.embed('📊 Hasil Voting', `${lines.join('\n') || '_Tidak ada suara_'}\n\n${result}`)] });
    if (lynched) await this.kill(lynched);
  }

  // ---- kematian & pemburu
  async kill(id) {
    const p = this.players.get(id);
    if (!p || !p.alive) return;
    p.alive = false;
    if (p.role === 'hunter' && !this.ended) await this.hunterShot(p);
  }

  async hunterShot(hunter) {
    if (!this.alive().length) return;
    const prev = this.state;
    this.state = 'hunter';
    this.hunter = { id: hunter.id, shot: null };

    const msg = await this.send({
      content: mention(hunter.id),
      allowedMentions: { users: [hunter.id] },
      embeds: [this.embed('🏹 Pemburu gugur!', `${mention(hunter.id)} punya ${Math.round(cfg.hunterMs / 1000)} detik untuk menembak satu pemain. Klik **Tembak**.`)],
      components: [row(btn('ww:hunter', 'Tembak', ButtonStyle.Danger, '🏹'))],
    });
    await new Promise((resolve) => {
      this._hunterResolve = resolve;
      this._hunterTimer = setTimeout(() => this._hunterDone(), cfg.hunterMs);
    });
    await clearButtons(msg);

    const shot = this.hunter?.shot;
    this.hunter = null;
    if (this.ended) return;
    this.state = prev;

    const target = shot ? this.players.get(shot) : null;
    if (target?.alive) {
      target.alive = false;
      await this.send({ embeds: [this.embed('🎯 Tembakan Pemburu', `${mention(hunter.id)} menembak ${mention(target.id)}!${this.reveal(target)}`)] });
    } else {
      await this.send({ embeds: [this.embed('⌛ Pemburu', `${mention(hunter.id)} tidak sempat menembak.`)] });
    }
  }

  // ---- akhir
  rosterText() {
    return [...this.players.values()]
      .map((p) => `${ROLES[p.role]?.emoji || '❔'} ${mention(p.id)} — ${ROLES[p.role]?.name || '-'}${p.alive ? '' : ' 💀'}`)
      .join('\n');
  }

  async finish(winner) {
    if (this.ended) return;
    this.ended = true;
    this.state = 'ended';
    games.delete(this.channel.id);
    this._endPhase();
    this._hunterDone();

    const village = winner === 'village';
    await this.send({
      embeds: [
        this.embed(
          village ? '🏆 Warga Menang!' : '🐺 Werewolf Menang!',
          `${village ? 'Semua Werewolf berhasil disingkirkan.' : 'Werewolf menguasai desa.'}\n\n**Daftar role:**\n${this.rosterText()}`
        ),
      ],
    });

    try {
      db.transaction(() => {
        for (const p of this.players.values()) {
          const isWolf = p.role === 'werewolf';
          const won = (isWolf && !village) || (!isWolf && village);
          upsertStats.run(this.guildId, p.id, won ? 1 : 0, isWolf ? 1 : 0, isWolf && won ? 1 : 0);
        }
      })();
    } catch (err) {
      console.warn('[werewolf] gagal simpan statistik:', err.message);
    }
    await this.closeThread('🏁 Game selesai. Thread ini diarsipkan.');
  }

  abort(reason) {
    if (this.ended) return;
    const wasLobby = this.state === 'lobby';
    this.ended = true;
    clearTimeout(this.lobbyTimer);
    games.delete(this.channel.id);
    this._endPhase();
    this._hunterDone();

    if (wasLobby) {
      this.lobbyMsg?.edit({ embeds: [this.embed('🐺 Werewolf — Lobby ditutup', reason)], components: [] }).catch(() => {});
    } else {
      this.send({ embeds: [this.embed('🛑 Game dihentikan', `${reason}${this.players.size && this.round ? `\n\n**Daftar role:**\n${this.rosterText()}` : ''}`)] }).catch(() => {});
    }
    this.closeThread('🛑 Game dihentikan.');
  }

  // ------------------------------------------------------------ interaksi
  async handle(i) {
    const [, action, extra] = i.customId.split(':');
    const me = this.players.get(i.user.id);
    const deny = (content) => i.reply({ content, flags: EPH });

    // ---- lobby
    if (['join', 'leave', 'begin', 'cancel'].includes(action)) {
      if (this.state !== 'lobby') return deny('❌ Game sudah dimulai atau selesai.');
      if (action === 'join') {
        if (me) return deny('Kamu sudah ikut.');
        if (this.players.size >= cfg.maxPlayers) return deny('❌ Lobby penuh.');
        this.players.set(i.user.id, { id: i.user.id, name: i.member?.displayName || i.user.username, role: null, alive: true });
        return i.update(this.lobbyPayload());
      }
      if (action === 'leave') {
        if (!me) return deny('Kamu belum ikut.');
        if (i.user.id === this.hostId) return deny('Host tidak bisa keluar. Pakai **Batal** untuk menutup lobby.');
        this.players.delete(i.user.id);
        return i.update(this.lobbyPayload());
      }
      if (!this.isManager(i)) return deny('❌ Hanya host yang bisa melakukan ini.');
      if (action === 'cancel') {
        await i.deferUpdate();
        return this.abort(`Lobby dibatalkan oleh ${i.user}.`);
      }
      if (this.players.size < cfg.minPlayers) return deny(`❌ Minimal ${cfg.minPlayers} pemain.`);
      await i.deferUpdate();
      return this.start();
    }

    // ---- lihat role
    if (action === 'role') {
      if (!me?.role) return deny('Kamu tidak ikut game ini.');
      const r = ROLES[me.role];
      let text = `${r.emoji} Role kamu: **${r.name}**\n${r.desc}`;
      if (me.role === 'werewolf') {
        const mates = [...this.players.values()].filter((p) => p.role === 'werewolf' && p.id !== me.id);
        text += `\n\n🐺 Rekanmu: ${mates.map((m) => mention(m.id)).join(', ') || '_tidak ada, kamu sendirian_'}`;
        if (this.thread) text += `\nDiskusi rahasia: ${this.thread}`;
      }
      if (!me.alive) text += '\n\n💀 Kamu sudah mati.';
      return deny(text);
    }

    // ---- aksi malam
    if (action === 'night') {
      if (this.state !== 'night') return deny('❌ Bukan waktu aksi malam.');
      if (!me) return deny('Kamu tidak ikut game ini.');
      if (!me.alive) return deny('💀 Kamu sudah mati.');
      const kind = { werewolf: 'wolf', seer: 'seer', doctor: 'doctor' }[me.role] || 'decoy';
      if ((kind === 'seer' && this.night.seerDone) || (kind === 'doctor' && this.night.doctorDone)) {
        return deny('✅ Aksimu malam ini sudah dilakukan. Tunggu pagi.');
      }
      let options;
      if (kind === 'wolf') options = this.alive().filter((p) => p.role !== 'werewolf');
      else if (kind === 'doctor') options = this.alive().filter((p) => p.id !== this.lastProtect);
      else options = this.alive().filter((p) => p.id !== me.id);
      if (!options.length) return deny('Tidak ada target yang bisa dipilih.');
      const menu = new StringSelectMenuBuilder()
        .setCustomId(`ww:nsel:${kind}`)
        .setPlaceholder('Pilih pemain...')
        .addOptions(options.map((p) => ({ label: p.name.slice(0, 100), value: p.id })));
      return i.reply({ content: '🌙 Pilih targetmu malam ini.', components: [row(menu)], flags: EPH });
    }

    if (action === 'nsel') {
      if (this.state !== 'night') return i.update({ content: '⌛ Malam sudah berakhir.', components: [] });
      if (!me?.alive) return i.update({ content: '💀 Kamu tidak bisa beraksi.', components: [] });
      const expected = { werewolf: 'wolf', seer: 'seer', doctor: 'doctor' }[me.role] || 'decoy';
      const target = this.players.get(i.values[0]);
      if (extra !== expected || !target?.alive) return i.update({ content: '❌ Pilihan tidak valid.', components: [] });
      const n = this.night;

      if (expected === 'wolf') {
        if (target.role === 'werewolf') return i.update({ content: '❌ Tidak bisa memangsa sesama Werewolf.', components: [] });
        n.wolfVotes.set(me.id, target.id);
        this.thread?.send({ content: `🗳️ ${mention(me.id)} memilih ${mention(target.id)}.`, allowedMentions: NO_PING }).catch(() => {});
        await i.update({ content: `🐺 Kamu memilih memangsa **${target.name}**. (Bisa diubah dengan klik Aksi Malam lagi.)`, components: [] });
      } else if (expected === 'seer') {
        if (n.seerDone) return i.update({ content: '✅ Kamu sudah menerawang malam ini.', components: [] });
        n.seerDone = true;
        const isWolf = target.role === 'werewolf';
        await i.update({ content: `🔮 **${target.name}** ${isWolf ? 'adalah 🐺 **Werewolf**!' : 'adalah 😇 **bukan Werewolf**.'}`, components: [] });
      } else if (expected === 'doctor') {
        if (n.doctorDone) return i.update({ content: '✅ Kamu sudah melindungi seseorang malam ini.', components: [] });
        if (target.id === this.lastProtect) return i.update({ content: '❌ Tidak boleh melindungi orang yang sama dua malam berturut-turut.', components: [] });
        n.doctorDone = true;
        n.protect = target.id;
        await i.update({ content: `🩺 Kamu melindungi **${target.name}** malam ini.`, components: [] });
      } else {
        await i.update({ content: `😴 Kamu memilih **${target.name}**, tapi tidak terjadi apa-apa. Kembali tidur.`, components: [] });
      }
      return this._nightDone();
    }

    // ---- lanjut voting (skip diskusi)
    if (action === 'skip') {
      if (this.state !== 'discuss') return deny('❌ Bukan waktu diskusi.');
      if (!me?.alive) return deny('Hanya pemain hidup yang bisa.');
      this.skip.add(me.id);
      const need = Math.floor(this.alive().length / 2) + 1;
      await i.reply({ content: `⏭️ Kamu setuju lanjut ke voting (${this.skip.size}/${need}).`, flags: EPH });
      if (this.skip.size >= need) this._endPhase();
      return;
    }

    // ---- voting
    if (action === 'votebtn') {
      if (this.state !== 'vote') return deny('❌ Voting sudah selesai.');
      if (!me?.alive) return deny('Hanya pemain hidup yang bisa vote.');
      const options = this.alive().filter((p) => p.id !== me.id).map((p) => ({ label: p.name.slice(0, 100), value: p.id }));
      options.push({ label: 'Skip (tidak ada yang digantung)', value: 'skip', emoji: '⏭️' });
      const menu = new StringSelectMenuBuilder().setCustomId('ww:vsel').setPlaceholder('Pilih siapa yang digantung...').addOptions(options);
      return i.reply({ content: '🗳️ Pilih pemain yang menurutmu Werewolf.', components: [row(menu)], flags: EPH });
    }

    if (action === 'vsel') {
      if (this.state !== 'vote') return i.update({ content: '⌛ Voting sudah selesai.', components: [] });
      if (!me?.alive) return i.update({ content: '💀 Kamu tidak bisa vote.', components: [] });
      const value = i.values[0];
      const target = value === 'skip' ? null : this.players.get(value);
      if (value !== 'skip' && (!target?.alive || target.id === me.id)) return i.update({ content: '❌ Pilihan tidak valid.', components: [] });
      this.votes.set(me.id, value);
      await i.update({ content: `✅ Votemu: ${target ? `**${target.name}**` : '**Skip**'}. (Bisa diubah dengan klik Vote lagi.)`, components: [] });
      this.voteMsg?.edit({ embeds: [this.voteEmbed()] }).catch(() => {});
      if (this.votes.size >= this.alive().length) this._endPhase();
      return;
    }

    // ---- pemburu
    if (action === 'hunter') {
      if (this.state !== 'hunter' || !this.hunter || i.user.id !== this.hunter.id) return deny('❌ Ini bukan giliranmu.');
      const options = this.alive().map((p) => ({ label: p.name.slice(0, 100), value: p.id }));
      if (!options.length) return deny('Tidak ada target.');
      const menu = new StringSelectMenuBuilder().setCustomId('ww:hsel').setPlaceholder('Pilih target tembakan...').addOptions(options);
      return i.reply({ content: '🏹 Siapa yang akan kamu tembak?', components: [row(menu)], flags: EPH });
    }

    if (action === 'hsel') {
      if (this.state !== 'hunter' || !this.hunter || i.user.id !== this.hunter.id) return i.update({ content: '⌛ Waktu menembak sudah habis.', components: [] });
      const target = this.players.get(i.values[0]);
      if (!target?.alive) return i.update({ content: '❌ Target tidak valid.', components: [] });
      this.hunter.shot = target.id;
      await i.update({ content: `🎯 Tembakan ke **${target.name}** terkirim.`, components: [] });
      return this._hunterDone();
    }
  }
}

// ------------------------------------------------------------------ API
const getGame = (channelId) => games.get(channelId) || null;

async function createLobby(i, { canThread = true } = {}) {
  const g = new Game(i.channel, i.user.id, i.member?.displayName || i.user.username);
  g.canThread = canThread;
  games.set(i.channelId, g);
  try {
    g.lobbyMsg = await i.channel.send(g.lobbyPayload());
  } catch (err) {
    clearTimeout(g.lobbyTimer);
    games.delete(i.channelId);
    throw err;
  }
  return g;
}

// Return true kalau interaksi ini milik Werewolf (customId diawali "ww:")
async function handleInteraction(i) {
  if (!i.customId?.startsWith('ww:')) return false;
  const g = games.get(i.channelId);
  if (!g) {
    await i.reply({ content: '❌ Game ini sudah selesai atau tidak ditemukan.', flags: EPH }).catch(() => {});
    return true;
  }
  await g.handle(i);
  return true;
}

module.exports = { createLobby, handleInteraction, getGame };
