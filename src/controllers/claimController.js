const { v4: uuidv4 } = require("uuid");
const ClaimSession = require("../models/ClaimSession");
const AutoBotLog = require("../models/AutoBotLog");
const Order = require("../models/Order");
const Product = require("../models/Product");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");
const logger = require("../utils/logger");

function tryGetIO() {
  try {
    return require("../config/socket").getIO();
  } catch {
    return null;
  }
}

const AUTO_ONLY_GAMES = ["grow-a-garden-2"];
function isAutoOnlyGame(game) {
  return !!game && AUTO_ONLY_GAMES.includes(String(game).trim().toLowerCase());
}

async function logBot({ roomId, orderRef, robloxUsername, game, account, action, status, message, items }) {
  try {
    await AutoBotLog.create({
      roomId,
      orderRef,
      robloxUsername,
      game,
      account,
      action,
      status: status || "ok",
      message,
      items: (items || []).slice(0, 50),
    });
  } catch (err) {
    logger.error("Failed to write AutoBotLog:", err.message);
  }
}

const GENERIC_ITEM_NAMES = ["general claim", "claim chat"];
function isGenericName(name) {
  return !name || GENERIC_ITEM_NAMES.includes(name.trim().toLowerCase());
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Resolve a Roblox username to its numeric user ID via the official Roblox
 * users API (server-side, so the bot never has to ask for it manually).
 */
async function resolveRobloxUserId(username) {
  if (!username?.trim()) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch("https://users.roblox.com/v1/users/get-by-username", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request: username.trim() }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) return null;
    const data = await resp.json();
    return data?.id ? String(data.id) : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the most recent successfully-paid order for a customer using every
 * identifier the customer can realistically supply: orderRef (exact), email
 * (case-insensitive), or Roblox username (case-insensitive). Falls through in
 * that order so a mismatch in one field never loses the order.
 */
async function findPaidOrder({ orderRef, emailLower, robloxUsername }) {
  const base = { "payment.status": "succeeded" };
  const attempts = [];

  if (orderRef?.trim()) attempts.push({ ...base, orderNumber: orderRef.trim() });
  if (emailLower?.includes("@")) attempts.push({ ...base, "customer.email": emailLower });
  if (robloxUsername?.trim()) {
    attempts.push({ ...base, "customer.robloxUsername": { $regex: `^${escapeRegex(robloxUsername.trim())}$`, $options: "i" } });
  }

  for (const query of attempts) {
    const order = await Order.findOne(query).sort({ createdAt: -1 }).lean();
    if (order) return order;
  }
  return null;
}

/**
 * Build claim-session items from an order, enriching each item with the
 * category name from the Product/Category models so claim chats and the
 * auto-delivery bot always see "item + category" for GAG2 orders.
 */
async function enrichItemsFromOrder(order) {
  const items = order.items || [];
  const productIds = items.map(i => i.product).filter(Boolean);
  const products = productIds.length
    ? await Product.find({ _id: { $in: productIds } })
        .select("name game category")
        .populate("category", "name")
        .lean()
    : [];
  const productByMap = new Map(products.map(p => [String(p._id), p]));

  const enriched = items.map(i => {
    const product = i.product ? productByMap.get(String(i.product)) : null;
    // Prefer the snapshot taken at checkout; fall back to the live product
    // for older orders that predate productSnapshot.
    const name = i.productSnapshot?.name || product?.name || "";
    const game = i.productSnapshot?.game || product?.game || null;
    const category = i.product ? (product?.category?.name || null) : null;
    return {
      name,
      quantity: i.quantity || 1,
      ...(category ? { category } : {}),
      ...(game ? { game } : {}),
    };
  });

  return {
    items: enriched.filter(i => i.name && !isGenericName(i.name)),
    game: items[0]?.productSnapshot?.game || enriched[0]?.game || null,
  };
}

exports.createClaim = catchAsync(async (req, res, next) => {
  const { robloxUsername, contactEmail, orderRef, game, items, itemName } = req.body;

  if (!robloxUsername?.trim()) return next(new AppError("Roblox username is required", 400));
  if (!contactEmail?.includes("@")) return next(new AppError("Valid contact email is required", 400));

  const emailLower = contactEmail.trim().toLowerCase();

  // Resolve the customer's paid order from the database FIRST — the DB is the
  // single source of truth for items/category/game/orderRef. The frontend-sent
  // items are only a fallback when no paid order can be found (e.g. legacy
  // claims before the checkout finished confirming the payment).
  const dbOrder = await findPaidOrder({
    orderRef: orderRef?.trim() || null,
    emailLower,
    robloxUsername: robloxUsername?.trim() || null,
  });

  let resolvedItems = Array.isArray(items) ? items : [];
  let resolvedItemName = (() => {
    if (itemName?.trim() && !isGenericName(itemName)) return itemName.trim();
    const real = resolvedItems.find(i => i?.name?.trim() && !isGenericName(i.name));
    return real?.name?.trim() || null;
  })();
  let resolvedOrderRef = orderRef?.trim() || null;
  let resolvedGame = game?.trim() || null;

  if (dbOrder) {
    const enriched = await enrichItemsFromOrder(dbOrder);
    if (enriched.items.length) resolvedItems = enriched.items;
    if (!resolvedItemName && enriched.items[0]?.name) resolvedItemName = enriched.items[0].name;
    if (!resolvedOrderRef && dbOrder.orderNumber) resolvedOrderRef = dbOrder.orderNumber;
    if (!resolvedGame && enriched.game) resolvedGame = enriched.game;
  }

  // Grow A Garden 2 is fully automated — manual claim chats are not allowed.
  if (isAutoOnlyGame(resolvedGame)) {
    return next(
      new AppError(
        "Grow A Garden 2 uses fully automated bot delivery. Please use the Auto Delivery flow after checkout.",
        400
      )
    );
  }

  // First try: exact match by email + orderRef (if provided) + active status
  let existingSession = null;
  if (resolvedOrderRef) {
    existingSession = await ClaimSession.findOne({
      contactEmail: emailLower,
      orderRef: resolvedOrderRef,
      status: { $in: ["pending", "active"] },
    }).sort({ createdAt: -1 });
  }

  // Fallback: catch double-submits where orderRef differs or is missing on one call
  // (e.g. page submits before product info loads, then again after).
  // Only applies when BOTH sides have no orderRef, or they share the same one —
  // a request carrying a different orderRef is a new purchase and must get a fresh session.
  if (!existingSession) {
    const twoMinAgo = new Date(Date.now() - 2 * 60 * 1000);
    const recentActive = await ClaimSession.findOne({
      contactEmail: emailLower,
      status: { $in: ["pending", "active"] },
      createdAt: { $gte: twoMinAgo },
    }).sort({ createdAt: -1 });

    if (recentActive) {
      const sameOrder =
        !resolvedOrderRef ||
        !recentActive.orderRef ||
        recentActive.orderRef === resolvedOrderRef;
      if (sameOrder) existingSession = recentActive;
    }
  }

  // Permanent block: if this specific orderRef was already delivered/ended,
  // never allow a new session to be created for it regardless of time passed.
  // Also dedupe by orderRef alone (any email) — a delivered order can never be
  // re-claimed under a different email either.
  if (!existingSession && resolvedOrderRef) {
    const completedForOrder = await ClaimSession.findOne({
      orderRef: resolvedOrderRef,
      status: { $in: ["claimed", "ended"] },
    }).sort({ updatedAt: -1 });
    if (completedForOrder) existingSession = completedForOrder;
  }

  // Same for pending/active sessions: if an auto-delivery (or manual) session is
  // already running for this order under ANY email, hand it back — never spawn a
  // second session for the same order.
  if (!existingSession && resolvedOrderRef) {
    const liveForOrder = await ClaimSession.findOne({
      orderRef: resolvedOrderRef,
      status: { $in: ["pending", "active"] },
    }).sort({ createdAt: -1 });
    if (liveForOrder) existingSession = liveForOrder;
  }

  // Also return recently closed/ended/claimed sessions so the customer
  // cannot immediately re-create a new session after an agent closes theirs.
  // Only blocks re-creation when the order ref matches (or neither side has one) —
  // a new purchase with a different orderRef must be allowed through as a fresh claim.
  if (!existingSession) {
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000);
    const recentClosed = await ClaimSession.findOne({
      contactEmail: emailLower,
      status: { $in: ["closed", "ended", "claimed"] },
      updatedAt: { $gte: thirtyMinAgo },
    }).sort({ updatedAt: -1 });

    if (recentClosed) {
      const sameOrder =
        !resolvedOrderRef ||
        !recentClosed.orderRef ||
        recentClosed.orderRef === resolvedOrderRef;
      if (sameOrder) existingSession = recentClosed;
    }
  }

  // ── Payment guard ────────────────────────────────────────────────────────────
  // Only allow a NEW claim session to be created when at least one successfully
  // paid Stripe order exists for this customer.  Existing sessions are returned
  // as-is (no disruption to live chats), but creating a fresh session requires a
  // confirmed payment.status === "succeeded" order in the database.
  if (!existingSession) {
    const paymentQuery = { "customer.email": emailLower, "payment.status": "succeeded" };
    if (resolvedOrderRef) paymentQuery.orderNumber = resolvedOrderRef;
    const paidOrder = await Order.findOne(paymentQuery).select("_id orderNumber").lean();
    if (!paidOrder) {
      const msg = resolvedOrderRef
        ? `No successful payment found for order ${resolvedOrderRef}. Claim chats can only be opened for orders whose payment reached Stripe successfully.`
        : "No successful payment found for this email address. Claim chats can only be opened after a payment has been confirmed by Stripe.";
      return next(new AppError(msg, 402));
    }
    // Pin orderRef to the confirmed paid order when none was supplied by the client.
    if (!resolvedOrderRef && paidOrder.orderNumber) {
      resolvedOrderRef = paidOrder.orderNumber;
    }
  }
  // ── Additional guard: After resolving orderRef from a paid order, permanently
  // block re-creation if any completed session already exists for that orderRef.
  // This catches the case where resolvedOrderRef was null on the earlier checks
  // but was filled in by the payment guard above.
  // NOTE: Only runs when no existingSession was found above — if we already have
  // an existingSession (e.g. a claimed session) we return it below, not a 403.
  // NOTE: Does NOT include "closed" — a closed (non-delivered) session only
  // blocks for 30 minutes (handled above); after that the user may reopen.
  if (!existingSession && resolvedOrderRef) {
    const alreadyDelivered = await ClaimSession.findOne({
      orderRef: resolvedOrderRef,
      status: { $in: ["claimed", "ended"] },
    }).sort({ updatedAt: -1 });
    if (alreadyDelivered) {
      logger.info(`Blocked new claim for already-delivered order ${resolvedOrderRef} (${emailLower})`);
      return next(
        new AppError(
          "This order has already been delivered. If you have a new order, please contact our support team.",
          403
        )
      );
    }
  }
  // ── End payment guard ─────────────────────────────────────────────────────────

  if (existingSession) {
    // Backfill item/order/game info onto the existing session if it's missing it and
    // this request resolved real data — covers the case where an earlier attempt
    // created the session as a generic/itemless claim (e.g. before checkout finished
    // confirming, or before the widget had refreshed its local order data) and this
    // later attempt has the real info available.
    let changed = false;
    if ((!existingSession.items || existingSession.items.length === 0) && resolvedItems.length > 0) {
      existingSession.items = resolvedItems;
      changed = true;
    }
    if (isGenericName(existingSession.itemName) && resolvedItemName) {
      existingSession.itemName = resolvedItemName;
      changed = true;
    }
    if (!existingSession.orderRef && resolvedOrderRef) {
      existingSession.orderRef = resolvedOrderRef;
      changed = true;
    }
    if (!existingSession.game && resolvedGame) {
      existingSession.game = resolvedGame;
      changed = true;
    }
    if (existingSession.items?.length && resolvedItems.length) {
      let itemsChanged = false;
      const merged = existingSession.items.map(orig => {
        const plain = orig.toObject ? orig.toObject() : { ...orig };
        const match = resolvedItems.find(r => r.name === plain.name);
        if (match?.category && !plain.category) {
          itemsChanged = true;
          return { ...plain, category: match.category };
        }
        return plain;
      });
      if (itemsChanged) {
        existingSession.items = merged;
        changed = true;
      }
    }
    if (changed) {
      await existingSession.save();
      logger.info(`Backfilled item/order info on existing claim session ${existingSession.roomId}`);
    }

    logger.info(`Returning existing claim session ${existingSession.roomId} for ${robloxUsername} (status: ${existingSession.status})`);
    return res.status(200).json({
      success: true,
      data: {
        roomId: existingSession.roomId,
        status: existingSession.status,
        mode: existingSession.mode || "manual",
        assignedAgent: existingSession.assignedAgent || null,
        messages: existingSession.messages,
        items: existingSession.items || [],
        game: existingSession.game || null,
        orderRef: existingSession.orderRef || null,
      },
    });
  }

  const roomId = uuidv4();

  const Game = require("../models/Game");
  let claimTimeMsg = null;
  let nextSlotAt = null;
  if (game?.trim()) {
    try {
      const gameDoc = await Game.findOne({ slug: game.trim().toLowerCase() }).select("name claimTime claimSchedule");
      if (gameDoc) {
        const gmt3 = new Date(Date.now() + 3 * 60 * 60 * 1000);
        const hhmm = `${String(gmt3.getUTCHours()).padStart(2, "0")}:${String(gmt3.getUTCMinutes()).padStart(2, "0")}`;
        let inActiveSlot = false;
        if (gameDoc.claimSchedule?.length) {
          const slot = gameDoc.claimSchedule.find(s => {
            if (!s.from || !s.to || !s.minutes) return false;
            return s.from <= s.to ? (hhmm >= s.from && hhmm <= s.to) : (hhmm >= s.from || hhmm <= s.to);
          });
          if (slot) inActiveSlot = true;
          if (!inActiveSlot) {
            const future = gameDoc.claimSchedule
              .filter(s => s.from && s.from > hhmm)
              .sort((a, b) => a.from.localeCompare(b.from))[0];
            if (future) {
              nextSlotAt = future.from;
            } else {
              // No future slot today — wrap to earliest slot (next day, same schedule)
              const earliest = gameDoc.claimSchedule
                .filter(s => s.from)
                .sort((a, b) => a.from.localeCompare(b.from))[0];
              if (earliest) nextSlotAt = earliest.from;
            }
          }
        } else if ((gameDoc.claimTime || 0) > 0) {
          inActiveSlot = true;
        }
        if (!inActiveSlot && ((gameDoc.claimSchedule?.length || 0) > 0 || (gameDoc.claimTime || 0) > 0)) {
          claimTimeMsg = nextSlotAt
            ? `\u23F1 Claim time for ${gameDoc.name} is currently closed. Next available: ${nextSlotAt} (GMT+3).`
            : `\u23F1 Claim time for ${gameDoc.name} is currently unavailable. Our team will respond when available.`;
        }
      }
    } catch {}
  }

  const initMessages = [
    { sender: "system", text: `${robloxUsername.trim()} has joined the chat`, senderName: "System" },
  ];
  if (claimTimeMsg) {
    initMessages.push({ sender: "system", text: claimTimeMsg, senderName: "System" });
  }

  const session = await ClaimSession.create({
    roomId,
    robloxUsername: robloxUsername.trim(),
    contactEmail: emailLower,
    orderRef: resolvedOrderRef,
    game: resolvedGame || game?.trim() || null,
    mode: "manual",
    itemName: resolvedItemName,
    items: resolvedItems,
    messages: initMessages,
  });

  try {
    const { notifyNewClaim } = require("../config/socket");
    notifyNewClaim({
      roomId: session.roomId,
      robloxUsername: session.robloxUsername,
      contactEmail: session.contactEmail,
      game: session.game,
      orderRef: session.orderRef,
      itemName: session.itemName,
      items: session.items,
      createdAt: session.createdAt,
    });
  } catch {}

  logger.info(`New claim session: ${roomId} for ${robloxUsername} — item: ${resolvedItemName || "general"}`);

  res.status(201).json({
    success: true,
    data: {
      roomId: session.roomId,
      status: session.status,
      mode: session.mode || "manual",
      messages: session.messages,
      items: session.items || [],
      game: session.game || null,
      orderRef: session.orderRef || null,
      nextSlotAt,
    },
  });
});

