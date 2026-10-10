import { DecimalAmount } from '../core/DecimalAmount';

/** Main_UI owns the five-wave row; other battles own different HUDs. */
export function usesStageHud(mode: string): boolean { return mode === 'Main'; }
export function clampRatio(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}
export function completionRatio(kills: number, total: number): number {
  return total > 0 ? clampRatio(kills / total) : 0;
}
export function timeRatio(remaining: number, duration: number): number {
  return duration > 0 ? clampRatio(remaining / duration) : 0;
}
export function stageWaveIndex(wave: number): number {
  return Number.isFinite(wave) ? Math.max(0, Math.min(4, Math.floor(wave))) : 0;
}
export function stageLabel(stage: number, wave: number): string {
  return `Stage ${Math.max(0, Math.floor(Number.isFinite(stage) ? stage : 0)) + 1}-${stageWaveIndex(wave) + 1}`;
}
/** Display precision never truncates the spendable wallet. */
export function formatGold(value: DecimalAmount | number, units: readonly string[], maxDigits = 5): string {
  if (typeof value === 'number' && (!Number.isFinite(value) || value <= 0)) return '0';
  return DecimalAmount.from(value).format(units, maxDigits);
}
export function formatDiamonds(value: number): string {
  return String(Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0);
}
