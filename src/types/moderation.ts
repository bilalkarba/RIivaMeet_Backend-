/** Shared message-moderation types (no runtime imports, safe for presenters/services). */

export type ModerationPolicy = 'warn' | 'block' | 'flag';
export type ModerationAction = 'ALLOW' | 'WARN' | 'BLOCK' | 'FLAG';

export type ModerationMatchKind =
  | 'PHONE'
  | 'EMAIL'
  | 'WHATSAPP'
  | 'FACEBOOK'
  | 'INSTAGRAM'
  | 'TELEGRAM'
  | 'SOCIAL_PROFILE'
  | 'SOCIAL_HANDLE';

/** Never carries the matched value: warnings and flags must not repeat a phone number. */
export interface ModerationMatch {
  kind: ModerationMatchKind;
  label: string;
}

export interface ModerationOutcome {
  action: ModerationAction;
  policy: ModerationPolicy;
  matches: ModerationMatch[];
}
