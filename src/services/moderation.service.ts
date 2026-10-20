import { env } from "../config/env.js";
import { prisma } from "../config/prisma.js";
import type {
  AdminListModerationFlagsQuery,
  ReviewModerationFlagBody,
} from "../schemas/moderation.schema.js";
import type {
  ModerationAction,
  ModerationMatch,
  ModerationMatchKind,
  ModerationOutcome,
  ModerationPolicy,
} from "../types/moderation.js";
import { ApiError } from "../utils/errors.js";
import {
  toAdminMessageFlagResponse,
  type AdminMessageFlagResponse,
} from "../utils/presenters.js";

/**
 * Message moderation (off-platform contact sharing).
 *
 * Coaching conversations are the product, so deliberately moving a client off-platform
 * (phone, WhatsApp, Instagram, Telegram, …) is a policy violation. The detector runs
 * server-side inside `chat.service.sendMessage`, which is the single entry point used by
 * both REST and Socket.IO, so a client cannot bypass it by using a different transport.
 *
 * The check is configurable (`MESSAGE_MODERATION_POLICY`):
 *  - `warn`  persists + delivers the message and returns a warning to the sender;
 *  - `block` rejects it before it is persisted or broadcast;
 *  - `flag`  persists + delivers it and records a reviewable flag for administrators.
 *
 * Detection is intentionally conservative: it looks for contact *formats* (phone-like
 * digit runs, email addresses, social domains, handles introduced by a social network
 * name) rather than isolated words, so normal coaching text ("run 5 km at 6:30",
 * "€45/hour", "2026-10-19") is not flagged.
 */

export type {
  ModerationAction,
  ModerationMatch,
  ModerationMatchKind,
  ModerationOutcome,
  ModerationPolicy,
} from "../types/moderation.js";

/** Social networks / messaging providers that count as taking the conversation off-platform. */
const SOCIAL_DOMAINS: {
  kind: ModerationMatchKind;
  label: string;
  pattern: RegExp;
}[] = [
  {
    kind: "WHATSAPP",
    label: "WhatsApp",
    pattern:
      /(?:https?:\/\/)?(?:www\.)?(?:wa\.me|wa\.link|api\.whatsapp\.com|chat\.whatsapp\.com|whatsapp\.com|whatsapp\.link|whatsapp:)\b/i,
  },
  {
    kind: "FACEBOOK",
    label: "Facebook",
    pattern:
      /(?:https?:\/\/)?(?:www\.|m\.|web\.|l\.)?(?:facebook\.com|fb\.com|fb\.me|fb\.watch|m\.me|messenger\.com)\b/i,
  },
  {
    kind: "INSTAGRAM",
    label: "Instagram",
    pattern:
      /(?:https?:\/\/)?(?:www\.)?(?:instagram\.com|instagr\.am|ig\.me)\b/i,
  },
  {
    kind: "TELEGRAM",
    label: "Telegram",
    pattern:
      /(?:https?:\/\/)?(?:www\.)?(?:t\.me|telegram\.me|telegram\.org|telegram\.dog|tg:\/\/)\b/i,
  },
  {
    kind: "SOCIAL_PROFILE",
    label: "Social profile",
    pattern:
      /(?:https?:\/\/)?(?:www\.)?(?:linkedin\.com|tiktok\.com|snapchat\.com|twitter\.com|x\.com|discord\.gg|discord\.com|youtube\.com|youtu\.be|pinterest\.com|reddit\.com)\b/i,
  },
];

const EMAIL_PATTERN = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/i;

/**
 * Platform names in every spelling users actually type: English, French, transliterated
 * Darija and Arabic script, including the common "face book" spacing. One source string
 * drives the cue, intent and "platform followed by a name" detectors so they cannot
 * drift apart.
 */
const SOCIAL_PLATFORM_SOURCE = String.raw`face\s*book|facebook|facebok|facbook|fcbk|fcb|fb|messenger|fays\s*book|faysbook|faysbouk|fesbook|insta\s*gram|instagram|instgram|insta|ig|whats\s*app|whatsapp|whatsap|watsapp|tele\s*gram|telegram|telgram|tg|tiktok|snapchat|linkedin|فيسبوك|فايسبوك|فيس\s*بوك|انستغرام|إنستغرام|انستجرام|إنستجرام|واتساب|واتس\s*اب|وتساب|تلغرام|تيليغرام|تلجرام|تيليجرام`;

