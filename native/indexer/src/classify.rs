// Port of src/server/classify.ts: file classes and languages from names, folder roles from their content.
// Keep the tables in sync with the TypeScript source; the parity test compares both on the same tree.

pub const PROJECT_MARKERS: &[&str] = &[
    ".git", "package.json", "Cargo.toml", "pyproject.toml", "requirements.txt", "setup.py", "setup.cfg", "go.mod",
    "CLAUDE.md", "AGENTS.md", "Package.swift", "pubspec.yaml", "composer.json", "Gemfile", "build.gradle", "pom.xml",
    "tauri.conf.json", "Makefile", "CMakeLists.txt", "appsscript.json", "manifest.json", "Pipfile", "environment.yml",
];

const DATA_CLASSES: &[&str] = &["data", "sheet", "archive", "binary", "image", "video", "audio", "font", "log"];
const MEDIA_CLASSES: &[&str] = &["image", "video", "audio"];

pub fn is_data_class(cls: &str) -> bool {
    DATA_CLASSES.contains(&cls)
}

pub fn is_media_class(cls: &str) -> bool {
    MEDIA_CLASSES.contains(&cls)
}

fn lang_of(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "py" | "pyw" | "pyi" => "python",
        "js" | "mjs" | "cjs" | "jsx" => "javascript",
        "ts" | "mts" | "cts" | "tsx" => "typescript",
        "gs" => "appsscript", "rs" => "rust", "go" => "go", "java" => "java", "kt" => "kotlin", "swift" => "swift",
        "c" | "h" => "c",
        "cpp" | "cc" | "cxx" | "hpp" | "hh" | "hxx" => "cpp",
        "cu" | "cuh" => "cuda",
        "m" | "mm" => "objc", "rb" => "ruby", "php" => "php",
        "sh" | "bash" | "zsh" | "fish" => "shell",
        "ps1" => "powershell", "sql" => "sql", "r" => "r", "scala" => "scala", "lua" => "lua", "pl" => "perl",
        "vue" => "vue", "svelte" => "svelte", "dart" => "dart", "cs" => "csharp",
        "ex" | "exs" => "elixir", "hs" => "haskell", "clj" => "clojure", "cmake" => "cmake", "mk" => "make",
        "applescript" | "scpt" => "applescript",
        "html" | "htm" => "html", "css" => "css", "scss" => "scss", "less" => "less",
        "md" | "mdx" => "markdown", "rst" => "rst", "txt" => "text", "tex" => "latex", "json" => "json",
        "jsonl" | "ndjson" => "jsonl",
        "yaml" | "yml" => "yaml", "toml" => "toml",
        "ini" | "cfg" | "conf" => "ini",
        "plist" => "plist", "xml" => "xml", "svg" => "svg", "ipynb" => "notebook",
        "csv" | "tsv" => "csv",
        "sqlite" | "db" | "sqlite3" => "sqlite",
        "log" => "log", "env" => "env", "dockerfile" => "docker", "proto" => "protobuf", "graphql" => "graphql",
        "wasm" => "wasm",
        _ => return None,
    })
}

