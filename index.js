require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, PermissionsBitField } = require('discord.js');
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

// Cooldown tracking for /resetroblox per user
const resetCooldownMs = 24 * 60 * 60 * 1000; // 1 day cooldown

// Express API for validating keys
app.get('/validate', async (req, res) => {
  const { key, robloxId, robloxUsername } = req.query;
  if (!key || !robloxId || !robloxUsername) return res.status(400).send('Missing parameters');

  await loadKeys();
  const entry = Object.values(issuedKeys).find(k => k.key === key);

  if (!entry) return res.status(403).send('Invalid');
  if (Date.now() > new Date(entry.expiresAt).getTime()) return res.status(403).send('Expired');
  if (entry.usageLeft <= 0) return res.status(403).send('Used');

  if (!entry.robloxId) {
    // First time claim — lock key to roblox user
    entry.robloxId = robloxId;
    entry.robloxUsername = robloxUsername;
  } else if (entry.robloxId !== robloxId) {
    return res.status(403).send('BoundToAnotherUser');
  }

  entry.usageLeft -= 1;
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
  new SlashCommandBuilder()
    .setName('genkey')
    .setDescription('Generate a new key'),
  new SlashCommandBuilder()
    .setName('revoke')
    .setDescription('Revoke a key')
    .addStringOption(opt => opt.setName('key').setDescription('Key to revoke').setRequired(true)),
  new SlashCommandBuilder()
    .setName('listkeys')
    .setDescription('List all issued keys'),
  new SlashCommandBuilder()
    .setName('resetroblox')
    .setDescription('Reset Roblox account linked to your key')
    .addStringOption(opt => opt.setName('key').setDescription('Your key').setRequired(true))
];

async function registerCommands() {
  try {
    const appId = (await client.application.fetch()).id;
    await rest.put(Routes.applicationGuildCommands(appId, GUILD_ID), {
      body: commands.map(cmd => cmd.toJSON())
    });
    console.log('✅ Slash commands registered.');
  } catch (e) {
    console.error('❌ Command registration failed:', e);
  }
}

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, user } = interaction;

  await loadKeys();

  if (commandName === 'genkey') {
    // Only allow admin
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return interaction.reply({ content: '❌ You are not allowed to generate keys.', ephemeral: true });
    }

    const key = generateKey();
    issuedKeys[key] = {
      key,
      usageLeft: 1,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(), // 3 days
      robloxId: null,
      robloxUsername: null,
      discordId: null,
      lastReset: null
    };
    await saveKeys();
    return interaction.reply({ content: `🔑 Key generated: \`${key}\` (Expires in 3 days, 1 use)`, ephemeral: true });
  }

  if (commandName === 'revoke') {
    // Only admin
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return interaction.reply({ content: '❌ You are not allowed to revoke keys.', ephemeral: true });
    }
    const key = interaction.options.getString('key').toUpperCase();
    if (!issuedKeys[key]) return interaction.reply({ content: '⚠️ Key not found.', ephemeral: true });

    delete issuedKeys[key];
    await saveKeys();
    return interaction.reply({ content: `❌ Key \`${key}\` revoked.`, ephemeral: true });
  }

  if (commandName === 'listkeys') {
    // Only admin
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return interaction.reply({ content: '❌ You are not allowed to list keys.', ephemeral: true });
    }
    let text = '';
    for (const key in issuedKeys) {
      const k = issuedKeys[key];
      text += `\`${k.key}\` → Roblox: \`${k.robloxUsername ?? 'Unclaimed'}\` (ID: \`${k.robloxId ?? 'N/A'}\`) | Discord: \`${k.discordId ?? 'N/A'}\` | Uses left: ${k.usageLeft} | Expires: ${new Date(k.expiresAt).toLocaleString()}\n`;
    }
    if (text.length === 0) text = 'No keys issued yet.';
    return interaction.reply({ content: text, ephemeral: true });
  }

  if (commandName === 'resetroblox') {
    const key = interaction.options.getString('key').toUpperCase();

    if (!issuedKeys[key]) {
      return interaction.reply({ content: '⚠️ Key not found.', ephemeral: true });
    }

    const k = issuedKeys[key];

    if (k.discordId && k.discordId !== user.id) {
      return interaction.reply({ content: '❌ This key was not redeemed by your Discord account.', ephemeral: true });
    }

    const now = Date.now();

    // Admins skip cooldown
    const isAdmin = interaction.member.permissions.has(PermissionsBitField.Flags.Administrator);

    if (!isAdmin && k.lastReset) {
      const lastReset = new Date(k.lastReset).getTime();
      if (now - lastReset < resetCooldownMs) {
        const left = Math.ceil((resetCooldownMs - (now - lastReset)) / (1000 * 60)); // minutes left
        return interaction.reply({ content: `⏳ You must wait ${left} more minutes before resetting Roblox account again.`, ephemeral: true });
      }
    }

    // Reset Roblox data but keep Discord ID locked (so only that Discord user can reset it)
    k.robloxId = null;
    k.robloxUsername = null;
    k.lastReset = new Date().toISOString();
    // Also mark the discordId if not set yet
    if (!k.discordId) k.discordId = user.id;

    await saveKeys();
    return interaction.reply({ content: '✅ Roblox account linked to your key has been reset. You can now claim it again.', ephemeral: true });
  }
});

client.login(TOKEN);
