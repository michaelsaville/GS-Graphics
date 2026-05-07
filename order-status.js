// Centralized order status vocabulary + display helpers.
// Status is stored as a free-form VARCHAR in the DB; vocabulary enforced here.

const STATUSES = [
  { value: 'pending',    label: 'Pending payment', tone: 'inactive' },
  { value: 'paid',       label: 'Paid',            tone: 'active' },
  { value: 'processing', label: 'In production',   tone: 'info' },
  { value: 'ready',      label: 'Ready for pickup', tone: 'info' },
  { value: 'fulfilled',  label: 'Fulfilled',       tone: 'active' },
  { value: 'cancelled',  label: 'Cancelled',       tone: 'inactive' },
  { value: 'refunded',   label: 'Refunded',        tone: 'inactive' },
  { value: 'failed',     label: 'Payment failed',  tone: 'danger' },
];

const VALID = new Set(STATUSES.map(s => s.value));

function isValid(s) { return VALID.has(s); }

function info(s) {
  return STATUSES.find(x => x.value === s) || { value: s, label: s, tone: 'inactive' };
}

// Statuses operators are allowed to manually transition to via the admin UI.
// 'pending' and 'failed' are payment-flow internal — not exposed in the dropdown.
const MANUAL_CHOICES = ['paid', 'processing', 'ready', 'fulfilled', 'cancelled', 'refunded'];

module.exports = { STATUSES, MANUAL_CHOICES, isValid, info };
