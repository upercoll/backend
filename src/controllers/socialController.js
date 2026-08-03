const https = require("https");
const Collaborator = require("../models/Collaborator");
const SocialSubmission = require("../models/SocialSubmission");
const SocialPayout = require("../models/SocialPayout");
const FeaturedYouTuber = require("../models/FeaturedYouTuber");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");
const { sendSocialInviteEmail } = require("../config/email");

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { "User-Agent": "Mozilla/5.0 RBstars-Panel/1.0" } },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(raw));
          } catch {
            reject(new Error("Non-JSON response"));
          }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(8000, () => {
      req.destroy();
      reject(new Error("Request timed out"));
    });
  });
}

// Fetches raw HTML text, following up to 5 redirects
function httpsFetchText(url, extraHeaders = {}, _hops = 0) {
  return new Promise((resolve, reject) => {
    if (_hops > 5) return reject(new Error("Too many redirects"));
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
        ...extraHeaders,
      },
    };
    const req = https.get(options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = res.headers.location.startsWith("http")
          ? res.headers.location
          : `https://${parsedUrl.hostname}${res.headers.location}`;
        res.resume();
        return httpsFetchText(next, extraHeaders, _hops + 1).then(resolve).catch(reject);
      }
      let raw = "";
      res.on("data", (chunk) => (raw += chunk));
      res.on("end", () => resolve(raw));
    });
    req.on("error", reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error("Request timed out")); });
  });
}

// ─── Platform stat scrapers ───────────────────────────────────────────────────

