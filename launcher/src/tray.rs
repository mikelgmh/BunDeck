//! Icono de bandeja (system tray) del launcher — SOLO Windows.
//!
//! El tray es propiedad única del launcher (el daemon no tiene tray propio):
//! al hacer clic se abre la ventana del launcher, y el menú ofrece Abrir panel
//! (ventana GPUI), Abrir en la web (navegador) y Salir (apaga el daemon y cierra
//! el launcher).
//!
//! Implementación Win32 directa (`Shell_NotifyIconW`) sobre un HWND oculto
//! con su propio bucle de mensajes en un hilo dedicado. Los eventos viajan
//! al hilo de GPUI por un `mpsc` que la vista ancla sondea cada ~100ms.

use std::sync::mpsc::{self, Receiver};

const MENU_OPEN: usize = 1;
const MENU_WEB: usize = 2;
const MENU_QUIT: usize = 3;

/// Eventos del tray hacia el hilo de GPUI.
#[derive(Debug, Clone, Copy)]
pub enum TrayEvent {
    /// Clic izquierdo (o doble clic) en el icono, o "Abrir panel".
    ShowLauncher,
    /// "Abrir en la web": abrir el dashboard en el navegador.
    OpenPanel,
    /// "Salir": apaga el daemon y cierra el launcher.
    Quit,
    /// Reinicio del launcher para self-update: conserva el daemon actualizado.
    Restart,
}

fn menu_event(command: usize) -> Option<TrayEvent> {
    match command {
        MENU_OPEN => Some(TrayEvent::ShowLauncher),
        MENU_WEB => Some(TrayEvent::OpenPanel),
        MENU_QUIT => Some(TrayEvent::Quit),
        _ => None,
    }
}

/// Control para apagar el hilo del tray de forma limpia.
pub struct TrayCtl {
    hwnd_raw: isize,
    thread: Option<std::thread::JoinHandle<()>>,
    shutdown_msg: u32,
}

