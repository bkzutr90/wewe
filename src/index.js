const { Client, GatewayIntentBits, MessageFlags, REST, Routes } = require('discord.js');
const cfg = require('./config');
const { commands } = require('./commands');
const { handleInteraction } = require('./game');

if (!cfg.token) {
  console.error('DISCORD_TOKEN wajib diisi (Variables di Railway / .env)');
  process.exit(1);
}

// Semua interaksi lewat slash command dan tombol, jadi hanya butuh intent Guilds.
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

async function registerCommands(clientId) {
  try {
    const body = [...commands.values()].map((c) => c.data.toJSON());
    const rest = new REST({ version: '10' }).setToken(cfg.token);
    const route = cfg.guildId ? Routes.applicationGuildCommands(clientId, cfg.guildId) : Routes.applicationCommands(clientId);
    await rest.put(route, { body });
    console.log(`✅ ${body.length} command terdaftar (${cfg.guildId ? `server ${cfg.guildId} (mode test)` : 'global, semua server'})`);
  } catch (err) {
    console.error('[register] gagal daftar command:', err);
  }
}

client.once('clientReady', async () => {
  console.log(`🔥 Online sebagai ${client.user.tag} di ${client.guilds.cache.size} server`);
  await registerCommands(client.user.id);
});

client.on('interactionCreate', async (i) => {
  try {
    if (i.isChatInputCommand()) {
      const cmd = commands.get(i.commandName);
      if (cmd) await cmd.execute(i, client);
      return;
    }
    if (i.isButton() || i.isStringSelectMenu()) {
      await handleInteraction(i);
    }
  } catch (err) {
    console.error('[interaction] error:', err);
    const msg = '❌ Terjadi error. Coba lagi sebentar lagi.';
    try {
      if (i.deferred || i.replied) await i.followUp({ content: msg, flags: MessageFlags.Ephemeral });
      else await i.reply({ content: msg, flags: MessageFlags.Ephemeral });
    } catch {}
  }
});

process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));

client.login(cfg.token);
