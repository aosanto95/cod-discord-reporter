# Call of Duty community-report Discord bot

This bot watches X's recent public posts for video posts mentioning `@CallofDutyCM` and forwards them to one Discord channel. Each Discord message includes the public X username, post text and time, engagement counts, post link, and available video/preview media.

It intentionally does **not** collect private information, infer someone's identity, or decide whether a cheating allegation is true. Treat forwarded posts as unverified reports and use the official in-game/Activision reporting process for enforcement.

## Requirements

- Node.js 20 or newer
- A Discord application/bot with permission to View Channel, Send Messages, and Embed Links in the destination channel
- An X developer project and bearer token with access to the recent-search endpoint

## Setup

1. Copy `.env.example` to `.env`.
2. Fill in the Discord bot token, destination channel ID, and X bearer token.
3. In this folder, run `npm install` and then `npm start`.

The bot stores IDs of already-forwarded posts in `data/seen.json`, so restarts do not repost the same reports. Keep `.env` private and never commit or share it.

## Run continuously on Railway

1. Put this folder in a GitHub repository, then choose **New Project → Deploy from GitHub repo** in Railway. Railway will build the included Dockerfile.
2. In the Railway service's **Variables** tab, add `DISCORD_TOKEN`, `DISCORD_CHANNEL_ID`, and `X_BEARER_TOKEN`. Add `X_QUERY` and `POLL_SECONDS` only if you want to override their defaults. Never paste secrets into GitHub.
3. Add a Railway Volume mounted at `/data`, then set `DATA_DIR=/data`. This preserves the duplicate-history file across restarts and deployments.
4. Generate a Railway domain under **Settings → Networking**. Railway uses `/health` to validate the deployment; visiting the domain also shows a small JSON status response.
5. Open the deployment logs. A successful start prints `Logged in as ...`; the bot then continues running when your PC is off.

Use exactly one Railway replica. Multiple replicas could forward the same post more than once.

## Useful adjustments

- Change `X_QUERY` to add keywords such as `(cheating OR aimbot OR wallhack)` if the feed is too broad.
- Keep `has:videos` to exclude text-only accusations.
- X API access levels and rate limits vary. If the API returns `401`, `403`, or `429`, verify the developer-project access and polling interval.
- For moderation, restrict the output channel and add a note explaining that posts are allegations, not confirmed findings.