/**
 * POST /api/claims/auto — start an AUTOMATED (bot) delivery session.
 * Same hardened resolution as createClaim, plus:
 *  - Requires a confirmed paid order (auto delivery needs a real order).
 *  - Reuses/returns any existing pending/active session for the order (dedup).
 *  - Hard-blocks if the order was already delivered (claimed/ended) — no way to
 *    re-trigger auto delivery or open a manual chat for a delivered order.
 *  - Snaps autoDelivery config (private server link + instructions) from the Game.
 */
exports.createAutoDelivery = catchAsync(async (req, res, next) => {
  const { robloxUsername, contactEmail, orderRef, game } = req.body;

  if (!robloxUsername?.trim()) return next(new AppError("Roblox username is required", 400));
  if (!contactEmail?.includes("@")) return next(new AppError("Valid contact email is required", 400));

  const emailLower = contactEmail.trim().toLowerCase();
  const dbOrder = await findPaidOrder({
    orderRef: orderRef?.trim() || null,
    emailLower,
    robloxUsername: robloxUsername.trim(),
  });

  let resolvedItems = [];
  let resolvedOrderRef = orderRef?.trim() || null;
  let resolvedGame = game?.trim() || null;
  let resolvedItemName = null;

  if (!dbOrder) {
    const msg = orderRef?.trim()
      ? `No successful payment found for order ${orderRef.trim()}. Automated delivery can only be started for paid orders.`
      : "No successful payment found for this email address. Automated delivery can only be started after a payment has been confirmed.";
    return next(new AppError(msg, 402));
  }

  const enriched = await enrichItemsFromOrder(dbOrder);
  if (enriched.items.length) resolvedItems = enriched.items;
  if (!resolvedOrderRef && dbOrder.orderNumber) resolvedOrderRef = dbOrder.orderNumber;
  if (!resolvedGame && enriched.game) resolvedGame = enriched.game;
  if (enriched.items[0]?.name) resolvedItemName = enriched.items[0].name;

  if (!resolvedOrderRef) return next(new AppError("Could not resolve your order. Please contact support.", 400));

  // Resolve the numeric Roblox user ID automatically (used by the delivery bot
  // to find the exact player in its server — no manual entry anywhere).
  const robloxUserId = await resolveRobloxUserId(robloxUsername.trim());

  // ── Guards ─────────────────────────────────────────────────────────────
  // 1) Already delivered? Never allow auto delivery (or any claim) again.
  const alreadyDelivered = await ClaimSession.findOne({
    orderRef: resolvedOrderRef,
    status: { $in: ["claimed", "ended"] },
  }).sort({ updatedAt: -1 });
  if (alreadyDelivered) {
    return next(
      new AppError(
        "This order has already been delivered. If you have a new order, please contact our support team.",
        403
      )
    );
  }

  // 2) Dedup: reuse an existing pending/active session for this order.
  const existingSession = await ClaimSession.findOne({
    orderRef: resolvedOrderRef,
    status: { $in: ["pending", "active"] },
  }).sort({ createdAt: -1 });

  if (existingSession) {
    let changed = false;
    if ((!existingSession.items || existingSession.items.length === 0) && resolvedItems.length > 0) {
      existingSession.items = resolvedItems;
      changed = true;
    }
    if (isGenericName(existingSession.itemName) && resolvedItemName) {
      existingSession.itemName = resolvedItemName;
      changed = true;
    }
    if (!existingSession.game && resolvedGame) {
      existingSession.game = resolvedGame;
      changed = true;
    }
    if (!existingSession.robloxUserId && robloxUserId) {
      existingSession.robloxUserId = robloxUserId;
      changed = true;
    }
    if (existingSession.mode !== "auto") {
      existingSession.mode = "auto";
      changed = true;
    }
    if (changed) await existingSession.save();

    return res.status(200).json({
      success: true,
      data: {
        roomId: existingSession.roomId,
        status: existingSession.status,
        mode: "auto",
        messages: existingSession.messages,
        items: existingSession.items || [],
        game: existingSession.game || resolvedGame || null,
        orderRef: existingSession.orderRef || resolvedOrderRef,
        robloxUsername: existingSession.robloxUsername,
        robloxUserId: existingSession.robloxUserId || robloxUserId || null,
      },
    });
  }

  // ── Create the auto session ────────────────────────────────────────────
  // ── Game guard: automated delivery is only available for auto-only games ──
  if (!resolvedGame || !isAutoOnlyGame(resolvedGame)) {
    return next(
      new AppError(
        "Automated delivery is only available for Grow A Garden 2 orders. Please use the Claim Chat to connect with a delivery agent.",
        400
      )
    );
  }

  // ── Create the auto session ────────────────────────────────────────────
  const roomId = uuidv4();
  const session = await ClaimSession.create({
    roomId,
    robloxUsername: robloxUsername.trim(),
    robloxUserId: robloxUserId || undefined,
    contactEmail: emailLower,
    orderRef: resolvedOrderRef,
    game: resolvedGame || null,
    mode: "auto",
    itemName: resolvedItemName,
    items: resolvedItems,
    messages: [
      { sender: "system", text: `${robloxUsername.trim()} started automated delivery`, senderName: "System" },
    ],
  });

  try {
    const { notifyNewClaim } = require("../config/socket");
    notifyNewClaim({
      roomId: session.roomId,
      robloxUsername: session.robloxUsername,
      contactEmail: session.contactEmail,
      game: session.game,
      orderRef: session.orderRef,
      itemName: session.itemName,
      items: session.items,
      mode: "auto",
      createdAt: session.createdAt,
    });
  } catch {}

  logger.info(`New AUTO delivery session: ${roomId} for ${robloxUsername} — order ${resolvedOrderRef}`);

  res.status(201).json({
    success: true,
    data: {
      roomId: session.roomId,
      status: session.status,
      mode: "auto",
      messages: session.messages,
      items: session.items || [],
      game: session.game || null,
      orderRef: session.orderRef,
    },
  });
});