/** A platform token may not be glued to another word (letter/number boundary). */
const PLATFORM_BOUNDARY_START = String.raw`(?<![\p{L}\p{N}])`;
const PLATFORM_BOUNDARY_END = String.raw`(?![\p{L}\p{N}])`;

/** Non-global: `exec` is safe to reuse without leaking `lastIndex`. */
const SOCIAL_PLATFORM_TEST = new RegExp(
  `${PLATFORM_BOUNDARY_START}(${SOCIAL_PLATFORM_SOURCE})${PLATFORM_BOUNDARY_END}`,
  "iu",
);

/**
 * A handle is only treated as contact sharing when a network name introduces it:
 * "telegram: @name", "instagram @name", "wa: name". A plain "@coach" mention stays legal.
 */
const SOCIAL_HANDLE_PATTERN = new RegExp(
  `${PLATFORM_BOUNDARY_START}(?:${SOCIAL_PLATFORM_SOURCE}|wa)${PLATFORM_BOUNDARY_END}\\s*(?::\\s*)?@[\\p{L}0-9_][\\p{L}0-9_.-]{2,31}${PLATFORM_BOUNDARY_END}`,
  "iu",
);

/**
 * Explicit "this is my account" phrasing. Darija/Arabic account cues are strong enough to
 * flag on their own because they are used to hand out a profile.
 */
const STRONG_ACCOUNT_CUE_PATTERN = new RegExp(
  `${PLATFORM_BOUNDARY_START}(?:` +
    String.raw`(?:hada|had|hadak|hadi)\s+(?:howa\s+)?(?:hsab(?:i|iy|ek|o)?|compte|profil|page)(?:\s+(?:dyal(?:i|iy|ek|o)?))?\s+(?:on\s+|fi\s+|f\s+)?(?:${SOCIAL_PLATFORM_SOURCE})` +
    `|` +
    String.raw`(?:حسابي|حسابك|حسابه|حسابها|صفحتي|صفحتك|صفحته|صفحتها|بروفايلي|البروفايل)\s*(?:على|في|ف|عبر)?\s*(?:${SOCIAL_PLATFORM_SOURCE})` +
    `)${PLATFORM_BOUNDARY_END}`,
  "iu",
);

/** "Find/add/contact me on <network>" is contact-sharing intent in any language. */
const CONTACT_INTENT_PATTERN = new RegExp(
  `${PLATFORM_BOUNDARY_START}(?:` +
    String.raw`(?:find|add|contact|reach|message|dm|text|call|follow|look)\s+me\s+(?:up\s+)?(?:on|at|via|through)\s+(?:${SOCIAL_PLATFORM_SOURCE})` +
    `|` +
    String.raw`(?:تواصلوا|تواصل|راسلوني|راسلني|تابعوني|أضيفوني|اضيفوني|ابحثوا\s+عني|ابحث\s+عني)\s*(?:على|في|عبر)\s*(?:${SOCIAL_PLATFORM_SOURCE})` +
    `)${PLATFORM_BOUNDARY_END}`,
  "iu",
);

/**
 * Words that are never a person's name in this context. Their purpose is to keep ordinary
 * discussion ("Facebook is useful", "Instagram marketing", "WhatsApp group") out of the
 * detector while still catching "Facebook Bilal Karbach".
 */
