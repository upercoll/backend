const jwt = require("jsonwebtoken");
const Raffle = require("../models/Raffle");
const Customer = require("../models/Customer");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");
const raffleSvc = require("../services/raffleService");

const TYPES = raffleSvc.TYPES;

/** Hard ceiling on a single prize — the owner's rule: nothing over $100. */
const MAX_PRIZE = 100;

/** Read the customer token when present without forcing a login (public page). */
async function optionalCustomer(req) {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) return null;
    const decoded = jwt.verify(header.split(" ")[1], process.env.JWT_SECRET);
    if (decoded.type !== "customer") return null;
    const customer = await Customer.findById(decoded.id).select("+active");
    if (!customer || !customer.active) return null;
    return customer;
  } catch {
    return null;
  }
}

function publicWinners(raffle) {
  if (!raffle) return [];
  return (raffle.winners || []).map((w) => ({
    position: w.position,
    name: raffleSvc.maskName(w.name),
    tickets: w.tickets,
    prize: w.prize,
    claimed: w.claimed,
  }));
}

/* ── Public ────────────────────────────────────────────────────────────── */

/** GET /api/raffles/current?type=weekly — the live page payload. */
exports.getCurrent = catchAsync(async (req, res) => {
  const type = TYPES.includes(req.query.type) ? req.query.type : "weekly";
  const settings = await raffleSvc.getSettings();
  const cadence = settings.schedule[type];
  if (!cadence || !cadence.enabled) {
    return res.json({ success: true, data: { raffle: null, disabled: true } });
  }

  const raffle = await raffleSvc.getCurrentRaffle(type);
  if (!raffle) return res.json({ success: true, data: { raffle: null } });

  // Live leaderboard for this period (also how tickets/rank are computed).
  const leaderboard = await raffleSvc.aggregateEntries({
    startsAt: raffle.startsAt,
    endsAt: raffle.endsAt,
    ticketRate: settings.ticketRate,
  });
  const totalTickets = leaderboard.reduce((s, e) => s + e.tickets, 0);

  const customer = await optionalCustomer(req);
  let me = null;
  if (customer) {
    const idx = leaderboard.findIndex((e) => e.email === customer.email.toLowerCase());
    me = {
      name: customer.robloxUsername || customer.email,
      tickets: idx >= 0 ? leaderboard[idx].tickets : 0,
      rank: idx >= 0 ? idx + 1 : null,
    };
  }

  const last = await Raffle.findOne({ type, status: "drawn" }).sort({ number: -1 });

  res.json({
    success: true,
    data: {
      raffle: {
        id: raffle._id,
        type: raffle.type,
        number: raffle.number,
        status: raffle.status,
        startsAt: raffle.startsAt,
        endsAt: raffle.endsAt,
        prizePool: raffle.prizePool,
        topPrize: raffle.prizeTiers[0] || 0,
        winnerCount: raffle.prizeTiers.length,
      },
      settings: {
        ticketRate: settings.ticketRate,
        about: settings.about,
        // The public page renders the cadence's auto-draw schedule line.
        schedule: { day: cadence.day, hour: cadence.hour, autoDraw: cadence.autoDraw !== false },
      },
      entrants: leaderboard.length,
      totalTickets,
      me,
      recentWinners: publicWinners(last),
      lastDraw: last
        ? { number: last.number, drawnAt: last.drawnAt, entrants: last.totalEntrants }
        : null,
    },
  });
});

/** GET /api/raffles/me — my tickets everywhere + my trophy case. */
exports.getMe = catchAsync(async (req, res) => {
  const email = req.customer.email.toLowerCase();
  const settings = await raffleSvc.getSettings();

  const tickets = {};
  for (const type of TYPES) {
    tickets[type] = 0;
    if (!settings.schedule?.[type]?.enabled) continue;
    const raffle = await Raffle.findOne({ type, status: "active" });
    tickets[type] = await raffleSvc.getMyTickets(raffle, email);
  }

  const draws = await Raffle.find({ "winners.email": email, status: "drawn" })
    .sort({ drawnAt: -1 })
    .limit(24);
  const wins = draws.map((d) => {
    const w = d.winners.find((x) => x.email === email);
    return {
      raffleId: d._id,
      type: d.type,
      number: d.number,
      position: w.position,
      prize: w.prize,
      tickets: w.tickets,
      drawnAt: d.drawnAt,
      claimed: w.claimed,
      claimedAt: w.claimedAt,
      promoCode: w.promoCode,
    };
  });

  res.json({ success: true, data: { tickets, wins } });
});

