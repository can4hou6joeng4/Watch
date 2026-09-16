// Watch 桌面壳：极简界面 + 会话反查 cwd + 一键在系统终端起航（失败退回剪贴板）。
// 业务逻辑全部由 src/cli.ts 承担；Rust 侧只提供前端调用 CLI 的桥，以及 launch_terminal 这条本地能力。
// open <id>（不带 --from）为纯查询：全局反查 cwd / resume，不修改任何会话文件。

use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use tauri::Manager;

/// CLI 运行时根目录（含 src/cli.ts 与 node_modules/tsx）。
/// 开发态 = 仓库根（CARGO_MANIFEST_DIR/../..）；打包态 = 应用 Resources/watch-core。
static CORE_ROOT: OnceLock<PathBuf> = OnceLock::new();

fn init_core_root(app: &tauri::App) {
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let root = if dev.join("src/cli.ts").exists() {
        dev
    } else {
        app.path()
            .resource_dir()
            .expect("resource_dir 不可用")
            .join("watch-core")
    };
    let _ = CORE_ROOT.set(root);
}

fn repo_root() -> Result<PathBuf, String> {
    CORE_ROOT
        .get()
        .cloned()
        .ok_or_else(|| "核心目录未初始化".to_string())
}

/// node 是否已在 PATH 中可直接执行（Windows 下 OS 会自行解析 node.exe 的位置）
fn node_on_path() -> bool {
    Command::new("node")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// 解析 node 可执行程序名/路径。
/// Windows：优先 PATH（返回 "node" 交给 OS 解析），失败再查固定安装目录；
/// 其它平台：保持 which / Homebrew / nvm 兜底。
fn resolve_node() -> Result<PathBuf, String> {
    if cfg!(target_os = "windows") {
        if node_on_path() {
            return Ok(PathBuf::from("node"));
        }
        let mut cands: Vec<PathBuf> = vec!["C:\\Program Files\\nodejs\\node.exe".into()];
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            cands.push(PathBuf::from(&local).join("Programs\\nodejs\\node.exe"));
        }
        for cand in cands {
            if cand.exists() {
                return Ok(cand);
            }
        }
        return Err("找不到 node，请安装 Node.js 或将其加入 PATH".into());
    }

    if let Ok(out) = Command::new("which").arg("node").output() {
        if out.status.success() {
            let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !p.is_empty() {
                return Ok(PathBuf::from(p));
            }
        }
    }
    for cand in ["/opt/homebrew/bin/node", "/usr/local/bin/node"] {
        if PathBuf::from(cand).exists() {
            return Ok(PathBuf::from(cand));
        }
    }
    let home = std::env::var_os("HOME").map(PathBuf::from).ok_or("无法解析 HOME")?;
    let nvm = home.join(".nvm/versions/node");
    if let Ok(entries) = fs::read_dir(nvm) {
        let mut vers: Vec<PathBuf> = entries.filter_map(|e| e.ok().map(|e| e.path())).collect();
        vers.sort();
        if let Some(bin) = vers
            .into_iter()
            .rev()
            .map(|v| v.join("bin/node"))
            .find(|p| p.exists())
        {
            return Ok(bin);
        }
    }
    Err("找不到 node，请从终端启动 desktop:dev".into())
}

/// GUI 进程不继承用户 shell 的 PATH（macOS launchd 环境只有 /usr/bin:/bin:…），
/// 从 login shell 取一次真实 PATH（并补充加载 rc 文件）后缓存；失败返回 None 保持现状。
/// 绝不传 -i（交互模式）：非交互探测子进程传 -i 会导致 zsh 初始化行编辑与作业控制，
/// 尝试争抢/窃取控制终端前台进程组，引发 SIGTTIN 挂起主前台进程（如 agy）。
/// Windows 的 GUI 进程继承用户 PATH，无需处理。
fn shell_path() -> Option<&'static str> {
    static PATH: OnceLock<Option<String>> = OnceLock::new();
    PATH.get_or_init(|| {
        if cfg!(target_os = "windows") {
            return None;
        }
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let probe = "for rc in \"$HOME/.zshrc\" \"$HOME/.bashrc\"; do [ -f \"$rc\" ] && . \"$rc\" 2>/dev/null; done; echo __WATCH_PATH__$PATH";
        let out = Command::new(shell)
            .args(["-l", "-c", probe])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&out.stdout);
        let p = text
            .lines()
            .find_map(|l| l.strip_prefix("__WATCH_PATH__"))?
            .trim()
            .to_string();
        if p.is_empty() { None } else { Some(p) }
    })
    .as_deref()
}

fn parse_cli_json(stdout: &str, stderr: &str, exit_code: i32) -> Result<Value, String> {
    let stdout = stdout.trim();
    if stdout.is_empty() {
        let stderr = stderr.trim();
        return Err(if stderr.is_empty() {
            format!("CLI 无输出, exit={exit_code}")
        } else {
            stderr.to_string()
        });
    }
    let json = stdout
        .lines()
        .rev()
        .find(|line| line.trim_start().starts_with('{'))
        .unwrap_or(stdout);
    serde_json::from_str(json).map_err(|e| format!("解析 CLI JSON 失败: {e}"))
}

