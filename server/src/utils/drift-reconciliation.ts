/**
 * Drift reconciliation utilities
 * Functions for detecting and correcting playback drift
 */

import { getConfig } from '../config';
import type { Room } from '../types/room';

/**
 * Calculate expected playback time based on room state
 * @param room - Room to calculate expected time for
 * @returns Expected playback time in seconds
 */
export function calculateExpectedTime(room: Room): number {
  const now = Date.now();

  if (room.state.paused) {
    // If paused: expected_time = state.time
    return room.state.time;
  } else {
    // If playing: expected_time = state.time + (now - last_state_update_ts)
    const elapsedSeconds = (now - room.state.last_state_update_ts) / 1000;
    return room.state.time + elapsedSeconds;
  }
}

/**
 * Calculate drift between client-reported time and expected time
 * @param clientTime - Client-reported playback time in seconds
 * @param expectedTime - Server-calculated expected time in seconds
 * @returns Drift in milliseconds (positive = client ahead, negative = client behind)
 */
export function calculateDrift(clientTime: number, expectedTime: number): number {
  return (clientTime - expectedTime) * 1000; // Convert to milliseconds
}

/**
 * Select sync adjustment mode based on drift amount
 * @param driftMs - Drift in milliseconds (absolute value)
 * @returns Sync mode: 'nudge-rate' for small corrections, 'seek' for large corrections
 */
export function selectSyncMode(driftMs: number): 'nudge-rate' | 'seek' {
  const config = getConfig();
  const absDrift = Math.abs(driftMs);

  if (absDrift >= config.seekThresholdMs) {
    return 'seek';
  } else if (absDrift >= config.nudgeThresholdMs) {
    return 'nudge-rate';
  } else {
    // Below nudge threshold - no correction needed
    return 'nudge-rate'; // Default, but caller should check threshold first
  }
}

/**
 * Check if drift reconciliation should be skipped due to cooldown window
 * @param room - Room to check
 * @returns true if reconciliation should be skipped, false otherwise
 */
export function shouldSkipReconciliation(room: Room): boolean {
  const config = getConfig();
  const now = Date.now();
  const timeSinceLastEvent = now - room.state.last_explicit_event_ts;

  // Skip if within cooldown window after explicit event
  if (timeSinceLastEvent < config.cooldownWindowMs) {
    return true;
  }

  return false;
}

/**
 * Check if drift exceeds threshold requiring correction
 * @param driftMs - Drift in milliseconds (absolute value)
 * @returns true if drift exceeds threshold, false otherwise
 */
export function exceedsDriftThreshold(driftMs: number): boolean {
  const config = getConfig();
  return Math.abs(driftMs) >= config.driftThresholdMs;
}
