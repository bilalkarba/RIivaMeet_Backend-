import { prisma } from '../config/prisma.js';
import { ApiError } from '../utils/errors.js';
import { toBlockedUser, type BlockedUserResponse } from '../utils/presenters.js';

/**
 * Blocking service (Phase 2).
 *
 * A block is directional: `blocker` no longer wants to see or hear from `blocked`.
 * Blocking is idempotent and reversible; it never deletes the other account.
 *
 * Blocking rules enforced here and by callers:
 *  - a user cannot block themselves (400, mirrored by a CHECK constraint);
 *  - blocked users are removed from the blocker's discovery results (search,
 *    suggestions) and cannot message each other. Chat is a later phase; the shared
 *    `getRelatedUserIds` helper is the single source of truth both features use.
 */

export async function blockUser(blockerId: string, blockedId: string): Promise<BlockedUserResponse[]> {
  if (blockerId === blockedId) {
    throw ApiError.badRequest('You cannot block yourself');
  }

  const target = await prisma.user.findUnique({ where: { id: blockedId }, select: { id: true } });
  if (!target) {
    throw ApiError.notFound('User not found');
  }

  await prisma.block.upsert({
    where: { blockerId_blockedId: { blockerId, blockedId } },
    create: { blockerId, blockedId },
    update: {},
  });

  return listBlocks(blockerId);
}

export async function unblockUser(blockerId: string, blockedId: string): Promise<BlockedUserResponse[]> {
  const existing = await prisma.block.findUnique({
    where: { blockerId_blockedId: { blockerId, blockedId } },
    select: { id: true },
  });

  if (!existing) {
    throw ApiError.notFound('You are not blocking this user');
  }

  await prisma.block.delete({ where: { id: existing.id } });
  return listBlocks(blockerId);
}

export async function listBlocks(blockerId: string): Promise<BlockedUserResponse[]> {
  const rows = await prisma.block.findMany({
    where: { blockerId },
    include: { blocked: { select: { id: true, name: true, displayName: true, avatarUrl: true } } },
    orderBy: { createdAt: 'desc' },
  });

  return rows.map(toBlockedUser);
}

/**
 * Users the viewer blocked *or* who blocked the viewer. Used to keep blocked accounts
 * out of discovery and (later) out of chat.
 */
export async function getRelatedUserIds(userId: string): Promise<string[]> {
  const rows = await prisma.block.findMany({
    where: { OR: [{ blockerId: userId }, { blockedId: userId }] },
    select: { blockerId: true, blockedId: true },
  });

  const ids = new Set<string>();
  for (const row of rows) {
    ids.add(row.blockerId === userId ? row.blockedId : row.blockerId);
  }
  return [...ids];
}

/** True when either user has blocked the other (bidirectional). */
export async function isBlockedBetween(userA: string, userB: string): Promise<boolean> {
  if (userA === userB) {
    return false;
  }
  const row = await prisma.block.findFirst({
    where: {
      OR: [
        { blockerId: userA, blockedId: userB },
        { blockerId: userB, blockedId: userA },
      ],
    },
    select: { id: true },
  });
  return row !== null;
}