fn run_cli_json(args: &[&str]) -> Result<Value, String> {
    let repo = repo_root()?;
    let cli = repo.join("src/cli.ts");
    if !cli.exists() {
        return Err(format!("找不到 CLI: {}", cli.display()));
    }
    let tsx_entry = repo.join("node_modules/tsx/dist/cli.mjs");
    if !tsx_entry.exists() {
        return Err("仓库根缺少 node_modules，请先 npm install".into());
    }
    let node = resolve_node()?;
    let mut cmd = Command::new(&node);
    cmd.current_dir(&repo).arg(&tsx_entry).arg(&cli).args(args);
    if let Some(path) = shell_path() {
        cmd.env("PATH", path);
    }
    let output = cmd.output().map_err(|e| format!("启动 tsx 失败: {e}"))?;
    parse_cli_json(
        &String::from_utf8_lossy(&output.stdout),
        &String::from_utf8_lossy(&output.stderr),
        output.status.code().unwrap_or(-1),
    )
}

fn run_cli_json_owned(args: Vec<String>) -> Result<Value, String> {
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run_cli_json(&refs)
}

fn is_uuid(value: &str) -> bool {
    let groups = [8, 4, 4, 4, 12];
    let parts: Vec<&str> = value.split('-').collect();
    parts.len() == groups.len()
        && parts.iter().zip(groups).all(|(part, len)| {
            part.len() == len && part.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
}

fn is_plan_id(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn codex_prepare_args(source_id: &str, cwd: &str) -> Result<Vec<String>, String> {
    if !is_uuid(source_id) {
        return Err("Codex 官方导入需要 Claude Code 会话 UUID".into());
    }
    if !Path::new(cwd).is_absolute() {
        return Err("Codex 官方导入需要绝对项目路径".into());
    }
    Ok(vec![
        "import-codex".into(),
        "prepare".into(),
        source_id.into(),
        "--cwd".into(),
        cwd.into(),
        "--desktop-project".into(),
        "--experimental".into(),
        "--json".into(),
    ])
}

fn codex_confirm_args(plan_id: &str) -> Result<Vec<String>, String> {
    if !is_plan_id(plan_id) {
        return Err("无效的 Codex 导入计划 ID".into());
    }
    Ok(vec![
        "import-codex".into(),
        "confirm".into(),
        plan_id.into(),
        "--experimental".into(),
        "--json".into(),
    ])
}

fn codex_status_args(plan_id: &str) -> Result<Vec<String>, String> {
    if !is_plan_id(plan_id) {
        return Err("无效的 Codex 导入计划 ID".into());
    }
    Ok(vec![
        "import-codex".into(),
        "status".into(),
        plan_id.into(),
        "--json".into(),
    ])
}

/// 输入会话 ID，全局反查其 cwd（等价 `watch open <id> --json`，只查询不修改）
#[tauri::command]
async fn resolve_cwd(session_id: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || run_cli_json(&["open", session_id.as_str(), "--json"]))
        .await
        .map_err(|e| format!("resolve_cwd 任务失败: {e}"))?
}

/// 获取最近记录的会话列表（等价 `watch recent --json`）
#[tauri::command]
async fn list_recent_sessions() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || run_cli_json(&["recent", "--json"]))
        .await
        .map_err(|e| format!("list_recent_sessions 任务失败: {e}"))?
}

/// 获取各 Agent 在本机的安装可用状态（等价 `watch providers --json`）
#[tauri::command]
async fn list_available_providers() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || run_cli_json(&["providers", "--json"]))
        .await
        .map_err(|e| format!("list_available_providers 任务失败: {e}"))?
}

/// 获取工作区接力链历史记录（等价 `watch status --json --cwd <cwd>`）
#[tauri::command]
async fn get_handoff_history(cwd: Option<String>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut args = vec!["status", "--json"];
        let cwd_str;
        if let Some(ref c) = cwd {
            cwd_str = c.clone();
            args.push("--cwd");
            args.push(&cwd_str);
        }
        run_cli_json(&args)
    })
    .await
    .map_err(|e| format!("get_handoff_history 任务失败: {e}"))?
}

/// 把来源会话内容转入目标 provider 新会话（等价 `watch open <id> --to <provider> --json`）
#[tauri::command]
async fn open_in(source_id: String, provider_id: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_cli_json(&["open", source_id.as_str(), "--to", provider_id.as_str(), "--json"])
    })
    .await
    .map_err(|e| format!("open_in 任务失败: {e}"))?
}

/// 点击前预检（只读，不写入）：等价 `watch open <id> --to <provider> --check --json`
#[tauri::command]
async fn check_open(source_id: String, provider_id: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_cli_json(&["open", source_id.as_str(), "--to", provider_id.as_str(), "--check", "--json"])
    })
    .await
    .map_err(|e| format!("check_open 任务失败: {e}"))?
}

