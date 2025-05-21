require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionsBitField
} = require('discord.js');
const express = require('express');
const fs = require('fs-extra');
const app = express();

const TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const PORT = process.env.PORT || 3000;

const KEYS_FILE = './keys.json';
let issuedKeys = {};

async function loadKeys() {
  if (await fs.pathExists(KEYS_FILE)) {
    issuedKeys = await fs.readJson(KEYS_FILE);
  } else {
    issuedKeys = {};
  }
}

async function saveKeys() {
  await fs.writeJson(KEYS_FILE, issuedKeys, { spaces: 2 });
}

function generateKey() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let key = 'RBX-';
  for (let i = 0; i < 8; i++) {
    key += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return key;
}

// --- API Endpoint ---
app.get('/validate', async (req, res) => {
  const { key, hwid } = req.query;
  if (!key || !hwid) return res.status(400).send('Missing parameters');

  await loadKeys();
  const entry = Object.values(issuedKeys).find(k => k.key === key);
  if (!entry) return res.status(403).send('Invalid');
  if (Date.now() > new Date(entry.expiresAt).getTime()) return res.status(403).send('Expired');

  // HWID Check
  if (!entry.hwid) {
    entry.hwid = hwid;
  } else if (entry.hwid !== hwid) {
    return res.status(403).send('BoundToAnotherHWID');
  }

  await saveKeys();
  return res.send('Valid');
});

app.listen(PORT, () => {
  console.log(`API running on port ${PORT}`);
});

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  await registerCommands();
});

const rest = new REST({ version: '10' }).setToken(TOKEN);

const commands = [
  new SlashCommandBuilder().setName('genkey').setDescription('Generate a new HWID key'),
  new SlashCommandBuilder()
    .setName('revoke')
    .setDescription('Revoke a key')
    .addStringOption(opt => opt.setName('key').setDescription('Key to revoke').setRequired(true)),
  new SlashCommandBuilder().setName('listkeys').setDescription('List all keys'),
  new SlashCommandBuilder()
    .setName('resethwid')
    .setDescription('Reset HWID of a key')
    .addStringOption(opt => opt.setName('key').setDescription('Your key').setRequired(true))
];

async function registerCommands() {
  const appId = (await client.application.fetch()).id;
  await rest.put(Routes.applicationGuildCommands(appId, GUILD_ID), {
    body: commands.map(c => c.toJSON())
  });
  console.log('✅ Slash commands registered.');
}

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName, user } = interaction;
  await loadKeys();

  // --- /genkey ---
  if (commandName === 'genkey') {
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return interaction.reply({ content: '❌ No permission.', ephemeral: true });
    }

    const key = generateKey();
    issuedKeys[key] = {
      key,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
      hwid: null,
      lastReset: null
    };

    await saveKeys();

    const embed = new EmbedBuilder()
      .setTitle('🔑 Key Generated')
      .addFields(
        { name: 'Key', value: `\`${key}\`` },
        { name: 'Expires', value: '3 days' },
        { name: 'Usage', value: '∞ (unlimited)' }
      )
      .setColor(0x57F287)
      .setTimestamp();

    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  // --- /revoke ---
  if (commandName === 'revoke') {
    const key = interaction.options.getString('key');
    if (!issuedKeys[key]) {
      return interaction.reply({ content: '❌ Key not found.', ephemeral: true });
    }
    delete issuedKeys[key];
    await saveKeys();

    const embed = new EmbedBuilder()
      .setTitle('🗑️ Key Revoked')
      .setDescription(`\`${key}\` has been removed.`)
      .setColor(0xED4245);

    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  // --- /listkeys ---
  if (commandName === 'listkeys') {
    const entries = Object.values(issuedKeys);
    if (entries.length === 0) {
      return interaction.reply({ content: 'No keys available.', ephemeral: true });
    }

    const embed = new EmbedBuilder()
      .setTitle('🧾 Issued Keys')
      .setDescription(
        entries.map(k =>
          `\`${k.key}\` | Expires: <t:${Math.floor(new Date(k.expiresAt).getTime() / 1000)}:R> | HWID: ${k.hwid ? '✅' : '❌'}`
        ).join('\n')
      )
      .setColor(0x3498DB);

    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  // --- /resethwid ---
  if (commandName === 'resethwid') {
    const key = interaction.options.getString('key');
    const entry = issuedKeys[key];

    if (!entry) return interaction.reply({ content: '❌ Key not found.', ephemeral: true });

    const now = Date.now();
    if (entry.lastReset && now - new Date(entry.lastReset).getTime() < 12 * 60 * 60 * 1000) {
      return interaction.reply({ content: '⏳ You can only reset HWID once every 12 hours.', ephemeral: true });
    }

    entry.hwid = null;
    entry.lastReset = new Date().toISOString();
    await saveKeys();

    const embed = new EmbedBuilder()
      .setTitle('♻️ HWID Reset')
      .setDescription(`HWID for \`${key}\` has been cleared.`)
      .setColor(0xF1C40F);

    return interaction.reply({ embeds: [embed], ephemeral: true });
  }
});

client.login(TOKEN);
