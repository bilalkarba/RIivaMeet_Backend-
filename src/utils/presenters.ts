import type {
  BookingStatus,
  CallStatus,
  CallType,
  ExperienceLevel,
  ReportReason,
  ReportStatus,
  ReportTargetType,
  NotificationType,
  Role,
} from '../generated/prisma/enums.js';

/**
 * API presenters.
 *
 * Every response shape the API exposes is defined here, which guarantees:
 *  - `passwordHash` is never serialized;
 *  - money is serialized as a 2-decimal *string* (`"45.00"`) so JavaScript clients
 *    never lose precision to floating point;
 *  - dates are serialized as ISO 8601 strings;
 *  - internal columns (e.g. `userId` on reviews) stay out of public payloads unless
 *    the client legitimately needs them.
 */

interface DecimalLike {
  toFixed(digits?: number): string;
}

export function toMoneyString(value: DecimalLike | string | number | null | undefined): string {
  if (value === null || value === undefined) {
    return '0.00';
  }
  if (typeof value === 'number') {
    return value.toFixed(2);
  }
  if (typeof value === 'string') {
    return Number(value).toFixed(2);
  }
  return value.toFixed(2);
}

const toIso = (value: Date | string): string => (value instanceof Date ? value.toISOString() : new Date(value).toISOString());

export interface UserLike {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  role: Role;
  createdAt: Date;
  updatedAt: Date;
}

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  role: Role;
  hasCoachProfile: boolean;
  createdAt: string;
  updatedAt: string;
}

export function toPublicUser(user: UserLike, options?: { hasCoachProfile?: boolean }): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    phone: user.phone,
    role: user.role,
    hasCoachProfile: options?.hasCoachProfile ?? false,
    createdAt: toIso(user.createdAt),
    updatedAt: toIso(user.updatedAt),
  };
}

export interface AuthResponse {
  user: PublicUser;
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: string;
}

export interface SportSummary {
  id: string;
  name: string;
  slug: string;
}

export interface SportWithCoachCount extends SportSummary {
  coachCount: number;
}

export interface AvailabilitySlot {
  id: string;
  startAt: string;
  endAt: string;
  isAvailable: boolean;
}

export interface CoachProfileLike {
  id: string;
  userId: string;
  bio: string;
  certifications?: string[];
  hourlyPrice: DecimalLike | string | number;
  experienceLevel: ExperienceLevel;
  city: string;
  neighborhood: string;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  isPublished: boolean;
  createdAt: Date;
  updatedAt: Date;
  user?: { id: string; name: string; email?: string };
  sports?: { sport: SportSummary }[];
  availability?: { id: string; startAt: Date; endAt: Date; isAvailable: boolean }[];
  _count?: { bookings?: number; reviews?: number };
}