/// 只读预览 Claude Code -> Codex Desktop 官方项目先建导入，不提交导入。
#[tauri::command]
async fn prepare_codex_import(source_id: String, cwd: String) -> Result<Value, String> {
    let args = codex_prepare_args(&source_id, &cwd)?;
    tauri::async_runtime::spawn_blocking(move || run_cli_json_owned(args))
        .await
        .map_err(|e| format!("prepare_codex_import 任务失败: {e}"))?
}

/// 用户审阅预览后，按计划 ID 提交一次官方导入。重复与未知结果由核心持久锁阻断。
#[tauri::command]
async fn confirm_codex_import(plan_id: String) -> Result<Value, String> {
    let args = codex_confirm_args(&plan_id)?;
    tauri::async_runtime::spawn_blocking(move || run_cli_json_owned(args))
        .await
        .map_err(|e| format!("confirm_codex_import 任务失败: {e}"))?
}

/// 查询已有计划，不提交或重试任何写入。
#[tauri::command]
async fn codex_import_status(plan_id: String) -> Result<Value, String> {
    let args = codex_status_args(&plan_id)?;
    tauri::async_runtime::spawn_blocking(move || run_cli_json_owned(args))
        .await
        .map_err(|e| format!("codex_import_status 任务失败: {e}"))?
}

fn codex_thread_url(thread_id: &str) -> Result<String, String> {
    if !is_uuid(thread_id) {
        return Err("无效的 Codex 线程 ID".into());
    }
    Ok(format!("codex://threads/{thread_id}"))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[allow(dead_code)] // Non-host variants are constructed by cross-platform command-spec tests.
enum OpenPlatform {
    MacOs,
    Windows,
    Linux,
}

fn current_open_platform() -> OpenPlatform {
    #[cfg(target_os = "macos")]
    return OpenPlatform::MacOs;
    #[cfg(target_os = "windows")]
    return OpenPlatform::Windows;
    #[cfg(target_os = "linux")]
    return OpenPlatform::Linux;
}

fn codex_open_command(
    thread_id: &str,
    platform: OpenPlatform,
) -> Result<(String, Vec<String>), String> {
    let url = codex_thread_url(thread_id)?;
    Ok(match platform {
        OpenPlatform::MacOs => ("open".into(), vec![url]),
        OpenPlatform::Windows => (
            "cmd.exe".into(),
            vec!["/C".into(), "start".into(), "".into(), url],
        ),
        OpenPlatform::Linux => ("xdg-open".into(), vec![url]),
    })
}

fn run_open_command(program: &str, args: &[String]) -> Result<(), String> {
    let output = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("启动 Codex Desktop 失败: {e}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if stderr.is_empty() {
        format!("打开 Codex Desktop 失败, exit={}", output.status.code().unwrap_or(-1))
    } else {
        stderr
    })
}

fn open_codex_thread_blocking(thread_id: &str) -> Result<(), String> {
    let (program, args) = codex_open_command(thread_id, current_open_platform())?;
    run_open_command(&program, &args)
}

/// 打开已导入的目标线程；此动作不读取来源、不执行导入，也不调用模型。
#[tauri::command]
async fn open_codex_thread(thread_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || open_codex_thread_blocking(&thread_id))
        .await
        .map_err(|e| format!("open_codex_thread 任务失败: {e}"))?
}

/// 一键起航：在系统终端里新开窗口并执行 `command`（前端已拼好 `cd … && <resume>`）。
/// `terminal`：macOS 下 "terminal"（默认）| "kaku" | "iterm2" | "ghostty"，其它平台忽略。
/// 失败返回 Err（终端未安装、自动化权限被拒等），前端据此退回「复制命令」。
#[tauri::command]
async fn launch_terminal(cwd: String, command: String, terminal: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        launch_terminal_blocking(&cwd, &command, terminal.as_deref().unwrap_or("terminal"))
    })
    .await
    .map_err(|e| format!("launch_terminal 任务失败: {e}"))?
}

/// 本机可用的终端 id（推荐顺序：系统终端、Kaku、iTerm2、Ghostty），前端据此只展示装了的选项。
/// 非 macOS 只有 "terminal" 一项（Windows 走 wt.exe → PowerShell，Linux 走 gnome-terminal → x-terminal-emulator）。
#[tauri::command]
fn list_terminals() -> Vec<String> {
    let mut v = vec!["terminal".to_string()];
    if cfg!(target_os = "macos") {
        if kaku_cli().is_some() {
            v.push("kaku".into());
        }
        if app_bundle("iTerm").is_some() {
            v.push("iterm2".into());
        }
        if app_bundle("Ghostty").is_some() {
            v.push("ghostty".into());
        }
    }
    v
}

/// `/Applications/<name>.app` 或 `~/Applications/<name>.app`（仅 macOS 有意义，其它平台恒 None）
fn app_bundle(name: &str) -> Option<PathBuf> {
    let mut cands = vec![PathBuf::from(format!("/Applications/{name}.app"))];
    if let Some(home) = std::env::var_os("HOME") {
        cands.push(PathBuf::from(home).join(format!("Applications/{name}.app")));
    }
    cands.into_iter().find(|p| p.exists())
}

