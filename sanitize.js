const sanitizeHtml = require('sanitize-html');

// Allowlist for admin-edited HTML (About blurb + Privacy policy).
// Quill emits the basics; we accept those plus a small set of common formatting tags.
// Strips <script>, <style>, on* attrs, javascript: hrefs, etc.
const RICH_TEXT_OPTIONS = {
  allowedTags: [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'p', 'br', 'hr', 'div', 'span',
    'strong', 'em', 'u', 's', 'b', 'i',
    'ul', 'ol', 'li',
    'blockquote', 'pre', 'code',
    'a', 'img',
  ],
  allowedAttributes: {
    'a':   ['href', 'target', 'rel'],
    'img': ['src', 'alt', 'title', 'width', 'height'],
    '*':   ['class', 'style'],
  },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesByTag: { img: ['http', 'https', 'data'] },
  allowedStyles: {
    '*': {
      'color':            [/^#(0x)?[0-9a-f]+$/i, /^rgb\(/, /^rgba\(/],
      'background-color': [/^#(0x)?[0-9a-f]+$/i, /^rgb\(/, /^rgba\(/],
      'text-align':       [/^left$|^right$|^center$|^justify$/],
      'font-size':        [/^[\d.]+(px|em|rem|%)$/],
      'font-weight':      [/^[1-9]00$|^bold$|^normal$/],
      'font-style':       [/^italic$|^normal$/],
      'text-decoration':  [/^underline$|^line-through$|^none$/],
      'margin':           [/^[\d.]+(px|em|rem|%)?\s*(.+)?$/],
      'padding':          [/^[\d.]+(px|em|rem|%)?\s*(.+)?$/],
    },
  },
  // Force any <a> we keep to be safe-ish for new tabs
  transformTags: {
    'a': sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer' }, true),
  },
};

function sanitizeRichText(html) {
  return sanitizeHtml(String(html || ''), RICH_TEXT_OPTIONS);
}

// Accept only http(s) URLs OR a same-site /uploads/... path. Anything else (javascript:,
// data:, file:, etc.) is replaced with empty string. Used for facebook_url, image_url,
// logo_url admin fields where the value flows into href/src attributes.
function safeUrl(s) {
  s = String(s || '').trim();
  if (!s) return '';
  if (s.startsWith('/uploads/') && !s.includes('..')) return s;
  if (/^https?:\/\//i.test(s)) {
    try {
      // Reject if URL parsing fails (catches malformed input)
      new URL(s);
      return s;
    } catch { return ''; }
  }
  return '';
}

module.exports = { sanitizeRichText, safeUrl };