/**
 * GET /api/claims/:roomId/status — public lightweight status poll used by the
 * auto-delivery page. Returns only non-sensitive session state.
 */
exports.getSessionStatus = catchAsync(async (req, res, next) => {
  const session = await ClaimSession.findOne({ roomId: req.params.roomId }).select(
    "roomId status mode items game orderRef robloxUsername robloxUserId delivererAssigned autoDelivery updatedAt"
  );
  if (!session) return next(new AppError("Session not found", 404));

  res.json({
    success: true,
    data: {
      roomId: session.roomId,
      status: session.status,
      mode: session.mode || "manual",
      items: session.items || [],
      game: session.game || null,
      orderRef: session.orderRef || null,
      robloxUsername: session.robloxUsername,
      robloxUserId: session.robloxUserId || null,
      delivererName: session.delivererAssigned?.name || session.assignedAgent?.name || null,
      autoDelivery: session.autoDelivery || null,
    },
  });
});

/**
 * GET /api/claims/auto-queue?game=slug — PUBLIC. The delivery bot polls this
 * continuously. Returns only non-sensitive auto-mode session data (never the
 * private server link). Sessions are handed out oldest-first; "active" ones
 * were claimed by the bot but not yet reported delivered (crash recovery).
 */
function mapAutoSession(s) {
  return {
    roomId: s.roomId,
    robloxUsername: s.robloxUsername,
    robloxUserId: s.robloxUserId || null,
    game: s.game || null,
    status: s.status,
    items: (s.items || []).map(i => {
      const qty = i.quantity || 1;
      const delivered = i.delivered || 0;
      return {
        name: i.name,
        quantity: qty,
        delivered,
        remaining: Math.max(0, qty - delivered),
        category: i.category || null,
      };
    }),
  };
}

