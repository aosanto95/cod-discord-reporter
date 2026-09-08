import "dotenv/config";
import { Client, EmbedBuilder, GatewayIntentBits, PermissionFlagsBits, MessageFlags } from "discord.js";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

const required = ["DISCORD_TOKEN", "DISCORD_CHANNEL_ID", "X_BEARER_TOKEN"];
const missing = required.filter((name) => !process.env[name]);
if (missing.length) throw new Error(`Missing environment variables: ${missing.join(", ")}`);

const query = process.env.X_QUERY || "@CallofDutyCM has:videos -is:retweet";
const pollMs = Math.max(30, Number(process.env.POLL_SECONDS || 60)) * 1000;
const dataDir = process.env.DATA_DIR || "data";
const statePath = path.resolve(dataDir, "seen.json");
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
let polling = false;
let lastSuccessfulPoll = null;
let lastPollError = null;
let monitoringEnabled = true;
let resumeAfter = Date.now();
let monitoringGeneration = 0;
let pendingSend = null;
let controlQueue = Promise.resolve();
let reportGuildId;
const controlPath = path.resolve(dataDir, "monitoring.json");

const server = createServer((request, response) => {
  if (request.url !== "/health" && request.url !== "/") {
    response.writeHead(404).end("Not found");
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({
    ok: true,
    discordReady: client.isReady(),
    monitoringEnabled,
    lastSuccessfulPoll,
    lastPollError
  }));
});
server.listen(Number(process.env.PORT || 3000), "0.0.0.0");

async function loadSeen() {
  try {
    return new Set(JSON.parse(await readFile(statePath, "utf8")));
  } catch (error) {
    if (error.code !== "ENOENT") console.warn("Could not read state:", error.message);
    return new Set();
  }
}

async function saveSeen(seen) {
  await mkdir(path.dirname(statePath), { recursive: true });
  const temp = `${statePath}.tmp`;
  await writeFile(temp, JSON.stringify([...seen].slice(-5000), null, 2));
  await rename(temp, statePath);
}

async function searchX() {
  const params = new URLSearchParams({
    query,
    max_results: "25",
    "tweet.fields": "author_id,created_at,public_metrics,attachments",
    expansions: "author_id,attachments.media_keys",
    "user.fields": "name,username,verified,profile_image_url",
    "media.fields": "type,url,preview_image_url,variants"
  });
  const response = await fetch(`https://api.x.com/2/tweets/search/recent?${params}`, {
    headers: { Authorization: `Bearer ${process.env.X_BEARER_TOKEN}` }
  });
  if (!response.ok) throw new Error(`X API ${response.status}: ${await response.text()}`);
  return response.json();
}

function bestVideoUrl(media) {
  return media?.variants
    ?.filter((item) => item.content_type === "video/mp4" && item.url)
    .sort((a, b) => (b.bit_rate || 0) - (a.bit_rate || 0))[0]?.url;
}

function makeEmbed(tweet, author, media) {
  const postUrl = `https://x.com/${author.username}/status/${tweet.id}`;
  const metrics = tweet.public_metrics || {};
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setAuthor({
      name: `${author.name} (@${author.username})${author.verified ? " ✓" : ""}`,
      iconURL: author.profile_image_url
    })
    .setDescription(tweet.text.slice(0, 4096))
    .setURL(postUrl)
    .addFields(
      { name: "Post", value: `[Open on X](${postUrl})`, inline: true },
      { name: "Public engagement", value: `Replies ${metrics.reply_count || 0} • Reposts ${metrics.retweet_count || 0} • Likes ${metrics.like_count || 0}`, inline: false }
    )
    .setFooter({ text: `X post ID: ${tweet.id}` })
    .setTimestamp(new Date(tweet.created_at));

  const preview = media.find((item) => item.preview_image_url || item.url);
  if (preview) embed.setImage(preview.preview_image_url || preview.url);
  return { embed, postUrl, videoUrl: media.map(bestVideoUrl).find(Boolean) };
}

