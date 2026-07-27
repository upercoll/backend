const https = require("https");
const Collaborator = require("../models/Collaborator");
const SocialSubmission = require("../models/SocialSubmission");
const SocialPayout = require("../models/SocialPayout");
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

async function scrapeTikTokStats(url) {
  try {
    const html = await httpsFetchText(url);
    // TikTok embeds video stats inside multiple possible JSON blobs
    // playCount = views, diggCount = likes
    const viewMatch = html.match(/"playCount"\s*:\s*(\d+)/);
    const likeMatch = html.match(/"diggCount"\s*:\s*(\d+)/);
    return {
      views: viewMatch ? parseInt(viewMatch[1], 10) : 0,
      likes: likeMatch ? parseInt(likeMatch[1], 10) : 0,
    };
  } catch {
    return { views: 0, likes: 0 };
  }
}

async function scrapeYouTubeStats(videoId) {
  try {
    const html = await httpsFetchText(
      `https://www.youtube.com/watch?v=${videoId}`,
      {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      }
    );
    const viewMatch = html.match(/"viewCount"\s*:\s*"(\d+)"/);
    // likeCount is hidden on the page but sometimes in ytInitialData
    const likeMatch = html.match(/"defaultText"\s*:\s*\{\s*"accessibility"\s*:\s*\{\s*"accessibilityData"\s*:\s*\{\s*"label"\s*:\s*"([\d,]+) likes"/);
    return {
      views: viewMatch ? parseInt(viewMatch[1], 10) : 0,
      likes: likeMatch ? parseInt(likeMatch[1].replace(/,/g, ""), 10) : 0,
    };
  } catch {
    return { views: 0, likes: 0 };
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

    // Try YouTube Data API v3 first (best quality, requires key)
    if (process.env.YOUTUBE_API_KEY) {
      try {
        const stats = await httpsGet(
          `https://www.googleapis.com/youtube/v3/videos?id=${videoId}` +
            `&key=${process.env.YOUTUBE_API_KEY}&part=statistics,snippet`
        );
        const item = stats.items?.[0];
        if (item) {
          views = parseInt(item.statistics?.viewCount || 0);
          likes = parseInt(item.statistics?.likeCount || 0);
          if (!title) title = item.snippet?.title || "";
          if (!channelName) channelName = item.snippet?.channelTitle || "";
        }
      } catch {}
    }

    // Fallback: scrape the YouTube page for view count when no API key or API returned 0
    if (views === 0) {
      try {
        const scraped = await scrapeYouTubeStats(videoId);
        if (scraped.views > 0) views = scraped.views;
        if (scraped.likes > 0 && likes === 0) likes = scraped.likes;
      } catch {}
    }

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
      const scraped = await scrapeTikTokStats(url);
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
    status: "in_review",
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
      all
        .filter((s) => s.status === "accepted")
        .reduce((sum, s) => sum + (s.offeredAmount || 0), 0)
        .toFixed(2)
    ),
    totalPaid: parseFloat(
      all
        .filter((s) => s.status === "paid")
        .reduce((sum, s) => sum + (s.offeredAmount || 0), 0)
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

  if (rateType === "per_view") {
    finalRatePerView = parseFloat(ratePerView);
    if (!finalRatePerView || finalRatePerView <= 0) {
      return next(new AppError("Rate per view must be greater than 0", 400));
    }
    finalOfferedAmount = parseFloat((finalRatePerView * (sub.views || 0)).toFixed(2));
  } else if (rateType === "auto") {
    finalOfferedAmount = parseFloat(offeredAmount);
    if (!finalOfferedAmount || finalOfferedAmount <= 0) {
      return next(new AppError("Offered amount must be greater than 0", 400));
    }
    finalRatePerView =
      sub.views > 0
        ? parseFloat((finalOfferedAmount / sub.views).toFixed(8))
        : 0;
  } else {
    return next(new AppError("rateType must be 'per_view' or 'auto'", 400));
  }

  sub.rateType = rateType;
  sub.ratePerView = finalRatePerView;
  sub.offeredAmount = finalOfferedAmount;
  if (adminNote !== undefined) sub.adminNote = adminNote;
  sub.status = "reviewed";
  sub.reviewedAt = new Date();
  sub.reviewedBy = req.panelUser.email;

  await sub.save();

  res.json({ success: true, data: { submission: sub } });
});

exports.adminInviteCreator = catchAsync(async (req, res, next) => {
  const { name, email } = req.body;
  if (!name || !email) return next(new AppError("name and email are required", 400));

  const existing = await Collaborator.findOne({ email: email.toLowerCase().trim() });
  if (existing) return next(new AppError("A creator with this email already exists", 409));

  const creator = new Collaborator({
    name: name.trim(),
    email: email.toLowerCase().trim(),
    isSocialCreator: true,
    invitedBy: req.panelUser.email,
    status: "invited",
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

exports.adminListCreators = catchAsync(async (req, res) => {
  const collaborators = await Collaborator.find({ isSocialCreator: true, status: { $in: ["active", "invited"] } }).sort({ createdAt: -1 });

  const enriched = await Promise.all(
    collaborators.map(async (c) => {
      const submissions = await SocialSubmission.find({ collaborator: c._id }).lean();
      const pendingPayout = submissions
        .filter((s) => s.status === "accepted")
        .reduce((sum, s) => sum + (s.offeredAmount || 0), 0);
      const totalPaid = submissions
        .filter((s) => s.status === "paid")
        .reduce((sum, s) => sum + (s.offeredAmount || 0), 0);
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

  const acceptedSubs = submissions.filter((s) => s.status === "accepted");
  const pendingPayout = parseFloat(
    acceptedSubs.reduce((sum, s) => sum + (s.offeredAmount || 0), 0).toFixed(2)
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
    status: "accepted",
  }).sort({ acceptedAt: 1 });

  if (acceptedSubs.length === 0) {
    return next(new AppError("No accepted submissions to pay out", 400));
  }

  const totalOwed = parseFloat(
    acceptedSubs.reduce((sum, s) => sum + (s.offeredAmount || 0), 0).toFixed(2)
  );

  // Optional partial payout: only pay up to partialAmount
  const { partialAmount } = req.body;
  let subsToMark = acceptedSubs;
  let payoutAmount = totalOwed;

  if (partialAmount != null) {
    const partial = parseFloat(partialAmount);
    if (isNaN(partial) || partial <= 0) {
      return next(new AppError("partialAmount must be a positive number", 400));
    }
    if (partial > totalOwed) {
      return next(new AppError(`Partial amount ($${partial}) exceeds total owed ($${totalOwed})`, 400));
    }

    // Select submissions from oldest until we hit the partial amount
    subsToMark = [];
    let running = 0;
    for (const s of acceptedSubs) {
      const amt = s.offeredAmount || 0;
      if (running + amt > partial + 0.001) break; // stop before exceeding
      subsToMark.push(s);
      running = parseFloat((running + amt).toFixed(2));
    }

    if (subsToMark.length === 0) {
      return next(new AppError("Partial amount is less than any single accepted submission's payout", 400));
    }
    payoutAmount = parseFloat(
      subsToMark.reduce((sum, s) => sum + (s.offeredAmount || 0), 0).toFixed(2)
    );
  }

  const payout = await SocialPayout.create({
    collaborator: collab._id,
    amount: payoutAmount,
    submissionCount: subsToMark.length,
    submissionIds: subsToMark.map((s) => s._id),
    periodEnd: new Date(),
    paidAt: new Date(),
    paidBy: req.panelUser.email,
  });

  await SocialSubmission.updateMany(
    { _id: { $in: subsToMark.map((s) => s._id) } },
    {
      status: "paid",
      paidAt: new Date(),
      paidBy: req.panelUser.email,
      paidInPayoutId: payout._id,
    }
  );

  res.json({
    success: true,
    data: { payout, count: subsToMark.length, totalAmount: payoutAmount },
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
  if (sub.rateType === "per_view" && sub.ratePerView && sub.status !== "accepted") {
    sub.offeredAmount = parseFloat((sub.ratePerView * updatedViews).toFixed(2));
  }

  await sub.save();

  res.json({ success: true, data: { submission: sub } });
});
