const crypto = require("crypto");
const Raffle = require("../models/Raffle");
const { RaffleSettings, DEFAULT_TIERS } = require("../models/Raffle");
const Order = require("../models/Order");
const PromoCode = require("../models/PromoCode");
const AppError = require("../utils/AppError");

/** Active cadences. "daily" is reserved in the schema for a future raffle. */
const TYPES = ["weekly", "monthly"];
const DAY = 24 * 3600 * 1000;

/** Default auto schedule per cadence (UTC): weekly on Monday, monthly on the
    1st — both draw at the moment the period closes. day: 0–6 (0 = Sunday) for
    weekly, 1–31 for monthly. */
const DEFAULT_SCHEDULE = {
  weekly: { enabled: true, day: 1, hour: 0, autoDraw: true },
  monthly: { enabled: true, day: 1, hour: 0, autoDraw: true },
};

function clampInt(n, lo, hi, fallback) {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
}

/* ── Draw lock ───────────────────────────────────────────────────────────
   Draw + period rollover both mutate settings counters and raffle status.
   Render runs a single process, so a promise chain is enough to stop two
   sweeps (cron + a public request hitting at the same second) racing; the
   atomic `status: active` flip below is the second line of defence.       */
let lockChain = Promise.resolve();
function withLock(fn) {
  const run = lockChain.then(fn, fn);
  lockChain = run.catch(() => {});
  return run;
}

/* ── Settings ─────────────────────────────────────────────────────────── */
async function getSettings() {
  let s = await RaffleSettings.findOne({ key: "raffle" });
  if (!s) s = await RaffleSettings.create({ key: "raffle" });
  // Back-fill the per-cadence schedule if an older settings doc predates it.
  let touched = false;
  for (const t of TYPES) {
    if (!s.schedule || !s.schedule[t]) {
      if (!s.schedule) s.schedule = {};
      s.schedule[t] = { ...DEFAULT_SCHEDULE[t] };
      touched = true;
    }
    if (!s.schedule[t].tiers || !s.schedule[t].tiers.length) {
      s.schedule[t].tiers = [...DEFAULT_TIERS];
      touched = true;
    }
  }
  if (touched) await s.save();
  return s;
}

/* ── Period windows (all UTC, matching the reference design) ─────────────
   weekly  -> next scheduled weekday+hour boundary (7-day window)
   monthly -> next scheduled day-of-month boundary (clamped to month length) */
function periodWindow(type, ref = new Date(), sched = {}) {
  const hour = clampInt(sched.hour, 0, 23, 0);
  const refMs = new Date(ref).getTime();

  if (type === "weekly") {
    const target = clampInt(sched.day, 0, 6, 1); // 1 = Monday
    const d = new Date(ref);
    const today = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    let start = today - ((d.getUTCDay() - target + 7) % 7) * DAY + hour * 3600 * 1000;
    if (start > refMs) start -= 7 * DAY; // this week's boundary hasn't happened yet
    return { startsAt: new Date(start), endsAt: new Date(start + 7 * DAY) };
  }

  // monthly - day-of-month boundary, clamped to the month's length (a "31st"
  // draw lands on the 28th/29th in February), at the scheduled hour.
  const target = clampInt(sched.day, 1, 31, 1);
  const boundary = (year, month) => {
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    return Date.UTC(year, month, Math.min(target, lastDay), hour);
  };
  const d = new Date(ref);
  let start = boundary(d.getUTCFullYear(), d.getUTCMonth());
  let end;
  if (start > refMs) {
    // this month's boundary hasn't happened yet → run last month's window
    start = boundary(d.getUTCFullYear(), d.getUTCMonth() - 1);
    end = boundary(d.getUTCFullYear(), d.getUTCMonth());
  } else {
    end = boundary(d.getUTCFullYear(), d.getUTCMonth() + 1);
  }
  return { startsAt: new Date(start), endsAt: new Date(end) };
}

/* ── Live ticket leaderboard ─────────────────────────────────────────────
   Tickets = floor(spend in period × ticketRate) per customer, from PAID
   orders only (pending / cancelled / refunded money never earns tickets). */