/// Kaku（tw93 的 WezTerm 分支）随包自带 WezTerm CLI，路径固定在 bundle 里
fn kaku_cli() -> Option<PathBuf> {
    app_bundle("Kaku")
        .map(|p| p.join("Contents/MacOS/kaku"))
        .filter(|p| p.exists())
}

/// 用户登录 shell；起终端时用它包一层 `-l -i -c`：登录 + 交互才会读 .zprofile 与 .zshrc，
/// 各家 agent CLI（nvm / Homebrew 装的）的 PATH 多半在 .zshrc 里，只 `-l -c` 会找不到命令。
#[cfg(not(target_os = "windows"))]
fn login_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into())
}

/// 等子进程结束并按退出码判定；stderr 非空时原文返回（如 osascript 的「找不到应用程序」）
#[cfg(not(target_os = "linux"))]
fn run_to_completion(mut cmd: Command, what: &str) -> Result<(), String> {
    let out = cmd
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("启动 {what} 失败: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
    Err(if err.is_empty() {
        format!("{what} 退出码 {}", out.status.code().unwrap_or(-1))
    } else {
        format!("{what}: {err}")
    })
}

/// 起一个可能常驻（xterm / kaku-gui）也可能立刻退出（gnome-terminal 这类 D-Bus 瘦客户端）的终端进程：
/// spawn 后在 grace 内轮询 try_wait。期间以非 0 退出 → Err（带 stderr，前端据此退回剪贴板）；
/// 以 0 退出或仍在运行 → Ok。仍在运行的交给独立线程 wait，否则子进程结束后会以 <defunct> 僵尸留到 Watch 退出。
#[cfg(not(target_os = "windows"))]
fn spawn_and_probe(mut cmd: Command, what: &str, grace: std::time::Duration) -> Result<(), String> {
    use std::io::Read;
    use std::time::{Duration, Instant};
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("启动 {what} 失败: {e}"))?;
    let stderr = child.stderr.take();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = String::new();
        if let Some(mut s) = stderr {
            let _ = s.read_to_string(&mut buf);
        }
        let _ = tx.send(buf);
    });
    let deadline = Instant::now() + grace;
    loop {
        match child.try_wait() {
            Ok(Some(st)) if st.success() => return Ok(()),
            Ok(Some(st)) => {
                let err = rx.recv_timeout(Duration::from_millis(300)).unwrap_or_default().trim().to_string();
                return Err(if err.is_empty() {
                    format!("{what} 退出码 {}", st.code().unwrap_or(-1))
                } else {
                    format!("{what}: {err}")
                });
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            Ok(None) => {
                std::thread::spawn(move || {
                    let _ = child.wait();
                });
                return Ok(());
            }
            Err(e) => return Err(format!("等待 {what} 失败: {e}")),
        }
    }
}

/// POSIX 单引号包裹（与 App.tsx 的 shellQuote 同规则）
#[cfg(not(target_os = "windows"))]
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// 把「登录交互 shell 执行 command、结束后留在 shell 里」写成一个自删除的 /bin/sh 脚本，返回路径。
/// 各终端 `-e` 语义不一：Ghostty < 1.2、gnome-terminal / xfce4-terminal 的 -e 把后面的参数拼成一个字符串再按
/// shell 切词，xterm / konsole / Debian x-terminal-emulator 则按 argv 直传。只要 -e 后每个参数都不含空白，
/// 两种语义结果一致 —— 于是统一传 `/bin/sh <脚本>`，引号全部收进脚本。
#[cfg(not(target_os = "windows"))]
fn write_launch_script(shell: &str, command: &str) -> Result<PathBuf, String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut dir = std::env::temp_dir();
    if dir.to_string_lossy().chars().any(char::is_whitespace) {
        dir = PathBuf::from("/tmp");
    }
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let path = dir.join(format!("watch-launch-{}-{nanos}.sh", std::process::id()));
    let body = format!(
        "#!/bin/sh\nrm -f -- {p}\nexec {sh} -l -i -c {cmd}\n",
        p = sh_quote(&path.to_string_lossy()),
        sh = sh_quote(shell),
        cmd = sh_quote(&format!("{command}; exec {shell}")),
    );
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o700)
        .open(&path)
        .map_err(|e| format!("写启动脚本失败: {e}"))?;
    f.write_all(body.as_bytes()).map_err(|e| format!("写启动脚本失败: {e}"))?;
    Ok(path)
}