fn class_of(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "py" | "pyw" | "pyi" | "js" | "mjs" | "cjs" | "jsx" | "ts" | "mts" | "cts" | "tsx" | "gs" | "rs" | "go"
        | "java" | "kt" | "swift" | "c" | "h" | "cpp" | "cc" | "cxx" | "hpp" | "hh" | "hxx" | "cu" | "cuh" | "m"
        | "mm" | "rb" | "php" | "sh" | "bash" | "zsh" | "fish" | "ps1" | "sql" | "r" | "scala" | "lua" | "pl"
        | "vue" | "svelte" | "dart" | "cs" | "ex" | "exs" | "hs" | "clj" | "cmake" | "mk" | "applescript"
        | "scpt" | "css" | "scss" | "less" | "proto" | "graphql" => "code",
        "md" | "mdx" | "rst" | "txt" | "tex" | "html" | "htm" | "pdf" | "doc" | "docx" | "odt" | "pages" | "rtf"
        | "epub" | "ppt" | "pptx" | "key" => "doc",
        "yaml" | "yml" | "toml" | "ini" | "cfg" | "conf" | "plist" | "lock" | "editorconfig" | "properties" => "config",
        "csv" | "tsv" | "jsonl" | "ndjson" | "xml" | "parquet" | "feather" | "arrow" | "sqlite" | "db" | "sqlite3"
        | "pkl" | "pickle" | "npy" | "npz" => "data",
        "xls" | "xlsx" | "xlsm" | "ods" | "numbers" => "sheet",
        "gz" | "zip" | "tar" | "tgz" | "7z" | "rar" | "bz2" | "xz" | "dmg" | "pkg" | "whl" => "archive",
        "png" | "jpg" | "jpeg" | "gif" | "svg" | "webp" | "heic" | "bmp" | "tiff" | "tif" | "ico" | "psd" | "icns" => "image",
        "mp4" | "mov" | "avi" | "mkv" | "webm" | "m4v" => "video",
        "mp3" | "wav" | "m4a" | "aac" | "flac" | "ogg" => "audio",
        "ttf" | "otf" | "woff" | "woff2" => "font",
        "log" => "log",
        "ipynb" => "notebook",
        "o" | "so" | "dylib" | "dll" | "a" | "exe" | "bin" | "node" | "pyc" | "pcm" | "class" | "jar" | "wasm" | "d"
        | "obj" | "lib" | "pdb" | "rlib" | "rmeta" => "binary",
        _ => return None,
    })
}

const CONFIG_JSON: &[&str] = &[
    "package.json", "package-lock.json", "tsconfig.json", "jsconfig.json", "composer.json", "manifest.json",
    "settings.json", "settings.local.json", "brain.config.json", "tauri.conf.json", "renovate.json", "vercel.json",
    "app.json", "extensions.json", "launch.json", "tasks.json", "mcp.json", ".mcp.json", "config.json", "credentials.json",
];
const CONFIG_JSON_SUFFIX: &[&str] = &[".config.json", ".code-workspace", "rc.json"];

fn special(lower: &str) -> Option<(&'static str, &'static str)> {
    Some(match lower {
        "dockerfile" => ("config", "docker"), "makefile" => ("code", "make"), "cmakelists.txt" => ("code", "cmake"),
        "readme" | "license" | "licence" | "changelog" | "notice" | "authors" => ("doc", "text"),
        "procfile" => ("config", "text"), "pipfile" => ("config", "toml"),
        "gemfile" => ("config", "ruby"), "rakefile" => ("code", "ruby"), "justfile" => ("code", "make"),
        ".gitignore" | ".gitattributes" => ("config", "text"), ".gitmodules" => ("config", "ini"),
        ".editorconfig" => ("config", "ini"),
        ".prettierrc" | ".eslintrc" | ".babelrc" => ("config", "json"),
        ".nvmrc" | ".python-version" | ".tool-versions" | ".dockerignore" => ("config", "text"),
        ".npmrc" => ("secret", "text"),
        ".localized" => ("other", "text"), ".ds_store" => ("other", "binary"),
        _ => return None,
    })
}

/// Case-insensitive glob (`*` and `?` only), same semantics as `globToRegExp` in config.ts.
pub struct Glob(Vec<char>);

impl Glob {
    pub fn new(pattern: &str) -> Glob {
        Glob(pattern.chars().map(fold).collect())
    }

    pub fn matches(&self, name: &str) -> bool {
        let s: Vec<char> = name.chars().map(fold).collect();
        let p = &self.0;
        let (mut i, mut j) = (0usize, 0usize);
        let (mut star, mut mark) = (usize::MAX, 0usize);
        while i < s.len() {
            if j < p.len() && (p[j] == '?' || (p[j] != '*' && p[j] == s[i])) {
                i += 1;
                j += 1;
            } else if j < p.len() && p[j] == '*' {
                star = j;
                mark = i;
                j += 1;
            } else if star != usize::MAX {
                j = star + 1;
                mark += 1;
                i = mark;
            } else {
                return false;
            }
        }
        while j < p.len() && p[j] == '*' {
            j += 1;
        }
        j == p.len()
    }
}

fn fold(c: char) -> char {
    let mut l = c.to_lowercase();
    match (l.next(), l.next()) {
        (Some(x), None) => x,
        _ => c,
    }
}

