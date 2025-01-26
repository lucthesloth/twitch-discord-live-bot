/**
 * IDefs.ts
 * 
 * Common interface definitions used throughout the project.
 */

/** Represents the structure of config.json */
export interface IConfig {
    channels: string[];
  }
  
  /** Represents a row in the "Channels" table. */
  export interface IChannelRow {
    channelName: string;
    channelID: string; // Twitch user_id
  }
  
  /**
   * Represents a row in the "ChannelData" table.
   * 'rowid' is auto-created by SQLite if you select it explicitly (SELECT rowid, *).
   * 'endTime' can be null if the channel is still live.
   */
  export interface IChannelDataRow {
    rowid: number;         // Only present if you "SELECT rowid"
    channel: string;       // Foreign key referencing "Channels.channelID"
    startTime: number;
    endTime: number | null;
    messageID: string | null;
    messageLink: string | null;
    thumbnailURL: string | null;  
    lastThumbUpdate: number | null;
  }
  
  /**
   * Represents a row in the "MessageHistory" table.
   * This records completed streams.
   */
  export interface IMessageHistoryRow {
    rowid: number;         // Only present if you "SELECT rowid"
    channel: string;       // Foreign key referencing "Channels.channelID"
    vodDuration: string | null;
    startTime: number;
    endTime: number;
    messageID: string | null;
    messageLink: string | null;
    vodLink: string | null;
  }
  
  /**
   * Represents the JSON object returned by Twitch's Helix /streams endpoint
   * for a single stream.
   */
  export interface IStreamData {
    user_id: string;
    user_login: string;
    user_name: string;
    type: string;          // "live" if streaming
    title: string;
    started_at: string;    // ISO8601 timestamp string
    thumbnail_url: string;
    game_name: string;
  }
  