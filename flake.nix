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

      flake = {
        nixosModules.default = import ./nix/module.nix;
        nixosModules.personal-backlog = import ./nix/module.nix;
      };

      perSystem =
        {
          system,
          pkgs,
          ...
        }:
        let
          pre-commit-check = git-hooks.lib.${system}.run {
            src = ./.;
            hooks = {
              nixfmt.enable = true;
            };
          };
        in
        {
          formatter = pkgs.nixfmt-tree;

          packages = {
            default = pkgs.callPackage ./nix/package.nix { };
            personal-backlog = pkgs.callPackage ./nix/package.nix { };
          };

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
