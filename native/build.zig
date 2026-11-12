const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.resolveTargetQuery(.{
        .cpu_arch = .x86_64,
        .os_tag = .windows,
        .abi = .gnu,
    });
    const module = b.createModule(.{
        .target = target,
        .optimize = .ReleaseFast,
        .link_libc = true,
    });
    module.addCSourceFile(.{
        .file = b.path("sso-bridge.cpp"),
        .flags = &.{ "-std=c++17", "-Wall", "-Wextra" },
    });
    const library = b.addLibrary(.{
        .name = "sso-bridge",
        .linkage = .dynamic,
        .root_module = module,
    });
    const install = b.addInstallFile(library.getEmittedBin(), "main/sso-bridge-win-x64.node");
    b.getInstallStep().dependOn(&install.step);
}
