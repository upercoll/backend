const Role = require("../models/Role");
const TeamMember = require("../models/TeamMember");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");
const { PERMISSIONS } = require("../models/Role");

exports.getPermissions = catchAsync(async (req, res) => {
  res.json({ success: true, data: { permissions: PERMISSIONS } });
});

exports.listRoles = catchAsync(async (req, res) => {
  const roles = await Role.find({ active: true })
    .populate("createdBy", "email name")
    .sort({ createdAt: -1 });

  const rolesWithCounts = await Promise.all(
    roles.map(async (role) => {
      const memberCount = await TeamMember.countDocuments({ role: role._id, active: true });
      return { ...role.toObject(), memberCount };
    })
  );

  res.json({ success: true, data: { roles: rolesWithCounts } });
});

exports.getRole = catchAsync(async (req, res, next) => {
  const role = await Role.findById(req.params.id).populate("createdBy", "email name");
  if (!role) return next(new AppError("Role not found", 404));

  const members = await TeamMember.find({ role: role._id, active: true }).select("email status claimGames createdAt");

  res.json({ success: true, data: { role, members } });
});

exports.createRole = catchAsync(async (req, res, next) => {
  const { name, description, color, permissions } = req.body;
  if (!name) return next(new AppError("Role name is required", 400));

  const invalid = (permissions || []).filter((p) => !PERMISSIONS.includes(p));
  if (invalid.length) return next(new AppError(`Invalid permissions: ${invalid.join(", ")}`, 400));

  const existing = await Role.findOne({ name: name.trim(), active: true });
  if (existing) return next(new AppError("A role with this name already exists", 400));

  const role = await Role.create({
    name: name.trim(),
    description,
    color: color || "#6366f1",
    permissions: permissions || [],
    createdBy: req.panelUser.id,
  });

  res.status(201).json({ success: true, data: { role } });
});

exports.updateRole = catchAsync(async (req, res, next) => {
  const role = await Role.findById(req.params.id);
  if (!role) return next(new AppError("Role not found", 404));

  const { name, description, color, permissions } = req.body;

  if (permissions) {
    const invalid = permissions.filter((p) => !PERMISSIONS.includes(p));
    if (invalid.length) return next(new AppError(`Invalid permissions: ${invalid.join(", ")}`, 400));
    role.permissions = permissions;
  }

  if (name) role.name = name.trim();
  if (description !== undefined) role.description = description;
  if (color) role.color = color;

  await role.save();
  res.json({ success: true, data: { role } });
});

exports.deleteRole = catchAsync(async (req, res, next) => {
  const role = await Role.findById(req.params.id);
  if (!role) return next(new AppError("Role not found", 404));

  const memberCount = await TeamMember.countDocuments({ role: role._id, active: true });
  if (memberCount > 0) {
    return next(new AppError(`Cannot delete role with ${memberCount} active member(s). Reassign them first.`, 400));
  }

  role.active = false;
  await role.save();

  res.json({ success: true, message: "Role deleted" });
});
