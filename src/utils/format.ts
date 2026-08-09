/**
 * Byte/percent/duration formatting shared by the summary row and every file
 * card. Kept in one place so "what unit do we switch to and when" has exactly
 * one answer — two near-identical copies drifted apart once already.
 */

const UNITS = ['B', 'KB', 'MB', 'GB'] as const

/** Picks B/KB/MB/GB automatically, rounding to 1 decimal below 10 of a unit. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  const decimals = unit === 0 ? 0 : value < 10 ? 1 : 0
  return `${value.toFixed(decimals)} ${UNITS[unit]}`
}

/** Savings are positive when the output shrank; a negative value grew. */
export function formatSignedBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  return `${bytes < 0 ? '−' : ''}${formatBytes(Math.abs(bytes))}`
}

export function formatPercent(percent: number): string {
  if (!Number.isFinite(percent) || Math.abs(percent) < 0.05) return '0%'
  const magnitude = Math.abs(percent)
  const rounded = magnitude < 10 ? magnitude.toFixed(1) : magnitude.toFixed(0)
  return `${percent < 0 ? '−' : ''}${rounded}%`
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`
}
