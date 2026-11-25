//! Atajos globales de teclado (Fase 2).
//!
//! - La web guarda sus atajos en el daemon (`settings`, clave
//!   `shortcuts.config`): `{ version: 1, shortcuts: { id: { combo, enabled } } }`.
//! - Este hilo los sondea cada 5 s y los registra como hotkeys globales.
//!   - Windows: `RegisterHotKey` sobre una ventana solo-mensajes propia
//!     (hilo dedicado, mismo patrón que `tray.rs`).
//!   - Linux/macOS: stub (aviso único por stderr; los atajos in-app de la
//!     web siguen funcionando con la ventana enfocada).
//! - Al pulsar: `POST /api/v1/shortcuts/trigger { id, source: "launcher" }`.
//!   El daemon aplica "el primero que captura gana" (ventana de 800 ms por
//!   id) y difunde `shortcut.triggered` para las acciones solo-UI.
//!
//! El hilo es detached y vive lo que el proceso: al salir se liberan los
//! registros automáticamente. No bloquea el arranque (si el daemon aún no
//! responde, reintenta en cada sondeo).

use std::collections::HashMap;
use std::time::{Duration, Instant};

/// Modificadores Win32 (`RegisterHotKey`): MOD_ALT=0x1, MOD_CONTROL=0x2,
/// MOD_SHIFT=0x4, MOD_WIN=0x8. Se definen aquí para que el parser sea
/// testeable sin la API de Windows.
pub const MOD_ALT: u32 = 0x0001;
pub const MOD_CONTROL: u32 = 0x0002;
pub const MOD_SHIFT: u32 = 0x0004;
pub const MOD_WIN: u32 = 0x0008;

/// Ids de atajo conocidos (espejo de `daemon/src/api/shortcuts.ts` y
/// `web/src/composables/useShortcuts.ts`). Se ignoran ids desconocidos.
pub const KNOWN_IDS: &[&str] = &[
    "toggle-panels",
    "next-profile",
    "prev-profile",
    "mute-all",
    "toggle-kiosk",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Hotkey {
    pub mods: u32,
    pub vk: u32,
}

fn vk_for_key(key: &str) -> Option<u32> {
    let k = key.trim();
    if k.len() == 1 {
        let c = k.chars().next()?.to_ascii_uppercase();
        if c.is_ascii_alphabetic() {
            return Some(0x41 + (c as u32 - 'A' as u32));
        }
        if c.is_ascii_digit() {
            return Some(0x30 + (c as u32 - '0' as u32));
        }
        return None;
    }
    // F1..F24
    if (k.len() == 2 || k.len() == 3) && (k.starts_with('F') || k.starts_with('f')) {
        if let Ok(n) = k[1..].parse::<u32>() {
            if (1..=24).contains(&n) {
                return Some(0x6F + n);
            }
        }
        return None;
    }
    Some(match k.to_ascii_lowercase().as_str() {
        "enter" => 0x0D,
        "tab" => 0x09,
        "space" => 0x20,
        "escape" => 0x1B,
        "left" | "arrowleft" => 0x25,
        "up" | "arrowup" => 0x26,
        "right" | "arrowright" => 0x27,
        "down" | "arrowdown" => 0x28,
        "insert" => 0x2D,
        "delete" => 0x2E,
        "home" => 0x24,
        "end" => 0x23,
        "pageup" | "pgup" => 0x21,
        "pagedown" | "pgdn" => 0x22,
        _ => return None,
    })
}

/// Parsea "Ctrl+Alt+P" → (mods, vk). Exige ≥1 modificador y 1 sola tecla.
pub fn parse_hotkey(combo: &str) -> Option<Hotkey> {
    let mut mods = 0u32;
    let mut keys: Vec<&str> = Vec::new();
    for part in combo.split('+') {
        let p = part.trim();
        if p.is_empty() {
            continue;
        }
        match p.to_ascii_lowercase().as_str() {
            "ctrl" | "control" => mods |= MOD_CONTROL,
            "alt" | "option" => mods |= MOD_ALT,
            "shift" => mods |= MOD_SHIFT,
            "meta" | "cmd" | "command" | "win" | "super" | "windows" => mods |= MOD_WIN,
            _ => keys.push(p),
        }
    }
    if mods == 0 || keys.len() != 1 {
        return None;
    }
    vk_for_key(keys[0]).map(|vk| Hotkey { mods, vk })
}

/// Lee `shortcuts.config` del daemon. Devuelve id → (mods, vk) habilitados.
pub fn fetch_enabled_hotkeys() -> HashMap<String, Hotkey> {
    let mut out = HashMap::new();
    let url = format!(
        "http://127.0.0.1:{}/api/v1/settings?key=shortcuts.config",
        super::monitor::api_port()
    );
    let agent: ureq::Agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_millis(1500))
        .timeout_read(Duration::from_millis(1500))
        .timeout_write(Duration::from_millis(1500))
        .build();
    let body: serde_json::Value = match agent.get(&url).call() {
        Ok(res) => match res.into_json() {
            Ok(v) => v,
            Err(_) => return out,
        },
        Err(_) => return out,
    };
    // GET settings?key=… → { key, value }; value es string JSON (o ya objeto).
    let value = body.get("value").cloned().unwrap_or(serde_json::Value::Null);
    let obj: serde_json::Value = match &value {
        serde_json::Value::String(s) => serde_json::from_str(s).unwrap_or(serde_json::Value::Null),
        other => other.clone(),
    };
    let map = obj.get("shortcuts").unwrap_or(&obj);
    let map = match map.as_object() {
        Some(m) => m,
        None => return out,
    };
    for id in KNOWN_IDS {
        let entry = match map.get(*id) {
            Some(e) => e,
            None => continue,
        };
        if entry.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false) {
            if let Some(combo) = entry.get("combo").and_then(|v| v.as_str()) {
                if let Some(hk) = parse_hotkey(combo) {
                    out.insert(id.to_string(), hk);
                }
            }
        }
    }
    out
}

