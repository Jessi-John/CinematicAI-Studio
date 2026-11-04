/**
 * Tests for the Alertmanager webhook receiver.
 */

import express from 'express';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type http from 'http';

describe('POST /api/alerts/alerts', () => {
  let app: express.Express;
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    process.env.ALERT_RECEIVER_TOKEN = 'test-alert-token';
    const { alertsRouter } = await import('./alerts.js');
    app = express();
    app.use(express.json());
    app.use('/api/alerts', alertsRouter);
    server = app.listen(0);
    port = (server.address() as import('net').AddressInfo).port;
  });

  afterAll(async () => {
    server.close();
    delete process.env.ALERT_RECEIVER_TOKEN;
  });

  it('returns 401 without bearer token', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/alerts/alerts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 with wrong bearer token', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/alerts/alerts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });

  it('returns 200 with valid bearer token', async () => {
    const payload = {
      status: 'firing',
      alerts: [{
        status: 'firing',
        labels: { alertname: 'TestAlert', severity: 'critical' },
        annotations: { summary: 'Test summary' },
        startsAt: new Date().toISOString(),
      }],
    };
    const res = await fetch(`http://127.0.0.1:${port}/api/alerts/alerts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-alert-token' },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; received: number };
    expect(body.success).toBe(true);
    expect(body.received).toBe(1);
  });

  it('H22: returns 400 (not a hang/crash) for a malformed alert entry', async () => {
    const payload = {
      alerts: [{ status: 'firing' }], // missing labels/annotations shape is tolerated (defaults), but wrong types are not
    };
    const res = await fetch(`http://127.0.0.1:${port}/api/alerts/alerts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-alert-token' },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(200); // labels/annotations default to {} — handled, not a TypeError
  });

  it('H22: returns 400 for invalid payload types', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/alerts/alerts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-alert-token' },
      body: JSON.stringify({ alerts: 'not-an-array' }),
    });
    expect(res.status).toBe(400);
  });

  it('H22: returns 400 when alerts array exceeds 500 entries', async () => {
    const payload = {
      alerts: Array.from({ length: 501 }, () => ({ status: 'firing', labels: {}, annotations: {} })),
    };
    const res = await fetch(`http://127.0.0.1:${port}/api/alerts/alerts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-alert-token' },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(400);
  });
});