pub struct FileClass {
    pub ext: String,
    pub cls: &'static str,
    pub lang: Option<&'static str>,
}

pub fn classify_file(name: &str, secrets: &[Glob]) -> FileClass {
    let lower = name.to_lowercase();
    let ext = match lower.rfind('.') {
        Some(dot) if dot > 0 => lower[dot + 1..].to_string(),
        _ if lower.starts_with('.') => lower[1..].to_string(),
        _ => String::new(),
    };
    if secrets.iter().any(|g| g.matches(name)) {
        return FileClass { ext, cls: "secret", lang: None };
    }
    if let Some((cls, lang)) = special(&lower) {
        return FileClass { ext, cls, lang: Some(lang) };
    }
    if ext == "json" {
        let is_config = CONFIG_JSON.contains(&lower.as_str()) || CONFIG_JSON_SUFFIX.iter().any(|s| lower.ends_with(s));
        return FileClass { ext, cls: if is_config { "config" } else { "data" }, lang: Some("json") };
    }
    let lang = lang_of(&ext);
    match class_of(&ext) {
        Some(cls) => FileClass { ext, cls, lang },
        None if ext.is_empty() => FileClass { ext, cls: "other", lang: None },
        None => FileClass { ext, cls: "other", lang },
    }
}

#[derive(Default, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirStats {
    pub files: u64,
    pub bytes: u64,
    pub child_count: u64,
    pub data_files: u64,
    pub media_files: u64,
    pub code_files: u64,
    pub doc_files: u64,
    pub markers: Vec<String>,
}

pub fn classify_dir(s: &DirStats, dump_min_files: f64, dump_data_share: f64) -> &'static str {
    if !s.markers.is_empty() {
        return "project";
    }
    let files = s.files as f64;
    if files >= dump_min_files {
        if s.data_files as f64 / files >= dump_data_share {
            return "dump";
        }
        if s.media_files as f64 / files >= 0.8 {
            return "media";
        }
    } else if files >= 20.0 && s.media_files as f64 / files >= 0.8 {
        return "media";
    }
    "folder"
}

#[cfg(test)]
mod tests {
    use super::*;

    fn secrets() -> Vec<Glob> {
        [".env", ".env.*", "*.pem", "id_rsa*", "service-account*.json", "token.json"].iter().map(|g| Glob::new(g)).collect()
    }

    #[test]
    fn files() {
        let s = secrets();
        let c = classify_file("Main.TS", &s);
        assert_eq!((c.ext.as_str(), c.cls, c.lang), ("ts", "code", Some("typescript")));
        let c = classify_file(".env.local", &s);
        assert_eq!(c.cls, "secret");
        let c = classify_file("ID_RSA.pub", &s);
        assert_eq!(c.cls, "secret");
        let c = classify_file("package.json", &s);
        assert_eq!((c.cls, c.lang), ("config", Some("json")));
        let c = classify_file("export.json", &s);
        assert_eq!(c.cls, "data");
        let c = classify_file("Makefile", &s);
        assert_eq!((c.ext.as_str(), c.cls, c.lang), ("", "code", Some("make")));
        let c = classify_file(".gitignore", &s);
        assert_eq!((c.ext.as_str(), c.cls), ("gitignore", "config"));
        let c = classify_file("notes", &s);
        assert_eq!((c.ext.as_str(), c.cls, c.lang), ("", "other", None));
        let c = classify_file("x.env", &s);
        assert_eq!((c.cls, c.lang), ("other", Some("env")));
    }

    #[test]
    fn globs() {
        assert!(Glob::new("*.key").matches("a.KEY"));
        assert!(!Glob::new("*.key").matches("a.keys"));
        assert!(Glob::new("a?c").matches("abc"));
        assert!(Glob::new("*").matches(""));
    }

    #[test]
    fn dirs() {
        let mut s = DirStats { files: 100, data_files: 85, ..Default::default() };
        assert_eq!(classify_dir(&s, 100.0, 0.85), "dump");
        s.data_files = 10;
        s.media_files = 80;
        assert_eq!(classify_dir(&s, 100.0, 0.85), "media");
        s.markers.push("package.json".into());
        assert_eq!(classify_dir(&s, 100.0, 0.85), "project");
    }
}
