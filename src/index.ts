/**
 * src/index.ts
 */

import { Database } from "bun:sqlite";
import { WebhookClient, EmbedBuilder } from "discord.js";
import { readFileSync } from "fs";

// Import interfaces
import { IConfig, IChannelRow, IChannelDataRow, IStreamData } from "./IDefs";

// Load config
const config: IConfig = JSON.parse(readFileSync("./config.json", "utf-8"));

// If we have a WEBHOOK_URL in .env, use that; else fallback to dev endpoint
const PRODUCTION_WEBHOOK_URL = process.env.WEBHOOK_URL;
const DEV_WEBHOOK_URL = "https://discord.com/api/webhooks/xxx/xxx";
const webhookUrl =
  PRODUCTION_WEBHOOK_URL && PRODUCTION_WEBHOOK_URL.trim() !== ""
    ? PRODUCTION_WEBHOOK_URL
    : DEV_WEBHOOK_URL;

// Setup the Discord Webhook Client
const webhookClient = new WebhookClient({ url: webhookUrl });

// Twitch credentials from .env (you must fill these in)
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID ?? "";
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET ?? "";

// Create (or open) the local SQLite database
const db = new Database("app.sqlite");

// -----------------------------------------------------------------------------
// 1. Database Setup
// -----------------------------------------------------------------------------

// We assume you already have Channels, MessageHistory, etc. This part just ensures they exist.
// Adjust or run migrations as needed if your schema is older.

db.run(`
CREATE TABLE IF NOT EXISTS Channels (
  channelName TEXT NOT NULL,
  channelID TEXT NOT NULL PRIMARY KEY
);
`);

/*
  Added two new columns to ChannelData:
    - thumbnailURL TEXT       (base thumbnail, e.g. https://...-1280x720.jpg)
    - lastThumbUpdate INTEGER (tracks the last time we updated the embed image)
*/
db.run(`
CREATE TABLE IF NOT EXISTS ChannelData (
  channel TEXT NOT NULL,
  startTime INTEGER NOT NULL,
  endTime INTEGER,
  messageID TEXT,
  messageLink TEXT,
  thumbnailURL TEXT,
  lastThumbUpdate INTEGER,
  FOREIGN KEY(channel) REFERENCES Channels(channelID)
);
`);

db.run(`
CREATE TABLE IF NOT EXISTS MessageHistory (
  channel TEXT NOT NULL,
  vodDuration TEXT,
  startTime INTEGER NOT NULL,
  endTime INTEGER NOT NULL,
  messageID TEXT,
  messageLink TEXT,
  vodLink TEXT,
  FOREIGN KEY(channel) REFERENCES Channels(channelID)
);
`);

// [NEW] Table to log errors
db.run(`
CREATE TABLE IF NOT EXISTS ErrorLog (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  errorType TEXT NOT NULL,
  description TEXT,
  line INTEGER,
  trace TEXT
);
`);

// -----------------------------------------------------------------------------
// 2. Helper: Fetch OAuth Token from Twitch
// -----------------------------------------------------------------------------
let globalTwitchToken = "";
let tokenExpiresAt = 0;

async function getTwitchToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (globalTwitchToken && now < tokenExpiresAt) {
    return globalTwitchToken;
  }

  console.log("[Twitch] Fetching new OAuth token...");

  const params = new URLSearchParams({
    client_id: TWITCH_CLIENT_ID,
    client_secret: TWITCH_CLIENT_SECRET,
    grant_type: "client_credentials",
  });

  // Use Bun's fetch
  const response = await fetch(`https://id.twitch.tv/oauth2/token?${params}`, {
    method: "POST",
  });
  if (!response.ok) {
    throw new Error("Failed to fetch Twitch token");
  }

  const data = await response.json();
  globalTwitchToken = data.access_token;
  tokenExpiresAt = now + data.expires_in - 60; // subtract some seconds as buffer
  return globalTwitchToken;
}

// -----------------------------------------------------------------------------
// 3. Error Logging Helper
// -----------------------------------------------------------------------------
function parseErrorLine(stack: string | undefined): number | null {
  if (!stack) return null;
  const lines = stack.split("\n");
  const secondLine = lines[1] || "";
  const match = secondLine.match(/:(\d+):\d+\)?$/);
  if (match) {
    return parseInt(match[1], 10);
  }
  return null;
}

function logError(error: unknown, errorType: string) {
  let errObj: Error | null = null;
  if (error instanceof Error) {
    errObj = error;
  } else if (typeof error === "string") {
    errObj = new Error(error);
  }

  const timestamp = Date.now();
  const desc = errObj?.message ?? String(error);
  const stack = errObj?.stack;
  const lineNum = parseErrorLine(stack);

  db.run(
    `INSERT INTO ErrorLog (timestamp, errorType, description, line, trace)
     VALUES (?, ?, ?, ?, ?)`,
    [timestamp, errorType, desc, lineNum, stack ?? ""]
  );
  console.error(`[ErrorLog] ${errorType} => ${desc}\n${stack}`);
}