/// AppleScript 字符串字面量转义：只有反斜杠与双引号需要处理
#[cfg(target_os = "macos")]
fn escape_applescript(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Kaku（tw93 的 WezTerm 分支）。有实例在跑时**只能**用 `cli spawn` 接到它上面：实测 `kaku start`
/// 找不到实例会自己变成第二个 GUI 实例，并抢走运行目录里的默认 socket 符号链接、让原实例的
/// socket 消失 —— 原实例的 `kaku cli` 从此失灵直到重启。所以流程是：
/// 1. 枚举 ~/.local/share/kaku/gui-sock-<pid>（新的在前），先 connect 探活跳过死 socket，再通过
///    WEZTERM_UNIX_SOCKET 指定后 `cli --no-auto-start spawn --new-window`（默认符号链接可能悬空，不走它；
///    `KAKU_UNIX_SOCKET` 这个名字 cli 不读；不带 --no-auto-start 时连不上会退避重试 2.25s 再试着拉起
///    bundle 里并不存在的 wezterm-mux-server）；窗口开进 GUI 当前 workspace，否则用户切了 workspace 会看不见；
/// 2. 全部连不上但 kaku-gui 进程还在：报错交给前端退回剪贴板，绝不 start；
/// 3. 确实没有实例：`start` 起 GUI，进程常驻，只探测 1.5s 内有没有立刻失败。
#[cfg(target_os = "macos")]
fn launch_kaku(cwd: &str, command: &str) -> Result<(), String> {
    let bin = kaku_cli().ok_or("找不到 Kaku.app（/Applications 或 ~/Applications）")?;
    let shell = login_shell();
    let prog = format!("{command}; exec {shell}");
    let mut last_err = String::new();
    for sock in kaku_sockets() {
        if std::os::unix::net::UnixStream::connect(&sock).is_err() {
            continue;
        }
        let mut c = Command::new(&bin);
        c.args(["cli", "--no-auto-start", "spawn", "--new-window"]);
        if let Some(ws) = kaku_active_workspace(&bin, &sock) {
            c.arg("--workspace").arg(ws);
        }
        if !cwd.is_empty() {
            c.arg("--cwd").arg(cwd);
        }
        c.arg("--").arg(&shell).args(["-l", "-i", "-c"]).arg(&prog);
        c.env("WEZTERM_UNIX_SOCKET", &sock);
        match run_to_completion(c, "Kaku") {
            Ok(()) => return Ok(()),
            Err(e) => last_err = e,
        }
    }
    if app_process_running("Kaku.app/Contents/MacOS/kaku-gui") {
        return Err(format!(
            "Kaku 正在运行但连不上它的控制 socket（重启 Kaku 可恢复）{}",
            if last_err.is_empty() { String::new() } else { format!("：{last_err}") }
        ));
    }
    let mut c = Command::new(&bin);
    c.arg("start");
    if !cwd.is_empty() {
        c.arg("--cwd").arg(cwd);
    }
    c.arg("--").arg(&shell).args(["-l", "-i", "-c"]).arg(&prog);
    spawn_and_probe(c, "Kaku", std::time::Duration::from_millis(1500))
}

/// GUI 当前所在 workspace：`list-clients` 里 pid == gui-sock-<pid> 的那条（GUI 自己也是一个 client），
/// 没有就取最近有输入且有焦点 pane 的 client。`cli spawn --new-window` 不带 --workspace 固定落到 default，
/// 而 kaku-gui 只渲染 active workspace 的窗口。任何一步拿不到都返回 None（不传参数，维持旧行为）。
#[cfg(target_os = "macos")]
fn kaku_active_workspace(bin: &std::path::Path, sock: &std::path::Path) -> Option<String> {
    let gui_pid: Option<u64> = sock
        .file_name()
        .and_then(|n| n.to_str())
        .and_then(|n| n.strip_prefix("gui-sock-"))
        .and_then(|p| p.parse().ok());
    let out = Command::new(bin)
        .args(["cli", "--no-auto-start", "list-clients", "--format", "json"])
        .env("WEZTERM_UNIX_SOCKET", sock)
        .stdin(Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let clients: Vec<Value> = serde_json::from_slice(&out.stdout).ok()?;
    let pick = clients
        .iter()
        .find(|c| gui_pid.is_some() && c["pid"].as_u64() == gui_pid)
        .or_else(|| {
            clients
                .iter()
                .filter(|c| !c["focused_pane_id"].is_null())
                .min_by_key(|c| c["idle_time"]["secs"].as_u64().unwrap_or(u64::MAX))
        })?;
    pick["workspace"].as_str().filter(|w| !w.is_empty()).map(str::to_string)
}

/// 运行目录里全部 gui-sock-<pid>，按 mtime 新→旧；死实例留下的 socket 连不上，试连即知
#[cfg(target_os = "macos")]
fn kaku_sockets() -> Vec<PathBuf> {
    let Some(home) = std::env::var_os("HOME") else { return vec![] };
    let Ok(rd) = fs::read_dir(PathBuf::from(home).join(".local/share/kaku")) else { return vec![] };
    let mut v: Vec<(std::time::SystemTime, PathBuf)> = rd
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().starts_with("gui-sock-"))
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .collect();
    v.sort_by(|a, b| b.0.cmp(&a.0));
    v.into_iter().map(|(_, p)| p).collect()
}

/// 是否有**当前用户**的某个 .app 进程（按 `ps -o comm=` 给出的可执行文件完整路径后缀判定）。
/// **不能用 `pgrep`**：macOS 的 pgrep 默认排除调用者自己的祖先进程（要 `-a` 才包含），开发态从 Kaku / iTerm2
/// 标签页里 `npm run desktop:dev` 时它们正是 Watch 的祖先，pgrep 会漏报，漏报会让 launch_kaku 误走 `start`
/// 再造一个实例。`-U $USER` 只看本用户，别的登录用户开着同一个终端不该挡住我们。
#[cfg(target_os = "macos")]
fn app_process_running(exe_suffix: &str) -> bool {
    let mut ps = Command::new("ps");
    match std::env::var("USER") {
        Ok(user) if !user.is_empty() => ps.args(["-xo", "comm=", "-U", &user]),
        _ => ps.args(["-axo", "comm="]),
    };
    ps.stdin(Stdio::null())
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).lines().any(|l| l.trim_end().ends_with(exe_suffix)))
        .unwrap_or(false)
}

