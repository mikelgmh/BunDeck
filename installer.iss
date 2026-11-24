#if FileExists("version.iss")
  ; Generado por build.sh / CI desde package.json (no commitear).
  #include "version.iss"
#else
  ; Fallback manual para `iscc installer.iss` directo. Mantener sincronizado.
  #define AppVersion "1.5.0"
#endif
[Setup]
AppName=BunDeck
; Identificador estable para que futuras actualizaciones por usuario
; actualicen esta instalación en su sitio.
AppId=LibreDeck
AppVersion={#AppVersion}
AppPublisher=Mikel
AppPublisherURL=https://github.com/mikelgmh/BunDeck
AppSupportURL=https://github.com/mikelgmh/BunDeck
AppUpdatesURL=https://github.com/mikelgmh/BunDeck
SetupIconFile=icon.ico
UninstallDisplayIcon={app}\libredeck-launcher.exe
DefaultDirName={localappdata}\Programs\BunDeck
DisableDirPage=yes
UsePreviousAppDir=no
PrivilegesRequired=lowest
DefaultGroupName=BunDeck
AllowNoIcons=yes
OutputDir=installer
OutputBaseFilename=BunDeck-Setup
Compression=lzma
SolidCompression=yes
WizardStyle=modern

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "spanish"; MessagesFile: "compiler:Languages\Spanish.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "dist\libredeck-daemon.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "dist\libredeck-cli.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "dist\libredeck-launcher.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "dist\libredeck-updater.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "dist\active.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "icon.ico"; DestDir: "{app}"; Flags: ignoreversion
Source: "dist\web-dist\*"; DestDir: "{app}\web-dist"; Flags: ignoreversion recursesubdirs createallsubdirs

[Dirs]
Name: "{%APPDATA}\LibreDeck"; Flags: uninsneveruninstall
Name: "{%APPDATA}\LibreDeck\data"; Flags: uninsneveruninstall
Name: "{%APPDATA}\LibreDeck\data\assets"; Flags: uninsneveruninstall
Name: "{%APPDATA}\LibreDeck\data\logs"; Flags: uninsneveruninstall
Name: "{%APPDATA}\LibreDeck\data\plugins"; Flags: uninsneveruninstall

[Icons]
Name: "{group}\BunDeck"; Filename: "{app}\libredeck-launcher.exe"; IconFilename: "{app}\icon.ico"
Name: "{group}\{cm:UninstallProgram,BunDeck}"; Filename: "{uninstallexe}"
Name: "{userdesktop}\BunDeck"; Filename: "{app}\libredeck-launcher.exe"; IconFilename: "{app}\icon.ico"; Tasks: desktopicon

[Run]
Filename: "{app}\libredeck-launcher.exe"; Description: "{cm:LaunchProgram,BunDeck}"; Flags: nowait postinstall skipifsilent