exports.getAutoQueue = catchAsync(async (req, res, next) => {
  // Automated delivery exists ONLY for auto-only games (Grow A Garden 2).
  // The queue is hard-locked to those games regardless of the query param,
  // so the bot can never be pointed at another game's orders.
  const game = req.query.game?.trim()?.toLowerCase();
  const filter = {
    mode: "auto",
    status: { $in: ["pending", "active"] },
    game: { $in: AUTO_ONLY_GAMES },
  };
  if (game && AUTO_ONLY_GAMES.includes(game)) filter.game = game;

  const sessions = await ClaimSession.find(filter)
    .sort({ createdAt: 1 })
    .select("roomId robloxUsername robloxUserId game items status")
    .lean();

  res.json({
    success: true,
    data: {
      pending: sessions.filter(s => s.status === "pending").map(mapAutoSession),
      active: sessions.filter(s => s.status === "active").map(mapAutoSession),
    },
  });
});

/**
 * POST /api/claims/auto/:roomId/claim — PUBLIC. The bot claims item quantities
 * it is about to deliver. Reservations are tracked per item so multiple bot
 * accounts never double-send the same quantity. Body:
 *   { items: [{ name, quantity }], account }
 * If no items are given the whole session is claimed (legacy behaviour).
 */
exports.claimAutoSession = catchAsync(async (req, res, next) => {
  const session = await ClaimSession.findOne({
    roomId: req.params.roomId,
    mode: "auto",
    status: { $in: ["pending", "active"] },
  });
  if (!session) return next(new AppError("Auto session not found or already claimed", 409));
  if (session.game && !isAutoOnlyGame(session.game)) {
    return next(new AppError("Automated delivery is only available for Grow A Garden 2", 403));
  }

  const account = String(req.body?.account || "AUTO BOT").slice(0, 60);
  const requested = (req.body?.items || []).filter(
    i => typeof i?.name === "string" && i.name.trim() && Number(i.quantity) > 0
  );

  if (requested.length === 0) {
    if (session.status !== "pending") {
      return next(new AppError("Session already claimed by another bot", 409));
    }
    session.status = "active";
    session.delivererAssigned = { name: account, claimedAt: new Date() };
    session.messages.push({
      sender: "system",
      text: "Automated delivery bot is preparing your items",
      senderName: "System",
      timestamp: new Date(),
    });
    await session.save();
    await logBot({
      roomId: session.roomId,
      orderRef: session.orderRef,
      robloxUsername: session.robloxUsername,
      game: session.game,
      account,
      action: "claim",
      message: `Session claimed by ${account}`,
    });
    return res.json({ success: true, data: { roomId: session.roomId, status: session.status } });
  }

  // Reservations older than the TTL are treated as stale (the claiming bot
  // crashed or gave up without reporting). They are freed so other bot
  // accounts can take over the order instead of blocking it forever.
  const RESERVATION_TTL_MS = 10 * 60 * 1000;
  const now = Date.now();
  const allReservations = (session.autoDelivery?.reservations || []).slice();
  const reservations = allReservations.filter(r => {
    const t = r.claimedAt ? new Date(r.claimedAt).getTime() : 0;
    return now - t < RESERVATION_TTL_MS;
  });
  const staleCount = allReservations.length - reservations.length;
  const reservedOf = name =>
    reservations.reduce((sum, r) => (r.name === name ? sum + (r.quantity || 0) : sum), 0);

  const token = account + ":" + Date.now();
  const granted = [];
  for (const it of requested) {
    const item = (session.items || []).find(i => i.name === it.name);
    if (!item) continue;
    const remaining = (item.quantity || 1) - (item.delivered || 0);
    const qty = Math.min(Math.floor(Number(it.quantity)), Math.max(0, remaining - reservedOf(item.name)));
    if (qty <= 0) continue;
    reservations.push({ name: item.name, quantity: qty, account: token, claimedAt: new Date() });
    granted.push({ name: item.name, quantity: qty });
  }

  if (granted.length === 0) {
    return next(new AppError("No remaining quantity to claim for these items", 409));
  }

  session.autoDelivery = session.autoDelivery || {};
  session.autoDelivery.reservations = reservations;
  session.status = "active";
  session.delivererAssigned = { name: account, claimedAt: new Date() };
  await session.save();

  if (staleCount > 0) {
    await logBot({
      roomId: session.roomId,
      orderRef: session.orderRef,
      robloxUsername: session.robloxUsername,
      game: session.game,
      account,
      action: "info",
      message: `Freed ${staleCount} stale reservation(s) older than the 10min TTL (crashed bot took them over)`,
    });
  }

  await logBot({
    roomId: session.roomId,
    orderRef: session.orderRef,
    robloxUsername: session.robloxUsername,
    game: session.game,
    account,
    action: "claim",
    items: granted.map(g => ({ name: g.name, quantity: g.quantity })),
    message: `${account} claimed ${granted.map(g => `${g.name} x${g.quantity}`).join(", ")}`,
  });

  res.json({ success: true, data: { roomId: session.roomId, status: session.status, items: granted } });
});

