/**
 * Message types for communication between content script and background script
 */

/**
 * Playback intent from content script to background
 * Represents a user-initiated playback action
 */
export interface PlaybackIntent {
  type: 'play' | 'pause' | 'seek';
  /** Current video time in seconds (for play/pause) or target time (for seek) */
  time: number;
}

/**
 * Playback command from background to content script
 * Represents an authoritative command from the server
 */
export interface PlaybackCommand {
  type: 'play' | 'pause' | 'seek' | 'sync_adjust';
  /** Target time in seconds (for seek) or current time (for play/pause) */
  time?: number;
  /** Delta adjustment in seconds (for sync_adjust) */
  delta?: number;
}

/**
 * Content identity information
 */
export interface ContentIdentity {
  providerId: string;
  episodeId: string;
  normalizedUrl: string;
}

/**
 * Base message structure for chrome.runtime messaging
 */
export interface BaseMessage {
  type: string;
}

/**
 * Content script → Background message types
 */
export interface ContentToBackgroundMessage extends BaseMessage {
  type: 'PLAYBACK_INTENT' | 'CONTENT_IDENTITY' | 'EPISODE_CHANGE_REQUEST' | 'PING';
  data?: PlaybackIntent | ContentIdentity | Record<string, unknown>;
}

/**
 * Background → Content script message types
 */
export interface BackgroundToContentMessage extends BaseMessage {
  type: 'PLAYBACK_COMMAND' | 'PONG';
  data?: PlaybackCommand | Record<string, unknown>;
}

/**
 * Union type for all content → background messages
 */
export type ContentMessage = ContentToBackgroundMessage;

/**
 * Union type for all background → content messages
 */
export type BackgroundMessage = BackgroundToContentMessage;
