/**
 * Single source of truth for "how much money did we actually keep".
 *
 * Every revenue / totalSpent / commission figure in the API must be derived
 * from these, never from a raw `$sum: "$pricing.total"`:
 *
 *   - `pricing.total` never accounts for refunds, so a refunded order used to
 *     show up as revenue at full price.
 *   - `PAID_STATUSES` deliberately contains "refunded" (a refunded order WAS
 *     paid), which means the paid filter happily matched refunded orders too.
 *   - `items.totalPrice` is the pre-discount line total, so per-product /
 *     per-game sums ignored promo discounts entirely — and commission rates
 *     applied to those sums were paid on money that never existed.
 *
 * NET_REVENUE clamps at 0 so a bad `refundAmount` can never produce negative
 * revenue. REVENUE_FILTER additionally drops fully refunded orders outright,
 * which covers orders whose status was flipped to "refunded" without a
 * recorded refundAmount.
 */

const PAID_STATUSES = ["paid", "delivering", "completed", "refunded", "partially_refunded"];

/** "Was this order paid at some point?" — for COUNTS, not for money. */
const PAID_FILTER = {
  $or: [{ "payment.status": "succeeded" }, { status: { $in: PAID_STATUSES } }],
};

/**
 * MERCHANDISE revenue — what the owner actually keeps.
 *
 * Order totals now include sales tax (`pricing.total === subtotal - discount +
 * tax`). Tax is collected on the customer's behalf and has to be remitted, so
 * it is NOT revenue and must never reach a revenue figure or a commission
 * base. Refunds are subtracted because that money left too.
 */
const MERCHANDISE_TOTAL = {
  $subtract: [
    { $ifNull: ["$pricing.total", 0] },
    { $ifNull: ["$pricing.tax", 0] },
  ],
};

/** Revenue the owner keeps: merchandise minus refunds, floored at 0. */
const NET_REVENUE = {
  $max: [0, { $subtract: [MERCHANDISE_TOTAL, { $ifNull: ["$refundAmount", 0] }] }],
};

/**
 * What a customer actually spent (gross of tax, net of refunds). Used for
 * "total spent" summaries, which should match Customer.totalSpent.
 */
const NET_SPENT = {
  $max: [0, { $subtract: ["$pricing.total", { $ifNull: ["$refundAmount", 0] }] }],
};

/** Paid + not fully refunded. Use for every revenue sum. */
const REVENUE_FILTER = { ...PAID_FILTER, status: { $ne: "refunded" } };

/**
 * Stages to place AFTER the initial $match and BEFORE $unwind: "$items".
 * Adds `netShare` = net order revenue / subtotal so each order's items can be
 * scaled down by the promo discount (and any partial refund). The parts then
 * sum back exactly to NET_REVENUE for that order.
 */
const NET_ITEM_STAGES = [
  { $match: { status: { $ne: "refunded" } } },
  {
    $project: {
      items: 1,
      netShare: {
        $cond: [
          { $gt: ["$pricing.subtotal", 0] },
          { $divide: [NET_REVENUE, "$pricing.subtotal"] },
          1,
        ],
      },
    },
  },
];

/** Value expression for a line item after NET_ITEM_STAGES. */
const NET_ITEM_VALUE = { $multiply: ["$items.totalPrice", "$netShare"] };

module.exports = {
  PAID_STATUSES,
  PAID_FILTER,
  NET_REVENUE,
  NET_SPENT,
  REVENUE_FILTER,
  NET_ITEM_STAGES,
  NET_ITEM_VALUE,
};
