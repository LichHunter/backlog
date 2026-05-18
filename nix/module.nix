{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.services.personal-backlog;
  package = pkgs.callPackage ./package.nix { };
in
{
  options.services.personal-backlog = {
    enable = lib.mkEnableOption "Personal Backlog task manager";

    package = lib.mkOption {
      type = lib.types.package;
      default = package;
      defaultText = lib.literalExpression "pkgs.personal-backlog";
      description = "The personal-backlog package to use.";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 8080;
      description = "Port to listen on.";
    };

    dataDir = lib.mkOption {
      type = lib.types.path;
      default = "/var/lib/personal-backlog";
      description = "Directory to store backlog data.";
    };

    user = lib.mkOption {
      type = lib.types.str;
      default = "backlog";
      description = "User account under which the service runs.";
    };

    group = lib.mkOption {
      type = lib.types.str;
      default = "backlog";
      description = "Group under which the service runs.";
    };

    openFirewall = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Whether to open the firewall for the service port.";
    };
  };

  config = lib.mkIf cfg.enable {
    users.users.${cfg.user} = {
      isSystemUser = true;
      group = cfg.group;
      home = cfg.dataDir;
      createHome = true;
    };

    users.groups.${cfg.group} = { };

    systemd.services.personal-backlog = {
      description = "Personal Backlog Task Manager";
      wantedBy = [ "multi-user.target" ];
      after = [ "network.target" ];

      serviceConfig = {
        Type = "simple";
        User = cfg.user;
        Group = cfg.group;
        WorkingDirectory = cfg.dataDir;
        ExecStart = "${cfg.package}/bin/personal-backlog --port ${toString cfg.port} --dir ${cfg.dataDir}";
        Restart = "on-failure";
        RestartSec = 5;

        StateDirectory = "personal-backlog";
        StateDirectoryMode = "0750";

        NoNewPrivileges = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        PrivateTmp = true;
        ReadWritePaths = [ cfg.dataDir ];
      };
    };

    networking.firewall.allowedTCPPorts = lib.mkIf cfg.openFirewall [ cfg.port ];
  };
}
