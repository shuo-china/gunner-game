import type { RewardedAdPlacement } from '../session/RewardedAds';

/** Distribution targets are separate from backend identity namespaces and ad networks. */
export type GameChannel = 'web' | 'wechat-mini' | 'douyin-mini' | 'taptap-mini' | 'taptap-android';
export interface PlatformBuildTarget { readonly wechat?: boolean; readonly douyin?: boolean; readonly native?: boolean; }
export interface PlatformChannelConfig {
  readonly channel: GameChannel;
  readonly label: string;
  /** Public AppID / Client ID. Secrets belong on the server. */
  readonly appId: string;
  readonly ads: {
    readonly provider: string;
    readonly unitIds: Readonly<Partial<Record<RewardedAdPlacement, string>>>;
  };
}
export interface PlatformContext { readonly config: PlatformChannelConfig; readonly globals: object; }

export interface PlatformHttpRequest {
  readonly url: string;
  readonly method: 'GET' | 'POST';
  readonly data?: unknown;
  readonly timeout: number;
  readonly header: Record<string, string>;
  success(response: { statusCode: number; data: unknown }): void;
  fail(error: unknown): void;
}
export interface PlatformHttpTransport {
  /** Bind the host's receiver inside the adapter. Abort must be safe after completion. */
  request(options: PlatformHttpRequest): { abort?(): void } | void;
}
export type PlatformCredential = Readonly<Record<string, unknown>>;
export interface PlatformLoginProvider {
  /** Must match the server-verified player DTO, never a client-generated identity. */
  readonly identityProvider: string;
  readonly appId: string;
  /** Relative endpoint below the shared /game/v1 base URL. */
  readonly endpoint: string;
  acquireCredential(options: {
    readonly timeoutMs: number;
    success(credential: PlatformCredential): void;
    fail(code: string): void;
  }): (() => void) | void;
}
export interface PlatformLoginBinding {
  readonly provider: PlatformLoginProvider;
  readonly transport: PlatformHttpTransport;
}

export interface PlatformShareOptions {
  readonly title?: string;
  readonly imageUrl?: string;
  readonly query?: string;
}
export interface PlatformShareResult {
  /** Returning from a share sheet is unverified unless the platform confirms delivery. */
  readonly status: 'confirmed' | 'unverified' | 'cancelled' | 'failed' | 'unavailable';
  readonly message?: string;
}
/** Adapters only launch platform sharing and report its observable result.
 * Gameplay owns reward eligibility, the daily limit and durable settlement. */
export interface PlatformShareProvider {
  readonly supported: boolean;
  share(options?: PlatformShareOptions): Promise<PlatformShareResult>;
  onHide?(): void;
  onShow?(): void;
  destroy(): void;
}