async function aggregateEntries({ startsAt, endsAt, ticketRate, email }) {
  const to = new Date(Math.min(Date.now(), endsAt.getTime()));
  const match = {
    createdAt: { $gte: startsAt, $lt: to },
    status: { $in: ["paid", "delivering", "completed"] },
  };
  if (email) match["customer.email"] = email;
  const rows = await Order.aggregate([
    { $match: match },
    { $sort: { createdAt: -1 } },
    {
      $group: {
        _id: "$customer.email",
        spent: { $sum: "$pricing.total" },
        name: { $last: "$customer.robloxUsername" },
      },
    },
    {
      $project: {
        email: "$_id",
        name: 1,
        spent: 1,
        tickets: { $floor: { $multiply: ["$spent", ticketRate] } },
        _id: 0,
      },
    },
    { $match: { tickets: { $gte: 1 } } },
    { $sort: { tickets: -1, spent: -1 } },
  ]);
  return rows;
}

/* ── The draw ─────────────────────────────────────────────────────────────
   Weighted pick without replacement, crypto RNG. Each customer can win at
   most once per draw; every remaining entry keeps its full weight after a
   pick (standard "no-repeat raffle").                                    */
function weightedPick(entries, taken) {
  const pool = entries.filter((e) => !taken.has(e.email));
  if (!pool.length) return null;
  const total = pool.reduce((s, e) => s + e.tickets, 0);
  let r = crypto.randomInt(1, total + 1);
  for (const e of pool) {
    r -= e.tickets;
    if (r <= 0) return e;
  }
  return pool[pool.length - 1];
}

async function drawRaffle(raffle) {
  // Atomic flip — if another sweep already took it, do nothing.
  const live = await Raffle.findOneAndUpdate(
    { _id: raffle._id, status: "active" },
    { $set: { status: "drawing" } },
    { new: true }
  );
  if (!live) return null;

  try {
    // Draw under the CURRENT ticket rate (admin can retune mid-period — the
    // live page already counts with it); the result records what it ran with.
    const settings = await getSettings();
    live.ticketRate = settings.ticketRate;
    const entries = await aggregateEntries({ ...live.toObject(), ticketRate: settings.ticketRate });
    // Hand-picked winners (added by the owner while the raffle was open) keep
    // their slots and prizes — the random draw only fills what's left.
    const winners = [...live.winners].sort((a, b) => a.position - b.position);
    const taken = new Set(winners.map((w) => w.email));
    const maxWinners = Math.min(live.prizeTiers.length, entries.length);
    for (let i = winners.length; i < maxWinners; i++) {
      const w = weightedPick(entries, taken);
      if (!w) break;
      taken.add(w.email);
      winners.push({
        email: w.email,
        name: w.name,
        tickets: w.tickets,
        spent: w.spent,
        prize: live.prizeTiers[i],
        position: i + 1,
        claimed: false,
      });
    }
    winners.forEach((w, i) => { w.position = i + 1; });
    live.entries = entries;
    live.winners = winners;
    live.totalEntrants = entries.length;
    live.totalTickets = entries.reduce((s, e) => s + e.tickets, 0);
    live.status = "drawn";
    live.drawnAt = new Date();
    await live.save();
    return live;
  } catch (err) {
    // Put it back so the next sweep can retry instead of it being stuck.
    live.status = "active";
    await live.save();
    throw err;
  }
}

/* ── Rollover: draw whatever is due, then open the next period ─────────── */
async function ensureRaffles() {
  return withLock(async () => {
    const settings = await getSettings();
    const now = new Date();

    for (const type of TYPES) {
      const cadence = settings.schedule[type];
      if (!cadence || !cadence.enabled) continue;

      let current = await Raffle.findOne({ type }).sort({ number: -1 });

      // Auto-schedule: close + draw when the period ends. With autoDraw off,
      // tickets stop at endsAt but the draw waits for the admin's
      // "End & draw now" (the next period opens only after that draw).
      if (current && current.status === "active" && now >= current.endsAt) {
        if (cadence.autoDraw !== false) {
          await drawRaffle(current);
          current = null;
        }
      }
      if (!current || current.status === "drawn") {
        const { startsAt, endsAt } = periodWindow(type, now, cadence);
        if (endsAt <= now) continue; // safety: never open an already-closed window
        // Deterministic number: the counter can lag a seeded/rolled-back doc,
        // so always stay ahead of the highest number that already exists.
        const latest = await Raffle.findOne({ type }).sort({ number: -1 }).select("number");
        const number = Math.max(settings.counters[type] || 0, latest ? latest.number : 0) + 1;
        settings.counters[type] = number;
        await settings.save();
        const tiers = cadence.tiers && cadence.tiers.length ? [...cadence.tiers] : [...DEFAULT_TIERS];
        current = await Raffle.create({
          type,
          number,
          startsAt,
          endsAt,
          ticketRate: settings.ticketRate,
          prizeTiers: tiers,
          prizePool: tiers.reduce((a, b) => a + b, 0),
        });
      }
    }
    return true;
  });
}

