export interface AudioPreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
export interface AudioPreferencesOptions {
  environment: 'test' | 'production';
  storage?: AudioPreferenceStorage;
}

export function audioPreferencesStorageKey(environment: 'test' | 'production'): string {
  return `forest-gunner:audio:v1:${environment}`;
}

/** Device preferences stay independent of progression and tutorial replay saves. */
export class AudioPreferences {
  private bgm = true;
  private sound = true;
  private readonly key: string;

  constructor(private readonly options: AudioPreferencesOptions) {
    this.key = audioPreferencesStorageKey(options.environment);
    try {
      const raw = options.storage?.getItem(this.key);
      if (!raw) return;
      const data: unknown = JSON.parse(raw);
      if (!data || typeof data !== 'object' || Array.isArray(data)) return;
      const saved = data as { version?: unknown; bgmEnabled?: unknown; soundEnabled?: unknown };
      if (saved.version !== 1) return;
      if (typeof saved.bgmEnabled === 'boolean') this.bgm = saved.bgmEnabled;
      if (typeof saved.soundEnabled === 'boolean') this.sound = saved.soundEnabled;
    } catch { /* Storage denial or a damaged preference must not prevent play. */ }
  }

  get bgmEnabled(): boolean { return this.bgm; }
  get soundEnabled(): boolean { return this.sound; }

  setBgmEnabled(enabled: boolean): void {
    if (this.bgm === enabled) return;
    this.bgm = enabled; this.save();
  }

  setSoundEnabled(enabled: boolean): void {
    if (this.sound === enabled) return;
    this.sound = enabled; this.save();
  }

  private save(): void {
    try {
      this.options.storage?.setItem(this.key, JSON.stringify({ version: 1, bgmEnabled: this.bgm, soundEnabled: this.sound }));
    } catch { /* The new preference remains effective for this session. */ }
  }
}
