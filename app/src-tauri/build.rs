fn main() {
    println!("cargo:rerun-if-env-changed=VB_TRIAL_BUILD");
    tauri_build::build()
}
