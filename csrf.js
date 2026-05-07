const crypto = require('crypto');

const EXEMPT_PREFIXES = ['/webhooks/', '/api/cron/'];

// App-level middleware: initializes token + enforces it for non-multipart requests.
// Multipart requests are deferred — req.body isn't populated until multer runs,
// so per-route handlers must call csrfCheck after their multer middleware.
function csrfMiddleware(req, res, next) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  res.locals.csrfToken = req.session.csrfToken;

  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (EXEMPT_PREFIXES.some(p => req.path.startsWith(p))) return next();

  const ct = req.get('content-type') || '';
  if (ct.startsWith('multipart/form-data')) return next();

  if (!isValid(req)) return reject(res);
  next();
}

// Per-route check, used after multer on multipart routes.
function csrfCheck(req, res, next) {
  if (!isValid(req)) return reject(res);
  next();
}

function isValid(req) {
  const submitted = (req.body && req.body._csrf) || req.get('x-csrf-token');
  const expected = req.session.csrfToken;
  if (!submitted || !expected) return false;
  // Constant-time compare. Lengths must match for timingSafeEqual.
  if (submitted.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(submitted), Buffer.from(expected));
  } catch {
    return false;
  }
}

function reject(res) {
  return res.status(403).send('Invalid CSRF token. Please reload the page and try again.');
}

module.exports = { csrfMiddleware, csrfCheck };
