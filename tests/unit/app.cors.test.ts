import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';

describe('CORS configuration', () => {
  it('allows browser origins when FRONTEND_URL has a trailing slash', async () => {
    const response = await request(createApp())
      .options('/api/v1/sports')
      .set('Origin', 'http://localhost:4200')
      .set('Access-Control-Request-Method', 'GET');

    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:4200');
  });
});