async function poll() {
  if (polling || !monitoringEnabled) return;
  polling = true;
  const generation = monitoringGeneration;
  try {
    const channel = await client.channels.fetch(process.env.DISCORD_CHANNEL_ID);
    if (!channel?.isTextBased()) throw new Error("DISCORD_CHANNEL_ID is not a text channel");

    const seen = await loadSeen();
    if (!monitoringEnabled || generation !== monitoringGeneration) return;
    const result = await searchX();
    const users = new Map((result.includes?.users || []).map((u) => [u.id, u]));
    const mediaByKey = new Map((result.includes?.media || []).map((m) => [m.media_key, m]));
    const tweets = [...(result.data || [])].reverse();

    for (const tweet of tweets) {
      if (!monitoringEnabled || generation !== monitoringGeneration) break;
      if (!(Date.parse(tweet.created_at) >= resumeAfter)) continue;
      if (seen.has(tweet.id)) continue;
      const author = users.get(tweet.author_id);
      const media = (tweet.attachments?.media_keys || []).map((key) => mediaByKey.get(key)).filter(Boolean);
      if (!author || !media.some((item) => item.type === "video" || item.type === "animated_gif")) continue;

      const { embed, postUrl, videoUrl } = makeEmbed(tweet, author, media);
      pendingSend = channel.send({
        content: videoUrl ? `Video: ${videoUrl}` : postUrl,
        embeds: [embed],
        allowedMentions: { parse: [] }
      });
      try { await pendingSend; } finally { pendingSend = null; }
      seen.add(tweet.id);
    }
    await saveSeen(seen);
    lastSuccessfulPoll = new Date().toISOString();
    lastPollError = null;
  } catch (error) {
    console.error(new Date().toISOString(), error);
    lastPollError = error.message;
  } finally {
    polling = false;
  }
}

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand() || !["start", "stop"].includes(interaction.commandName)) return;
  try {
    if (interaction.guildId !== reportGuildId || !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: "Only the server owner and administrators can use this command.", flags: MessageFlags.Ephemeral });
      return;
    }
    const requestedAt = interaction.createdTimestamp || Date.now();
    const acknowledgement = interaction.deferReply({ flags: MessageFlags.Ephemeral });
    acknowledgement.catch(() => {});
    const operation = controlQueue.then(async () => {
      const enabled = interaction.commandName === "start";
      monitoringEnabled = false;
      monitoringGeneration++;
      const nextResumeAfter = enabled ? requestedAt : resumeAfter;
      const sending = pendingSend;
      await acknowledgement;
      await mkdir(path.dirname(controlPath), { recursive: true });
      await writeFile(`${controlPath}.tmp`, JSON.stringify({ enabled, resumeAfter: nextResumeAfter }));
      await rename(`${controlPath}.tmp`, controlPath);
      if (sending) await sending.catch(() => {});
      resumeAfter = nextResumeAfter;
      monitoringEnabled = enabled;
      await interaction.editReply(enabled
        ? "Posting started. Only X posts created from this /start onward will be posted. Posts from the pause are skipped."
        : "Posting stopped. Use /start to resume with new X posts only; posts made during this pause will be skipped.");
      if (enabled) void poll();
    });
    controlQueue = operation.catch(() => {});
    await operation;
  } catch (error) {
    console.error("Monitoring command failed:", error.message);
    const content = "Could not complete the command. Please try again.";
    await (interaction.deferred ? interaction.editReply({ content }) : interaction.reply({ content, flags: MessageFlags.Ephemeral })).catch(() => {});
  }
});

client.once("ready", async () => {
  try {
    try {
      const state = JSON.parse(await readFile(controlPath, "utf8"));
      if (typeof state.enabled !== "boolean") throw new Error("Invalid monitoring state");
      monitoringEnabled = state.enabled;
      if (state.resumeAfter !== undefined) {
        if (!Number.isFinite(state.resumeAfter)) throw new Error("Invalid resume timestamp");
        resumeAfter = state.resumeAfter;
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const channel = await client.channels.fetch(process.env.DISCORD_CHANNEL_ID);
    if (!channel?.guild) throw new Error("The report channel must belong to a server");
    reportGuildId = channel.guild.id;
    for (const [name, description] of [["start", "Resume report monitoring"], ["stop", "Pause report monitoring"]]) {
      await channel.guild.commands.create({ name, description, defaultMemberPermissions: PermissionFlagsBits.Administrator });
    }
  console.log(`Logged in as ${client.user.tag}; polling every ${pollMs / 1000}s`);
  await poll();
  setInterval(poll, pollMs);
  } catch (error) {
    console.error("Bot startup failed:", error.message);
    process.exit(1);
  }
});

client.login(process.env.DISCORD_TOKEN);