/// Reenvía el disparo al daemon (el que ejecuta + difunde).
pub fn post_trigger(id: &str) -> bool {
    let url = format!(
        "http://127.0.0.1:{}/api/v1/shortcuts/trigger",
        super::monitor::api_port()
    );
    let agent: ureq::Agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_millis(1500))
        .timeout_read(Duration::from_millis(1500))
        .timeout_write(Duration::from_millis(1500))
        .build();
    agent
        .post(&url)
        .send_json(serde_json::json!({ "id": id, "source": "launcher" }))
        .is_ok()
}

/// Arranca el hilo de atajos globales (detached). En no-Windows es un stub.
pub fn start_shortcuts() {
    std::thread::spawn(|| {
        #[cfg(windows)]
        imp::run();
        #[cfg(not(windows))]
        {
            eprintln!(
                "[shortcuts] atajos globales no soportados en este SO; \
                 los atajos in-app de la web siguen funcionando con la ventana enfocada."
            );
        }
    });
}

#[cfg(windows)]
mod imp {
    use super::*;
    use std::ptr::null_mut;
    use windows::core::w;
    use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        RegisterHotKey, UnregisterHotKey, HOT_KEY_MODIFIERS,
    };
    use windows::Win32::UI::WindowsAndMessaging::*;

    const WM_SHORTCUT_BASE: i32 = 0xBDEC;
    const POLL_INTERVAL: Duration = Duration::from_secs(5);

    unsafe extern "system" fn wndproc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }

    pub(super) fn run() {
        unsafe {
            let hinstance =
                HINSTANCE(GetModuleHandleW(None).map(|h| h.0).unwrap_or(null_mut()));
            let class = w!("BunDeckHotkeys");
            let wc = WNDCLASSW {
                lpfnWndProc: Some(wndproc),
                hInstance: hinstance,
                lpszClassName: class,
                ..Default::default()
            };
            RegisterClassW(&wc);
            let hwnd = CreateWindowExW(
                WINDOW_EX_STYLE(0),
                class,
                w!(""),
                WINDOW_STYLE(0),
                0,
                0,
                0,
                0,
                Some(HWND_MESSAGE),
                None,
                Some(hinstance),
                None,
            )
            .unwrap_or(HWND(null_mut()));
            if hwnd.0.is_null() {
                eprintln!("[shortcuts] no se pudo crear la ventana de hotkeys");
                return;
            }

            // id numérico → shortcut id (estable por índice en KNOWN_IDS).
            let mut registered: HashMap<String, super::Hotkey> = HashMap::new();
            let mut last_poll = Instant::now() - POLL_INTERVAL;

            loop {
                if last_poll.elapsed() >= POLL_INTERVAL {
                    last_poll = Instant::now();
                    let wanted = super::fetch_enabled_hotkeys();
                    // Bajas y cambios: desregistrar lo que ya no coincide.
                    let mut drop: Vec<String> = Vec::new();
                    for (id, hk) in &registered {
                        if wanted.get(id) != Some(hk) {
                            drop.push(id.clone());
                        }
                    }
                    for id in drop {
                        let _ = UnregisterHotKey(Some(hwnd), hotkey_id(&id));
                        registered.remove(&id);
                    }
                    // Altas: las queridas aún no registradas.
                    for id in super::KNOWN_IDS {
                        if registered.contains_key(*id) {
                            continue;
                        }
                        if let Some(hk) = wanted.get(*id) {
                            let num = hotkey_id(id);
                            if register(hwnd, num, hk) {
                                registered.insert(id.to_string(), *hk);
                            } else {
                                eprintln!(
                                    "[shortcuts] no se pudo registrar {id} (¿en uso por otra app?)"
                                );
                            }
                        }
                    }
                }

                // Espera hasta 1 s combinando mensajes + sondeo.
                let _ = MsgWaitForMultipleObjects(None, false, 1000, QS_ALLINPUT);
                let mut msg: MSG = std::mem::zeroed();
                while PeekMessageW(&mut msg, Some(hwnd), 0, 0, PM_REMOVE).as_bool() {
                    if msg.message == WM_HOTKEY {
                        let num = msg.wParam.0 as i32;
                        let hit = super::KNOWN_IDS
                            .iter()
                            .find(|id| hotkey_id(id) == num)
                            .map(|s| s.to_string());
                        if let Some(id) = hit {
                            if registered.contains_key(&id) && !super::post_trigger(&id) {
                                eprintln!("[shortcuts] el daemon no aceptó el trigger de {id}");
                            }
                        }
                    } else {
                        let _ = TranslateMessage(&msg);
                        DispatchMessageW(&msg);
                    }
                }
            }
        }
    }

    fn hotkey_id(id: &str) -> i32 {
        let idx = super::KNOWN_IDS.iter().position(|v| *v == id).unwrap_or(0) as i32;
        WM_SHORTCUT_BASE + idx
    }

    fn register(hwnd: HWND, num: i32, hk: &super::Hotkey) -> bool {
        unsafe {
            RegisterHotKey(
                Some(hwnd),
                num,
                HOT_KEY_MODIFIERS(hk.mods),
                hk.vk,
            )
            .is_ok()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parsea_ctrl_alt_letra() {
        assert_eq!(
            parse_hotkey("Ctrl+Alt+P"),
            Some(Hotkey { mods: MOD_CONTROL | MOD_ALT, vk: 0x50 })
        );
    }

    #[test]
    fn parsea_flechas_y_shift() {
        assert_eq!(
            parse_hotkey("Ctrl+Alt+ArrowRight"),
            Some(Hotkey { mods: MOD_CONTROL | MOD_ALT, vk: 0x27 })
        );
        assert_eq!(
            parse_hotkey("Ctrl+Shift+F5"),
            Some(Hotkey { mods: MOD_CONTROL | MOD_SHIFT, vk: 0x74 })
        );
    }

    #[test]
    fn rechaza_sin_modificador_o_multitecla() {
        assert_eq!(parse_hotkey("P"), None);
        assert_eq!(parse_hotkey(""), None);
        assert_eq!(parse_hotkey("Ctrl+P+M"), None);
        assert_eq!(parse_hotkey("Ctrl+Alt+Nope"), None);
    }

    #[test]
    fn win_cuenta_como_modificador() {
        let hk = parse_hotkey("Win+K").unwrap();
        assert_eq!(hk.mods & MOD_WIN, MOD_WIN);
        assert_eq!(hk.vk, 0x4B);
    }
}