const NAME_STOPWORDS = new Set(
  [
    // articles, prepositions, pronouns, auxiliaries
    "a", "an", "the", "and", "or", "but", "if", "then", "than", "so", "as", "at",
    "by", "for", "from", "in", "into", "of", "off", "on", "onto", "out", "over",
    "per", "to", "up", "via", "with", "within", "without", "is", "are", "was",
    "were", "be", "been", "being", "am", "do", "does", "did", "have", "has", "had",
    "will", "would", "can", "could", "should", "may", "might", "must", "i", "me",
    "my", "mine", "we", "us", "our", "ours", "you", "your", "yours", "he", "him",
    "his", "she", "her", "hers", "it", "its", "they", "them", "their", "theirs",
    "this", "that", "these", "those", "here", "there", "where", "when", "what",
    "who", "whom", "whose", "which", "how", "why", "yes", "no", "not", "ok",
    "okay", "please", "thanks", "thank", "hello", "hi", "hey", "bye",
    // time and quantity
    "all", "any", "some", "more", "most", "much", "many", "few", "lot", "very",
    "just", "only", "also", "too", "now", "soon", "later", "today", "tonight",
    "tomorrow", "yesterday", "week", "weekend", "month", "year", "morning",
    "afternoon", "evening", "night", "day", "days", "time", "monday", "tuesday",
    "wednesday", "thursday", "friday", "saturday", "sunday", "january",
    "february", "march", "april", "may", "june", "july", "august", "september",
    "october", "november", "december",
    // social-media vocabulary
    "page", "pages", "group", "groups", "account", "accounts", "profile",
    "profiles", "business", "marketing", "advertising", "ads", "ad", "promotion",
    "promotions", "course", "courses", "training", "coach", "coaching", "club",
    "clubs", "gym", "sport", "sports", "app", "apps", "website", "link", "links",
    "post", "posts", "story", "stories", "video", "videos", "photo", "photos",
    "picture", "pictures", "reel", "reels", "live", "event", "events", "update",
    "updates", "news", "feed", "chat", "message", "messages", "friends", "login",
    "support", "help", "privacy", "settings", "contact", "official", "verified",
    "public", "private", "online", "offline", "useful", "good", "great", "best",
    "nice", "bad", "amazing", "awesome", "terrible", "boring", "interesting",
    "important", "popular", "available", "free", "paid", "easy", "hard",
    "difficult", "fun", "cool", "weird", "rocks", "sucks", "new", "feature",
    "features", "tip", "tips", "guide", "guides", "tutorial", "tutorials",
    "review", "reviews", "beta", "version", "launch",
    // platform names (so "Facebook Messenger" is not a name)
    "facebook", "fb", "messenger", "instagram", "insta", "ig", "whatsapp",
    "telegram", "tiktok", "snapchat", "linkedin",
    // French
    "est", "c'est", "mon", "ma", "mes", "notre", "nos", "ton", "ta", "tes",
    "votre", "vos", "son", "sa", "ses", "le", "la", "les", "un", "une", "des",
    "du", "de", "au", "aux", "et", "ou", "pour", "sur", "dans", "avec", "sans",
    "je", "tu", "il", "elle", "nous", "vous", "ils", "elles", "ce", "cette",
    "ces", "qui", "que", "quoi", "dont", "où", "comment", "pourquoi", "oui",
    "non", "merci", "bonjour", "salut", "compte", "profil", "groupe",
    "publication", "publications", "vidéo", "vidéos", "cours", "entraînement",
    "salle", "formation", "utile", "utiles", "génial", "super", "nul", "bien",
    // Arabic
    "في", "على", "عن", "من", "الى", "إلى", "مع", "بدون", "هذا", "هذه", "ذلك",
    "تلك", "هو", "هي", "هم", "نحن", "أنا", "انا", "كان", "كانت", "يكون", "هل",
    "لا", "نعم", "ربما", "شكرا", "شكراً", "مرحبا", "السلام", "عليكم", "صفحة",
    "مجموعة", "تطبيق", "موقع", "رابط", "روابط", "منشور", "منشورات", "صورة",
    "صور", "فيديو", "فيديوهات", "قناة", "تسويق", "تدريب", "مدرب", "نادي",
    "رياضة", "جيد", "جيدة", "رائع", "مفيد", "سيء", "اليوم", "غدا", "غداً",
    "الآن", "الان", "الأسبوع", "الشهر", "السنة", "صباحا", "مساء", "ليلا",
    "خلال", "حول", "بشأن", "أثناء", "اثناء",
  ].map((word) => word.toLowerCase()),
);

