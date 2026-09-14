{ pkgs, ... }:

{
  # JavaScript/Node — matches the release workflow (Node 22 LTS)
  languages.javascript = {
    enable = true;
    package = pkgs.nodejs_22;
    npm.enable = true;
    npm.install.enable = true;
  };

  # Rust toolchain from nixpkgs (binary-cached on cache.nixos.org —
  # deliberately not rust-overlay, which would need extra substituters).
  # Tauri Linux system libraries mirror the set used in flake.nix.
  packages =
    with pkgs;
    [
      rustc
      cargo
      rustfmt
      clippy
      rust-analyzer
      pkg-config
      openssl
    ]
    ++ pkgs.lib.optionals pkgs.stdenv.hostPlatform.isLinux [
      webkitgtk_4_1
      gtk3
      cairo
      gdk-pixbuf
      glib
      dbus
      librsvg
      libappindicator-gtk3
    ]
    ++ pkgs.lib.optionals pkgs.stdenv.hostPlatform.isDarwin (
      with pkgs.darwin.apple_sdk.frameworks;
      [
        Security
        CoreServices
        CoreFoundation
        Foundation
        AppKit
        WebKit
      ]
    );

  env.RUST_SRC_PATH = "${pkgs.rustPlatform.rustLibSrc}";

  # Convenience: `devenv run dev` / `devenv run build`
  scripts = {
    dev.exec = "npm run dev";
    build.exec = "npm run build";
  };

  enterShell = ''
    echo "Backlog App devenv — npm run dev | cargo check (src-tauri)"
  '';
}
