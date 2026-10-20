import { describe, expect, it } from 'vitest';

import {
  assertMessageNotBlocked,
  detectOffPlatformContact,
  moderateMessageText,
} from '../../src/services/moderation.service.js';

const kinds = (value: string): string[] => detectOffPlatformContact(value).map((match) => match.kind);

describe('off-platform contact detection', () => {
  it('detects phone numbers in common and obfuscated formats', () => {
    expect(kinds('Call me on +49 176 1234567')).toContain('PHONE');
    expect(kinds('My number is 0176 1234 5678')).toContain('PHONE');
    expect(kinds('reach me on 0049 (0) 176 1234567')).toContain('PHONE');
    expect(kinds('whatsapp ٠١٧٦ ١٢٣ ٤٥٦٧')).toContain('PHONE');
    expect(kinds('+1.202.555.0142')).toContain('PHONE');
  });

  it('detects messaging and social links, including obfuscated domains', () => {
    expect(kinds('wa.me/491761234567')).toContain('WHATSAPP');
    expect(kinds('chat.whatsapp.com/abc123')).toContain('WHATSAPP');
    expect(kinds('facebook.com/coach.anna')).toContain('FACEBOOK');
    expect(kinds('fb[.]me/coach')).toContain('FACEBOOK');
    expect(kinds('Hada Hsabi Facebook Bilal Karbach')).toContain('FACEBOOK');
    expect(kinds('hada hsabi facebook')).toContain('FACEBOOK');
    expect(kinds('Facebook Bilal Karbach')).toContain('FACEBOOK');
    expect(kinds('instagram dot com/coach')).toContain('INSTAGRAM');
    expect(kinds('instagram[.]com/coach')).toContain('INSTAGRAM');
    expect(kinds('t.me/coachname')).toContain('TELEGRAM');
    expect(kinds('telegram: @coachname')).toContain('SOCIAL_HANDLE');
    expect(kinds('linkedin.com/in/coach')).toContain('SOCIAL_PROFILE');
  });

  it('detects lowercase, uncued and non-English Facebook account references', () => {
    // The reported case: Darija cue + capitalised name.
    expect(kinds('Hada Hsabi Facebook Bilal Karbach')).toContain('FACEBOOK');
    // Bypass attempts that previously needed a capitalised English prefix.
    expect(kinds('facebook bilal karbach')).toContain('FACEBOOK');
    expect(kinds('my facebook is bilal karbach')).toContain('FACEBOOK');
    expect(kinds('facebook account bilal')).toContain('FACEBOOK');
    expect(kinds('fb: bilalkarbach')).toContain('FACEBOOK');
    // Typo variant observed in a real conversation.
    expect(kinds('hada hsabi facbook bilal karbach')).toContain('FACEBOOK');
    expect(kinds("mon compte facebook c'est Bilal Karbach")).toContain('FACEBOOK');
    expect(kinds('je suis sur facebook: bilal.karbach')).toContain('FACEBOOK');
    expect(kinds('حسابي على فيسبوك بلال كرباش')).toContain('FACEBOOK');
    expect(kinds('حسابي فيسبوك')).toContain('FACEBOOK');
    expect(kinds('فيسبوك بلال كرباش')).toContain('FACEBOOK');
  });

  it('detects spaced, letter-spaced, obfuscated and aliased social references', () => {
    expect(kinds('face book bilal karbach')).toContain('FACEBOOK');
    expect(kinds('f a c e b o o k Bilal Karbach')).toContain('FACEBOOK');
    expect(kinds('faysbook bilal karbach')).toContain('FACEBOOK');
    expect(kinds('facebook[.]com/bilal')).toContain('FACEBOOK');
    expect(kinds('m.facebook.com/bilal')).toContain('FACEBOOK');
    expect(kinds('fb.watch/abc123')).toContain('FACEBOOK');
    expect(kinds('ig.me/bilal')).toContain('INSTAGRAM');
    expect(kinds('tg://resolve?domain=bilal')).toContain('TELEGRAM');
    expect(kinds('find me on facebook')).toContain('FACEBOOK');
    expect(kinds('تابعوني على فيسبوك')).toContain('FACEBOOK');
  });

  it('detects email addresses, including [at]/[dot] variants', () => {
    expect(kinds('mail me at coach@example.com')).toContain('EMAIL');
    expect(kinds('coach [at] example [dot] com')).toContain('EMAIL');
    expect(kinds('coach (at) example (dot) com')).toContain('EMAIL');
  });

  it('does not flag ordinary coaching discussion', () => {
    const ordinary = [
      'Let us meet at 10:00 on 2026-10-19 for a 60 minute session.',
      'The session costs €45 and covers 5 km at 70% effort.',
      'Do 3 sets of 12 reps at 60 kg, then rest for 90 seconds.',
      'Your rating improved from 3.5 to 4.2 this month.',
      'We will review the match video and the tactics board tomorrow.',
      'Facebook is useful for following the local sports club.',
      'We discussed Instagram marketing during the coaching course.',
      'Bring shoes, water and a towel. See you at the gym.',
      'I ran 12 km and did 4x400 m intervals.',
      'Our Facebook page has the schedule for next week.',
      'I saw your Facebook post about the match.',
      'Follow the club on Facebook for updates.',
      'Facebook Messenger is down today.',
      'Instagram and TikTok are popular with athletes.',
      'My Facebook account is useful for the club.',
      'Facebook est utile pour le club.',
      'Nous avons parlé de Facebook pendant la formation.',
      'تحدثنا عن فيسبوك خلال التدريب.',
      'فيسبوك موقع جيد للتواصل مع النادي.',
      'WhatsApp group for the team?',
      'Check the Facebook event tomorrow.',
      'Instagram reels are fun.',
    ];

    for (const message of ordinary) {
      expect(kinds(message), message).toEqual([]);
    }
  });

  it('never echoes the matched value in the returned matches', () => {
    const matches = detectOffPlatformContact('Call +49 176 1234567 or mail coach@example.com');
    const serialized = JSON.stringify(matches);

    expect(serialized).not.toContain('1234567');
    expect(serialized).not.toContain('coach@example.com');
    expect(matches.every((match) => typeof match.label === 'string')).toBe(true);
  });
});

describe('message moderation policies', () => {
  const contact = 'Message me on +49 176 1234567';

  it('allows ordinary text under every policy', () => {
    for (const policy of ['warn', 'block', 'flag'] as const) {
      expect(moderateMessageText('Great session today, see you next week.', { policy })).toMatchObject({
        action: 'ALLOW',
        policy,
        matches: [],
      });
    }
  });

  it('maps warn, block and flag policies to their actions', () => {
    expect(moderateMessageText(contact, { policy: 'warn' }).action).toBe('WARN');
    expect(moderateMessageText(contact, { policy: 'block' }).action).toBe('BLOCK');
    expect(moderateMessageText(contact, { policy: 'flag' }).action).toBe('FLAG');
  });

  it('can be disabled explicitly', () => {
    expect(moderateMessageText(contact, { policy: 'block', enabled: false })).toMatchObject({
      action: 'ALLOW',
      matches: [],
    });
  });

  it('throws only for the block action', () => {
    const blocked = moderateMessageText(contact, { policy: 'block' });
    expect(() => assertMessageNotBlocked(blocked)).toThrow(/not allowed/i);

    expect(() => assertMessageNotBlocked(moderateMessageText(contact, { policy: 'warn' }))).not.toThrow();
    expect(() => assertMessageNotBlocked(moderateMessageText(contact, { policy: 'flag' }))).not.toThrow();
  });
});