const NAME_WORD_PATTERN = /^[\p{L}][\p{L}'-]{1,30}$/u;

function classifySocialPlatform(provider: string): {
  kind: ModerationMatchKind;
  label: string;
} {
  const compact = provider.toLowerCase().replace(/\s+/g, "");

  if (
    compact.startsWith("face") ||
    compact.startsWith("fays") ||
    compact.startsWith("fes") ||
    compact === "fb" ||
    compact === "fcb" ||
    compact === "fcbk" ||
    compact === "facbook" ||
    compact.includes("messenger") ||
    compact.includes("فيس") ||
    compact.includes("فايسبوك")
  ) {
    return { kind: "FACEBOOK", label: "Facebook" };
  }
  if (compact.startsWith("insta") || compact === "ig" || compact.includes("انست")) {
    return { kind: "INSTAGRAM", label: "Instagram" };
  }
  if (
    compact.startsWith("tele") ||
    compact === "tg" ||
    compact.includes("تلغرام") ||
    compact.includes("تيلي")
  ) {
    return { kind: "TELEGRAM", label: "Telegram" };
  }
  if (
    compact.includes("whats") ||
    compact.includes("wats") ||
    compact.includes("واتس") ||
    compact.includes("وتساب")
  ) {
    return { kind: "WHATSAPP", label: "WhatsApp" };
  }
  return { kind: "SOCIAL_PROFILE", label: "Social profile" };
}

function findPlatform(value: string): string | null {
  return SOCIAL_PLATFORM_TEST.exec(value)?.[1] ?? null;
}

/**
 * Does the text directly after a platform name look like a person's account name?
 *
 * Two name tokens ("Facebook Bilal Karbach") are enough. A single token needs an explicit
 * separator/account connector ("facebook: bilal", "facebook account bilal") or a
 * capitalised Latin name ("Facebook Bilal"). Stopwords keep ordinary discussion legal.
 */
function hasNameAfterPlatform(suffix: string): boolean {
  const immediate = suffix.split(/[.!?؟\n]/, 1)[0]?.trimStart() ?? "";
  if (immediate.startsWith("@")) {
    return true;
  }

  let rest = immediate;
  let connectorKind: "separator" | "account" | "verb" | null = null;

  const separator = /^(?::|=|–|—|-)\s*/u.exec(rest);
  if (separator) {
    connectorKind = "separator";
    rest = rest.slice(separator[0].length).trimStart();
  } else {
    const wordConnector =
      /^(is|c'est|est|account|profile|page|compte|profil|حساب|صفحة)(?![\p{L}\p{N}])\s*/iu.exec(
        rest,
      );
    if (wordConnector) {
      const connector = wordConnector[1]!.toLowerCase();
      connectorKind = ["is", "c'est", "est"].includes(connector)
        ? "verb"
        : "account";
      rest = rest.slice(wordConnector[0].length).trimStart();
    }
  }

  // "Facebook Messenger", "Instagram and TikTok", ... are not names.
  if (SOCIAL_PLATFORM_TEST.test(rest)) {
    return false;
  }

  const tokens: string[] = [];
  for (const raw of rest.split(/\s+/).slice(0, 3)) {
    const word = raw.replace(/^[,;:.!?؟]+|[,;:.!?؟]+$/g, "");
    if (!NAME_WORD_PATTERN.test(word)) {
      break;
    }
    if (NAME_STOPWORDS.has(word.toLowerCase())) {
      break;
    }
    tokens.push(word);
  }

  if (tokens.length >= 2) {
    return true;
  }

  if (tokens.length === 1) {
    if (connectorKind === "separator" || connectorKind === "account") {
      return true;
    }
    // Latin names are capitalised; Arabic script has no case, so it needs two tokens or
    // an explicit account cue (see STRONG_ACCOUNT_CUE_PATTERN).
    return /^\p{Lu}/u.test(tokens[0]!);
  }

  return false;
}

function detectNamedSocialProfile(
  value: string,
): { kind: ModerationMatchKind; label: string } | null {
  for (const match of value.matchAll(
    new RegExp(
      `${PLATFORM_BOUNDARY_START}(${SOCIAL_PLATFORM_SOURCE})${PLATFORM_BOUNDARY_END}`,
      "giu",
    ),
  )) {
    const provider = match[1];
    const suffix = value.slice((match.index ?? 0) + match[0].length);
    if (provider && hasNameAfterPlatform(suffix)) {
      return classifySocialPlatform(provider);
    }
  }
  return null;
}

const ARABIC_INDIC_DIGITS = /[\u0660-\u0669]/g;
const EXTENDED_ARABIC_INDIC_DIGITS = /[\u06f0-\u06f9]/g;

function toAsciiDigits(value: string): string {
  return value
    .replace(ARABIC_INDIC_DIGITS, (digit) =>
      String(digit.charCodeAt(0) - 0x0660),
    )
    .replace(EXTENDED_ARABIC_INDIC_DIGITS, (digit) =>
      String(digit.charCodeAt(0) - 0x06f0),
    );
}

/**
 * Normalize the forms people actually type: full-width characters, zero-width spaces,
 * Arabic-Indic digits, `[at]`/`(dot)` and `example dot com`.
 *
 * Normalization is only used for detection - the persisted message always keeps the
 * exact text the sender wrote.
 */
function normalizeForDetection(value: string): string {
  return (
    toAsciiDigits(value.normalize("NFKC"))
      .replace(/[\u200b-\u200d\ufeff]/gi, "")
      .replace(/[．。｡]/g, ".")
      .replace(/[＠]/g, "@")
      .replace(/[\[({<]\s*(?:at|@)\s*[\])}>]/gi, "@")
      .replace(/[\[({<]\s*(?:dot|\.)\s*[\])}>]/gi, ".")
      .replace(/(?<=\w)\s*\(\s*at\s*\)\s*(?=\w)/gi, "@")
      .replace(/(?<=\w)\s+dot\s+(?=\w)/gi, ".")
      .replace(/(?<=\w)\s+at\s+(?=[\w-]+\s*(?:\.|dot)\s*[\w-]+)/gi, "@")
      // `.` used as an obfuscated dot: `fb[.]me`, `fb(.)me`.
      .replace(/[\[({<]\s*\.\s*[\])}>]/g, ".")
      // Split/space-obfuscated network names: "face book", "insta gram", ...
      .replace(/\bface\s+book\b/gi, "facebook")
      .replace(/\bwhats\s+app\b/gi, "whatsapp")
      .replace(/\binsta\s+gram\b/gi, "instagram")
      .replace(/\btele\s+gram\b/gi, "telegram")
      // Letter-spaced bypasses ("f a c e b o o k") for detection only.
      .replace(/\b(?:[\p{L}]\s+){3,}[\p{L}]\b/gu, (chunk) =>
        chunk.replace(/\s+/g, ""),
      )
      // Collapse the spaces left by `coach [at] example [dot] com` so the email pattern
      // sees a contiguous address. Detection-only; the stored text is untouched.
      .replace(/\s*@\s*/g, "@")
      .replace(/\s*\.\s*(?=[a-z]{2,}\b)/gi, ".")
  );
}

/** Remove dates/times before phone detection so "2026-10-19 10:00" is not a phone. */
function stripDatesAndTimes(value: string): string {
  return value
    .replace(
      /\b\d{4}-\d{2}-\d{2}(?:[t ]\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:z|[+-]\d{2}:?\d{2})?)?\b/gi,
      " ",
    )
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, " ")
    .replace(/\b\d{1,2}[/.]\d{1,2}[/.]\d{2,4}\b/g, " ");
}