/**
 * POST /api/claims/auto/log — PUBLIC. The bot reports non-delivery events
 * (polls, errors, rejection reasons) so they show up in the admin panel.
 */
exports.logBotEvent = catchAsync(async (req, res, next) => {
  const { roomId, orderRef, robloxUsername, game, action, status, message, items } = req.body || {};
  const account = String(req.body?.account || "AUTO BOT").slice(0, 60);
  if (!["claim", "deliver", "complete", "error", "info"].includes(action)) {
    return next(new AppError("Unknown action", 400));
  }
  await logBot({
    roomId,
    orderRef,
    robloxUsername,
    game,
    account,
    action,
    status: status || "ok",
    message: String(message || "").slice(0, 1900),
    items: Array.isArray(items) ? items : undefined,
  });
  res.json({ success: true });
});

/**
 * POST /api/claims/auto/:roomId/deliver — PUBLIC. The bot reports the item
 * quantities it actually delivered. Quantities are added to the item's
 * delivered count; the session flips to "claimed" only once every item is
 * fully delivered (partial reports keep it active for other accounts to
 * finish). Body: { items: [{ name, quantity }], account, notes }
 */
exports.deliverAutoSession = catchAsync(async (req, res, next) => {
  const notes = req.body?.notes || "";
  const account = String(req.body?.account || "AUTO BOT").slice(0, 60);
  const session = await ClaimSession.findOne({
    roomId: req.params.roomId,
    mode: "auto",
    status: "active",
  });
  if (!session) return next(new AppError("Auto session not found or not active", 409));
  if (session.game && !isAutoOnlyGame(session.game)) {
    return next(new AppError("Automated delivery is only available for Grow A Garden 2", 403));
  }

  const reported = (req.body?.items || []).filter(
    i => typeof i?.name === "string" && i.name.trim() && Number(i.quantity) > 0
  );

  const accepted = [];
  for (const it of reported) {
    const item = (session.items || []).find(i => i.name === it.name);
    if (!item) continue;
    const remaining = (item.quantity || 1) - (item.delivered || 0);
    const applied = Math.min(Math.floor(Number(it.quantity)), Math.max(0, remaining));
    if (applied <= 0) continue;
    item.delivered = (item.delivered || 0) + applied;
    accepted.push({ name: item.name, quantity: applied });
  }

  // Release ALL reservations held by this account — whatever it did not
  // confirm as delivered goes back into the pool for other accounts
  // (e.g. the account does not own the item, or hit the recipient gift limit).
  // Claim stores reservations with account = "<name>:<timestamp>", so match
  // both the plain name and the token form.
  if (session.autoDelivery?.reservations?.length) {
    session.autoDelivery.reservations = session.autoDelivery.reservations.filter(
      r => r.account !== account && !(typeof r.account === "string" && r.account.startsWith(account + ":"))
    );
  }

  const allDone = (session.items || []).every(i => (i.delivered || 0) >= (i.quantity || 1));

  if (allDone) {
    session.status = "claimed";
    session.resolvedAt = new Date();
    session.messages.push({
      sender: "system",
      text: "Your order has been delivered! Items should be in your inventory.",
      senderName: "System",
      timestamp: new Date(),
    });
  } else {
    session.status = "active";
    session.messages.push({
      sender: "system",
      text: `Delivery in progress (${(session.items || [])
        .map(i => `${i.name} ${Math.min(i.delivered || 0, i.quantity || 1)}/${i.quantity || 1}`)
        .join(", ")})`,
      senderName: "System",
      timestamp: new Date(),
    });
  }
  await session.save();

  if (allDone) {
    // Auto-complete the linked order (same as the deliverer panel flow)
    if (session.orderRef) {
      try {
        const linkedOrder = await Order.findOne({ orderNumber: session.orderRef });
        const terminal = ["completed", "cancelled", "refunded", "partially_refunded"];
        if (linkedOrder && !terminal.includes(linkedOrder.status)) {
          linkedOrder.status = "completed";
          linkedOrder.fulfilledAt = new Date();
          linkedOrder.fulfilledBy = "AUTO BOT";
          linkedOrder.delivery.status = "delivered";
          linkedOrder.delivery.deliveredAt = new Date();
          linkedOrder.delivery.trackingNumber = "AUTO-BOT";
          if (notes) linkedOrder.delivery.notes = notes;
          if (!linkedOrder.timeline) linkedOrder.timeline = [];
          linkedOrder.timeline.push({
            action: "Order auto-completed via automated delivery bot",
            by: "AUTO BOT",
            details: `Claim session ${session.roomId} delivered by bot`,
            timestamp: new Date(),
          });
          await linkedOrder.save();
        }
      } catch {}
    }

    // Also create a ProofOfDelivery entry so it shows in the admin POD panel
    try {
      const ProofOfDelivery = require("../models/ProofOfDelivery");
      await ProofOfDelivery.create({
        claimSessionId: session._id,
        roomId: session.roomId,
        orderRef: session.orderRef || undefined,
        submittedByType: "auto-bot",
        agentName: "AUTO BOT",
        proofImageUrls: [],
        estimatedDelivery: "Delivered",
        notes: notes || undefined,
        customerEmail: session.contactEmail || undefined,
        robloxUsername: session.robloxUsername,
        game: session.game || undefined,
      });
    } catch (podErr) {
      logger.error("Failed to create ProofOfDelivery for auto bot:", podErr.message);
    }

    logger.info(`AUTO BOT delivered session ${session.roomId} (order ${session.orderRef})`);
  } else {
    logger.info(
      `AUTO BOT partial delivery on ${session.roomId}: ${accepted
        .map(a => `${a.name} x${a.quantity}`)
        .join(", ") || "nothing"}`
    );
  }

  await logBot({
    roomId: session.roomId,
    orderRef: session.orderRef,
    robloxUsername: session.robloxUsername,
    game: session.game,
    account,
    action: allDone ? "complete" : "deliver",
    items: accepted.map(a => ({ name: a.name, quantity: a.quantity })),
    message: allDone
      ? `Delivery COMPLETE by ${account} — ${accepted.map(a => `${a.name} x${a.quantity}`).join(", ")}`
      : `${account} delivered ${accepted.map(a => `${a.name} x${a.quantity}`).join(", ") || "nothing"} — order still in progress`,
  });

  res.json({ success: true, data: { roomId: session.roomId, status: session.status, items: accepted } });
});