impl TrayCtl {
    /// Quita el icono y termina el hilo del tray (bloquea hasta que salga).
    pub fn shutdown(mut self) {
        #[cfg(windows)]
        {
            use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
            use windows::Win32::UI::WindowsAndMessaging::PostMessageW;
            if self.hwnd_raw != 0 {
                unsafe {
                    let _ = PostMessageW(
                        Some(HWND(self.hwnd_raw as *mut _)),
                        self.shutdown_msg,
                        WPARAM(0),
                        LPARAM(0),
                    );
                }
            }
        }
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

#[cfg(windows)]
mod imp {
    use super::TrayEvent;
    use crate::strings;
    use std::ptr::null_mut;
    use std::sync::mpsc::Sender;
    use windows::core::{w, PCWSTR};
    use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, POINT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::Shell::{
        Shell_NotifyIconW, NIF_ICON, NIF_MESSAGE, NIF_TIP, NIM_ADD, NIM_DELETE,
        NOTIFYICONDATAW,
    };
    use windows::Win32::UI::WindowsAndMessaging::*;

    pub(super) const WM_TRAYICON: u32 = WM_APP + 41;
    pub(super) const WM_TRAY_SHUTDOWN: u32 = WM_APP + 42;
    struct TrayThread {
        tx: Sender<TrayEvent>,
        hicon: HICON,
        taskbar_created: u32,
    }

    fn wide_tip(text: &str) -> [u16; 128] {
        let mut buf = [0u16; 128];
        for (i, c) in text.encode_utf16().take(127).enumerate() {
            buf[i] = c;
        }
        buf
    }

    fn load_icon() -> HICON {
        unsafe {
            // 1) icon.ico junto al exe (layout instalado), 2) raíz del repo
            // (dev: el exe vive en launcher/target/...), 3) icono por defecto.
            let mut candidates: Vec<std::path::PathBuf> = Vec::new();
            if let Ok(exe) = std::env::current_exe() {
                if let Some(dir) = exe.parent() {
                    candidates.push(dir.join("icon.ico"));
                    // dev: <root>/launcher/target/<profile>/exe -> <root>/icon.ico
                    let mut d = dir.to_path_buf();
                    for _ in 0..3 {
                        if !d.pop() {
                            break;
                        }
                    }
                    candidates.push(d.join("icon.ico"));
                }
            }
            for c in candidates {
                if c.is_file() {
                    let wide: Vec<u16> =
                        c.to_string_lossy().encode_utf16().chain([0]).collect();
                    if let Ok(h) = LoadImageW(
                        None,
                        PCWSTR(wide.as_ptr()),
                        IMAGE_ICON,
                        16,
                        16,
                        LR_LOADFROMFILE,
                    ) {
                        if !h.0.is_null() {
                            return HICON(h.0);
                        }
                    }
                }
            }
            LoadIconW(None, IDI_APPLICATION).unwrap_or(HICON(null_mut()))
        }
    }

    fn add_icon(hwnd: HWND, hicon: HICON) {
        unsafe {
            let nid = NOTIFYICONDATAW {
                cbSize: std::mem::size_of::<NOTIFYICONDATAW>() as u32,
                hWnd: hwnd,
                uID: 1,
                uFlags: NIF_MESSAGE | NIF_ICON | NIF_TIP,
                uCallbackMessage: WM_TRAYICON,
                hIcon: hicon,
                szTip: wide_tip(strings::get("tray.tip")),
                ..Default::default()
            };
            let _ = Shell_NotifyIconW(NIM_ADD, &nid);
        }
    }

    fn remove_icon(hwnd: HWND) {
        unsafe {
            let nid = NOTIFYICONDATAW {
                cbSize: std::mem::size_of::<NOTIFYICONDATAW>() as u32,
                hWnd: hwnd,
                uID: 1,
                ..Default::default()
            };
            let _ = Shell_NotifyIconW(NIM_DELETE, &nid);
        }
    }

    fn show_menu(hwnd: HWND, tx: &Sender<TrayEvent>) {
        unsafe {
            let menu = match CreatePopupMenu() {
                Ok(m) => m,
                Err(_) => return,
            };
            // Textos localizados: el `w!` estático no sirve para tablas
            // dinámicas; el Vec vive hasta el fin de la llamada.
            let open_label = strings::wide("tray.open_panel");
            let _ = AppendMenuW(menu, MF_STRING, super::MENU_OPEN, PCWSTR(open_label.as_ptr()));
            let web_label = strings::wide("tray.open_web");
            let _ = AppendMenuW(menu, MF_STRING, super::MENU_WEB, PCWSTR(web_label.as_ptr()));
            let _ = AppendMenuW(menu, MF_SEPARATOR, 0, PCWSTR::null());
            let quit_label = strings::wide("tray.quit");
            let _ = AppendMenuW(menu, MF_STRING, super::MENU_QUIT, PCWSTR(quit_label.as_ptr()));
            let mut pt = POINT { x: 0, y: 0 };
            if GetCursorPos(&mut pt).is_err() {
                let _ = DestroyMenu(menu);
                return;
            }
            // Requerido para que el menú se cierre al hacer clic fuera.
            let _ = SetForegroundWindow(hwnd);
            let cmd = TrackPopupMenu(
                menu,
                TPM_RETURNCMD | TPM_RIGHTBUTTON | TPM_BOTTOMALIGN | TPM_LEFTALIGN,
                pt.x,
                pt.y,
                Some(0),
                hwnd,
                None,
            );
            let _ = DestroyMenu(menu);
            if let Some(ev) = super::menu_event(cmd.0 as usize) {
                let _ = tx.send(ev);
            }
        }
    }

    unsafe extern "system" fn wndproc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        // El puntero al estado viaja en GWLP_USERDATA.
        let state = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut TrayThread;
        if msg == WM_TRAYICON {
            if !state.is_null() {
                let low = (lparam.0 & 0xffff) as u32;
                if low == WM_LBUTTONUP || low == WM_LBUTTONDBLCLK {
                    let _ = (*state).tx.send(TrayEvent::ShowLauncher);
                } else if low == WM_RBUTTONUP {
                    show_menu(hwnd, &(*state).tx);
                }
            }
            return LRESULT(0);
        }
        if msg == WM_TRAY_SHUTDOWN || msg == WM_DESTROY {
            remove_icon(hwnd);
            PostQuitMessage(0);
            return LRESULT(0);
        }
        // Re-registrar el icono si Explorer se reinicia.
        if !state.is_null() && msg == (*state).taskbar_created {
            add_icon(hwnd, (*state).hicon);
            return LRESULT(0);
        }
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }

    pub(super) fn spawn(
        tx: Sender<TrayEvent>,
    ) -> (
        std::sync::mpsc::Receiver<isize>,
        std::thread::JoinHandle<()>,
    ) {
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<isize>();
        let thread = std::thread::spawn(move || unsafe {
            let hinstance = HINSTANCE(
                GetModuleHandleW(None).map(|h| h.0).unwrap_or(null_mut()),
            );
            let class = w!("BunDeckTray");
            let wc = WNDCLASSW {
                lpfnWndProc: Some(wndproc),
                hInstance: hinstance,
                lpszClassName: class,
                ..Default::default()
            };
            RegisterClassW(&wc);
            // Ventana solo-mensajes: nunca visible, nunca en la barra de tareas.
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
                let _ = ready_tx.send(0);
                return;
            }
            let hicon = load_icon();
            let taskbar_created = RegisterWindowMessageW(w!("TaskbarCreated"));
            let mut state = Box::new(TrayThread {
                tx,
                hicon,
                taskbar_created,
            });
            SetWindowLongPtrW(
                hwnd,
                GWLP_USERDATA,
                &mut *state as *mut TrayThread as isize,
            );
            add_icon(hwnd, hicon);
            let _ = ready_tx.send(hwnd.0 as isize);
            let mut msg: MSG = std::mem::zeroed();
            while GetMessageW(&mut msg, None, 0, 0).0 != 0 {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            // `state` se libera aquí (fin del hilo); el icono ya se quitó.
            let _ = state;
        });
        (ready_rx, thread)
    }
}

#[cfg(test)]
mod tests {
    use super::{menu_event, TrayEvent};

