import "dotenv/config";
import { Client, EmbedBuilder, GatewayIntentBits } from "discord.js";
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

const server = createServer((request, response) => {
  if (request.url !== "/health" && request.url !== "/") {
    response.writeHead(404).end("Not found");
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({
    ok: true,
    discordReady: client.isReady(),
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
  if (polling) return;
  polling = true;
  try {
    const channel = await client.channels.fetch(process.env.DISCORD_CHANNEL_ID);
    if (!channel?.isTextBased()) throw new Error("DISCORD_CHANNEL_ID is not a text channel");

    const seen = await loadSeen();
    const result = await searchX();
    const users = new Map((result.includes?.users || []).map((u) => [u.id, u]));
    const mediaByKey = new Map((result.includes?.media || []).map((m) => [m.media_key, m]));
    const tweets = [...(result.data || [])].reverse();

    for (const tweet of tweets) {
      if (seen.has(tweet.id)) continue;
      const author = users.get(tweet.author_id);
      const media = (tweet.attachments?.media_keys || []).map((key) => mediaByKey.get(key)).filter(Boolean);
      if (!author || !media.some((item) => item.type === "video" || item.type === "animated_gif")) continue;

      const { embed, postUrl, videoUrl } = makeEmbed(tweet, author, media);
      await channel.send({
        content: videoUrl ? `Video: ${videoUrl}` : postUrl,
        embeds: [embed],
        allowedMentions: { parse: [] }
      });
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

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}; polling every ${pollMs / 1000}s`);
  await poll();
  setInterval(poll, pollMs);
});

client.login(process.env.DISCORD_TOKEN);
