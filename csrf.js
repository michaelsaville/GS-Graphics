const crypto = require('crypto');

const EXEMPT_PREFIXES = ['/webhooks/'];

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
  return submitted && req.session.csrfToken && submitted === req.session.csrfToken;
}

function reject(res) {
  return res.status(403).send('Invalid CSRF token. Please reload the page and try again.');
}

module.exports = { csrfMiddleware, csrfCheck };