/* ── Public helpers ─────────────────────────────────────────────────────── */
const MASK_KEEP = 2;
function maskName(name) {
  if (!name) return "•••";
  const n = String(name);
  if (n.length <= MASK_KEEP * 2) return n[0] + "*".repeat(Math.max(1, n.length - 1));
  const head = n.slice(0, MASK_KEEP);
  const tail = n.slice(-MASK_KEEP);
  return head + "*".repeat(n.length - MASK_KEEP * 2) + tail;
}

async function getCurrentRaffle(type) {
  await ensureRaffles();
  return Raffle.findOne({ type }).sort({ number: -1 });
}

async function getMyTickets(raffle, email) {
  if (!raffle || !email) return 0;
  const rows = await aggregateEntries({
    startsAt: raffle.startsAt,
    endsAt: raffle.endsAt,
    ticketRate: raffle.ticketRate,
    email,
  });
  return rows.length ? rows[0].tickets : 0;
}

/* ── Claim: turn a win into a real single-use store credit code ───────── */
async function claimPrize(raffleId, customer) {
  const raffle = await Raffle.findById(raffleId);
  if (!raffle) throw new AppError("Raffle not found", 404);
  if (raffle.status !== "drawn") throw new AppError("This raffle hasn't been drawn yet", 400);

  // Atomic claim: arrayFilters pins the EXACT winner row (this email AND
  // still unclaimed) — the positional `$` alone can match a different array
  // element when the clauses land on different rows, which would let a
  // double claim through and even claim someone else's prize.
  const email = customer.email.toLowerCase();
  const code = `RFL-${raffle.type[0].toUpperCase()}${raffle.number}-${crypto
    .randomBytes(3)
    .toString("hex")
    .toUpperCase()}`;

  const updated = await Raffle.findOneAndUpdate(
    { _id: raffle._id, status: "drawn" },
    {
      $set: {
        "winners.$[w].claimed": true,
        "winners.$[w].claimedAt": new Date(),
        "winners.$[w].promoCode": code,
      },
    },
    { new: true, arrayFilters: [{ "w.email": email, "w.claimed": false }] }
  );

  // Verify OUR code actually landed on THEIR row — if the array filter
  // matched nothing, the row still carries the old state (or doesn't exist).
  const row = updated?.winners?.find((x) => x.email === email);
  if (!row) throw new AppError("No winning ticket for this raffle", 404);
  if (row.promoCode !== code) throw new AppError("Prize already claimed", 400);

  const prize = row.prize;
  try {
    await PromoCode.create({
      code,
      description: `Raffle prize — ${raffle.type} #${raffle.number}`,
      discountType: "fixed",
      discountValue: prize,
      maxUses: 1,
      maxUsesPerUser: 1,
      active: true,
      expiresAt: new Date(Date.now() + 365 * DAY), // a year to spend it
    });
  } catch (err) {
    // Roll the claim back so they can retry instead of losing the prize.
    await Raffle.updateOne(
      { _id: raffle._id, "winners.promoCode": code },
      { $set: { "winners.$.claimed": false, "winners.$.claimedAt": null, "winners.$.promoCode": null } }
    );
    throw err;
  }
  return { code, amount: prize, type: raffle.type, number: raffle.number };
}

/* ── Sweep ──────────────────────────────────────────────────────────────── */
let sweepStarted = false;
function startRaffleScheduler(intervalMs = 60000) {
  if (sweepStarted) return;
  sweepStarted = true;
  // No run at boot — Render cold starts shouldn't pay for the aggregation.
  // The first public hit triggers ensureRaffles() anyway; the sweep just
  // makes rollover punctual even while nobody is browsing.
  setInterval(() => {
    ensureRaffles().catch((err) => console.error("[raffle sweep]", err.message));
  }, intervalMs);
}

module.exports = {
  TYPES,
  DEFAULT_SCHEDULE,
  getSettings,
  periodWindow,
  aggregateEntries,
  drawRaffle,
  ensureRaffles,
  getCurrentRaffle,
  getMyTickets,
  maskName,
  claimPrize,
  startRaffleScheduler,
};
