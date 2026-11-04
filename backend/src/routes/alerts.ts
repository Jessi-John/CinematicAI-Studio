/**
 * Alert receiver for Prometheus/Alertmanager.
 *
 * Exposes a single webhook endpoint that:
 *   - authenticates Alertmanager via a shared bearer token (ALERT_RECEIVER_TOKEN)
 *   - logs every firing/resolved alert
 *   - optionally forwards the payload to ALERT_WEBHOOK_URL (Slack, PagerDuty, etc.)
 *
 * This avoids putting admin API keys in Alertmanager config and keeps the
 * alert path separate from user/admin routes.
 */

import { Router, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { logger } from '../services/logger.js';
import { getAlertWebhookUrl, getAlertReceiverToken } from '../config/env.js';
import { asyncHandler } from '../middleware/error.js';

const router = Router();

const alertSchema = z.object({
  status: z.enum(['firing', 'resolved']).optional(),
  alerts: z
    .array(
      z.object({
        status: z.enum(['firing', 'resolved']),
        labels: z.record(z.string(), z.string()).default({}),
        annotations: z.record(z.string(), z.string()).default({}),
        startsAt: z.string().optional(),
        endsAt: z.string().optional(),
      })
    )
    .max(500)
    .default([]),
});

type AlertPayload = z.infer<typeof alertSchema>;

// H22: dedicated limiter for the alerts endpoint — it is mounted OUTSIDE the
// rate-limited /api chain, so without this it gets unlimited unauthenticated
// 401 spam (log flooding) and, with a leaked token, unthrottled webhook
// amplification. Keyed on IP; 60/min is generous for Alertmanager retries.
const alertsLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many alert posts, slow down' },
});

function verifyAlertToken(req: Request, res: Response, next: () => void): void {
  const token = getAlertReceiverToken();
  if (!token) {
    res.status(503).json({ error: 'Alert receiver not configured' });
    return;
  }
  const header = req.headers.authorization || '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
  // Timing-safe comparison: compare HMAC digests so attacker cannot infer
  // the token length or correctness from response timing.
  const providedDigest = crypto.createHmac('sha256', 'alert-token').update(provided).digest();
  const expectedDigest = crypto.createHmac('sha256', 'alert-token').update(token).digest();
  if (providedDigest.length !== expectedDigest.length || !crypto.timingSafeEqual(providedDigest, expectedDigest)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

router.post('/alerts', alertsLimiter, verifyAlertToken, asyncHandler(async (req, res) => {
  // H22: validate the payload instead of casting — a malformed alert entry
  // (missing labels/annotations) previously threw a TypeError inside an
  // UNWRAPPED async handler, producing an unhandled rejection and a hung
  // request (sockets leak under Alertmanager retries).
  const parsed = alertSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: 'Invalid alert payload' });
    return;
  }
  const payload: AlertPayload = parsed.data;
  const alerts = payload.alerts;
  const externalUrl = getAlertWebhookUrl();

  for (const alert of alerts) {
    const logPayload = {
      status: alert.status,
      alertname: alert.labels['alertname'],
      severity: alert.labels['severity'],
      summary: alert.annotations['summary'],
      description: alert.annotations['description'],
    };
    if (alert.status === 'firing') {
      logger.error(logPayload, 'PROMETHEUS ALERT FIRING');
    } else {
      logger.info(logPayload, 'PROMETHEUS ALERT RESOLVED');
    }
  }

  if (externalUrl) {
    try {
      const response = await fetch(externalUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        logger.warn(
          { status: response.status, url: externalUrl },
          'External alert webhook returned non-2xx'
        );
      }
    } catch (err) {
      logger.warn({ err, url: externalUrl }, 'Failed to forward alert to external webhook');
    }
  }

  res.json({ success: true, received: alerts.length });
}));

export const alertsRouter = router;
