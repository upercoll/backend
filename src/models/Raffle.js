const mongoose = require("mongoose");

/**
 * Weekly / Monthly raffle draws.
 *
 * Every raffle is ONE document per draw period. Tickets are never stored
 * while a raffle is running — they're aggregated live from paid Orders
 * (every $1 spent = ticketRate tickets), so there's nothing to keep in sync
 * when an order is refunded or a period rolls over. At draw time the live
 * leaderboard is snapshotted into `entries` and the winners are picked from
 * that snapshot, so the result is auditable forever.
 *
 * Each cadence runs on an admin-defined SCHEDULE (day + hour UTC) with its
 * own prize ladder and winner count — the ladder's length IS the winner
 * count. A "daily" cadence is reserved (enum value kept) but not active.
 *
 * Winners get a real store-credit promo code on claim (PromoCode, fixed $,
 * single use) — the same codes the checkout already redeems.
 */
const raffleWinnerSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true },       // roblox username
    tickets: { type: Number, required: true, min: 1 },
    spent: { type: Number, required: true, min: 0 },          // USD in period
    prize: { type: Number, required: true, min: 0 },          // USD amount
    position: { type: Number, required: true, min: 1 },       // 1 = grand prize
    claimed: { type: Boolean, default: false },
    claimedAt: { type: Date, default: null },
    promoCode: { type: String, default: null },               // code given on claim
  },
  { _id: false }
);

const raffleEntrySchema = new mongoose.Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    tickets: { type: Number, required: true, min: 1 },
    spent: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const raffleSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ["weekly", "monthly", "daily"], required: true }, // "daily" reserved for a future cadence
    number: { type: Number, required: true, min: 1 },          // per-type sequence
    status: { type: String, enum: ["active", "drawing", "drawn"], default: "active" },

    startsAt: { type: Date, required: true },
    endsAt: { type: Date, required: true },
    drawnAt: { type: Date, default: null },

    // Snapshot of the settings this draw ran under — changing settings later
    // never rewrites history.
    ticketRate: { type: Number, required: true, min: 0.01 },
    prizeTiers: { type: [Number], required: true },            // prize by position
    prizePool: { type: Number, required: true, min: 0 },       // sum of tiers

    // Filled at draw time.
    entries: [raffleEntrySchema],
    winners: [raffleWinnerSchema],
    totalTickets: { type: Number, default: 0 },
    totalEntrants: { type: Number, default: 0 },
  },
  { timestamps: true }
);

raffleSchema.index({ type: 1, number: -1 });
raffleSchema.index({ status: 1, endsAt: 1 });
raffleSchema.index({ "winners.email": 1 });

/** Default prize ladder — 20 winners, $340 pool, grand prize $100 (the
    owner's hard ceiling). Length = winner count; admins can resize it. */
const DEFAULT_TIERS = [
  100, 75, 50, 25, 20, 15, 10, 10, 5, 5,
  5, 5, 3, 3, 2, 2, 2, 1, 1, 1,
];

/**
 * One cadence of the auto schedule, per raffle type.
 *   day   — weekly: day-of-week 0–6 (0 = Sunday); monthly: day-of-month 1–31
 *           (clamped to the month's length, so 31 → 28/29 in February)
 *   hour  — 0–23, UTC. The draw fires at this day+hour when the period ends.
 *   autoDraw — when false, the sweep does NOT draw at the period end: tickets
 *           stop at endsAt and the admin must press "End & draw now".
 *   tiers — prize by position; its length is the number of winners.
 */
const raffleCadenceSchema = new mongoose.Schema(
  {
    enabled: { type: Boolean, default: true },
    day: { type: Number, default: 1, min: 0, max: 31 },
    hour: { type: Number, default: 0, min: 0, max: 23 },
    autoDraw: { type: Boolean, default: true },
    tiers: { type: [Number], default: () => [...DEFAULT_TIERS] },
  },
  { _id: false }
);

/** Global raffle configuration. Singleton (key: "raffle"). */
const raffleSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, default: "raffle", unique: true },
    // Auto schedule — when each cadence closes (and therefore draws), its
    // prize ladder / winner count, and whether the sweep draws it alone.
    schedule: {
      weekly: { type: raffleCadenceSchema, default: () => ({ enabled: true, day: 1, hour: 0 }) },
      monthly: { type: raffleCadenceSchema, default: () => ({ enabled: true, day: 1, hour: 0 }) },
    },
    // Tickets earned per $1 spent on paid orders inside the period.
    ticketRate: { type: Number, default: 1, min: 0.01 },
    counters: {
      weekly: { type: Number, default: 0 },
      monthly: { type: Number, default: 0 },
    },
    about: {
      type: String,
      default:
        "Spend $1 or more for a chance to win up to $100 USD! Every week, twenty lucky " +
        "winners are randomly selected from everyone who ordered. If you win, simply click " +
        "Claim to collect your prize as a store credit code. Don't miss out — order now and " +
        "see if this draw is your lucky one!",
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Raffle", raffleSchema);
module.exports.RaffleSettings = mongoose.model("RaffleSettings", raffleSettingsSchema);
module.exports.DEFAULT_TIERS = DEFAULT_TIERS;