export interface CoachSummaryResponse {
  id: string;
  userId: string;
  name: string;
  bio: string;
  certifications: string[];
  hourlyPrice: string;
  experienceLevel: ExperienceLevel;
  city: string;
  neighborhood: string;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  isPublished: boolean;
  sports: SportSummary[];
  averageRating: number | null;
  reviewCount: number;
  distanceKm?: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface CoachDetailResponse extends CoachSummaryResponse {
  coachName: string;
  availability: AvailabilitySlot[];
  totalBookings?: number;
}

function toSportSummaries(sports?: { sport: SportSummary }[]): SportSummary[] {
  return (sports ?? [])
    .map(({ sport }) => ({ id: sport.id, name: sport.name, slug: sport.slug }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function toCoachSummary(
  coach: CoachProfileLike,
  metrics: { averageRating: number | null; reviewCount: number; distanceKm?: number | null },
): CoachSummaryResponse {
  return {
    id: coach.id,
    userId: coach.userId,
    name: coach.user?.name ?? 'Coach',
    bio: coach.bio,
    certifications: coach.certifications ?? [],
    hourlyPrice: toMoneyString(coach.hourlyPrice),
    experienceLevel: coach.experienceLevel,
    city: coach.city,
    neighborhood: coach.neighborhood,
    address: coach.address,
    latitude: coach.latitude,
    longitude: coach.longitude,
    isPublished: coach.isPublished,
    sports: toSportSummaries(coach.sports),
    averageRating: metrics.averageRating,
    reviewCount: metrics.reviewCount,
    ...(metrics.distanceKm === undefined ? {} : { distanceKm: metrics.distanceKm }),
    createdAt: toIso(coach.createdAt),
    updatedAt: toIso(coach.updatedAt),
  };
}

export function toCoachDetail(
  coach: CoachProfileLike,
  metrics: { averageRating: number | null; reviewCount: number; distanceKm?: number | null },
): CoachDetailResponse {
  const summary = toCoachSummary(coach, metrics);
  return {
    ...summary,
    coachName: coach.user?.name ?? 'Coach',
    availability: (coach.availability ?? []).map((slot) => ({
      id: slot.id,
      startAt: toIso(slot.startAt),
      endAt: toIso(slot.endAt),
      isAvailable: slot.isAvailable,
    })),
    ...(coach._count?.bookings === undefined ? {} : { totalBookings: coach._count.bookings }),
  };
}

export interface BookingLike {
  id: string;
  status: BookingStatus;
  startAt: Date;
  endAt: Date;
  priceAtBooking: DecimalLike | string | number;
  createdAt: Date;
  updatedAt: Date;
  client?: { id: string; name: string; email?: string };
  coachProfile?: {
    id: string;
    userId: string;
    city: string;
    neighborhood: string;
    hourlyPrice: DecimalLike | string | number;
    user?: { id: string; name: string };
  };
  review?: { id: string; rating: number; comment: string | null; createdAt: Date } | null;
}

export interface BookingResponse {
  id: string;
  status: BookingStatus;
  startAt: string;
  endAt: string;
  durationMinutes: number;
  priceAtBooking: string;
  createdAt: string;
  updatedAt: string;
  client: { id: string; name: string };
  coach: {
    coachProfileId: string;
    userId: string;
    name: string;
    city: string;
    neighborhood: string;
    hourlyPrice: string;
  };
  review: { id: string; rating: number; comment: string | null; createdAt: string } | null;
}

export interface BookingNotificationLike {
  id: string;
  type: NotificationType;
  readAt: Date | null;
  createdAt: Date;
  booking: {
    startAt: Date;
    endAt: Date;
    client: { name: string };
  };
}

export interface BookingNotificationResponse {
  id: string;
  type: NotificationType;
  bookingId: string;
  clientName: string;
  startAt: string;
  endAt: string;
  readAt: string | null;
  createdAt: string;
}

export function toBookingNotificationResponse(
  notification: BookingNotificationLike & { bookingId: string },
): BookingNotificationResponse {
  return {
    id: notification.id,
    type: notification.type,
    bookingId: notification.bookingId,
    clientName: notification.booking.client.name,
    startAt: toIso(notification.booking.startAt),
    endAt: toIso(notification.booking.endAt),
    readAt: notification.readAt ? toIso(notification.readAt) : null,
    createdAt: toIso(notification.createdAt),
  };
}

export function toBookingResponse(booking: BookingLike): BookingResponse {
  const start = booking.startAt instanceof Date ? booking.startAt : new Date(booking.startAt);
  const end = booking.endAt instanceof Date ? booking.endAt : new Date(booking.endAt);

  return {
    id: booking.id,
    status: booking.status,
    startAt: start.toISOString(),
    endAt: end.toISOString(),
    durationMinutes: Math.round((end.getTime() - start.getTime()) / 60_000),
    priceAtBooking: toMoneyString(booking.priceAtBooking),
    createdAt: toIso(booking.createdAt),
    updatedAt: toIso(booking.updatedAt),
    client: {
      id: booking.client?.id ?? '',
      name: booking.client?.name ?? 'Client',
    },
    coach: {
      coachProfileId: booking.coachProfile?.id ?? '',
      userId: booking.coachProfile?.userId ?? '',
      name: booking.coachProfile?.user?.name ?? 'Coach',
      city: booking.coachProfile?.city ?? '',
      neighborhood: booking.coachProfile?.neighborhood ?? '',
      hourlyPrice: toMoneyString(booking.coachProfile?.hourlyPrice ?? 0),
    },
    review: booking.review
      ? {
          id: booking.review.id,
          rating: booking.review.rating,
          comment: booking.review.comment,
          createdAt: toIso(booking.review.createdAt),
        }
      : null,
  };
}

export interface ReviewLike {
  id: string;
  bookingId: string;
  rating: number;
  comment: string | null;
  createdAt: Date;
  client?: { id: string; name: string };
}

export interface ReviewResponse {
  id: string;
  bookingId: string;
  rating: number;
  comment: string | null;
  createdAt: string;
  client: { id: string; name: string };
}

export function toReviewResponse(review: ReviewLike): ReviewResponse {
  return {
    id: review.id,
    bookingId: review.bookingId,
    rating: review.rating,
    comment: review.comment,
    createdAt: toIso(review.createdAt),
    client: { id: review.client?.id ?? '', name: review.client?.name ?? 'Client' },
  };
}

export interface RatingSummary {
  averageRating: number | null;
  reviewCount: number;
}

// ---------------------------------------------------------------------------
// Profiles (Phase 1)
// ---------------------------------------------------------------------------

export interface UserProfileLike {
  id: string;
  name: string;
  phone?: string | null;
  role: Role;
  displayName: string | null;
  avatarUrl: string | null;
  bio: string | null;
  city: string | null;
  country: string | null;
  level: ExperienceLevel | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProfileSportEntry {
  id: string;
  name: string;
  slug: string;
  level: ExperienceLevel | null;
}

export function toProfileSports(
  sports: { sport: SportSummary; level: ExperienceLevel | null }[] | undefined,
): ProfileSportEntry[] {
  return (sports ?? [])
    .map(({ sport, level }) => ({ id: sport.id, name: sport.name, slug: sport.slug, level }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The signed-in user's own profile (includes account-only fields). */
export interface SelfProfileResponse {
  id: string;
  name: string;
  displayName: string | null;
  avatarUrl: string | null;
  bio: string | null;
  city: string | null;
  country: string | null;
  level: ExperienceLevel | null;
  role: Role;
  phone: string | null;
  sports: ProfileSportEntry[];
  hasCoachProfile: boolean;
  coachProfileId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Another user's public profile. Deliberately omits email, phone and any moderation
 * or report data: personal data must never leak through public endpoints.
 */
export interface PublicProfileResponse {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  bio: string | null;
  city: string | null;
  country: string | null;
  level: ExperienceLevel | null;
  role: Role;
  sports: ProfileSportEntry[];
  isCoach: boolean;
  coachProfileId: string | null;
  memberSince: string;
}

export function toSelfProfile(
  user: UserProfileLike,
  sports: { sport: SportSummary; level: ExperienceLevel | null }[] | undefined,
  options: { coachProfileId?: string | null } = {},
): SelfProfileResponse {
  return {
    id: user.id,
    name: user.name,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    bio: user.bio,
    city: user.city,
    country: user.country,
    level: user.level,
    role: user.role,
    phone: user.phone ?? null,
    sports: toProfileSports(sports),
    hasCoachProfile: Boolean(options.coachProfileId),
    coachProfileId: options.coachProfileId ?? null,
    createdAt: toIso(user.createdAt),
    updatedAt: toIso(user.updatedAt),
  };
}

// ---------------------------------------------------------------------------
// Safety: blocks and reports (Phase 2)
// ---------------------------------------------------------------------------

export interface UserRef {
  id: string;
  name: string;
  displayName?: string | null;
  avatarUrl?: string | null;
}

function toUserRef(user: UserRef): { id: string; displayName: string; avatarUrl: string | null } {
  return { id: user.id, displayName: user.displayName ?? user.name, avatarUrl: user.avatarUrl ?? null };
}

export interface BlockedUserResponse {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  blockedAt: string;
}

export function toBlockedUser(block: { createdAt: Date; blocked: UserRef }): BlockedUserResponse {
  return { id: block.blocked.id, displayName: block.blocked.displayName ?? block.blocked.name, avatarUrl: block.blocked.avatarUrl ?? null, blockedAt: toIso(block.createdAt) };
}

/** A report as its own reporter sees it (no reviewer identity, no internal notes). */
export interface ReportResponse {
  id: string;
  targetType: ReportTargetType;
  targetId: string;
  targetUserId: string | null;
  reason: ReportReason;
  description: string | null;
  status: ReportStatus;
  resolutionNote: string | null;
  createdAt: string;
  updatedAt: string;
  reviewedAt: string | null;
}

/** Moderation view: adds who filed it and against whom. Admin-only. */
export interface AdminReportResponse extends ReportResponse {
  reporter: { id: string; displayName: string };
  targetUser: { id: string; displayName: string } | null;
  reviewedBy: { id: string; displayName: string } | null;
}

export interface ReportLike {
  id: string;
  targetType: ReportTargetType;
  targetId: string;
  targetUserId: string | null;
  reason: ReportReason;
  description: string | null;
  status: ReportStatus;
  resolutionNote: string | null;
  createdAt: Date;
  updatedAt: Date;
  reviewedAt: Date | null;
}

export function toReportResponse(report: ReportLike): ReportResponse {
  return {
    id: report.id,
    targetType: report.targetType,
    targetId: report.targetId,
    targetUserId: report.targetUserId,
    reason: report.reason,
    description: report.description,
    status: report.status,
    resolutionNote: report.resolutionNote,
    createdAt: toIso(report.createdAt),
    updatedAt: toIso(report.updatedAt),
    reviewedAt: report.reviewedAt ? toIso(report.reviewedAt) : null,
  };
}

export function toAdminReportResponse(
  report: ReportLike & {
    reporter: UserRef;
    targetUser?: UserRef | null;
    reviewedBy?: UserRef | null;
  },
): AdminReportResponse {
  return {
    ...toReportResponse(report),
    reporter: toUserRef(report.reporter),
    targetUser: report.targetUser ? toUserRef(report.targetUser) : null,
    reviewedBy: report.reviewedBy ? toUserRef(report.reviewedBy) : null,
  };
}

// ---------------------------------------------------------------------------
// Chat (Phase 3)
// ---------------------------------------------------------------------------

export interface MessageResponse {
  id: string;
  conversationId: string;
  senderId: string;
  body: string;
  createdAt: string;
}

export function toMessageResponse(message: {
  id: string;
  conversationId: string;
  senderId: string;
  body: string;
  createdAt: Date;
}): MessageResponse {
  return {
    id: message.id,
    conversationId: message.conversationId,
    senderId: message.senderId,
    body: message.body,
    createdAt: toIso(message.createdAt),
  };
}

/** Inbox entry: the other participant, the last message and an unread count. */
export interface ConversationResponse {
  id: string;
  participant: { id: string; displayName: string; avatarUrl: string | null };
  lastMessage: MessageResponse | null;
  unreadCount: number;
  lastMessageAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationLike {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  lastMessageAt: Date | null;
  participants: { userId: string; user: { id: string; name: string; displayName: string | null; avatarUrl: string | null } }[];
}

export function toConversationResponse(
  conversation: ConversationLike,
  viewerId: string,
  options: { lastMessage?: { id: string; conversationId: string; senderId: string; body: string; createdAt: Date } | null; unreadCount?: number } = {},
): ConversationResponse {
  const other = conversation.participants.find((participant) => participant.userId !== viewerId);
  const otherUser = other?.user;

  return {
    id: conversation.id,
    participant: {
      id: otherUser?.id ?? '',
      displayName: otherUser?.displayName ?? otherUser?.name ?? 'Unknown user',
      avatarUrl: otherUser?.avatarUrl ?? null,
    },
    lastMessage: options.lastMessage ? toMessageResponse(options.lastMessage) : null,
    unreadCount: options.unreadCount ?? 0,
    lastMessageAt: conversation.lastMessageAt ? toIso(conversation.lastMessageAt) : null,
    createdAt: toIso(conversation.createdAt),
    updatedAt: toIso(conversation.updatedAt),
  };
}

export function toPublicProfile(
  user: UserProfileLike,
  sports: { sport: SportSummary; level: ExperienceLevel | null }[] | undefined,
  options: { coachProfileId?: string | null } = {},
): PublicProfileResponse {
  return {
    id: user.id,
    displayName: user.displayName ?? user.name,
    avatarUrl: user.avatarUrl,
    bio: user.bio,
    city: user.city,
    country: user.country,
    level: user.level,
    role: user.role,
    sports: toProfileSports(sports),
    isCoach: Boolean(options.coachProfileId),
    coachProfileId: options.coachProfileId ?? null,
    memberSince: toIso(user.createdAt),
  };
}

// ---------------------------------------------------------------------------
// Calls (WebRTC signalling)
// ---------------------------------------------------------------------------

/**
 * A call as one participant sees it.
 *
 * `direction` is resolved per viewer (the same row is OUTGOING for the caller and
 * INCOMING for the callee), so the client never has to compare ids to render a log.
 * No media, SDP or ICE candidate is ever stored or returned.
 */
export interface CallResponse {
  id: string;
  conversationId: string;
  type: CallType;
  status: CallStatus;
  direction: 'OUTGOING' | 'INCOMING';
  caller: { id: string; displayName: string; avatarUrl: string | null };
  callee: { id: string; displayName: string; avatarUrl: string | null };
  startedAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  endedById: string | null;
}

export interface CallLike {
  id: string;
  conversationId: string;
  callerId: string;
  calleeId: string;
  type: CallType;
  status: CallStatus;
  startedAt: Date;
  answeredAt: Date | null;
  endedAt: Date | null;
  endedById: string | null;
  caller: UserRef;
  callee: UserRef;
}

export function toCallResponse(call: CallLike, viewerId: string): CallResponse {
  return {
    id: call.id,
    conversationId: call.conversationId,
    type: call.type,
    status: call.status,
    direction: call.callerId === viewerId ? 'OUTGOING' : 'INCOMING',
    caller: toUserRef(call.caller),
    callee: toUserRef(call.callee),
    startedAt: toIso(call.startedAt),
    answeredAt: call.answeredAt ? toIso(call.answeredAt) : null,
    endedAt: call.endedAt ? toIso(call.endedAt) : null,
    endedById: call.endedById,
  };
}

/** One ICE server entry as the browser's `RTCIceServer` expects it. */
export interface IceServerResponse {
  urls: string[];
  username?: string;
  credential?: string;
}

export interface CallConfigResponse {
  iceServers: IceServerResponse[];
  ringTimeoutMs: number;
}