/**
 * GET /api/claims/admin/auto-logs — ADMIN ONLY. Latest automated delivery bot
 * activity (claims, delivers, completions, errors).
 */
exports.listAutoBotLogs = catchAsync(async (req, res, next) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const roomId = String(req.query.roomId || "").trim();
  const filter = {};
  if (roomId) filter.roomId = roomId;
  const logs = await AutoBotLog.find(filter)
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
  res.json({ success: true, data: { logs } });
});

exports.updateUserInfo = catchAsync(async (req, res, next) => {
  const { robloxUsername, contactEmail } = req.body;
  const session = await ClaimSession.findOne({ roomId: req.params.roomId });
  if (session.status !== "pending") {
    return next(new AppError("Cannot update info after agent has joined", 400));
  }

  const changes = [];

  if (robloxUsername?.trim() && robloxUsername.trim() !== session.robloxUsername) {
    const oldName = session.robloxUsername;
    const newName = robloxUsername.trim();
    session.robloxUsername = newName;
    changes.push(`${oldName} changed their Roblox username to ${newName}`);
  }

  if (
    contactEmail?.trim() &&
    contactEmail.includes("@") &&
    contactEmail.trim().toLowerCase() !== session.contactEmail
  ) {
    const newEmail = contactEmail.trim().toLowerCase();
    session.contactEmail = newEmail;
    changes.push(`User updated their contact email to ${newEmail}`);
  }

  if (changes.length === 0) {
    return res.json({ success: true, message: "No changes made" });
  }

  for (const text of changes) {
    session.messages.push({ sender: "system", text, senderName: "System" });
  }

  await session.save();

  const io = tryGetIO();
  if (io) {
    for (const text of changes) {
      io.to(`claim:${session.roomId}`).emit("claim:new_message", {
        sender: "system",
        text,
        senderName: "System",
        timestamp: new Date(),
        roomId: session.roomId,
      });
    }
    io.to("admin-room").emit("admin:claim_user_info_updated", {
      roomId: session.roomId,
      robloxUsername: session.robloxUsername,
      contactEmail: session.contactEmail,
    });
  }

  res.json({
    success: true,
    data: {
      robloxUsername: session.robloxUsername,
      contactEmail: session.contactEmail,
    },
  });
});

