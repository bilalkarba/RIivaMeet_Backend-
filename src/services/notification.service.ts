import { prisma } from '../config/prisma.js';
import { NotificationType } from '../generated/prisma/enums.js';
import { toBookingNotificationResponse, type BookingNotificationResponse } from '../utils/presenters.js';

const NOTIFICATION_INCLUDE = {
  booking: {
    select: {
      startAt: true,
      endAt: true,
      client: { select: { name: true } },
    },
  },
} as const;

export async function listMyNotifications(
  recipientId: string,
): Promise<{ notifications: BookingNotificationResponse[]; unreadCount: number }> {
  const where = { recipientId, type: NotificationType.BOOKING_REQUEST };
  const [notifications, unreadCount] = await prisma.$transaction(async (tx) => {
    const items = await tx.notification.findMany({
      where,
      include: NOTIFICATION_INCLUDE,
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    const count = await tx.notification.count({ where: { ...where, readAt: null } });
    return [items, count] as const;
  });

  return { notifications: notifications.map(toBookingNotificationResponse), unreadCount };
}

export async function markMyNotificationsRead(recipientId: string): Promise<{ updatedCount: number }> {
  const result = await prisma.notification.updateMany({
    where: { recipientId, type: NotificationType.BOOKING_REQUEST, readAt: null },
    data: { readAt: new Date() },
  });

  return { updatedCount: result.count };
}
