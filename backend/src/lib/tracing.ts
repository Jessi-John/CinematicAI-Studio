/**
 * OpenTelemetry Tracing Initialization
 *
 * Provides distributed tracing across all backend services:
 * - Express route handlers
 * - Prisma database queries
 * - Redis operations
 * - AI provider API calls (Kimi, Mistral)
 *
 * Tracing is initialized before any other module loads, ensuring all spans
 * are properly correlated with a single trace ID.
 *
 * Environment variables:
 *   OTEL_EXPORTER_OTLP_ENDPOINT - OTLP collector endpoint (default: http://localhost:4318/v1/traces)
 *   OTEL_SERVICE_NAME - Service name for traces (default: cinematicai-backend)
 */

import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { PrismaInstrumentation } from '@prisma/instrumentation';
import { logger } from '../services/logger.js';

function getOtelEndpoint(): string {
  return process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318/v1/traces';
}

function getOtelServiceName(): string {
  return process.env.OTEL_SERVICE_NAME || 'cinematicai-backend';
}

const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter({
    url: getOtelEndpoint(),
  }),
  instrumentations: [
    getNodeAutoInstrumentations({
      // Disable fs instrumentation - too noisy
      '@opentelemetry/instrumentation-fs': { enabled: false },
      // Disable http instrumentation on Redis - not needed
      '@opentelemetry/instrumentation-http': { enabled: true },
    }),
    new PrismaInstrumentation(),
  ],
  serviceName: getOtelServiceName(),
});

// Start tracing before any other module loads
sdk.start();

logger.info({
  endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318/v1/traces',
  service: process.env.OTEL_SERVICE_NAME || 'cinematicai-backend',
}, 'OpenTelemetry tracing initialized');

// Graceful shutdown
process.on('SIGTERM', async () => {
  // L23: catch shutdown errors so a failed OTLP export can't produce an
  // unhandled rejection during process teardown.
  try {
    await sdk.shutdown();
    logger.info('OpenTelemetry tracing shutdown complete');
  } catch (err) {
    logger.error({ err }, 'OpenTelemetry tracing shutdown failed');
  }
});

export { sdk };
