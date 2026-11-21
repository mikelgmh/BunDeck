//! Design tokens espejo del tema automático (dark) de bundeck:
//! `web/src/styles/bundeck.css` (.bundeck sin data-bd-pal).
//! Fondo negruzco + acento amarillo; primario invertido (claro).

use gpui::rgb;
use gpui::rgba;
use gpui::Rgba;

/// Fondo de la ventana (--bd-bg).
pub fn ground() -> Rgba {
    rgb(0x121315)
}
/// Superficie de tarjetas y botones (--bd-sf).
pub fn surface() -> Rgba {
    rgb(0x1A1C1F)
}
/// Superficie elevada / hover sutil (--bd-p1).
pub fn raised() -> Rgba {
    rgb(0x212328)
}
/// Línea de bordes (--bd-ln).
pub fn line() -> Rgba {
    rgb(0x2A2D31)
}
/// Texto principal (--bd-ink).
pub fn primary_text() -> Rgba {
    rgb(0xE8E9EB)
}
/// Texto secundario / apagado (--bd-mu).
pub fn secondary_text() -> Rgba {
    rgb(0x8C9096)
}
/// Texto tenue (jerarquía por debajo de secondary).
pub fn muted_text() -> Rgba {
    rgb(0x6F7479)
}
/// Acento amarillo (--bd-ac).
pub fn accent() -> Rgba {
    rgb(0xE0A84A)
}
/// Tinta sobre acento (marrón oscuro legible sobre #e0a84a).
/// Reservado para insignias sobre ámbar.
#[allow(dead_code)]
pub fn accent_ink() -> Rgba {
    rgb(0x241A05)
}
/// Botón primario bundeck (.bd-pri): fondo claro, tinta oscura.
pub fn primary_btn_bg() -> Rgba {
    rgb(0xE8E9EB)
}
/// Tinta del botón primario.
pub fn primary_btn_text() -> Rgba {
    rgb(0x121315)
}
/// Hover del botón primario (gris claro algo más oscuro).
pub fn primary_btn_hover() -> Rgba {
    rgb(0xC9CACD)
}
/// Transparente (subrayados inactivos, etc.).
pub fn transparent() -> Rgba {
    rgba(0x00000000)
}
/// OK / servicio en línea (punto .bd-ok).
pub fn ok() -> Rgba {
    rgb(0x6FCF97)
}
/// Aviso / arrancando (ámbar, como las cajas .bd-warnbox).
pub fn warn() -> Rgba {
    rgb(0xE0A84A)
}
/// Error / caído (rojo bundeck).
pub fn danger() -> Rgba {
    rgb(0xE5806F)
}
/// Hover del botón cerrar de la titlebar (rojo Windows, texto blanco).
pub fn close_hover() -> Rgba {
    rgb(0xE81123)
}