/** POST /api/raffles/:id/claim — winner claims; mints a store credit code. */
exports.claim = catchAsync(async (req, res) => {
  const result = await raffleSvc.claimPrize(req.params.id, req.customer);
  res.json({ success: true, data: result });
});

/* ── Admin (panel) ─────────────────────────────────────────────────────── */

/** GET /api/panel/raffles — recent draws across all types. */
exports.adminList = catchAsync(async (req, res) => {
  const draws = await Raffle.find({})
    .sort({ endsAt: -1 })
    .limit(30)
    .select("-entries");
  res.json({ success: true, data: draws });
});

/** GET /api/panel/raffles/summary?type=weekly — the admin tab payload. */
exports.adminSummary = catchAsync(async (req, res) => {
  const type = TYPES.includes(req.query.type) ? req.query.type : "weekly";
  await raffleSvc.ensureRaffles();
  const settings = await raffleSvc.getSettings();
  const current = await Raffle.findOne({ type }).sort({ number: -1 }).select("-entries");
  const last = await Raffle.findOne({ type, status: "drawn" }).sort({ number: -1 }).select("-entries");

  // Live top-of-board while the draw is open (entries only exist after a
  // draw, so the admin sees the same live aggregation the public page does).
  let leaderboard = [];
  if (current && current.status === "active") {
    leaderboard = (
      await raffleSvc.aggregateEntries({
        startsAt: current.startsAt,
        endsAt: current.endsAt,
        ticketRate: settings.ticketRate,
      })
    ).slice(0, 20);
  }

  res.json({ success: true, data: { current, last, settings, leaderboard } });
});

/** GET /api/panel/raffles/:id — one draw with full entries + winners. */
exports.adminGetDraw = catchAsync(async (req, res) => {
  const draw = await Raffle.findById(req.params.id);
  if (!draw) throw new AppError("Raffle not found", 404);
  res.json({ success: true, data: draw });
});

/** POST /api/panel/raffles/:id/draw — run the draw now, early. */
exports.adminDrawNow = catchAsync(async (req, res) => {
  const raffle = await Raffle.findById(req.params.id);
  if (!raffle) throw new AppError("Raffle not found", 404);
  if (raffle.status === "drawn") throw new AppError("This raffle was already drawn", 400);
  if (raffle.status === "drawing") throw new AppError("A draw is already in progress", 400);
  const drawn = await raffleSvc.drawRaffle(raffle);
  if (!drawn) throw new AppError("This raffle was drawn by another process", 400);
  res.json({ success: true, data: { id: drawn._id, winners: drawn.winners.length } });
});

/** POST /api/panel/raffles/:id/winners — hand-pick a winner.
    The owner can name any entrant as a winner instead of (or after) the
    random draw. Position fills the next open slot; prize defaults to that
    slot's tier unless a custom amount is sent. Works on an open raffle or a
    drawn one, so a forgotten winner can still be added. */