// -----------------------------------------------------------------------------
// 4. Helper: Fetch a Twitch channel’s user data (resolve channel ID by name)
// -----------------------------------------------------------------------------
async function fetchChannelID(channelName: string): Promise<string | null> {
  const token = await getTwitchToken();

  const url = `https://api.twitch.tv/helix/users?login=${channelName}`;
  const resp = await fetch(url, {
    headers: {
      "Client-Id": TWITCH_CLIENT_ID,
      Authorization: `Bearer ${token}`,
    },
  });
  if (!resp.ok) {
    console.error(`[Twitch] Error fetching channel ID for ${channelName}`);
    return null;
  }

  const data = await resp.json();
  if (data.data && data.data.length > 0) {
    return data.data[0].id; // Twitch user ID
  }
  return null;
}

// -----------------------------------------------------------------------------
// 5. Helper: Fetch if channel is live
// -----------------------------------------------------------------------------
async function fetchIsLive(channelID: string): Promise<IStreamData | null> {
  const token = await getTwitchToken();

  const url = `https://api.twitch.tv/helix/streams?user_id=${channelID}`;
  const resp = await fetch(url, {
    headers: {
      "Client-Id": TWITCH_CLIENT_ID,
      Authorization: `Bearer ${token}`,
    },
  });

  if (!resp.ok) {
    console.error(
      `[Twitch] Error checking live status for channelID=${channelID}`
    );
    return null;
  }

  const data = await resp.json();
  if (data.data && data.data.length > 0) {
    return data.data[0] as IStreamData; // if "type": "live", channel is live
  }
  return null;
}

// -----------------------------------------------------------------------------
// 6. Logic to handle going live / stopping stream (with time-based thumbnail refresh)
// -----------------------------------------------------------------------------
const THUMBNAIL_REFRESH_INTERVAL = 10 * 60 * 1000; // 10 minutes in ms

