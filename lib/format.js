// ----------------------------------------------------------------------------
// One place to decide how money is written.
//
// A point-of-sale screen that shows "5,000" without saying 5,000 of what is a
// real gap, not a cosmetic one — and the fix has to be in one file, because
// the moment the cashier's screen and the dashboard disagree about currency
// the numbers stop meaning anything. Change CURRENCY here and every total in
// the app follows.
//
// Note this is deliberately NOT applied to what the WebMCP tools return.
// Tools hand an agent raw numbers, which is the right shape for a machine to
// compute with; the string form is for the human reading the screen.
// ----------------------------------------------------------------------------

export const CURRENCY = 'IQD';

export function money(amount) {
  return `${Number(amount || 0).toLocaleString()} ${CURRENCY}`;
}

// For dense places (a table cell next to a column header that already says
// the currency) where repeating the code on every row is just noise.
export function amount(value) {
  return Number(value || 0).toLocaleString();
}
