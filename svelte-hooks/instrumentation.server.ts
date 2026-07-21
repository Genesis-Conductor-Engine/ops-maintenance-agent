/**
 * Sentry server instrumentation — copy into src/instrumentation.server.ts
 * Also enable in svelte.config.js:
 *   kit.experimental = { instrumentation: { server: true }, tracing: { server: true } }
 */
import * as Sentry from "@sentry/sveltekit";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV,
  release: process.env.SENTRY_RELEASE,
  sendDefaultPii: true,
  tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || "0.2"),
  enableLogs: true,
});
