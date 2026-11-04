// Runtime configuration — injected at container start by docker-entrypoint.sh.
// This file is a template. The entrypoint rewrites it with the actual
// API_BASE_URL before Next.js starts. Keeping it in source control with a
// safe default so the app works in development without Docker.
// When API_BASE_URL is empty (default), all API requests go through the
// Next.js BFF proxy at /api/*, avoiding CORS and keeping backend URLs internal.
window.__RUNTIME_CONFIG__ = {
  API_BASE_URL: ''
};
