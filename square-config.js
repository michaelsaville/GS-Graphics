const siteSettings = require('./site-settings');

// Square config priority: site_settings (DB-edited via /admin/settings) → env vars (fallback).
// Returns a normalized config object. Empty values stay empty so checkout can decide whether
// to short-circuit (sandbox-no-creds) or attempt a real Square call.
async function getSquareConfig() {
  let env = '', token = '', loc = '';
  try {
    const { square } = await siteSettings.load();
    if (square) {
      env   = square.environment || '';
      token = square.accessToken || '';
      loc   = square.locationId  || '';
    }
  } catch (e) { /* fall through */ }

  // Env fills any gaps left by DB
  env   = env   || process.env.SQUARE_ENVIRONMENT  || 'sandbox';
  token = token || process.env.SQUARE_ACCESS_TOKEN || '';
  loc   = loc   || process.env.SQUARE_LOCATION_ID  || '';

  // Treat the placeholder string from the original .env scaffold as "not configured"
  if (token === 'SQUARE_PLACEHOLDER') token = '';
  if (loc   === 'SQUARE_PLACEHOLDER') loc   = '';

  return {
    environment: env === 'production' ? 'production' : 'sandbox',
    accessToken: token,
    locationId:  loc,
    // The "is this a real configured Square?" check used by checkout to decide
    // between sandbox short-circuit vs. createPaymentLink call.
    isLive: env === 'production' && Boolean(token) && Boolean(loc),
    isConfigured: Boolean(token) && Boolean(loc),
  };
}

module.exports = { getSquareConfig };
