const Setting = require("../models/Setting");

/** Round to cents. All money in this codebase goes through this. */
function money(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * Sales-tax configuration.
 *
 * Previously the panel had a tax toggle that stored `salesTaxRate` /
 * `taxEnabled` and NOTHING ever read them — order totals were calculated with
 * no tax at all. This is the single place the rate is resolved so checkout,
 * the storefront display and the admin breakdown cannot disagree.
 */
async function getTaxSettings() {
  const s = await Setting.findOne()
    .select("salesTaxRate taxLabel taxEnabled")
    .lean()
    .catch(() => null);

  const rate = Number(s?.salesTaxRate);
  return {
    enabled: !!s?.taxEnabled && Number.isFinite(rate) && rate > 0,
    rate: Number.isFinite(rate) ? Math.max(0, Math.min(100, rate)) : 0,
    label: String(s?.taxLabel || "Sales Tax"),
  };
}

/**
 * Tax is charged on the amount actually payable AFTER any promo discount —
 * taxing a pre-discount amount would overcharge customers and inflate the
 * Stripe charge.
 */
function calculateTax(taxableAmount, tax) {
  if (!tax?.enabled || !(tax.rate > 0)) return 0;
  // Never tax a negative base — a discount larger than the cart would
  // otherwise produce negative tax AND a negative total.
  const base = Math.max(0, Number(taxableAmount) || 0);
  return money(base * (tax.rate / 100));
}

/**
 * Full order pricing, computed server-side from DB product prices + a
 * server-side promo lookup + the stored tax rate. The browser never supplies
 * any of these numbers.
 */
function buildPricing({ subtotal, discount, tax }) {
  // Clamp: a discount can never exceed the subtotal, so the payable amount is
  // floored at 0 no matter what the caller passes in.
  const afterDiscount = Math.max(0, money(subtotal - discount));
  const taxAmount = calculateTax(afterDiscount, tax);
  return {
    subtotal: money(subtotal),
    discount: money(discount),
    tax: taxAmount,
    taxLabel: taxAmount > 0 ? tax.label : "",
    total: money(afterDiscount + taxAmount),
  };
}

module.exports = { money, getTaxSettings, calculateTax, buildPricing };