exports.adminAddWinner = catchAsync(async (req, res) => {
  const { email, prize } = req.body || {};
  if (!email || typeof email !== "string" || !email.includes("@")) {
    throw new AppError("A valid winner email is required", 400);
  }
  const raffle = await Raffle.findById(req.params.id);
  if (!raffle) throw new AppError("Raffle not found", 404);
  if (raffle.status === "drawing") throw new AppError("A draw is in progress — try again", 400);

  const normalized = email.trim().toLowerCase();
  if (raffle.winners.some((w) => w.email === normalized)) {
    throw new AppError("That person is already a winner of this raffle", 400);
  }

  // Live entry for this person — proves they were actually in the draw and
  // gives us their real ticket count + Roblox name. Counted with the CURRENT
  // rate so it matches the leaderboard the owner is looking at.
  const settings = await raffleSvc.getSettings();
  const entry = await raffleSvc.aggregateEntries({
    startsAt: raffle.startsAt,
    endsAt: raffle.endsAt,
    ticketRate: settings.ticketRate,
    email: normalized,
  }).then((rows) => rows[0] || null);
  if (!entry) throw new AppError("That email has no tickets in this raffle", 400);

  // Next open position, priced by its tier unless overridden.
  const position = raffle.winners.length + 1;
  const amount = prize !== undefined && prize !== null && prize !== "" ? Number(prize) : raffle.prizeTiers[position - 1];
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new AppError("Prize must be a positive amount", 400);
  }
  if (amount > MAX_PRIZE) throw new AppError(`No single prize can exceed $${MAX_PRIZE}`, 400);

  raffle.winners.push({
    email: normalized,
    name: entry.name,
    tickets: entry.tickets,
    spent: entry.spent,
    prize: amount,
    position,
    claimed: false,
  });
  raffle.winners.sort((a, b) => a.position - b.position);
  await raffle.save();
  res.json({ success: true, data: { winners: raffle.winners.length, position } });
});

/** DELETE /api/panel/raffles/:id/winners/:email — undo a hand-picked winner.
    Claimed winners are locked: a real credit code is already out there, so
    pulling the row would hide a live prize. Positions are renumbered so the
    prize ladder stays contiguous. */
exports.adminRemoveWinner = catchAsync(async (req, res) => {
  const email = String(req.params.email || "").trim().toLowerCase();
  const raffle = await Raffle.findById(req.params.id);
  if (!raffle) throw new AppError("Raffle not found", 404);

  const row = raffle.winners.find((w) => w.email === email);
  if (!row) throw new AppError("That person is not a winner of this raffle", 404);
  if (row.claimed) throw new AppError("That prize is already claimed — it can't be removed", 400);

  raffle.winners = raffle.winners.filter((w) => w.email !== email);
  raffle.winners.forEach((w, i) => { w.position = i + 1; });
  await raffle.save();
  res.json({ success: true, data: { winners: raffle.winners.length } });
});

/** POST /api/panel/raffles/:id/void — cancel a raffle that should never
    produce winners (bad orders, a test period). Empties every prize and
    marks it drawn, so nothing is claimable and the next period opens. */
exports.adminVoid = catchAsync(async (req, res) => {
  const raffle = await Raffle.findById(req.params.id);
  if (!raffle) throw new AppError("Raffle not found", 404);
  if (raffle.status === "drawing") throw new AppError("A draw is in progress — try again", 400);
  if (raffle.winners.some((w) => w.claimed)) {
    throw new AppError("Winners have already claimed — this raffle can't be voided", 400);
  }
  raffle.winners = [];
  raffle.status = "drawn";
  raffle.drawnAt = new Date();
  await raffle.save();
  res.json({ success: true, data: { id: raffle._id, status: raffle.status } });
});

/** GET /api/panel/raffles/settings */
exports.adminGetSettings = catchAsync(async (req, res) => {
  const settings = await raffleSvc.getSettings();
  res.json({ success: true, data: settings });
});

/** Validate + normalize one cadence's tier ladder (shared with hand-picks). */
function cleanTiers(tiers) {
  if (!Array.isArray(tiers) || tiers.length < 1 || tiers.length > 100) {
    throw new AppError("Prize tiers must be a list of 1–100 amounts", 400);
  }
  const clean = tiers.map((t) => Number(t));
  if (clean.some((t) => !Number.isFinite(t) || t <= 0)) {
    throw new AppError("Every prize tier must be a positive amount", 400);
  }
  if (clean.some((t) => t > MAX_PRIZE)) {
    throw new AppError(`No single prize can exceed $${MAX_PRIZE}`, 400);
  }
  // Descending ladder — the UI reads position-by-position, so an accidental
  // out-of-order amount would silently price the wrong slot.
  const sorted = [...clean].sort((a, b) => b - a);
  if (sorted.some((t, i) => t !== clean[i])) {
    throw new AppError("Prize tiers must be listed highest first", 400);
  }
  return clean;
}

