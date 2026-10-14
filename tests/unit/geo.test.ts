import { describe, expect, it } from 'vitest';

import {
  EARTH_RADIUS_KM,
  RADIUS_MAX_KM,
  haversineDistanceKm,
  roundDistanceKm,
  toRadians,
} from '../../src/utils/geo.js';

/**
 * The distance search runs in SQL, but the same formula is implemented in
 * `utils/geo.ts`. These tests pin the numbers so the JavaScript implementation can be
 * compared against the database results (the integration suite asserts that parity
 * against real search responses).
 */
describe('haversineDistanceKm', () => {
  const berlin = { latitude: 52.520008, longitude: 13.404954 };
  const hamburg = { latitude: 53.551086, longitude: 9.993682 };

  it('returns 0 for identical coordinates', () => {
    expect(haversineDistanceKm(berlin, berlin)).toBe(0);
  });

  it('is symmetric', () => {
    expect(haversineDistanceKm(berlin, hamburg)).toBeCloseTo(haversineDistanceKm(hamburg, berlin), 10);
  });

  it('matches the known Berlin -> Hamburg great-circle distance (~255 km)', () => {
    expect(haversineDistanceKm(berlin, hamburg)).toBeCloseTo(255, 0);
  });

  it('matches one degree of latitude at the equator (~111.19 km)', () => {
    const distance = haversineDistanceKm({ latitude: 0, longitude: 0 }, { latitude: 1, longitude: 0 });
    expect(distance).toBeCloseTo(111.19, 1);
  });

  it('handles antipodal points (half the Earth circumference)', () => {
    const distance = haversineDistanceKm({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 180 });
    expect(distance).toBeCloseTo(Math.PI * EARTH_RADIUS_KM, 6);
  });

  it('handles longitudes that differ by more than 180 degrees without NaN', () => {
    const distance = haversineDistanceKm({ latitude: 10, longitude: -170 }, { latitude: -10, longitude: 170 });
    expect(Number.isFinite(distance)).toBe(true);
    expect(distance).toBeGreaterThan(0);
  });
});

describe('toRadians', () => {
  it('converts degrees to radians', () => {
    expect(toRadians(180)).toBeCloseTo(Math.PI, 12);
    expect(toRadians(0)).toBe(0);
  });
});

describe('roundDistanceKm', () => {
  it('rounds to metre precision', () => {
    expect(roundDistanceKm(1.23456)).toBe(1.235);
    expect(roundDistanceKm(0.0004)).toBe(0);
  });
});

describe('geo constants', () => {
  it('exposes sane bounds', () => {
    expect(EARTH_RADIUS_KM).toBe(6371);
    expect(RADIUS_MAX_KM).toBeGreaterThan(20_000 - 1);
  });
});
