fn main() {
    // Solo Windows tiene .rc que compilar; en el resto no hace nada.
    #[cfg(windows)]
    {
        let _ = embed_resource::compile("app.rc", embed_resource::NONE);
    }
    // Expone la versión canónica (root package.json o env) para la UI.
    // CI/build.sh inyectan BUNDECK_VERSION; en dev se lee el JSON.
    let ver = std::env::var("BUNDECK_VERSION").ok().or_else(|| std::env::var("LIBREDECK_VERSION").ok()).or_else(|| {
        std::fs::read_to_string("../package.json")
            .ok()
            .and_then(|raw| {
                raw.split("\"version\"")
                    .nth(1)
                    .and_then(|rest| rest.split('"').nth(1).map(|s| s.to_string()))
            })
    });
    if let Some(v) = ver {
        println!("cargo:rustc-env=BUNDECK_VERSION={v}");
        println!("cargo:rustc-env=LIBREDECK_VERSION={v}");
    }
    // Pubkey ed25519 para verificar bundles: env gana, si no el fichero
    // commiteado launcher/UPDATE_PUBKEY (ver scripts/gen-update-keys.mjs).
    let pubkey = std::env::var("BUNDECK_UPDATE_PUBKEY").ok().or_else(|| std::env::var("LIBREDECK_UPDATE_PUBKEY").ok()).or_else(|| {
        std::fs::read_to_string("UPDATE_PUBKEY")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    });
    if let Some(k) = pubkey {
        println!("cargo:rustc-env=BUNDECK_UPDATE_PUBKEY={k}");
        println!("cargo:rustc-env=LIBREDECK_UPDATE_PUBKEY={k}");
    }
}
