const AdminProfile = require("../models/AdminProfile");
const TeamMember = require("../models/TeamMember");
const { uploadToCloudinary, deleteFromCloudinary } = require("../config/cloudinary");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");

exports.getProfile = catchAsync(async (req, res) => {
  const memberType = req.panelUser.isOwner ? "User" : "TeamMember";
  let profile = await AdminProfile.findOne({ memberId: req.panelUser.id, memberType });

  if (!profile) {
    profile = await AdminProfile.create({
      memberId: req.panelUser.id,
      memberType,
      isOwner: req.panelUser.isOwner,
    });
  }

  res.json({ success: true, data: { profile } });
});

exports.updateProfile = catchAsync(async (req, res, next) => {
  const { displayName, username, bio, timezone, notifications } = req.body;
  const memberType = req.panelUser.isOwner ? "User" : "TeamMember";

  let profile = await AdminProfile.findOne({ memberId: req.panelUser.id, memberType });
  if (!profile) return next(new AppError("Profile not found", 404));

  if (username && username !== profile.username) {
    const exists = await AdminProfile.findOne({ username: username.toLowerCase(), _id: { $ne: profile._id } });
    if (exists) return next(new AppError("Username already taken", 400));
    profile.username = username.toLowerCase();
  }

  if (displayName !== undefined) profile.displayName = displayName;
  if (bio !== undefined) profile.bio = bio;
  if (timezone !== undefined) profile.timezone = timezone;
  if (notifications !== undefined) profile.notifications = { ...profile.notifications, ...notifications };

  profile.profileComplete = !!(profile.displayName && profile.username);

  await profile.save();
  res.json({ success: true, data: { profile } });
});

exports.uploadProfilePicture = catchAsync(async (req, res, next) => {
  if (!req.file) return next(new AppError("No image provided", 400));

  const memberType = req.panelUser.isOwner ? "User" : "TeamMember";
  const profile = await AdminProfile.findOne({ memberId: req.panelUser.id, memberType });
  if (!profile) return next(new AppError("Profile not found", 404));

  if (profile.profilePicture && profile.profilePicture.includes("cloudinary")) {
    const publicId = profile.profilePicture.split("/").slice(-1)[0].split(".")[0];
    await deleteFromCloudinary(`rbstars/avatars/${publicId}`);
  }

  const result = await uploadToCloudinary(req.file.buffer, {
    folder: "rbstars/avatars",
    transformation: [{ width: 200, height: 200, crop: "fill", gravity: "face" }],
  });

  profile.profilePicture = result.secure_url;
  await profile.save();

  res.json({ success: true, data: { profilePicture: result.secure_url } });
});

exports.changePassword = catchAsync(async (req, res, next) => {
  if (req.panelUser.isOwner) return next(new AppError("Use the main admin panel for password changes", 400));

  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return next(new AppError("Both passwords required", 400));
  if (newPassword.length < 8) return next(new AppError("New password must be at least 8 characters", 400));

  const member = await TeamMember.findById(req.panelUser.id).select("+password");
  if (!(await member.comparePassword(currentPassword))) {
    return next(new AppError("Current password is incorrect", 401));
  }

  member.password = newPassword;
  await member.save();

  res.json({ success: true, message: "Password updated" });
});
