// Standalone desktop shell. The runtime is bundled; user data lives outside the app.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use std::{cmp::Ordering, ffi::OsStr, fs, io::{Read, Write}, net::{TcpListener, TcpStream}, path::{Path, PathBuf}, process::{Child, Command, Stdio}, sync::Mutex, time::{Duration, Instant, SystemTime}};
use tauri::{Manager, RunEvent, WebviewWindow};
struct ServerProc(Mutex<Option<Child>>);

/// Compile-time switch for the trial package (VB_TRIAL_BUILD=1, see scripts/package-mac.mjs --trial): it keeps its own
/// profile folder and instance record and never asks for the regular port, so it cannot attach to or alter a live Visual Brain.
const TRIAL: bool = option_env!("VB_TRIAL_BUILD").is_some();
const PROFILE: &str = if TRIAL { "Visual Brain Trial" } else { "Visual Brain" };

#[derive(serde::Deserialize, Default)]
struct DevConfig { #[serde(rename = "serverDir")] server_dir: Option<String>, port: Option<u16>, node: Option<String> }
fn home() -> PathBuf { PathBuf::from(std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap_or_default()) }
fn data_dir() -> PathBuf {
    // The trial build ignores VISUAL_BRAIN_DATA_DIR (it may be exported for the regular app) and has its own override.
    if let Ok(dir) = std::env::var(if TRIAL { "VISUAL_BRAIN_TRIAL_DATA_DIR" } else { "VISUAL_BRAIN_DATA_DIR" }) { return PathBuf::from(dir); }
    if cfg!(target_os = "windows") { PathBuf::from(std::env::var("LOCALAPPDATA").unwrap_or_default()).join(PROFILE) }
    else { home().join("Library/Application Support").join(PROFILE) }
}
fn language(dir: &Path) -> String {
    if let Ok(text) = fs::read_to_string(dir.join("settings.json")) {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(lang) = json["language"].as_str() { return lang.to_string(); }
        }
    }
    let locale = if cfg!(target_os = "macos") {
        Command::new("defaults").args(["read", "-g", "AppleLocale"]).output().ok().map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).unwrap_or_default()
    } else { std::env::var("LANG").unwrap_or_default() };
    if locale.to_lowercase().starts_with("it") { "it".into() } else { "en".into() }
}
fn login_path() -> String {
    if cfg!(target_os = "windows") { return std::env::var("PATH").unwrap_or_default(); }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let from_shell = Command::new(shell).args(["-lic", "printf '\\nVB_PATH=%s\\n' \"$PATH\""])
        .output().ok().and_then(|o| String::from_utf8_lossy(&o.stdout).lines().find_map(|l| l.strip_prefix("VB_PATH=").map(str::to_owned))).unwrap_or_default();
    format!("{}:{}/.local/node/bin:{}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", from_shell, home().display(), home().display())
}
fn status(w: &WebviewWindow, it: &str, en: &str, lang: &str, error: bool) {
    let text = if lang == "it" { it } else { en };
    let _ = w.eval(&format!("window.__vb && window.__vb({}, {})", serde_json::to_string(text).unwrap(), error));
}
fn health(port: u16) -> Option<serde_json::Value> {
    let mut s = TcpStream::connect_timeout(&format!("127.0.0.1:{port}").parse().ok()?, Duration::from_millis(250)).ok()?;
    s.set_read_timeout(Some(Duration::from_millis(500))).ok()?;
    write!(s, "GET /api/health HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\n\r\n").ok()?;
    let mut response = String::new(); s.take(16384).read_to_string(&mut response).ok()?;
    serde_json::from_str(response.split_once("\r\n\r\n")?.1).ok()
}
fn current_bundle() -> Option<PathBuf> { std::env::current_exe().ok().and_then(|exe| exe.ancestors().nth(3).map(Path::to_path_buf)).filter(|p| p.extension().is_some_and(|e| e == "app")) }
/// Live agents carry the API URL in their environment and prompt. Never move that API to a random port on reopen.
fn terminal_api_port(dir: &Path) -> Option<u16> {
    let record: serde_json::Value = serde_json::from_str(&fs::read_to_string(dir.join("terminal-service/host.json")).ok()?).ok()?;
    let port = record["apiPort"].as_u64().filter(|p| *p > 0 && *p <= 65535)?;
    let pid = record["pid"].as_u64().filter(|p| *p > 1)?;
    let living = Command::new("/bin/kill").args(["-0", &pid.to_string()]).stdout(Stdio::null()).stderr(Stdio::null()).status().ok()?.success();
    living.then_some(port as u16)
}
fn server_listener(preferred: u16, pinned: Option<u16>) -> std::io::Result<TcpListener> {
    match pinned {
        Some(port) => TcpListener::bind(("127.0.0.1", port)),
        None => TcpListener::bind(("127.0.0.1", preferred)).or_else(|_| TcpListener::bind(("127.0.0.1", 0))),
    }
}
/// Runs a system tool with a deadline (killed when it overruns) and reports success.
fn sh(cmd: &str, args: &[&dyn AsRef<OsStr>], secs: u64) -> bool {
    let Ok(mut child) = Command::new(cmd).args(args.iter().map(|a| a.as_ref())).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn() else { return false };
    let start = Instant::now();
    loop {
        if let Ok(Some(code)) = child.try_wait() { return code.success(); }
        if start.elapsed() > Duration::from_secs(secs) { let _ = child.kill(); let _ = child.wait(); return false; }
        std::thread::sleep(Duration::from_millis(50));
    }
}
fn plist(bundle: &Path, key: &str) -> Option<String> {
    let out = Command::new("/usr/libexec/PlistBuddy").args(["-c", &format!("Print {key}")]).arg(bundle.join("Contents/Info.plist")).stderr(Stdio::null()).output().ok()?;
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string()).filter(|v| out.status.success() && !v.is_empty())
}
// Move to Applications. A quarantined ZIP opened from Downloads runs through App Translocation: a random read-only copy,
// so the updater cannot replace the bundle (EROFS) and macOS asks for permissions again at every launch.
fn is_translocated(bundle: &Path) -> bool { bundle.to_string_lossy().contains("/AppTranslocation/") }
/// An existing install wins (first of `dirs` holding the app); otherwise the first writable folder, else the last one.
fn choose_destination(dirs: &[&Path], app: &str, exists: impl Fn(&Path) -> bool, writable: impl Fn(&Path) -> bool) -> PathBuf {
    dirs.iter().map(|d| d.join(app)).find(|p| exists(p))
        .unwrap_or_else(|| dirs.iter().find(|d| writable(d)).or(dirs.last()).expect("destination folders").join(app))
}
/// Numeric dotted comparison: "0.2.10" > "0.2.9"; missing parts count as 0, non-digits are ignored.
fn compare_versions(a: &str, b: &str) -> Ordering {
    let parts = |v: &str| v.split('.').map(|p| p.chars().take_while(char::is_ascii_digit).collect::<String>().parse::<u64>().unwrap_or(0)).collect::<Vec<_>>();
    let (a, b) = (parts(a), parts(b));
    (0..a.len().max(b.len())).map(|i| a.get(i).unwrap_or(&0).cmp(b.get(i).unwrap_or(&0))).find(|o| o.is_ne()).unwrap_or(Ordering::Equal)
}
#[derive(Debug, PartialEq)]
enum Plan { Open, Copy }
fn plan(ours: &str, installed: Option<&str>) -> Plan { if installed.is_some_and(|v| compare_versions(v, ours).is_ge()) { Plan::Open } else { Plan::Copy } }
fn writable(dir: &Path) -> bool { let probe = dir.join(format!(".vb-probe-{}", std::process::id())); fs::create_dir(&probe).is_ok() && fs::remove_dir(&probe).is_ok() }
/// Copies `src` to `dest` without ever losing the installed app: stage a sibling, unquarantine and verify it, move the old
/// copy aside into `aside_root/<timestamp>/` (the server updater removes it later), then rename the new one into place.
fn install(src: &Path, dest: &Path, aside_root: &Path, verify: bool) -> Result<(), String> {
    let (Some(parent), Some(name)) = (dest.parent(), dest.file_name()) else { return Err(format!("Invalid destination {}", dest.display())) };
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let fresh = parent.join(format!("{}.new-{}", name.to_string_lossy(), std::process::id()));
    let _ = fs::remove_dir_all(&fresh);
    let staged = if !sh("/usr/bin/ditto", &[&src, &fresh], 120) { Err("copy failed") } else {
        sh("/usr/bin/xattr", &[&"-dr", &"com.apple.quarantine", &fresh], 30); // exits non-zero when nothing was quarantined
        if verify && !sh("/usr/bin/codesign", &[&"--verify", &"--deep", &"--strict", &fresh], 90) { Err("signature check failed") } else { Ok(()) }
    };
    if let Err(e) = staged { let _ = fs::remove_dir_all(&fresh); return Err(format!("{e}: {}", fresh.display())); }
    let aside = if dest.symlink_metadata().is_ok() {
        let stamp = Command::new("/bin/date").args(["-u", "+%Y%m%d%H%M%S"]).output().ok().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).filter(|s| !s.is_empty())
            .unwrap_or_else(|| SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_secs().to_string());
        let aside = aside_root.join(stamp);
        if let Err(e) = fs::create_dir_all(&aside).and_then(|_| fs::rename(dest, aside.join(name))) { let _ = fs::remove_dir_all(&fresh); return Err(format!("move aside {}: {e}", dest.display())); }
        Some(aside.join(name))
    } else { None };
    if let Err(e) = fs::rename(&fresh, dest) {
        if let Some(old) = aside { let _ = fs::rename(old, dest); }
        let _ = fs::remove_dir_all(&fresh);
        return Err(format!("rename into {}: {e}", dest.display()));
    }
    Ok(())
}
/// Installs (or reuses) the copy in Applications and opens it; true means this process must exit without starting a server.
/// The original in Downloads stays: translocation hides its real path from us.
const RELOCATED: &str = "--vb-relocated";
/// Set on the copy we open after moving: if it is still translocated we must not move again, or we would loop.
fn relaunched(args: impl IntoIterator<Item = String>) -> bool { args.into_iter().any(|a| a == RELOCATED) }
/// Candidate folders in priority order. VISUAL_BRAIN_APPLICATIONS_DIRS (colon-separated) replaces them; it exists for tests.
fn applications_dirs(env: Option<String>, home: &Path) -> Vec<PathBuf> {
    let custom: Vec<PathBuf> = env.unwrap_or_default().split(':').filter(|d| !d.is_empty()).map(PathBuf::from).collect();
    if custom.is_empty() { vec![PathBuf::from("/Applications"), home.join("Applications")] } else { custom }
}
fn quarantined(p: &Path) -> bool { sh("/usr/bin/xattr", &[&"-p", &"com.apple.quarantine", &p], 10) }
fn move_hint(window: &WebviewWindow, dir: &Path, lang: &str, error: &str) {
    let line = format!("move to Applications: {error}");
    eprintln!("{line}");
    if let Ok(mut log) = fs::create_dir_all(dir.join("logs")).and_then(|_| fs::OpenOptions::new().create(true).append(true).open(dir.join("logs/server.log"))) { let _ = writeln!(log, "{line}"); }
    status(window, "Non riesco a spostare Visual Brain in Applicazioni: chiudilo, trascinalo nella cartella Applicazioni e aprilo da lì. Intanto lo avvio da qui…",
        "Couldn't move Visual Brain to Applications: quit it, drag it into the Applications folder and open it from there. Starting from here meanwhile…", lang, false);
    std::thread::sleep(Duration::from_secs(5));
}
/// Installs (or reuses) the copy in Applications and opens it; true means this process must exit without starting a server.
/// The original in Downloads stays: translocation hides its real path from us.
fn relocate(window: &WebviewWindow, dir: &Path, lang: &str, bundle: &Path) -> bool {
    if relaunched(std::env::args()) { move_hint(window, dir, lang, &format!("{} still translocated after relocation", bundle.display())); return false; }
    status(window, "Sposto Visual Brain in Applicazioni…", "Moving Visual Brain to Applications…", lang, false);
    let dirs = applications_dirs(std::env::var("VISUAL_BRAIN_APPLICATIONS_DIRS").ok(), &home());
    let app = bundle.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "Visual Brain.app".into());
    let dest = choose_destination(&dirs.iter().map(PathBuf::as_path).collect::<Vec<_>>(), &app, |p| p.exists(), writable);
    let ours = plist(bundle, "CFBundleShortVersionString").unwrap_or_else(|| env!("CARGO_PKG_VERSION").into());
    let result = if dest.exists() && plist(&dest, "CFBundleIdentifier") != plist(bundle, "CFBundleIdentifier") { Err(format!("{} is a different app", dest.display())) }
        else if plan(&ours, plist(&dest, "CFBundleShortVersionString").as_deref()) == Plan::Copy { install(bundle, &dest, &dir.join("running-app-backups"), true) }
        // A quarantined install would be translocated in turn: clear it, or leave it alone.
        else if quarantined(&dest) && (!sh("/usr/bin/xattr", &[&"-dr", &"com.apple.quarantine", &dest], 30) || quarantined(&dest)) { Err(format!("cannot clear quarantine on {}", dest.display())) }
        else { Ok(()) };
    // A running copy at the destination just gets focused: its own instance check attaches to the live server.
    // `open` does not pass our environment on: forward the profile/test overrides (macOS 13+ `--env`) only when set.
    let env: Vec<String> = ["VISUAL_BRAIN_DATA_DIR", "VISUAL_BRAIN_APPLICATIONS_DIRS"].iter().filter_map(|k| std::env::var(k).ok().map(|v| format!("{k}={v}"))).collect();
    let mut args: Vec<&dyn AsRef<OsStr>> = vec![&"-n"];
    for e in &env { args.extend([&"--env" as &dyn AsRef<OsStr>, e]); }
    args.extend([&dest as &dyn AsRef<OsStr>, &"--args", &RELOCATED]);
    let result = result.and_then(|_| if sh("/usr/bin/open", &args, 15) { Ok(()) } else { Err(format!("open {} failed", dest.display())) });
    let Err(error) = result else { return true };
    move_hint(window, dir, lang, &error);
    false
}
fn run(window: &WebviewWindow, handle: &tauri::AppHandle, dir: &Path, lang: &str) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; fs::set_permissions(dir, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?; }
    let resources = handle.path().resource_dir().map_err(|e| e.to_string())?;
    let runtime = resources.join("runtime");
    // Only explicit developer overrides use an external checkout. Installed copies are self-contained.
    let cfg: DevConfig = fs::read_to_string(dir.join("config.json")).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    let dev = std::env::var("VISUAL_BRAIN_DIR").ok().or(cfg.server_dir);
    let bundle = current_bundle();
    // Before any server starts: on success this translocated copy exits and the one in Applications takes over.
    if cfg!(target_os = "macos") && !TRIAL && dev.is_none() {
        if let Some(b) = bundle.as_deref().filter(|b| is_translocated(b)) { if relocate(window, dir, lang, b) { handle.exit(0); return Ok(()); } }
    }
    let server_dir = dev.as_ref().map(PathBuf::from).unwrap_or_else(|| runtime.join("server"));
    if !server_dir.join("src/cli.ts").is_file() { return Err(if lang == "it" { "Runtime mancante. Reinstalla Visual Brain dal pacchetto completo." } else { "Missing runtime. Reinstall Visual Brain from the complete package." }.into()); }
    let node_name = if cfg!(target_os = "windows") { "node.exe" } else if cfg!(target_arch = "x86_64") { "node-x64" } else { "node-arm64" };
    let path = login_path();
    let node = if dev.is_some() {
        cfg.node.map(PathBuf::from).or_else(|| std::env::split_paths(&path).map(|p| p.join(if cfg!(target_os="windows") {"node.exe"} else {"node"})).find(|p| p.is_file()))
    } else { Some(runtime.join(node_name)) }.ok_or("Node runtime missing")?;
    if !node.is_file() { return Err(format!("Runtime missing: {}", node.display())); }
    let instance_file = dir.join("instance.json");
    if let Ok(record) = fs::read_to_string(&instance_file) {
        if let Ok(record) = serde_json::from_str::<serde_json::Value>(&record) {
            if let Some(port) = record["port"].as_u64().filter(|p| *p <= 65535) {
                if let Some(h) = health(port as u16) {
                    if h["app"] == "visual-brain" && h["profile"] == dir.to_string_lossy().as_ref() && h["instance"] == record["instance"] {
                        window.navigate(tauri::Url::parse(&format!("http://127.0.0.1:{port}/")).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
                        return Ok(());
                    }
                }
            }
        }
    }
    let preferred = if TRIAL { 0 } else { cfg.port.unwrap_or(4747) };
    let pinned = terminal_api_port(dir);
    let listener = server_listener(preferred, pinned).map_err(|e| match pinned {
        Some(port) if lang == "it" => format!("Le sessioni richiedono la porta API {port}, che è occupata. Libera la porta e riapri Visual Brain. I terminali restano attivi. ({e})"),
        Some(port) => format!("The terminal sessions need API port {port}, which is unavailable. Free the port and reopen Visual Brain. Sessions are still running. ({e})"),
        None => e.to_string(),
    })?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port(); drop(listener);
    let instance = format!("{}-{}", std::process::id(), SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_nanos());
    let log_dir = dir.join("logs"); fs::create_dir_all(&log_dir).map_err(|e| e.to_string())?;
    let log_path = log_dir.join("server.log");
    if fs::metadata(&log_path).map(|m| m.len() > 5_000_000).unwrap_or(false) { let _ = fs::rename(&log_path, log_dir.join("server.previous.log")); }
    let log = fs::OpenOptions::new().create(true).append(true).open(&log_path).map_err(|e| e.to_string())?;
    status(window, "Avvio del motore locale…", "Starting the local engine…", lang, false);
    // Updates apply only to the installed regular app: the trial package and development overrides never update themselves.
    let updates = !TRIAL && dev.is_none() && bundle.is_some();
    let mut command = Command::new(node);
    command.env("VISUAL_BRAIN_VERSION", env!("CARGO_PKG_VERSION"));
    if let (true, Some(bundle)) = (updates, bundle) { command.env("VISUAL_BRAIN_UPDATES", "1").env("VISUAL_BRAIN_APP", bundle); }
    // An app opened from a terminal inherits that terminal's environment: never the update switch of another installation.
    else { command.env_remove("VISUAL_BRAIN_UPDATES").env_remove("VISUAL_BRAIN_APP"); }
    let child = command.args(["src/cli.ts", "serve", "--port", &port.to_string()]).current_dir(&server_dir)
        .env("PATH", path).env("VISUAL_BRAIN_DATA_DIR", dir).env("VISUAL_BRAIN_LANGUAGE", lang).env("VISUAL_BRAIN_INSTANCE", &instance)
        .env_remove("CLAUDECODE").env_remove("CLAUDE_CODE_ENTRYPOINT").env_remove("CLAUDE_CODE_CHILD_SESSION")
        .stdin(Stdio::null()).stdout(Stdio::from(log.try_clone().map_err(|e| e.to_string())?)).stderr(Stdio::from(log)).spawn().map_err(|e| e.to_string())?;
    *handle.state::<ServerProc>().0.lock().map_err(|e| e.to_string())? = Some(child);
    let started = Instant::now();
    loop {
        if health(port).is_some_and(|h| h["app"] == "visual-brain" && h["instance"] == instance) { break; }
        if started.elapsed() > Duration::from_secs(90) { return Err(format!("Startup timeout. Log: {}", log_path.display())); }
        if let Some(child) = handle.state::<ServerProc>().0.lock().map_err(|e| e.to_string())?.as_mut() {
            if let Some(code) = child.try_wait().map_err(|e| e.to_string())? { return Err(format!("Engine exited ({code}). Log: {}", log_path.display())); }
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    fs::write(instance_file, serde_json::json!({"port": port, "instance": instance}).to_string()).map_err(|e| e.to_string())?;
    window.navigate(tauri::Url::parse(&format!("http://127.0.0.1:{port}/")).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    Ok(())
}
fn stop(app: &tauri::AppHandle) {
    if let Ok(mut slot) = app.state::<ServerProc>().0.lock() {
        if let Some(mut child) = slot.take() {
            // SIGTERM flushes session metadata and closes SQLite. The detached terminal host keeps its PTYs alive.
            #[cfg(unix)] { let _ = Command::new("/bin/kill").args(["-TERM", &child.id().to_string()]).status(); }
            let start = Instant::now();
            while start.elapsed() < Duration::from_secs(3) { if child.try_wait().ok().flatten().is_some() { return; } std::thread::sleep(Duration::from_millis(50)); }
            let _ = child.kill(); let _ = child.wait();
        }
    }
}
/// Files dropped on the window. The webview never sees their paths (macOS hides them from the page), so the shell
/// forwards them as a DOM event; the page decides which terminal receives them. Positions are sent in CSS pixels:
/// on macOS wry already reports points (typed as physical pixels), elsewhere they are divided by the scale factor.
fn forward_drop(window: &tauri::Window, kind: &str, paths: &[PathBuf], position: Option<tauri::PhysicalPosition<f64>>) {
    let Some(webview) = window.app_handle().get_webview_window(window.label()) else { return };
    let scale = if cfg!(target_os = "macos") { 1.0 } else { window.scale_factor().unwrap_or(1.0) };
    let position = position.map(|p| (p.x / scale, p.y / scale));
    #[cfg(target_os = "macos")]
    if kind == "drop" && paths.is_empty() {
        // Not a file on disk (screenshot thumbnail, image from a browser, Slack or Photos): saved in the profile first.
        let pending = dragged::receive(&data_dir().join("attachments").join("dropped"));
        std::thread::spawn(move || emit_drop(&webview, "drop", &pending.recv().unwrap_or_default(), position));
        return;
    }
    emit_drop(&webview, kind, paths, position);
}
fn emit_drop(webview: &WebviewWindow, kind: &str, paths: &[PathBuf], position: Option<(f64, f64)>) {
    let detail = serde_json::json!({
        "kind": kind,
        "paths": paths.iter().map(|p| p.to_string_lossy().into_owned()).collect::<Vec<_>>(),
        "x": position.map(|p| p.0), "y": position.map(|p| p.1),
    });
    let _ = webview.eval(&format!("window.dispatchEvent(new CustomEvent('vb-file-drop', {{ detail: {detail} }}))"));
}
#[cfg(target_os = "macos")]
mod dragged {
    //! wry reads only the file names of a drag. Promised files (screenshot thumbnail, Photos, browsers, Slack, Mail) and
    //! plain image data arrived as an empty drop and were lost: they are read from the drag pasteboard and saved here.
    use std::{fs, path::{Path, PathBuf}, ptr::NonNull, sync::mpsc, time::{Duration, Instant, SystemTime, UNIX_EPOCH}};
    use block2::RcBlock;
    use objc2::{runtime::AnyClass, ClassType};
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSFilePromiseReceiver, NSPasteboard, NSPasteboardNameDrag, NSPasteboardTypePNG, NSPasteboardTypeTIFF};
    use objc2_foundation::{NSArray, NSDictionary, NSError, NSOperationQueue, NSString, NSURL};

    /// Saved drops older than this are removed at the next drop.
    const KEEP: Duration = Duration::from_secs(30 * 24 * 3600);
    /// How long the source app has to write its promised files.
    const WAIT: Duration = Duration::from_secs(20);

    /// Reads the drag pasteboard now, while it still holds this drop; the saved paths arrive on the channel.
    pub fn receive(root: &Path) -> mpsc::Receiver<Vec<PathBuf>> {
        let (done, result) = mpsc::channel();
        prune(root);
        let dir = root.join(SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos().to_string());
        if fs::create_dir_all(&dir).is_err() { let _ = done.send(Vec::new()); return result; }
        let pasteboard = unsafe { NSPasteboard::pasteboardWithName(NSPasteboardNameDrag) };
        let classes = NSArray::<AnyClass>::from_slice(&[NSFilePromiseReceiver::class()]);
        let receivers: Vec<_> = unsafe { pasteboard.readObjectsForClasses_options(&classes, None) }
            .map(|found| found.to_vec()).unwrap_or_default()
            .into_iter().filter_map(|object| object.downcast::<NSFilePromiseReceiver>().ok()).collect();
        // Image data is saved now as well: it is used only when no promised file arrives.
        let fallback = image(&pasteboard, &dir);
        if receivers.is_empty() { let _ = done.send(fallback.into_iter().collect()); return result; }
        let expected: usize = receivers.iter().map(|r| r.fileTypes().count().max(1)).sum();
        let (file, files) = mpsc::channel::<Option<PathBuf>>();
        let destination = NSURL::fileURLWithPath_isDirectory(&NSString::from_str(&dir.to_string_lossy()), true);
        for receiver in &receivers {
            let file = file.clone();
            let reader = RcBlock::new(move |url: NonNull<NSURL>, error: *mut NSError| {
                let path = if error.is_null() { unsafe { url.as_ref() }.path().map(|p| PathBuf::from(p.to_string())) } else { None };
                let _ = file.send(path);
            });
            // The readers run on the main queue; only the background thread below waits for them.
            unsafe { receiver.receivePromisedFilesAtDestination_options_operationQueue_reader(&destination, &NSDictionary::new(), &NSOperationQueue::mainQueue(), &reader) };
        }
        drop(file);
        std::thread::spawn(move || {
            let deadline = Instant::now() + WAIT;
            let mut paths = Vec::new();
            for _ in 0..expected {
                match files.recv_timeout(deadline.saturating_duration_since(Instant::now())) { Ok(Some(path)) => paths.push(path), Ok(None) => {}, Err(_) => break }
            }
            match fallback { Some(image) if paths.is_empty() => paths.push(image), Some(image) => { let _ = fs::remove_file(image); }, None => {} }
            let _ = done.send(paths);
        });
        result
    }

    /// The image on the pasteboard as PNG: TIFF, what many apps put there, is converted because agents do not read it.
    fn image(pasteboard: &NSPasteboard, dir: &Path) -> Option<PathBuf> {
        let png = match pasteboard.dataForType(unsafe { NSPasteboardTypePNG }) {
            Some(png) => png,
            None => {
                let tiff = pasteboard.dataForType(unsafe { NSPasteboardTypeTIFF })?;
                let bitmap = NSBitmapImageRep::imageRepWithData(&tiff)?;
                unsafe { bitmap.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new()) }?
            }
        };
        let path = dir.join("immagine.png");
        fs::write(&path, png.to_vec()).ok()?;
        Some(path)
    }

    fn prune(root: &Path) {
        let Ok(entries) = fs::read_dir(root) else { return };
        for entry in entries.flatten() {
            if entry.metadata().and_then(|m| m.modified()).is_ok_and(|at| at.elapsed().unwrap_or_default() > KEEP) { let _ = fs::remove_dir_all(entry.path()); }
        }
    }
}
/// Traffic lights centred in the page's 56 px top bar. Tauri's `trafficLightPosition` is applied only when its own view redraws,
/// which never happens under the webview and the window glass, and AppKit puts the buttons back on resize and full screen.
#[cfg(target_os = "macos")]
mod traffic_lights {
    use objc2_app_kit::{NSWindow, NSWindowButton, NSWindowStyleMask};
    use objc2_foundation::{NSPoint, NSRect, NSSize};
    const BAR: f64 = 56.0;
    const LEFT: f64 = 18.0;

    pub fn place<R: tauri::Runtime>(window: &tauri::Window<R>) {
        let Ok(ptr) = window.ns_window() else { return };
        let ptr = ptr as usize;
        let _ = window.run_on_main_thread(move || unsafe {
            let ns = &*(ptr as *const NSWindow);
            if ns.styleMask().contains(NSWindowStyleMask::FullScreen) { return; }
            let (Some(close), Some(mini), Some(zoom)) = (ns.standardWindowButton(NSWindowButton::CloseButton), ns.standardWindowButton(NSWindowButton::MiniaturizeButton), ns.standardWindowButton(NSWindowButton::ZoomButton)) else { return };
            let (Some(titlebar), Some(container)) = (close.superview(), close.superview().and_then(|v| v.superview())) else { return };
            let width = ns.frame().size.width;
            container.setFrame(NSRect::new(NSPoint::new(0.0, ns.frame().size.height - BAR), NSSize::new(width, BAR)));
            titlebar.setFrame(NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(width, BAR)));
            let gap = mini.frame().origin.x - close.frame().origin.x;
            for (i, button) in [close, mini, zoom].iter().enumerate() {
                button.setFrameOrigin(NSPoint::new(LEFT + i as f64 * gap, ((BAR - button.frame().size.height) / 2.0).round()));
            }
        });
    }
}
fn main() {
    tauri::Builder::default().manage(ServerProc(Mutex::new(None))).on_window_event(|window, event| {
        #[cfg(target_os = "macos")]
        if matches!(event, tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Focused(_) | tauri::WindowEvent::ThemeChanged(_) | tauri::WindowEvent::ScaleFactorChanged { .. }) { traffic_lights::place(window); }
        if let tauri::WindowEvent::DragDrop(drop) = event {
            match drop {
                tauri::DragDropEvent::Enter { paths, position } => forward_drop(window, "over", paths, Some(*position)),
                tauri::DragDropEvent::Over { position } => forward_drop(window, "over", &[], Some(*position)),
                tauri::DragDropEvent::Drop { paths, position } => forward_drop(window, "drop", paths, Some(*position)),
                tauri::DragDropEvent::Leave => forward_drop(window, "leave", &[], None),
                _ => {}
            }
        }
    }).setup(|app| {
        let window = app.get_webview_window("main").expect("main window"); let handle = app.handle().clone();
        #[cfg(target_os = "macos")]
        traffic_lights::place(&window.as_ref().window());
        std::thread::spawn(move || { let dir = data_dir(); let lang = language(&dir); if let Err(error) = run(&window, &handle, &dir, &lang) { status(&window, &error, &error, &lang, true); stop(&handle); } });
        Ok(())
    }).build(tauri::generate_context!()).expect("Visual Brain startup").run(|app, event| { if let RunEvent::Exit = event { stop(app); } });
}
#[cfg(test)]
mod tests {
    use super::*;
    fn scratch(tag: &str) -> PathBuf { let d = std::env::temp_dir().join(format!("vb-move-test-{tag}-{}", std::process::id())); let _ = fs::remove_dir_all(&d); fs::create_dir_all(&d).unwrap(); d }
    /// Removes a scratch folder; its synthetic apps leave Launch Services first, or Launchpad shows them as "forbidden" icons.
    fn discard(root: &Path) {
        fn apps(dir: &Path, out: &mut Vec<PathBuf>) {
            for entry in fs::read_dir(dir).into_iter().flatten().flatten() {
                let path = entry.path();
                if path.extension().is_some_and(|e| e == "app") { out.push(path); } else if path.is_dir() { apps(&path, out); }
            }
        }
        let mut found = Vec::new(); apps(root, &mut found);
        for app in found { sh("/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister", &[&"-u", &app], 10); }
        let _ = fs::remove_dir_all(root);
    }
    fn fake_app(at: &Path, version: &str) {
        fs::create_dir_all(at.join("Contents/MacOS")).unwrap();
        fs::write(at.join("Contents/Info.plist"), format!(r#"<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.jethr.visualbrain</string><key>CFBundleShortVersionString</key><string>{version}</string></dict></plist>"#)).unwrap();
    }
    #[test] fn persistent_terminal_port() {
        let root = scratch("terminal-port");
        fs::create_dir_all(root.join("terminal-service")).unwrap();
        fs::write(root.join("terminal-service/host.json"), serde_json::json!({"pid": std::process::id(), "apiPort": 49321}).to_string()).unwrap();
        assert_eq!(terminal_api_port(&root), Some(49321));
        let occupied = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = occupied.local_addr().unwrap().port();
        assert!(server_listener(0, Some(port)).is_err(), "active terminal API port must never silently move");
        assert!(server_listener(port, None).is_ok(), "fresh profile can still choose a free port");
        fs::write(root.join("terminal-service/host.json"), r#"{"pid":0,"apiPort":49321}"#).unwrap();
        assert_eq!(terminal_api_port(&root), None);
        discard(&root);
    }
    #[test] fn translocation() {
        assert!(is_translocated(Path::new("/private/var/folders/xy/abc/T/AppTranslocation/1234-5678/d/Visual Brain.app")));
        assert!(!is_translocated(Path::new("/Applications/Visual Brain.app")));
        assert!(!is_translocated(Path::new("/Users/me/Downloads/Visual Brain.app")));
    }
    #[test] fn versions() {
        assert_eq!(compare_versions("0.2.10", "0.2.9"), Ordering::Greater);
        assert_eq!(compare_versions("0.2.9", "0.2.10"), Ordering::Less);
        assert_eq!(compare_versions("0.2", "0.2.0"), Ordering::Equal);
        assert_eq!(compare_versions("1.0.0-beta", "0.9.9"), Ordering::Greater);
        assert_eq!(plan("0.2.11", Some("0.2.11")), Plan::Open);
        assert_eq!(plan("0.2.11", Some("0.2.12")), Plan::Open);
        assert_eq!(plan("0.2.11", Some("0.2.9")), Plan::Copy);
        assert_eq!(plan("0.2.11", None), Plan::Copy);
    }
    #[test] fn destination() {
        let (sys, user) = (Path::new("/Applications"), Path::new("/Users/me/Applications"));
        let app = "Visual Brain.app";
        let pick = |existing: &[PathBuf], writable_sys: bool| choose_destination(&[sys, user], app, |p| existing.iter().any(|e| e == p), |d| writable_sys && d == sys);
        assert_eq!(pick(&[], true), sys.join(app));
        assert_eq!(pick(&[], false), user.join(app));
        assert_eq!(pick(&[user.join(app)], true), user.join(app));
        assert_eq!(pick(&[sys.join(app)], false), sys.join(app));
        assert_eq!(pick(&[sys.join(app), user.join(app)], true), sys.join(app));
    }
    #[test] fn relaunch_marker() {
        let args = |v: &[&str]| v.iter().map(|a| a.to_string()).collect::<Vec<_>>();
        assert!(relaunched(args(&["/x/Visual Brain", "--vb-relocated"])));
        assert!(!relaunched(args(&["/x/Visual Brain"])));
        assert!(!relaunched(args(&["/x/Visual Brain", "--vb-relocated=1", "-psn_0_1"])));
    }
    #[test] fn applications_override() {
        let home = Path::new("/Users/me");
        let defaults = vec![PathBuf::from("/Applications"), PathBuf::from("/Users/me/Applications")];
        assert_eq!(applications_dirs(None, home), defaults);
        assert_eq!(applications_dirs(Some(String::new()), home), defaults);
        assert_eq!(applications_dirs(Some("::".into()), home), defaults);
        assert_eq!(applications_dirs(Some("/tmp/a:/tmp/b dir:".into()), home), vec![PathBuf::from("/tmp/a"), PathBuf::from("/tmp/b dir")]);
        assert_eq!(applications_dirs(Some("/tmp/only".into()), home), vec![PathBuf::from("/tmp/only")]);
    }
    #[test] fn quarantine_detection() {
        let root = scratch("quarantine");
        let app = root.join("Visual Brain.app"); fake_app(&app, "0.2.11");
        assert!(!quarantined(&app));
        assert!(sh("/usr/bin/xattr", &[&"-w", &"com.apple.quarantine", &"0081;00000000;Test;", &app], 10));
        assert!(quarantined(&app));
        assert!(sh("/usr/bin/xattr", &[&"-dr", &"com.apple.quarantine", &app], 10) && !quarantined(&app));
        discard(&root);
    }
    #[test] fn install_replaces_and_keeps_backup() {
        let root = scratch("ok");
        let (src, dest, aside) = (root.join("src/Visual Brain.app"), root.join("Apps/Visual Brain.app"), root.join("backups"));
        fake_app(&src, "0.2.11"); fake_app(&dest, "0.2.9"); fs::write(dest.join("old-marker"), "x").unwrap();
        assert_eq!(plist(&dest, "CFBundleShortVersionString").as_deref(), Some("0.2.9"));
        install(&src, &dest, &aside, false).unwrap();
        assert_eq!(plist(&dest, "CFBundleShortVersionString").as_deref(), Some("0.2.11"));
        assert!(!dest.join("old-marker").exists());
        let backups: Vec<_> = fs::read_dir(&aside).unwrap().flatten().collect();
        assert_eq!(backups.len(), 1);
        assert!(backups[0].path().join("Visual Brain.app/old-marker").is_file());
        assert_eq!(fs::read_dir(root.join("Apps")).unwrap().count(), 1, "no staging leftovers");
        assert!(src.join("Contents/Info.plist").is_file(), "source untouched");
        discard(&root);
    }
    #[test] fn install_into_new_folder() {
        let root = scratch("new");
        let (src, dest) = (root.join("src/Visual Brain.app"), root.join("home/Applications/Visual Brain.app"));
        fake_app(&src, "0.2.11");
        install(&src, &dest, &root.join("backups"), false).unwrap();
        assert_eq!(plist(&dest, "CFBundleShortVersionString").as_deref(), Some("0.2.11"));
        assert!(!root.join("backups").exists());
        discard(&root);
    }
    #[test] fn install_verifies_signed_bundle_and_drops_quarantine() {
        let root = scratch("signed");
        let (src, dest) = (root.join("src/Visual Brain.app"), root.join("Apps/Visual Brain.app"));
        fake_app(&src, "0.2.11");
        fs::copy("/usr/bin/true", src.join("Contents/MacOS/vb")).unwrap();
        assert!(sh("/usr/libexec/PlistBuddy", &[&"-c", &"Add CFBundleExecutable string vb", &src.join("Contents/Info.plist")], 10));
        assert!(sh("/usr/bin/codesign", &[&"-s", &"-", &"--force", &src], 30), "ad-hoc signing");
        assert!(sh("/usr/bin/xattr", &[&"-w", &"com.apple.quarantine", &"0081;00000000;Test;", &src], 10));
        install(&src, &dest, &root.join("backups"), true).unwrap();
        assert!(sh("/usr/bin/codesign", &[&"--verify", &"--deep", &"--strict", &dest], 30));
        assert!(!sh("/usr/bin/xattr", &[&"-p", &"com.apple.quarantine", &dest], 10), "quarantine removed");
        discard(&root);
    }
    #[test] fn failed_install_leaves_destination() {
        let root = scratch("fail");
        let (src, dest, aside) = (root.join("src/Visual Brain.app"), root.join("Apps/Visual Brain.app"), root.join("backups"));
        fake_app(&src, "0.2.11"); fake_app(&dest, "0.2.9");
        // Unsigned fake bundle: codesign verification fails, so nothing may change.
        assert!(install(&src, &dest, &aside, true).is_err());
        // Missing source: the copy itself fails.
        assert!(install(&root.join("missing.app"), &dest, &aside, false).is_err());
        assert_eq!(plist(&dest, "CFBundleShortVersionString").as_deref(), Some("0.2.9"));
        assert_eq!(fs::read_dir(root.join("Apps")).unwrap().count(), 1, "no staging leftovers");
        assert!(!aside.exists());
        discard(&root);
    }
}