#[cfg(target_os = "macos")]
fn launch_terminal_blocking(cwd: &str, command: &str, terminal: &str) -> Result<(), String> {
    match terminal {
        "kaku" => launch_kaku(cwd, command),
        "iterm2" => {
            // iTerm2 词典：write text 自带回车。冷启动时 iTerm2 自己会按偏好开一个默认窗口，再 create window 就是两个；
            // 所以未运行时等它的启动窗口出现，若恰好只有一窗一 tab 一 session 且空闲就写进去，否则照常新建（本机无 iTerm2，未实测）。
            let cmd = escape_applescript(command);
            let script = if app_process_running("iTerm.app/Contents/MacOS/iTerm2") {
                format!(
                    "tell application \"iTerm\"\nactivate\nset w to (create window with default profile)\ntell current session of w to write text \"{cmd}\"\nend tell"
                )
            } else {
                format!(
                    concat!(
                        "tell application \"iTerm\"\n",
                        "activate\n",
                        "repeat 120 times\n",
                        "if (count of windows) > 0 then exit repeat\n",
                        "delay 0.05\n",
                        "end repeat\n",
                        "set reuse to false\n",
                        "if (count of windows) is 1 and (count of tabs of window 1) is 1 and (count of sessions of tab 1 of window 1) is 1 then\n",
                        "if not (is processing of current session of window 1) then set reuse to true\n",
                        "end if\n",
                        "if reuse then\n",
                        "tell current session of window 1 to write text \"{}\"\n",
                        "else\n",
                        "set w to (create window with default profile)\n",
                        "tell current session of w to write text \"{}\"\n",
                        "end if\n",
                        "end tell"
                    ),
                    cmd, cmd
                )
            };
            let mut c = Command::new("osascript");
            c.arg("-e").arg(script);
            run_to_completion(c, "iTerm2")
        }
        "ghostty" => {
            // Ghostty 没有 AppleScript 词典，用 open 新起实例并传参。-e 后的参数在 < 1.2 会被拼成一个字符串再按
            // shell 切词、≥ 1.2 才按 argv 直传，所以 -e 后只放不含空白的 `/bin/sh <脚本>`，引号全收进脚本（未实测）。
            let script = write_launch_script(&login_shell(), command)?;
            let mut c = Command::new("open");
            c.arg("-na").arg("Ghostty").arg("--args");
            if !cwd.is_empty() {
                c.arg(format!("--working-directory={cwd}"));
            }
            c.arg("-e").arg("/bin/sh").arg(&script);
            run_to_completion(c, "Ghostty").inspect_err(|_| {
                let _ = fs::remove_file(&script);
            })
        }
        _ => {
            // Terminal 未运行时 `activate` 会先按「启动时打开」偏好开一个空窗口，随后的 `do script`
            // 再开第二个（实测 count windows = 2；去掉或后置 activate 也一样）。所以先记下 running：
            // 冷启动时等启动窗口出现，其 tab 不忙就把命令写进它；否则（已在运行 / 窗口忙）照常新开窗口。
            let script = format!(
                concat!(
                    "tell application \"Terminal\"\n",
                    "set cmd to \"{}\"\n",
                    "set wasRunning to running\n",
                    "activate\n",
                    "if not wasRunning then\n",
                    "repeat 50 times\n",
                    "if (count of windows) > 0 then exit repeat\n",
                    "delay 0.1\n",
                    "end repeat\n",
                    "end if\n",
                    "if (not wasRunning) and (count of windows) > 0 and not (busy of selected tab of window 1) then\n",
                    "do script cmd in window 1\n",
                    "else\n",
                    "do script cmd\n",
                    "end if\n",
                    "end tell"
                ),
                escape_applescript(command)
            );
            let mut c = Command::new("osascript");
            c.arg("-e").arg(script);
            run_to_completion(c, "Terminal")
        }
    }
}

