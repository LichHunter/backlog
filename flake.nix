{
  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs";
    flake-parts.url = "github:hercules-ci/flake-parts";
    git-hooks.url = "github:cachix/git-hooks.nix";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-parts,
      git-hooks,
      ...
    }@inputs:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [
        "x86_64-linux"
      ];

      perSystem =
        {
          system,
          ...
        }:
        let
          pkgs = import nixpkgs {
            inherit system;
            config.allowUnfree = true;
          };

          pre-commit-check = git-hooks.lib.${system}.run {
            src = ./.;
            hooks = {
              nixfmt.enable = true;
            };
          };
        in
        {
          formatter = pkgs.nixfmt-tree;

          checks = {
            inherit pre-commit-check;
          };

          devShells.default = pkgs.mkShell {
            inherit (pre-commit-check) shellHook;

            buildInputs = with pkgs; [
              pre-commit
              gitleaks

              nixd
              nodejs_22

              opencode
            ];
          };
        };
    };
}
