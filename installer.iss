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
UninstallDisplayIcon={app}\bundeck-launcher.exe
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
Source: "dist\bundeck-daemon.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "dist\bundeck-cli.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "dist\bundeck-launcher.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "dist\bundeck-updater.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "dist\active.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "icon.ico"; DestDir: "{app}"; Flags: ignoreversion
Source: "dist\web-dist\*"; DestDir: "{app}\web-dist"; Flags: ignoreversion recursesubdirs createallsubdirs

[Dirs]
Name: "{%APPDATA}\BunDeck"; Flags: uninsneveruninstall
Name: "{%APPDATA}\BunDeck\data"; Flags: uninsneveruninstall
Name: "{%APPDATA}\BunDeck\data\assets"; Flags: uninsneveruninstall
Name: "{%APPDATA}\BunDeck\data\logs"; Flags: uninsneveruninstall
Name: "{%APPDATA}\BunDeck\data\plugins"; Flags: uninsneveruninstall
; Compat: instalaciones antiguas usaban LibreDeck
Name: "{%APPDATA}\LibreDeck"; Flags: uninsneveruninstall
Name: "{%APPDATA}\LibreDeck\data"; Flags: uninsneveruninstall

[Icons]
Name: "{group}\BunDeck"; Filename: "{app}\bundeck-launcher.exe"; IconFilename: "{app}\icon.ico"
Name: "{group}\{cm:UninstallProgram,BunDeck}"; Filename: "{uninstallexe}"
Name: "{userdesktop}\BunDeck"; Filename: "{app}\bundeck-launcher.exe"; IconFilename: "{app}\icon.ico"; Tasks: desktopicon

[Run]
Filename: "{app}\bundeck-launcher.exe"; Description: "{cm:LaunchProgram,BunDeck}"; Flags: nowait postinstall skipifsilent