#[cfg(target_os = "windows")]
fn launch_terminal_blocking(cwd: &str, command: &str, _terminal: &str) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    // 前端在 Windows 拼的是 PowerShell 语法（Set-Location …; …）。
    // Windows Terminal 对每个 argv 元素都按未转义的 `;` 切成多条命令，命令与 -d 的目录都要把 `;` 转成 `\;`。
    // -ExecutionPolicy Bypass 只作用于本次会话：Windows PowerShell 5.1 客户端默认 Restricted，而 npm 装的 agent CLI
    // 会被解析成 <name>.ps1 shim，Restricted 下直接拒绝执行；此时 wt 早已退出 0，剪贴板兜底不会触发。
    let wt_command = command.replace(';', "\\;");
    let mut wt = Command::new("wt.exe");
    if !cwd.is_empty() {
        wt.arg("-d").arg(cwd.replace(';', "\\;"));
    }
    wt.args(["powershell", "-NoExit", "-ExecutionPolicy", "Bypass", "-Command", &wt_command])
        .creation_flags(CREATE_NO_WINDOW);
    if run_to_completion(wt, "Windows Terminal").is_ok() {
        return Ok(());
    }
    // 没装 wt：让 conhost.exe 自己开一个新控制台并在其中启动 PowerShell。
    // 不能直接 `powershell` + CREATE_NEW_CONSOLE + Stdio::null()：Rust 一旦设置任一 stdio 就会带 STARTF_USESTDHANDLES，
    // 子进程虽然拿到新窗口，但 stdin/stdout/stderr 都是 NUL —— PowerShell 视 stdin 为重定向、读到 EOF 立即结束会话，
    // 窗口一闪而过，而 spawn 已成功、前端误报「已起航」。conhost 总是把新控制台自己的输入/输出句柄传给客户端，
    // 与 Watch 自身有没有控制台（release GUI / tauri dev）无关。conhost 会对客户端命令行做环境变量展开，路径含 %NAME% 会被展开（罕见）。
    let mut ps = Command::new("conhost.exe");
    ps.arg("powershell").args(["-NoExit", "-ExecutionPolicy", "Bypass", "-Command", command]);
    ps.spawn().map(|_| ()).map_err(|e| format!("启动 PowerShell 失败: {e}"))
}