    #[test]
    fn tray_menu_commands_map_to_the_expected_events() {
        assert!(matches!(menu_event(1), Some(TrayEvent::ShowLauncher)));
        assert!(matches!(menu_event(2), Some(TrayEvent::OpenPanel)));
        assert!(matches!(menu_event(3), Some(TrayEvent::Quit)));
        assert!(menu_event(0).is_none());
        assert!(menu_event(99).is_none());
    }
}

/// Arranca el tray en su propio hilo. Devuelve el receptor de eventos y el
/// control de apagado. En no-Windows no hay tray: el receptor nunca emite.
pub fn start_tray() -> (Receiver<TrayEvent>, TrayCtl) {
    #[cfg(windows)]
    {
        let (tx, rx) = mpsc::channel::<TrayEvent>();
        // "Salir" de la ventana pasa por aquí (limpia el icono al terminar).
        let _ = super::TRAY_TX.set(tx.clone());
        let (ready_rx, thread) = imp::spawn(tx);
        // El HWND ya existe cuando el hilo avisa (o 0 si falló).
        let hwnd_raw = ready_rx.recv().unwrap_or(0);
        let ctl = TrayCtl {
            hwnd_raw,
            thread: Some(thread),
            shutdown_msg: imp::WM_TRAY_SHUTDOWN,
        };
        return (rx, ctl);
    }
    #[cfg(not(windows))]
    {
        let (_tx, rx) = mpsc::channel::<TrayEvent>();
        return (
            rx,
            TrayCtl {
                hwnd_raw: 0,
                thread: None,
                shutdown_msg: 0,
            },
        );
    }
}