/**
 * 9-15 digits, optionally grouped with spaces/dots/dashes/parentheses/slashes.
 * A bare 9-15 digit run is still treated as a phone (foreign numbers often omit `+`).
 */
const PHONE_PATTERN = /(?<!\d)(?:\+|00)?\d(?:[\s().\/-]?\d){8,14}(?!\d)/g;

function detectPhone(text: string): string | null {
  const candidates = stripDatesAndTimes(text).match(PHONE_PATTERN) ?? [];

  for (const candidate of candidates) {
    const digits = candidate.replace(/\D/g, "");
    if (digits.length < 9 || digits.length > 15) {
      continue;
    }

    const international = /^\s*(?:\+|00)/.test(candidate);
    const hasSeparator = /[\s().\/-]/.test(candidate.trim());
    // A bare short run (9 digits) is usually an ID/reference, not a phone; require either
    // an international prefix, an explicit separator, or at least 10 digits.
    if (!international && !hasSeparator && digits.length < 10) {
      continue;
    }

    return candidate.trim();
  }

  return null;
}

/**
 * Detect off-platform contact details in a message. Returns at most one match per kind,
 * without echoing the matched value (so warnings/logs never repeat a phone number).
 */
export function detectOffPlatformContact(value: string): ModerationMatch[] {
  const normalized = normalizeForDetection(value);
  const matches: ModerationMatch[] = [];
  const seen = new Set<ModerationMatchKind>();

  const push = (kind: ModerationMatchKind, label: string): void => {
    if (seen.has(kind)) {
      return;
    }
    seen.add(kind);
    matches.push({ kind, label });
  };

  for (const domain of SOCIAL_DOMAINS) {
    if (domain.pattern.test(normalized)) {
      push(domain.kind, domain.label);
    }
  }

  if (EMAIL_PATTERN.test(normalized)) {
    push("EMAIL", "Email address");
  }

  if (SOCIAL_HANDLE_PATTERN.test(normalized)) {
    push("SOCIAL_HANDLE", "Social handle");
  }

  // "hada hsabi facebook ...", "حسابي على فيسبوك ..."
  const cue = STRONG_ACCOUNT_CUE_PATTERN.exec(normalized);
  const cuePlatform = cue ? findPlatform(cue[0]) : null;
  if (cuePlatform) {
    const account = classifySocialPlatform(cuePlatform);
    push(account.kind, account.label);
  }

  // "find me on facebook", "تابعوني على فيسبوك"
  const intent = CONTACT_INTENT_PATTERN.exec(normalized);
  const intentPlatform = intent ? findPlatform(intent[0]) : null;
  if (intentPlatform) {
    const account = classifySocialPlatform(intentPlatform);
    push(account.kind, account.label);
  }

  // "Facebook Bilal Karbach", "facebook: bilal", ...
  const profile = detectNamedSocialProfile(normalized);
  if (profile) push(profile.kind, profile.label);

  if (detectPhone(normalized)) {
    push("PHONE", "Phone number");
  }

  return matches;
}

