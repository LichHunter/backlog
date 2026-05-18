{
  lib,
  stdenv,
  python3,
  makeWrapper,
}:

stdenv.mkDerivation {
  pname = "personal-backlog";
  version = "0.1.0";

  src = ./..;

  nativeBuildInputs = [ makeWrapper ];

  buildInputs = [ python3 ];

  dontBuild = true;

  installPhase = ''
    runHook preInstall

    mkdir -p $out/bin $out/share/personal-backlog

    cp server/server.py $out/share/personal-backlog/
    cp -r webapp $out/share/personal-backlog/

    makeWrapper ${python3}/bin/python3 $out/bin/personal-backlog \
      --add-flags "$out/share/personal-backlog/server.py"

    runHook postInstall
  '';

  meta = with lib; {
    description = "A minimalist, single-user task manager where a Markdown file is your database";
    homepage = "https://github.com/alfishe/personal-backlog";
    license = licenses.mit;
    maintainers = [ ];
    platforms = platforms.unix;
    mainProgram = "personal-backlog";
  };
}