async function checkAllChannels() {
  for (const channelName of config.channels) {
    try {
      // 1. Ensure channel is in "Channels" table
      const row = db
        .query<IChannelRow, [string]>(
          "SELECT channelID FROM Channels WHERE channelName = ?"
        )
        .get(channelName);

      let channelID = row?.channelID;

      if (!channelID) {
        // fetch from Twitch and insert
        const fetchedID = await fetchChannelID(channelName);
        if (!fetchedID) continue;
        channelID = fetchedID;
        db.run<[string, string]>(
          "INSERT INTO Channels (channelName, channelID) VALUES (?, ?)",
          [channelName, channelID]
        );
      }

      // 2. Check if the channel is live
      const streamData = await fetchIsLive(channelID);

      // 3. If channel is live, handle new or existing streaming session
      //    If channel is NOT live but in ChannelData, handle stopping
      const currentStreamRow = db
        .query<IChannelDataRow, [string]>(
          `SELECT rowid, channel, startTime, endTime, messageID, messageLink, thumbnailURL, lastThumbUpdate
           FROM ChannelData
           WHERE channel = ? AND endTime IS NULL`
        )
        .get(channelID);

      if (streamData) {
        // channel is live
        const baseThumbUrl = streamData.thumbnail_url
          .replace("{width}", "1280")
          .replace("{height}", "720");

        if (!currentStreamRow) {
          // [A] Brand-new live session
          const startTime = Date.now();
          const embed = new EmbedBuilder()
            .setTitle(`${streamData.user_name} is LIVE`)
            .addFields([
              {
                name: "Game",
                value: streamData.game_name ?? "Unknown",
                inline: true,
              },
            ])
            .setURL(`https://twitch.tv/${streamData.user_login}`)
            .setDescription(`## ${streamData.title}` || "No stream title")
            .setColor(0x9146ff)
            .setTimestamp(new Date(startTime))
            // We append a timestamp so Discord fetches a fresh image now
            .setImage(baseThumbUrl + `?t=${Date.now()}`);

          const sentMessage = await webhookClient.send({
            content: process.env.DISCORD_ROLE ? `<@&${process.env.DISCORD_ROLE}>` : "",
            embeds: [embed],
          });
          const messageID = sentMessage.id;
          const messageLink = `https://discord.com/channels/.../${messageID}`;

          // Insert into ChannelData (store base thumbnail and last update time)
          db.run(
            `INSERT INTO ChannelData (channel, startTime, endTime, messageID, messageLink, thumbnailURL, lastThumbUpdate) 
             VALUES (?, ?, NULL, ?, ?, ?, ?)`,
            [
              channelID,
              startTime,
              messageID,
              messageLink,
              baseThumbUrl,
              Date.now(),
            ]
          );

          console.log(`[${channelName}] Went LIVE! MessageID: ${messageID}`);
        } else {
          // [B] Already in ChannelData => Channel is still live
          const streamRowId = currentStreamRow.rowid;
          const { messageID, thumbnailURL, lastThumbUpdate } = currentStreamRow;

          // [NEW] Time-based thumbnail refresh
          if (thumbnailURL) {
            const now = Date.now();
            const elapsedSinceLastUpdate = now - (lastThumbUpdate ?? 0);

            if (elapsedSinceLastUpdate >= THUMBNAIL_REFRESH_INTERVAL) {
              // It's been at least 10 minutes => Force new embed image
              console.log(
                `[${channelName}] 10+ minutes since last thumbnail update. Refreshing...`
              );

              const updatedEmbed = new EmbedBuilder()
                .setTitle(`${streamData.user_name} is LIVE`)
                .addFields([
                  {
                    name: "Game",
                    value: streamData.game_name ?? "Unknown",
                    inline: true,
                  },
                ])
                .setURL(`https://twitch.tv/${streamData.user_login}`)
                .setDescription(`## ${streamData.title}` || "No stream title")
                .setColor(0x9146ff)
                .setTimestamp(new Date())
                // Append timestamp to the stored base URL
                .setImage(thumbnailURL + `?t=${now}`);

              try {
                await webhookClient.editMessage(messageID || "", {
                  content: process.env.DISCORD_ROLE ? `<@&${process.env.DISCORD_ROLE}>` : "",
                  embeds: [updatedEmbed],
                });

                // Update lastThumbUpdate in DB
                db.run<[number, number]>(
                  "UPDATE ChannelData SET lastThumbUpdate = ? WHERE rowid = ?",
                  [now, streamRowId]
                );

                console.log(`[${channelName}] Thumbnail refreshed.`);
              } catch (err) {
                logError(err, "ThumbnailRefresh");
              }
            }
          }
        }
      } else {
        // channel is NOT live
        if (currentStreamRow) {
          // They were streaming, now they've stopped
          const streamRowId = currentStreamRow.rowid;
          const { startTime, messageID, messageLink } = currentStreamRow;
          const endTime = Date.now();

          // Update the record to mark the end of the stream
          db.run<[number, number]>(
            "UPDATE ChannelData SET endTime = ? WHERE rowid = ?",
            [endTime, streamRowId]
          );

          // Compute duration
          const durationMs = endTime - startTime;
          const durationHours = Math.floor(durationMs / 1000 / 60 / 60);
          const durationMinutes = Math.floor((durationMs / 1000 / 60) % 60);
          let vodDuration = `${durationHours}h ${durationMinutes}m`;
          if (durationHours <= 0) {
            vodDuration = `${durationMinutes}m`;
          }

          // For VOD link, you would typically fetch /helix/videos?user_id=...
          const vodLink = `https://www.twitch.tv/${channelName}/videos`;

          // Move the finished session to MessageHistory
          db.run(
            `INSERT INTO MessageHistory (
               channel, vodDuration, startTime, endTime, messageID, messageLink, vodLink
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
              channelID,
              vodDuration,
              startTime,
              endTime,
              messageID,
              messageLink,
              vodLink,
            ]
          );

          // Optionally remove the row from ChannelData or keep it with endTime set
          // db.run("DELETE FROM ChannelData WHERE rowid = ?", streamRowId);

          // Edit the original webhook message
          const newEmbed = new EmbedBuilder()
            .setTitle(`${channelName} just finished streaming!`)
            .setDescription(
              `Streamed for **${vodDuration}**.\nVOD link: [Click Here](${vodLink})`
            )
            .setColor(0xff0000)
            .setTimestamp(new Date(endTime));

          try {
            await webhookClient.editMessage(messageID || "", {
              content: process.env.DISCORD_ROLE ? `<@&${process.env.DISCORD_ROLE}>` : "",
              embeds: [newEmbed],
            });
            console.log(`[${channelName}] Stream ended. Message updated.`);
          } catch (err) {
            logError(err, "StreamEndUpdate");
          }
        }
      }
    } catch (err) {
      // If something unexpected happens per channel loop, log it:
      logError(err, "checkAllChannels");
    }
  }
}

// -----------------------------------------------------------------------------
// 7. Main Loop
// -----------------------------------------------------------------------------
async function mainLoop() {
  try {
    await checkAllChannels();
  } catch (error) {
    // If something unexpected happens at a higher level, log it:
    logError(error, "mainLoop");
  } finally {
    // Repeat
    setTimeout(mainLoop, 60_000); // check every minute (adjust as desired)
  }
}

(async function startBot() {
  console.log("[Bot] Starting up...");
  await mainLoop();
})();