export function getModerationPolicy(): ModerationPolicy {
  return env.MESSAGE_MODERATION_POLICY;
}

export function isModerationEnabled(): boolean {
  return env.MESSAGE_MODERATION_ENABLED === "true";
}

/**
 * Classify a message according to the configured policy.
 *
 * `policy`/`enabled` can be supplied explicitly by tests and by future per-account
 * overrides; production callers rely on the validated environment.
 */
export function moderateMessageText(
  value: string,
  options: { policy?: ModerationPolicy; enabled?: boolean } = {},
): ModerationOutcome {
  const policy = options.policy ?? getModerationPolicy();
  const enabled = options.enabled ?? isModerationEnabled();

  if (!enabled) {
    return { action: "ALLOW", policy, matches: [] };
  }

  const matches = detectOffPlatformContact(value);
  if (matches.length === 0) {
    return { action: "ALLOW", policy, matches };
  }

  const action: ModerationAction =
    policy === "block" ? "BLOCK" : policy === "flag" ? "FLAG" : "WARN";

  return { action, policy, matches };
}

/**
 * Throw the documented API error for a blocked message. Kept here so REST and Socket.IO
 * produce the same message and details.
 */
export function assertMessageNotBlocked(outcome: ModerationOutcome): void {
  if (outcome.action !== "BLOCK") {
    return;
  }

  throw ApiError.unprocessableEntity(
    "Sharing phone numbers, email addresses or social-media contacts is not allowed in this conversation.",
    { moderation: { policy: outcome.policy, matches: outcome.matches } },
  );
}

// ---------------------------------------------------------------------------
// Admin review queue
// ---------------------------------------------------------------------------

const FLAG_INCLUDE = {
  message: { select: { id: true, body: true, createdAt: true } },
  sender: { select: { id: true, name: true, displayName: true } },
  reviewedBy: { select: { id: true, name: true, displayName: true } },
} as const;

export async function listModerationFlags(
  query: AdminListModerationFlagsQuery,
): Promise<{ flags: AdminMessageFlagResponse[]; total: number }> {
  const where =
    query.reviewed === "true"
      ? { reviewedAt: { not: null } }
      : query.reviewed === "false"
        ? { reviewedAt: null }
        : {};

  const [rows, total] = await prisma.$transaction(async (tx) => {
    const flags = await tx.messageModerationFlag.findMany({
      where,
      include: FLAG_INCLUDE,
      orderBy: [
        { reviewedAt: { sort: "asc", nulls: "first" } },
        { createdAt: "desc" },
      ],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    const count = await tx.messageModerationFlag.count({ where });
    return [flags, count] as const;
  });

  return { flags: rows.map(toAdminMessageFlagResponse), total };
}

export async function reviewModerationFlag(
  adminId: string,
  flagId: string,
  input: ReviewModerationFlagBody,
): Promise<AdminMessageFlagResponse> {
  const existing = await prisma.messageModerationFlag.findUnique({
    where: { id: flagId },
    select: { id: true, reviewedAt: true },
  });

  if (!existing) {
    throw ApiError.notFound("Moderation flag not found");
  }

  if (existing.reviewedAt) {
    throw ApiError.conflict("This moderation flag has already been reviewed");
  }

  const updated = await prisma.messageModerationFlag.update({
    where: { id: flagId },
    data: {
      reviewedAt: new Date(),
      reviewedById: adminId,
      reviewNote: input.note ?? null,
    },
    include: FLAG_INCLUDE,
  });

  return toAdminMessageFlagResponse(updated);
}