/** PUT /api/panel/raffles/settings — the admin's auto schedule.
    Body: { enabled?, ticketRate?, about?, schedule?: { weekly?: {day, hour,
    autoDraw, tiers}, monthly?: {…} } }. Tier/amount changes take effect on the
    NEXT draws and instantly reprice OPEN ones; a day/hour change moves the
    open draw's endsAt to the new boundary (entries already earned stay).
    Existing drawn results are never rewritten. */
exports.adminUpdateSettings = catchAsync(async (req, res) => {
  const { enabled, ticketRate, about, schedule } = req.body || {};
  const settings = await raffleSvc.getSettings();

  if (enabled && typeof enabled === "object") {
    for (const t of TYPES) {
      if (typeof enabled[t] === "boolean") settings.schedule[t].enabled = enabled[t];
    }
  }
  if (ticketRate !== undefined) {
    const n = Number(ticketRate);
    if (!Number.isFinite(n) || n <= 0 || n > 1000) throw new AppError("Ticket rate must be between 0.01 and 1000", 400);
    settings.ticketRate = n;
  }
  if (about !== undefined) {
    if (typeof about !== "string" || about.length > 1200) throw new AppError("About text must be under 1200 characters", 400);
    settings.about = about;
  }

  // Per-cadence schedule: day (weekly 0–6 / monthly 1–31), hour (UTC),
  // auto-draw flag, and that cadence's prize ladder (= winner count).
  const scheduleChanges = [];
  if (schedule && typeof schedule === "object") {
    for (const t of TYPES) {
      const patch = schedule[t];
      if (!patch || typeof patch !== "object") continue;
      const cadence = settings.schedule[t];
      const before = { tiers: [...cadence.tiers], day: cadence.day, hour: cadence.hour };

      if (patch.day !== undefined) {
        const n = Math.floor(Number(patch.day));
        const lo = t === "weekly" ? 0 : 1;
        const hi = t === "weekly" ? 6 : 31;
        if (!Number.isFinite(n) || n < lo || n > hi) {
          throw new AppError(
            t === "weekly"
              ? "Weekly draw day must be 0–6 (0 = Sunday)"
              : "Monthly draw day must be 1–31",
            400
          );
        }
        cadence.day = n;
      }
      if (patch.hour !== undefined) {
        const n = Math.floor(Number(patch.hour));
        if (!Number.isFinite(n) || n < 0 || n > 23) throw new AppError("Draw hour must be 0–23 (UTC)", 400);
        cadence.hour = n;
      }
      if (patch.autoDraw !== undefined) cadence.autoDraw = !!patch.autoDraw;
      if (patch.tiers !== undefined) cadence.tiers = cleanTiers(patch.tiers);

      scheduleChanges.push({
        type: t,
        tiersChanged: patch.tiers !== undefined && JSON.stringify(before.tiers) !== JSON.stringify(cadence.tiers),
        timeChanged: cadence.day !== before.day || cadence.hour !== before.hour,
      });
    }
  }

  await settings.save();

  // Amounts take effect immediately on OPEN draws too — the owner edits the
  // ladder and the live ticket shows the new pool right away. Finished draws
  // keep whatever they were drawn with (and hand-picked prizes are never
  // rewritten either).
  for (const change of scheduleChanges) {
    const cadence = settings.schedule[change.type];
    if (change.tiersChanged) {
      await Raffle.updateMany(
        { status: "active", type: change.type },
        { $set: { prizeTiers: cadence.tiers, prizePool: cadence.tiers.reduce((s, t) => s + t, 0) } }
      );
    }
    // Moving the schedule re-times the OPEN draw's close (startsAt is kept so
    // tickets already earned stay in the draw); the next period follows the
    // new cadence fully.
    if (change.timeChanged) {
      const { endsAt } = raffleSvc.periodWindow(change.type, new Date(), cadence);
      await Raffle.updateMany(
        { status: "active", type: change.type },
        { $set: { endsAt } }
      );
    }
  }

  res.json({ success: true, data: settings });
});

/** POST /api/panel/raffles/ensure — open any missing current periods (seed). */
exports.adminEnsure = catchAsync(async (req, res) => {
  await raffleSvc.ensureRaffles();
  res.json({ success: true, data: { ok: true } });
});