exports.getSession = catchAsync(async (req, res, next) => {
  const session = await ClaimSession.findOne({ roomId: req.params.roomId }).select("-__v");
  if (!session) return next(new AppError("Session not found", 404));

  const isMonitor = req.panelUser.isOwner || req.panelUser.permissions?.includes("monitor_agents");
  if (!isMonitor) {
    const agentGames = req.panelUser.claimGames || [];
    if (agentGames.length > 0 && session.game && !agentGames.includes(session.game)) {
      return next(new AppError("You are not authorized to view this claim session", 403));
    }
  }

  res.json({
    success: true,
    data: {
      roomId: session.roomId,
      status: session.status,
      assignedAgent: session.assignedAgent,
      messages: session.messages,
    },
  });
});

exports.listClaims = catchAsync(async (req, res) => {
  const { status, page = 1, limit = 30 } = req.query;
  const filter = {};
  if (status) filter.status = status;

  const sessions = await ClaimSession.find(filter)
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(Number(limit))
    .select("-messages -__v");

  const total = await ClaimSession.countDocuments(filter);
  res.json({ success: true, total, data: sessions });
});

exports.getFullSession = catchAsync(async (req, res, next) => {
  const session = await ClaimSession.findOne({ roomId: req.params.roomId });
  if (!session) return next(new AppError("Session not found", 404));

  const isMonitor = req.panelUser.isOwner || req.panelUser.permissions?.includes("monitor_agents");
  if (!isMonitor) {
    const agentGames = req.panelUser.claimGames || [];
    if (agentGames.length > 0 && session.game && !agentGames.includes(session.game)) {
      return next(new AppError("You are not authorized to view this claim session", 403));
    }
  }

  res.json({ success: true, data: sanitizeSession(session) });
});

exports.updateStatus = catchAsync(async (req, res, next) => {
  const { status, agentName } = req.body;
  const allowed = ["active", "claimed", "ended", "closed"];
  if (!allowed.includes(status)) return next(new AppError(`Status must be one of: ${allowed.join(", ")}`, 400));

  const session = await ClaimSession.findOne({ roomId: req.params.roomId });
  if (!session) return next(new AppError("Session not found", 404));

  session.status = status;
  if (status === "active" && agentName) {
    session.assignedAgent = {
      userId: req.user?._id || null,
      name: agentName || req.user?.name || "Support Agent",
      joinedAt: new Date(),
    };
  }
  if (status === "claimed" || status === "ended") {
    session.resolvedAt = new Date();
  }

  await session.save();

  const io = tryGetIO();
  if (io) {
    if (status === "active") {
      const n = agentName || req.user?.name || "Support Agent";
      io.to(`claim:${session.roomId}`).emit("claim:agent_joined", {
        agentName: n,
        message: `${n} has joined the chat`,
      });
    }
    if (status === "ended") {
      io.to(`claim:${session.roomId}`).emit("claim:ended", {
        message: "The support agent has ended the chat. Thank you!",
      });
    }
    if (status === "claimed") {
      io.to(`claim:${session.roomId}`).emit("claim:marked_claimed", {
        message: "Your order has been delivered!",
      });
    }
  }

  res.json({ success: true, data: { status: session.status, assignedAgent: session.assignedAgent } });
});

exports.deleteSession = catchAsync(async (req, res, next) => {
  if (!req.panelUser.isOwner) return next(new AppError("Owner access required", 403));
  const session = await ClaimSession.findOne({ roomId: req.params.roomId });
  if (!session) return next(new AppError("Session not found", 404));
  await session.deleteOne();
  try {
    const io = tryGetIO();
    if (io) {
      io.to(`claim:${session.roomId}`).emit("claim:closed", { message: "This chat session has been removed by an administrator." });
      io.to("admin-room").emit("admin:claim_deleted", { roomId: session.roomId });
      io.to("agent-queue-room").emit("queue:claim_deleted", { roomId: session.roomId });
    }
  } catch {}
  logger.info(`Owner deleted claim session ${session.roomId}`);
  res.json({ success: true, message: "Session deleted" });
});

