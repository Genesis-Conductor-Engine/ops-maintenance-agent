/**
 * Sentry SvelteKit server hooks — copy into src/hooks.server.ts
 * Modern path: init lives in instrumentation.server.ts (≥2.31.0)
 */
import * as Sentry from "@sentry/sveltekit";

export const handleError = Sentry.handleErrorWithSentry();
export const handle = Sentry.sentryHandle();
