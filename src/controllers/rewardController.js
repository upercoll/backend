const RewardClaim = require("../models/RewardClaim");
const PromoCode = require("../models/PromoCode");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");

/* ────────────────────────────────────────────────────────────────
 * Reward tables — MUST stay in sync with the frontend:
 *   SPEND_LEVELS / LEVEL_MILESTONES / SPIN_PRIZES live in
 *   frontend/src/pages/ProfilePage.tsx
 * The backend is authoritative: it recomputes the customer's level
 * from Customer.totalSpent and issues codes server-side, so nothing
 * here can be triggered by editing client JS.
 * ──────────────────────────────────────────────────────────────── */

const SPEND_LEVELS = [
  0, 3.13, 6.25, 9.38, 12.5, 20, 27.5, 35, 42.5, 50,
  60, 70, 80, 90, 100, 110, 120, 130, 140, 150,
  160, 170, 180, 190, 200, 210, 220, 230, 240, 250,
  300, 350, 400, 450, 500, 550, 600, 650, 700, 750,
  925, 1100, 1275, 1450, 1625, 1800, 1975, 2150, 2325, 2500,
];

const LEVEL_MILESTONES = {
  1: 5, 3: 7, 5: 10, 7: 12, 10: 14, 15: 15, 20: 18,
  25: 20, 30: 22, 35: 25, 40: 27, 45: 30, 50: 35,
};

const { randomInt } = require("crypto");

// Wheel segments in display order (index = wedge the wheel lands on)
const SPIN_SEGMENTS = [5, 10, 15, 20, 25, 30, 10, 5];

// Probability ladder — weights out of 1,000,000 (MUST match SPIN_WEIGHTS in
// frontend ProfilePage.tsx). Discounts above 20% are literally
// one-in-a-million each; everything scales down from 5%.
const SPIN_WEIGHTS = { 5: 450000, 10: 320000, 15: 150000, 20: 79998, 25: 1, 30: 1 };

function drawSpin() {
  let roll = randomInt(1000000); // crypto-grade, unbiased
  let value = 5;
  const ladder = [5, 10, 15, 20, 25, 30];
  for (let i = 0; i < ladder.length; i++) {
    roll -= SPIN_WEIGHTS[ladder[i]];
    if (roll < 0) { value = ladder[i]; break; }
  }
  const matches = [];
  for (let i = 0; i < SPIN_SEGMENTS.length; i++) {
    if (SPIN_SEGMENTS[i] === value) matches.push(i);
  }
  return { idx: matches[randomInt(matches.length)], value };
}

const SPIN_MIN_LEVEL = 10;
const REWARD_VALID_DAYS = 7;

function getLevel(totalSpent) {
  const spent = Number(totalSpent) || 0;
  for (let i = SPEND_LEVELS.length - 1; i >= 0; i--) {
    if (spent >= SPEND_LEVELS[i]) return i + 1;
  }
  return 1;
}

// One spin per UTC calendar day (Render runs UTC)
function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

const TOKEN_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L

function randToken(len = 6) {
  let out = "";
  for (let i = 0; i < len; i++) {
    out += TOKEN_ALPHABET[Math.floor(Math.random() * TOKEN_ALPHABET.length)];
  }
  return out;
}

/**
 * Create a one-time, personal percent-off PromoCode. Goes through the same
 * PromoCode collection the admin panel and checkout already use, so the
 * normal /api/promo/validate + payment redemption path just works.
 */
async function issuePromo({ prefix, value, description }) {
  const expiresAt = new Date(Date.now() + REWARD_VALID_DAYS * 24 * 60 * 60 * 1000);
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = `${prefix}-${randToken()}`;
    try {
      return await PromoCode.create({
        code,
        description,
        discountType: "percent",
        discountValue: value,
        minOrderValue: 0,
        maxUses: 1,
        maxUsesPerUser: 1,
        startsAt: null,
        expiresAt,
        active: true,
      });
    } catch (err) {
      // unique code collision — regenerate; anything else is fatal
      if (err && err.code === 11000 && attempt < 2) continue;
      throw err;
    }
  }
  throw new AppError("Could not issue reward code — please try again", 500);
}

function claimData(claim) {
  return {
    kind: claim.kind,
    level: claim.kind === "level" ? Number(claim.key.split(":")[1]) : null,
    label: claim.prizeLabel,
    discountValue: claim.discountValue,
    code: claim.promoCode,
    expiresAt: claim.expiresAt,
    claimedAt: claim.createdAt,
  };
}