async function scrapeTikTokStats(url, videoId) {
  // Strategy 1: TikTok internal item-detail API (works without auth most of the time)
  if (videoId) {
    try {
      const apiUrl =
        `https://www.tiktok.com/api/item/detail/?itemId=${videoId}` +
        `&aid=1988&app_name=tiktok_web&device_platform=web_pc`;
      const data = await httpsGet(apiUrl);
      const stats =
        data?.itemInfo?.itemStruct?.stats ||
        data?.itemInfo?.itemStruct?.statsV2;
      if (stats) {
        const views =
          parseInt(stats.playCount || stats.videoViews || 0, 10);
        const likes =
          parseInt(stats.diggCount || stats.heartCount || 0, 10);
        if (views > 0 || likes > 0) return { views, likes };
      }
    } catch {}
  }

  // Strategy 2: scrape HTML – try several known JSON embedding patterns
  try {
    const html = await httpsFetchText(url);

    // Pattern A – __NEXT_DATA__ (newer TikTok SSR)
    try {
      const nd = html.match(/<script id="__NEXT_DATA__"[^>]*>(\{.*?\})<\/script>/s);
      if (nd) {
        const json = JSON.parse(nd[1]);
        // Drill into props.pageProps.itemInfo.itemStruct.stats
        const stats =
          json?.props?.pageProps?.itemInfo?.itemStruct?.stats ||
          json?.props?.pageProps?.videoData?.itemInfos;
        if (stats) {
          const views = parseInt(stats.playCount || stats.videoViews || 0, 10);
          const likes = parseInt(stats.diggCount || stats.heartCount || 0, 10);
          if (views > 0 || likes > 0) return { views, likes };
        }
      }
    } catch {}

    // Pattern B – SIGI_STATE (older TikTok SSR)
    try {
      const sg = html.match(/window\["SIGI_STATE"\]\s*=\s*(\{.+?\});\s*window\[/s);
      if (sg) {
        const json = JSON.parse(sg[1]);
        const items = json?.ItemModule;
        if (items) {
          const item = Object.values(items)[0];
          const stats = item?.stats;
          if (stats) {
            return {
              views: parseInt(stats.playCount || 0, 10),
              likes: parseInt(stats.diggCount || 0, 10),
            };
          }
        }
      }
    } catch {}

    // Pattern C – raw JSON blobs anywhere in the page (legacy fallback)
    const viewMatch = html.match(/"playCount"\s*:\s*"?(\d+)"?/);
    const likeMatch = html.match(/"diggCount"\s*:\s*"?(\d+)"?/);
    if (viewMatch || likeMatch) {
      return {
        views: viewMatch ? parseInt(viewMatch[1], 10) : 0,
        likes: likeMatch ? parseInt(likeMatch[1], 10) : 0,
      };
    }
  } catch {}

  return { views: 0, likes: 0 };
}

// The player endpoint can be rejected by YouTube depending on the server IP.
// The public watch page still exposes the view count in both structured metadata
// and player JSON, so use it as a no-key fallback before returning zero views.
async function fetchYouTubeStatsFromWatchPage(videoId) {
  const url = `https://www.youtube.com/watch?v=${videoId}&hl=en&gl=US&bpctr=9999999999&has_verified=1`;
  try {
    const html = await httpsFetchText(url, {
      "Accept-Language": "en-US,en;q=0.9",
      Referer: "https://www.youtube.com/",
    });

    const metadataViews = html.match(/<meta[^>]+itemprop=["']interactionCount["'][^>]+content=["']([\d,]+)["']/i)
      || html.match(/<meta[^>]+content=["']([\d,]+)["'][^>]+itemprop=["']interactionCount["']/i);
    const playerViews = html.match(/"viewCount"\s*:\s*"?(\d+)"?/);
    const views = parseInt((metadataViews?.[1] || playerViews?.[1] || "0").replace(/,/g, ""), 10) || 0;

    const title = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1]
      || html.match(/"title"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/)?.[1]?.replace(/\\"/g, '"')
      || "";
    const channelName = html.match(/<link[^>]+itemprop=["']name["'][^>]+content=["']([^"']+)["']/i)?.[1] || "";
    return { views, likes: 0, title, channelName };
  } catch {
    return { views: 0, likes: 0, title: "", channelName: "" };
  }
}

// ─── URL helpers ─────────────────────────────────────────────────────────────

function extractYouTubeId(url) {
  const match = url.match(
    /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/
  );
  return match?.[1] || null;
}

function extractTikTokId(url) {
  const match = url.match(/tiktok\.com\/@[^/]+\/video\/(\d+)/);
  return match?.[1] || null;
}

// ─── Video metadata fetch ─────────────────────────────────────────────────────

async function fetchVideoInfo(platform, url) {
  if (platform === "youtube") {
    const videoId = extractYouTubeId(url);
    if (!videoId) {
      throw new AppError(
        "Invalid YouTube URL. Use a youtube.com/watch or youtu.be link.",
        400
      );
    }

    const thumbnail = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
    let title = "";
    let channelName = "";
    let views = 0;
    let likes = 0;

    // oEmbed — always public, no key required
    try {
      const oe = await httpsGet(
        `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`
      );
      title = oe.title || "";
      channelName = oe.author_name || "";
    } catch {}

    // No YouTube API is used here. The count is scraped from the publicly
    // rendered watch page; oEmbed above is only used for lightweight metadata.
    const watchPage = await fetchYouTubeStatsFromWatchPage(videoId);
    if (watchPage.views > 0) views = watchPage.views;
    if (!title && watchPage.title) title = watchPage.title;
    if (!channelName && watchPage.channelName) channelName = watchPage.channelName;

    return { videoId, platform: "youtube", title, thumbnail, channelName, views, likes };
  }

  if (platform === "tiktok") {
    const videoId = extractTikTokId(url);
    let title = "";
    let thumbnail = "";
    let channelName = "";
    let views = 0;
    let likes = 0;

    // oEmbed gives us title/thumbnail/author but no stats
    try {
      const oe = await httpsGet(
        `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`
      );
      title = oe.title || "";
      thumbnail = oe.thumbnail_url || "";
      channelName = oe.author_name || "";
    } catch {}

    // Scrape the TikTok page for real view/like counts
    try {
      const scraped = await scrapeTikTokStats(url, videoId);
      views = scraped.views;
      likes = scraped.likes;
    } catch {}

    return {
      videoId: videoId || null,
      platform: "tiktok",
      title,
      thumbnail,
      channelName,
      views,
      likes,
    };
  }

  throw new AppError("Unsupported platform. Only youtube and tiktok are accepted.", 400);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CREATOR ENDPOINTS  (collabAuth middleware — req.collabUser.id)
// ═══════════════════════════════════════════════════════════════════════════════

exports.creatorPreview = catchAsync(async (req, res, next) => {
  const { platform, url } = req.body;
  if (!platform || !url) return next(new AppError("platform and url are required", 400));

  const info = await fetchVideoInfo(platform, url);
  res.json({ success: true, data: { info } });
});

exports.creatorSubmit = catchAsync(async (req, res, next) => {
  const { platform, url } = req.body;
  if (!platform || !url) return next(new AppError("platform and url are required", 400));

  // Prevent duplicates for the same creator/URL while not yet paid
  const exists = await SocialSubmission.findOne({
    collaborator: req.collabUser.id,
    url,
    status: { $ne: "paid" },
  });
  if (exists) {
    return next(new AppError("You have already submitted this video.", 409));
  }

  const info = await fetchVideoInfo(platform, url);

  const creator = await Collaborator.findById(req.collabUser.id);
  const rateType = creator?.socialRateType || "per_1k";
  const rate = Number(creator?.socialRate || 0);
  const offeredAmount = rateType === "per_1k"
    ? Number(((info.views / 1000) * rate).toFixed(2))
    : rate;
  const submission = await SocialSubmission.create({
    collaborator: req.collabUser.id,
    platform: info.platform,
    url,
    videoId: info.videoId,
    title: info.title,
    thumbnail: info.thumbnail,
    channelName: info.channelName,
    views: info.views,
    likes: info.likes,
    status: "active",
    rateType,
    ratePerView: rateType === "per_1k" ? rate / 1000 : 0,
    offeredAmount,
  });

  res.status(201).json({ success: true, data: { submission } });
});

exports.creatorGetMy = catchAsync(async (req, res) => {
  const { status } = req.query;
  const filter = { collaborator: req.collabUser.id };
  if (status) filter.status = status;

  const submissions = await SocialSubmission.find(filter).sort({ createdAt: -1 });
  res.json({ success: true, data: { submissions } });
});

exports.creatorGetStats = catchAsync(async (req, res) => {
  const all = await SocialSubmission.find({ collaborator: req.collabUser.id });

  const stats = {
    total: all.length,
    inReview: all.filter((s) => s.status === "in_review").length,
    reviewed: all.filter((s) => s.status === "reviewed").length,
    accepted: all.filter((s) => s.status === "accepted").length,
    paid: all.filter((s) => s.status === "paid").length,
    pendingPayout: parseFloat(
      all.filter((s) => s.status !== "paid")
        .reduce((sum, s) => sum + Math.max(0, (s.offeredAmount || 0) - (s.paidAmount || 0)), 0)
        .toFixed(2)
    ),
    totalPaid: parseFloat(
      all.reduce((sum, s) => sum + (s.paidAmount || (s.status === "paid" ? s.offeredAmount || 0 : 0)), 0)
        .toFixed(2)
    ),
  };

  res.json({ success: true, data: { stats } });
});

exports.creatorGetPayouts = catchAsync(async (req, res) => {
  const payouts = await SocialPayout.find({ collaborator: req.collabUser.id }).sort({
    createdAt: -1,
  });
  res.json({ success: true, data: { payouts } });
});

exports.creatorAccept = catchAsync(async (req, res, next) => {
  const submission = await SocialSubmission.findOne({
    _id: req.params.id,
    collaborator: req.collabUser.id,
  });

  if (!submission) return next(new AppError("Submission not found", 404));
  if (submission.status !== "reviewed") {
    return next(new AppError("This submission is not in a reviewable state", 400));
  }

  submission.status = "accepted";
  submission.acceptedAt = new Date();
  await submission.save();

  res.json({ success: true, data: { submission } });
});

exports.creatorRequestPayout = catchAsync(async (req, res, next) => {
  const creator = await Collaborator.findById(req.collabUser.id);
  const outstanding = await SocialSubmission.find({ collaborator: creator._id, status: { $ne: "paid" } });
  const balance = outstanding.reduce((sum, s) => sum + Math.max(0, (s.offeredAmount || 0) - (s.paidAmount || 0)), 0);
  if (balance <= 0) return next(new AppError("There is no available balance to request.", 400));
  creator.payoutRequestedAt = new Date();
  await creator.save();
  res.json({ success: true, data: { requestedAt: creator.payoutRequestedAt, balance: Number(balance.toFixed(2)) } });
});

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN ENDPOINTS  (panelAuth + requirePermission middleware)
// ═══════════════════════════════════════════════════════════════════════════════

exports.adminList = catchAsync(async (req, res) => {
  const { status, platform, collaborator, page = 1, limit = 60 } = req.query;
  const filter = {};
  if (status) filter.status = status;
  if (platform) filter.platform = platform;
  if (collaborator) filter.collaborator = collaborator;

  const [submissions, total] = await Promise.all([
    SocialSubmission.find(filter)
      .populate("collaborator", "name email")
      .sort({ createdAt: -1 })
      .skip((parseInt(page) - 1) * parseInt(limit))
      .limit(parseInt(limit)),
    SocialSubmission.countDocuments(filter),
  ]);

  res.json({ success: true, data: { submissions, total } });
});

exports.adminGetOne = catchAsync(async (req, res, next) => {
  const submission = await SocialSubmission.findById(req.params.id).populate(
    "collaborator",
    "name email"
  );
  if (!submission) return next(new AppError("Submission not found", 404));
  res.json({ success: true, data: { submission } });
});

exports.adminSetRate = catchAsync(async (req, res, next) => {
  const { rateType, ratePerView, offeredAmount, adminNote } = req.body;

  const sub = await SocialSubmission.findById(req.params.id);
  if (!sub) return next(new AppError("Submission not found", 404));
  if (sub.status === "paid") {
    return next(new AppError("This submission has already been paid out", 400));
  }

  let finalRatePerView = 0;
  let finalOfferedAmount = 0;

  if (rateType === "per_1k" || rateType === "per_view") {
    finalRatePerView = rateType === "per_1k" ? parseFloat(ratePerView) / 1000 : parseFloat(ratePerView);
    if (!finalRatePerView || finalRatePerView <= 0) {
      return next(new AppError("Rate per view must be greater than 0", 400));
    }
    finalOfferedAmount = parseFloat((finalRatePerView * (sub.views || 0)).toFixed(2));
  } else if (rateType === "per_video" || rateType === "auto") {
    finalOfferedAmount = parseFloat(offeredAmount);
    if (!finalOfferedAmount || finalOfferedAmount <= 0) {
      return next(new AppError("Offered amount must be greater than 0", 400));
    }
    finalRatePerView =
      sub.views > 0
        ? parseFloat((finalOfferedAmount / sub.views).toFixed(8))
        : 0;
  } else {
    return next(new AppError("rateType must be 'per_1k' or 'per_video'", 400));
  }

  sub.rateType = rateType === "per_view" ? "per_1k" : rateType === "auto" ? "per_video" : rateType;
  sub.ratePerView = finalRatePerView;
  sub.offeredAmount = finalOfferedAmount;
  if (adminNote !== undefined) sub.adminNote = adminNote;
  await sub.save();

  res.json({ success: true, data: { submission: sub } });
});

exports.adminInviteCreator = catchAsync(async (req, res, next) => {
  const { name, email, rateType = "per_1k", rate = 0, paymentMethods = [], requiresPaymentProof = false } = req.body;
  if (!name || !email) return next(new AppError("name and email are required", 400));

  const existing = await Collaborator.findOne({ email: email.toLowerCase().trim() });
  if (existing) return next(new AppError("A creator with this email already exists", 409));

  const creator = new Collaborator({
    name: name.trim(),
    email: email.toLowerCase().trim(),
    isSocialCreator: true,
    invitedBy: req.panelUser.email,
    status: "invited",
    socialRateType: rateType,
    socialRate: Number(rate) || 0,
    paymentMethods,
    requiresPaymentProof,
  });

  const rawToken = creator.generateInviteToken();
  await creator.save();

  const inviteUrl = `${process.env.FRONTEND_URL}/socials/invite/${rawToken}`;
  const inviterName = req.panelUser.email;

  await sendSocialInviteEmail({ to: creator.email, inviteUrl, name: creator.name, inviterName });

  res.status(201).json({
    success: true,
    data: { creator: creator.toSafeObject(), inviteUrl },
  });
});

exports.adminUpdateCreator = catchAsync(async (req, res, next) => {
  const creator = await Collaborator.findOne({ _id: req.params.collabId, isSocialCreator: true });
  if (!creator) return next(new AppError("Creator not found", 404));
  const { name, socialRateType, socialRate, paymentMethods, requiresPaymentProof } = req.body;
  if (name !== undefined) creator.name = String(name).trim();
  if (socialRateType !== undefined) creator.socialRateType = socialRateType;
  if (socialRate !== undefined) creator.socialRate = Number(socialRate) || 0;
  if (paymentMethods !== undefined) creator.paymentMethods = paymentMethods;
  if (requiresPaymentProof !== undefined) creator.requiresPaymentProof = Boolean(requiresPaymentProof);
  await creator.save();
  // A changed agreement applies to currently tracking videos too, so balances
  // never require a manual review/recalculation pass.
  if (socialRateType !== undefined || socialRate !== undefined) {
    const tracking = await SocialSubmission.find({ collaborator: creator._id, status: { $ne: "paid" } });
    for (const sub of tracking) {
      sub.rateType = creator.socialRateType;
      sub.ratePerView = creator.socialRateType === "per_1k" ? creator.socialRate / 1000 : 0;
      sub.offeredAmount = creator.socialRateType === "per_1k"
        ? Number(((sub.views || 0) * creator.socialRate / 1000).toFixed(2))
        : Number(creator.socialRate.toFixed(2));
      await sub.save();
    }
  }
  res.json({ success: true, data: { creator: creator.toSafeObject() } });
});

exports.adminListCreators = catchAsync(async (req, res) => {
  const collaborators = await Collaborator.find({ isSocialCreator: true, status: { $in: ["active", "invited"] } }).sort({ createdAt: -1 });

  const enriched = await Promise.all(
    collaborators.map(async (c) => {
      const submissions = await SocialSubmission.find({ collaborator: c._id }).lean();
      const pendingPayout = submissions
        .filter((s) => s.status !== "paid")
        .reduce((sum, s) => sum + Math.max(0, (s.offeredAmount || 0) - (s.paidAmount || 0)), 0);
      const totalPaid = submissions
        .reduce((sum, s) => sum + (s.paidAmount || (s.status === "paid" ? s.offeredAmount || 0 : 0)), 0);
      const lastPayout = await SocialPayout.findOne({ collaborator: c._id }).sort({
        createdAt: -1,
      });

      return {
        ...c.toSafeObject(),
        socialStats: {
          total: submissions.length,
          inReview: submissions.filter((s) => s.status === "in_review").length,
          reviewed: submissions.filter((s) => s.status === "reviewed").length,
          accepted: submissions.filter((s) => s.status === "accepted").length,
          active: submissions.filter((s) => s.status === "active").length,
          paid: submissions.filter((s) => s.status === "paid").length,
          pendingPayout: parseFloat(pendingPayout.toFixed(2)),
          totalPaid: parseFloat(totalPaid.toFixed(2)),
        },
        lastSocialPayoutAt: lastPayout?.paidAt || null,
        lastSocialPayoutAmount: lastPayout?.amount || null,
      };
    })
  );

  res.json({ success: true, data: { creators: enriched } });
});

exports.adminDeleteCreator = catchAsync(async (req, res, next) => {
  const collab = await Collaborator.findOne({ _id: req.params.collabId, isSocialCreator: true });
  if (!collab) return next(new AppError("Creator not found", 404));

  const hasPending = await SocialSubmission.exists({
    collaborator: collab._id,
    status: { $in: ["in_review", "reviewed", "accepted"] },
  });
  if (hasPending) {
    return next(new AppError("Cannot remove a creator with pending or unpaid submissions. Resolve them first.", 400));
  }

  await Collaborator.deleteOne({ _id: collab._id });
  res.json({ success: true, message: "Creator removed." });
});

exports.adminGetCreator = catchAsync(async (req, res, next) => {
  const collab = await Collaborator.findById(req.params.collabId);
  if (!collab) return next(new AppError("Creator not found", 404));

  const [submissions, payouts] = await Promise.all([
    SocialSubmission.find({ collaborator: collab._id }).sort({ createdAt: -1 }),
    SocialPayout.find({ collaborator: collab._id }).sort({ createdAt: -1 }),
  ]);

  const acceptedSubs = submissions.filter((s) => s.status !== "paid" && ((s.offeredAmount || 0) - (s.paidAmount || 0)) > 0);
  const pendingPayout = parseFloat(
    acceptedSubs.reduce((sum, s) => sum + Math.max(0, (s.offeredAmount || 0) - (s.paidAmount || 0)), 0).toFixed(2)
  );

  res.json({
    success: true,
    data: {
      creator: collab.toSafeObject(),
      submissions,
      payouts,
      acceptedSubmissions: acceptedSubs,
      pendingPayout,
    },
  });
});

exports.adminMarkPaid = catchAsync(async (req, res, next) => {
  const collab = await Collaborator.findById(req.params.collabId);
  if (!collab) return next(new AppError("Creator not found", 404));

  // Sort oldest first so partial payouts cover the earliest accepted submissions
  const acceptedSubs = await SocialSubmission.find({
    collaborator: collab._id,
    status: { $ne: "paid" },
  }).sort({ acceptedAt: 1 });

  if (acceptedSubs.length === 0) {
    return next(new AppError("No accepted submissions to pay out", 400));
  }

  const totalOwed = parseFloat(
    acceptedSubs.reduce((sum, s) => sum + Math.max(0, (s.offeredAmount || 0) - (s.paidAmount || 0)), 0).toFixed(2)
  );

  // Optional partial payout: only pay up to partialAmount
  const { partialAmount, paymentMethod, proofUrl } = req.body;
  let payoutAmount = partialAmount == null ? totalOwed : Number(partialAmount);

  if (partialAmount != null) {
    if (isNaN(payoutAmount) || payoutAmount <= 0) {
      return next(new AppError("partialAmount must be a positive number", 400));
    }
    if (payoutAmount > totalOwed) {
      return next(new AppError(`Partial amount ($${payoutAmount}) exceeds total owed ($${totalOwed})`, 400));
    }

    // Select submissions from oldest until we hit the partial amount
  }
  let left = Number(payoutAmount.toFixed(2));
  const allocations = [];
  for (const s of acceptedSubs) {
    if (left <= 0) break;
    const owing = Math.max(0, (s.offeredAmount || 0) - (s.paidAmount || 0));
    const amount = Number(Math.min(owing, left).toFixed(2));
    if (amount) { allocations.push({ submission: s._id, amount }); left = Number((left - amount).toFixed(2)); }
  }

  const payout = await SocialPayout.create({
    collaborator: collab._id,
    amount: payoutAmount,
    submissionCount: allocations.length,
    submissionIds: allocations.map((s) => s.submission), allocations,
    paymentMethod: paymentMethod || "", proofUrl: proofUrl || "",
    periodEnd: new Date(),
    paidAt: new Date(),
    paidBy: req.panelUser.email,
  });

  for (const allocation of allocations) {
    const sub = acceptedSubs.find(s => String(s._id) === String(allocation.submission));
    sub.paidAmount = Number(((sub.paidAmount || 0) + allocation.amount).toFixed(2));
    if (sub.paidAmount + 0.001 >= (sub.offeredAmount || 0)) { sub.status = "paid"; sub.paidAt = new Date(); sub.paidBy = req.panelUser.email; sub.paidInPayoutId = payout._id; }
    await sub.save();
  }
  collab.payoutRequestedAt = null;
  await collab.save();

  res.json({
    success: true,
    data: { payout, count: allocations.length, totalAmount: payoutAmount },
  });
});

exports.adminRefreshViews = catchAsync(async (req, res, next) => {
  const sub = await SocialSubmission.findById(req.params.id);
  if (!sub) return next(new AppError("Submission not found", 404));
  if (sub.status === "paid") {
    return next(new AppError("Cannot refresh views on a paid submission", 400));
  }

  let updatedViews = sub.views;
  let updatedLikes = sub.likes;

  try {
    const info = await fetchVideoInfo(sub.platform, sub.url);
    updatedViews = info.views;
    updatedLikes = info.likes;
    if (!sub.title && info.title) sub.title = info.title;
    if (!sub.thumbnail && info.thumbnail) sub.thumbnail = info.thumbnail;
    if (!sub.channelName && info.channelName) sub.channelName = info.channelName;
  } catch (e) {
    return next(new AppError(`Could not refresh views: ${e.message}`, 502));
  }

  sub.views = updatedViews;
  sub.likes = updatedLikes;

  // If the rate was set per_view, recalculate the offered amount
  if ((sub.rateType === "per_view" || sub.rateType === "per_1k") && sub.ratePerView && sub.status !== "paid") {
    sub.offeredAmount = parseFloat((sub.ratePerView * updatedViews).toFixed(2));
  }

  await sub.save();

  res.json({ success: true, data: { submission: sub } });
});

async function fetchFeaturedYouTuber(username) {
  const clean = username.replace(/^@/, "").trim();
  const channelUrl = `https://www.youtube.com/@${clean}`;
  const html = await httpsFetchText(channelUrl);
  const title = html.match(/<meta property="og:title" content="([^"]+)"/)?.[1] || clean;
  const avatarUrl = html.match(/<meta property="og:image" content="([^"]+)"/)?.[1] || "";
  const subscriberText = html.match(/([\d.,]+[KMB]?)\s+subscribers/i)?.[1] || "0";
  const factor = /B$/i.test(subscriberText) ? 1e9 : /M$/i.test(subscriberText) ? 1e6 : /K$/i.test(subscriberText) ? 1e3 : 1;
  return { username: clean, name: title.replace(/ - YouTube$/i, ""), subscribers: Math.round(parseFloat(subscriberText.replace(/[KMB,]/gi, "")) * factor) || 0, avatarUrl, channelUrl };
}
exports.publicFeaturedYouTubers = catchAsync(async (req, res) => {
  const creators = await FeaturedYouTuber.find({ active: true }).sort({ createdAt: -1 }).lean();
  res.json({ success: true, data: { creators } });
});
exports.adminFeaturedYouTubers = catchAsync(async (req, res) => {
  res.json({ success: true, data: { creators: await FeaturedYouTuber.find().sort({ createdAt: -1 }) } });
});
exports.adminAddFeaturedYouTuber = catchAsync(async (req, res, next) => {
  if (!req.body.username) return next(new AppError("A YouTube username is required", 400));
  let data; try { data = await fetchFeaturedYouTuber(req.body.username); } catch { data = { username: req.body.username.replace(/^@/, "").trim(), name: req.body.username.replace(/^@/, "").trim(), channelUrl: `https://www.youtube.com/@${req.body.username.replace(/^@/, "").trim()}` }; }
  const creator = await FeaturedYouTuber.findOneAndUpdate({ username: data.username }, data, { upsert: true, new: true, setDefaultsOnInsert: true });
  res.status(201).json({ success: true, data: { creator } });
});
exports.adminDeleteFeaturedYouTuber = catchAsync(async (req, res, next) => {
  const creator = await FeaturedYouTuber.findByIdAndDelete(req.params.id);
  if (!creator) return next(new AppError("YouTuber not found", 404));
  res.json({ success: true });
});