#[cfg(target_os = "linux")]
fn launch_terminal_blocking(cwd: &str, command: &str, _terminal: &str) -> Result<(), String> {
    use std::time::Duration;
    /// cwd 参数写法
    enum Cwd {
        None,
        Eq(&'static str),
        Sep(&'static str),
    }
    /// 「后面是要执行的程序」的引入方式；程序统一是 `/bin/sh <脚本>`（两个参数都不含空白，
    /// 不管终端把 -e 后面当 argv 直传还是拼成字符串再切词，结果都一样）
    enum Exec {
        DashDash,
        E,
        X,
        Positional,
        WeztermStart,
    }
    // gnome-terminal / ptyxis / konsole 是瘦客户端，把窗口交给常驻 server 后立刻退出（失败时非 0）；
    // xterm 一类自己常驻。spawn_and_probe 两种都能判。x-terminal-emulator 是 Debian 系的 alternatives，
    // Fedora / Arch 上没有，所以前面按实际二进制名逐个试。
    const TABLE: &[(&str, Cwd, Exec)] = &[
        ("gnome-terminal", Cwd::Eq("--working-directory="), Exec::DashDash),
        ("ptyxis", Cwd::Sep("-d"), Exec::DashDash),
        ("konsole", Cwd::Sep("--workdir"), Exec::E),
        ("xfce4-terminal", Cwd::Eq("--working-directory="), Exec::X),
        ("kitty", Cwd::Sep("--directory"), Exec::Positional),
        ("alacritty", Cwd::Sep("--working-directory"), Exec::E),
        ("foot", Cwd::Sep("-D"), Exec::Positional),
        ("wezterm", Cwd::None, Exec::WeztermStart),
        ("x-terminal-emulator", Cwd::None, Exec::E),
        ("xterm", Cwd::None, Exec::E),
    ];
    fn argv(cwd: &str, run: &str, spec: &(&str, Cwd, Exec)) -> Vec<String> {
        let (_, cwd_flag, exec) = spec;
        let mut v: Vec<String> = Vec::new();
        if let Exec::WeztermStart = exec {
            v.push("start".into());
            if !cwd.is_empty() {
                v.push("--cwd".into());
                v.push(cwd.into());
            }
            v.push("--".into());
        } else {
            if !cwd.is_empty() {
                match cwd_flag {
                    Cwd::None => {}
                    Cwd::Eq(f) => v.push(format!("{f}{cwd}")),
                    Cwd::Sep(f) => {
                        v.push((*f).into());
                        v.push(cwd.into());
                    }
                }
            }
            match exec {
                Exec::DashDash => v.push("--".into()),
                Exec::E => v.push("-e".into()),
                Exec::X => v.push("-x".into()),
                Exec::Positional | Exec::WeztermStart => {}
            }
        }
        v.push("/bin/sh".into());
        v.push(run.into());
        v
    }

    let script = write_launch_script(&login_shell(), command)?;
    let run = script.to_string_lossy().to_string();
    // $TERMINAL 里的终端只在表里有（知道它的 -e 语义）时才优先
    let preferred = std::env::var("TERMINAL").ok().and_then(|t| {
        let base = PathBuf::from(&t).file_name()?.to_string_lossy().to_string();
        TABLE.iter().position(|(name, _, _)| *name == base)
    });
    let order = preferred.into_iter().chain((0..TABLE.len()).filter(|i| Some(*i) != preferred));
    let mut tried: Vec<&str> = Vec::new();
    let mut errs: Vec<String> = Vec::new();
    for i in order {
        let spec = &TABLE[i];
        let mut c = Command::new(spec.0);
        c.args(argv(cwd, &run, spec));
        match spawn_and_probe(c, spec.0, Duration::from_millis(1500)) {
            Ok(()) => return Ok(()),
            Err(e) => {
                tried.push(spec.0);
                // 没装（ENOENT）不值得报；起来了又非 0 退出（无 DISPLAY、参数不认）才记下
                if !e.contains("os error 2") {
                    errs.push(e);
                }
            }
        }
    }
    let _ = fs::remove_file(&script);
    Err(format!(
        "找不到可用终端（试过 {}；可设 $TERMINAL 指定）{}",
        tried.join(" / "),
        if errs.is_empty() { String::new() } else { format!("：{}", errs.join("；")) }
    ))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            init_core_root(app);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            resolve_cwd,
            open_in,
            check_open,
            list_recent_sessions,
            list_available_providers,
            get_handoff_history,
            prepare_codex_import,
            confirm_codex_import,
            codex_import_status,
            open_codex_thread,
            launch_terminal,
            list_terminals,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{
        codex_confirm_args, codex_open_command, codex_prepare_args, codex_status_args,
        codex_thread_url, is_plan_id, is_uuid, parse_cli_json, run_open_command, OpenPlatform,
    };

    #[test]
    fn validates_structured_codex_identifiers() {
        assert!(is_uuid("01a07ebd-3f50-7fb0-8d63-57ab8bf44869"));
        assert!(!is_uuid("../../threads/unsafe"));
        assert!(is_plan_id(&"a".repeat(64)));
        assert!(!is_plan_id(&"A".repeat(64)));
        assert!(!is_plan_id("../plan"));
    }

    #[test]
    fn constructs_only_a_codex_thread_deep_link() {
        assert_eq!(
            codex_thread_url("01a07ebd-3f50-7fb0-8d63-57ab8bf44869").unwrap(),
            "codex://threads/01a07ebd-3f50-7fb0-8d63-57ab8bf44869",
        );
        assert!(codex_thread_url("https://example.com").is_err());
    }

    #[test]
    fn preserves_special_cwd_as_one_cli_argument() {
        let cwd = "/tmp/project with 'quotes' ; $(not-a-shell)";
        let args =
            codex_prepare_args("11111111-1111-4111-8111-111111111111", cwd).unwrap();
        assert_eq!(args[4], cwd);
        assert_eq!(args.iter().filter(|arg| arg.as_str() == cwd).count(), 1);
        assert_eq!(
            args,
            vec![
                "import-codex",
                "prepare",
                "11111111-1111-4111-8111-111111111111",
                "--cwd",
                cwd,
                "--desktop-project",
                "--experimental",
                "--json",
            ]
        );
        assert!(codex_prepare_args("../bad", cwd).is_err());
        assert!(
            codex_prepare_args("11111111-1111-4111-8111-111111111111", "relative").is_err()
        );
    }

    #[test]
    fn confirmation_and_status_argv_cannot_accept_traversal() {
        let plan_id = "a".repeat(64);
        assert_eq!(
            codex_confirm_args(&plan_id).unwrap(),
            vec![
                "import-codex",
                "confirm",
                &plan_id,
                "--experimental",
                "--json"
            ]
        );
        assert_eq!(
            codex_status_args(&plan_id).unwrap(),
            vec!["import-codex", "status", &plan_id, "--json"]
        );
        assert!(codex_confirm_args("../plan").is_err());
        assert!(codex_status_args("../plan").is_err());
    }

    #[test]
    fn builds_fixed_deep_link_commands_for_all_desktop_platforms() {
        let id = "01a07ebd-3f50-7fb0-8d63-57ab8bf44869";
        let url = format!("codex://threads/{id}");
        assert_eq!(
            codex_open_command(id, OpenPlatform::MacOs).unwrap(),
            ("open".into(), vec![url.clone()])
        );
        assert_eq!(
            codex_open_command(id, OpenPlatform::Windows).unwrap(),
            (
                "cmd.exe".into(),
                vec!["/C".into(), "start".into(), "".into(), url.clone()]
            )
        );
        assert_eq!(
            codex_open_command(id, OpenPlatform::Linux).unwrap(),
            ("xdg-open".into(), vec![url])
        );
    }

    #[test]
    fn missing_desktop_opener_is_a_visible_error() {
        let error = run_open_command("watch-command-that-does-not-exist", &[]).unwrap_err();
        assert!(error.contains("启动 Codex Desktop 失败"));
    }

    #[test]
    fn parses_single_line_cli_json_even_when_command_reports_uncertain() {
        let value = parse_cli_json(
            "diagnostic\n{\"ok\":false,\"status\":\"uncertain\"}\n",
            "details stay on stderr",
            2,
        )
        .unwrap();
        assert_eq!(value["status"], "uncertain");
        assert!(parse_cli_json("", "failure", 1).unwrap_err().contains("failure"));
    }
}