const alreadySpun = (key) => ({
  status: 409,
  body: {
    success: false,
    message: "You already spun today — come back tomorrow",
    lastSpin: key,
  },
});

/**
 * POST /api/rewards/spin  (customer)
 * Server-side draw: the wheel's landing index comes from here, the daily
 * limit is enforced per customer per UTC day, and the prize is written to
 * the DB BEFORE we hand the code to the client.
 */
exports.spin = catchAsync(async (req, res, next) => {
  const customer = req.customer;
  const level = getLevel(customer.totalSpent);

  if (level < SPIN_MIN_LEVEL) {
    return next(new AppError(`Daily Spin unlocks at Level ${SPIN_MIN_LEVEL}`, 403));
  }

  const key = todayKey();
  const existing = await RewardClaim.findOne({
    customer: customer._id,
    kind: "spin",
    key,
  });
  if (existing) {
    const dup = alreadySpun(key);
    return res.status(dup.status).json(dup.body);
  }

  const { idx, value } = drawSpin();
  const label = `${value}% OFF`;

  const promo = await issuePromo({
    prefix: "SPIN",
    value,
    description: `Daily Spin reward — ${label}`,
  });

  let claim;
  try {
    claim = await RewardClaim.create({
      customer: customer._id,
      kind: "spin",
      key,
      prizeLabel: label,
      discountValue: value,
      promoCode: promo.code,
      promo: promo._id,
      expiresAt: promo.expiresAt,
    });
  } catch (err) {
    // lost a race for today's spin — roll the promo back, never double-issue
    await PromoCode.deleteOne({ _id: promo._id }).catch(() => {});
    if (err && err.code === 11000) {
      const dup = alreadySpun(key);
      return res.status(dup.status).json(dup.body);
    }
    throw err;
  }

  res.status(201).json({
    success: true,
    data: { idx, ...claimData(claim), lastSpin: key },
  });
});

/**
 * POST /api/rewards/claim-level  { level }  (customer)
 * Idempotent: re-requesting an already-claimed milestone returns the same
 * code instead of erroring, so the UI can safely retry.
 */
exports.claimLevel = catchAsync(async (req, res, next) => {
  const customer = req.customer;
  const level = parseInt(req.body && req.body.level, 10);
  const value = Number.isInteger(level) ? LEVEL_MILESTONES[level] : undefined;

  if (!value) return next(new AppError("That level is not a reward milestone", 400));

  const serverLevel = getLevel(customer.totalSpent);
  if (serverLevel < level) {
    return next(new AppError(`Reach Level ${level} to claim this reward`, 403));
  }

  const key = `level:${level}`;
  const existing = await RewardClaim.findOne({
    customer: customer._id,
    kind: "level",
    key,
  });
  if (existing) {
    return res.json({ success: true, data: claimData(existing), alreadyClaimed: true });
  }

  const label = `${value}% OFF`;
  const promo = await issuePromo({
    prefix: `L${level}`,
    value,
    description: `Level ${level} reward — ${label}`,
  });

  let claim;
  try {
    claim = await RewardClaim.create({
      customer: customer._id,
      kind: "level",
      key,
      prizeLabel: label,
      discountValue: value,
      promoCode: promo.code,
      promo: promo._id,
      expiresAt: promo.expiresAt,
    });
  } catch (err) {
    await PromoCode.deleteOne({ _id: promo._id }).catch(() => {});
    if (err && err.code === 11000) {
      const again = await RewardClaim.findOne({ customer: customer._id, kind: "level", key });
      if (again) {
        return res.json({ success: true, data: claimData(again), alreadyClaimed: true });
      }
    }
    throw err;
  }

  res.status(201).json({ success: true, data: claimData(claim) });
});

/**
 * GET /api/rewards/claims  (customer)
 * Everything the profile needs in one call: authoritative level, whether
 * today's spin is still available, and all claimed reward codes (so codes
 * survive logouts / other devices).
 */
exports.getClaims = catchAsync(async (req, res) => {
  const customer = req.customer;
  const key = todayKey();

  const claims = await RewardClaim.find({ customer: customer._id }).sort("-createdAt");
  const spunToday = claims.some((c) => c.kind === "spin" && c.key === key);
  const level = getLevel(customer.totalSpent);

  res.json({
    success: true,
    data: {
      level,
      canSpin: level >= SPIN_MIN_LEVEL && !spunToday,
      lastSpin: spunToday ? key : null,
      claims: claims.map(claimData),
    },
  });
});