exports.bulkDeleteClaimed = catchAsync(async (req, res, next) => {
  if (!req.panelUser.isOwner) return next(new AppError("Owner access required", 403));
  const { email, roomIds } = req.body;

  let filter = {};
  if (Array.isArray(roomIds) && roomIds.length > 0) {
    filter = { roomId: { $in: roomIds } };
  } else if (email?.trim()) {
    filter = {
      contactEmail: email.trim().toLowerCase(),
      status: { $in: ["claimed", "ended", "closed"] },
    };
  } else {
    return next(new AppError("Provide email or roomIds", 400));
  }

  const sessions = await ClaimSession.find(filter).select("roomId").lean();
  const count = sessions.length;
  if (count === 0) return res.json({ success: true, message: "No sessions found to delete", count: 0 });

  await ClaimSession.deleteMany(filter);

  try {
    const io = tryGetIO();
    if (io) {
      for (const s of sessions) {
        io.to(`claim:${s.roomId}`).emit("claim:closed", { message: "This chat session has been removed by an administrator." });
      }
      io.to("admin-room").emit("admin:claims_bulk_deleted", { count });
    }
  } catch {}

  logger.info(`Owner bulk-deleted ${count} claim sessions`);
  res.json({ success: true, message: `Deleted ${count} session(s)`, count });
});

exports.getActiveClaims = catchAsync(async (req, res) => {
  const sessions = await ClaimSession.find({ status: { $in: ["pending", "active"] } })
    .sort({ createdAt: -1 })
    .limit(50)
    .select("-messages -__v");
  res.json({ success: true, data: { sessions } });
});

function sanitizeSession(s) {
  const obj = s.toObject ? s.toObject() : { ...s };
  if (isGenericName(obj.itemName)) obj.itemName = null;
  if (Array.isArray(obj.items)) {
    obj.items = obj.items.filter(i => i.name && !isGenericName(i.name));
  }
  return obj;
}

exports.getAgentQueue = catchAsync(async (req, res) => {
  const panelUser = req.panelUser;
  const agentId = panelUser?._id || panelUser?.id;
  const agentGames = panelUser?.claimGames || [];

  // Automated delivery sessions (Grow A Garden 2) are handled exclusively by
  // the bot — they never appear in the agents' manual queue. Manual = the
  // session has no mode at all (legacy) or mode "manual".
  const manualModes = [
    { mode: "manual" },
    { mode: { $exists: false } },
  ];
  const pendingFilter = { status: "pending", $or: manualModes };
  if (agentGames.length > 0) {
    const manualFor = gameCond =>
      manualModes.map(m => ({ ...m, ...gameCond }));
    pendingFilter.$or = [
      ...manualFor({ game: { $in: agentGames } }),
      ...manualFor({ game: null }),
      ...manualFor({ game: { $exists: false } }),
      ...manualFor({ game: "" }),
    ];
  }

  const [pending, mine, completed, closed] = await Promise.all([
    ClaimSession.find(pendingFilter)
      .sort({ createdAt: 1 })
      .limit(50)
      .select("-__v"),
    ClaimSession.find({
      status: "active",
      "assignedAgent.userId": agentId,
    })
      .sort({ createdAt: -1 })
      .limit(20)
      .select("-__v"),
    ClaimSession.find({
      status: { $in: ["claimed", "ended"] },
      "assignedAgent.userId": agentId,
    })
      .sort({ resolvedAt: -1 })
      .select("-messages -__v"),
    ClaimSession.find({
      status: "closed",
      "assignedAgent.userId": agentId,
    })
      .sort({ closedAt: -1 })
      .select("-messages -__v"),
  ]);

  res.json({
    success: true,
    data: {
      pending:   pending.map(sanitizeSession),
      mine:      mine.map(sanitizeSession),
      completed: completed.map(sanitizeSession),
      closed:    closed.map(sanitizeSession),
    },
  });
});

exports.submitFeedback = catchAsync(async (req, res, next) => {
  const { rating, comment } = req.body;
  const parsedRating = Number(rating);
  if (!parsedRating || parsedRating < 1 || parsedRating > 5) {
    return next(new AppError("Rating must be 1-5", 400));
  }

  let proofImageUrl = null;
  if (req.file) {
    try {
      const { uploadToCloudinary } = require("../config/cloudinary");
      const result = await uploadToCloudinary(req.file.buffer, { folder: "rbstars/reviews" });
      proofImageUrl = result.secure_url;
    } catch (err) {
      logger.error("Failed to upload review proof image:", err);
    }
  }

  const feedbackData = {
    rating: parsedRating,
    comment: comment ? String(comment).slice(0, 500) : undefined,
    proofImageUrl: proofImageUrl || undefined,
    submittedAt: new Date(),
  };

  const session = await ClaimSession.findOneAndUpdate(
    { roomId: req.params.roomId, status: { $in: ["claimed", "ended"] } },
    { feedback: feedbackData },
    { new: true }
  );

  if (!session) return next(new AppError("Session not found or not yet ended", 400));
  res.json({ success: true, message: "Feedback submitted. Thank you!" });
});

exports.getPublicReviews = catchAsync(async (req, res) => {
  const { limit = 30 } = req.query;

  const sessions = await ClaimSession.find({
    "feedback.rating": { $exists: true, $ne: null },
    "feedback.comment": { $exists: true, $ne: "" },
  })
    .sort({ "feedback.submittedAt": -1 })
    .limit(Math.min(Number(limit), 50))
    .select("robloxUsername feedback");

  const reviews = sessions.map(s => ({
    id: s._id,
    name: s.robloxUsername,
    rating: s.feedback.rating,
    comment: s.feedback.comment,
    proofImageUrl: s.feedback.proofImageUrl || null,
    submittedAt: s.feedback.submittedAt,
  }));

  const total = await ClaimSession.countDocuments({
    "feedback.rating": { $exists: true, $ne: null },
  });

  const avgRating =
    reviews.length > 0
      ? Math.round((reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length) * 10) / 10
      : 0;

  res.json({
    success: true,
    data: {
      reviews,
      total,
      averageRating: avgRating,
    },
  });
});
