import { randomUUID } from 'node:crypto';

import type { RequestHandler } from 'express';

/** Attach a correlation id to every request and echo it back to the client. */
export const requestId: RequestHandler = (req, res, next) => {
  const headerValue = req.headers['x-request-id'];
  const incoming = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  const id = incoming && incoming.trim().length > 0 && incoming.length <= 128 ? incoming : randomUUID();

  req.requestId = id;
  res.setHeader('X-Request-Id', id);
  next();
};
