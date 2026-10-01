# Release 启动缓慢调查

## 范围与结论

调查输入为用户提供的 Windows release 日志：桌面端 `0.20.0`、Harness `0.2.0-rc.2`、Node `25.5.0`，活动档案 `core-020`，含 24 个插件。

**尚未复现或确认超过 82 秒的启动延迟根因。** 本次改动修复的是健康检查丢失网络诊断的问题，不宣称已解决该延迟，不修改启动等待、重试、插件配置或用户数据。

## 时间线

| 日志时间 / 阶段 | 观察 |
| --- | --- |
| 16:28:13.912 | 开始停止上一轮进程 |
| 16:28:17.202 | 开始解析本轮运行时 |
| `stale_sweep_and_port` | 1282 ms |
| `prepare_active_runtime` | 3397 ms |
| 16:28:22.735 | 开始派生 Node |
| `spawn_probe_and_register` | 2527 ms，包含固定 2500 ms 存活探测 |
| 16:28:25.263 | 登记进程成功；启动编排合计 8137 ms，不代表 HTTP 已就绪 |
| 16:28:27.461–16:29:47.162 | 首页请求持续报 `HARNESS_BOOT_MANIFEST_REQUEST_FAILED`，覆盖进程登记后的约 82 秒 |
| 16:29:39.433 | 子进程日志出现 `native-attach: drop ... owner process gone`；不足以证明其阻塞启动 |

原错误只有 `error sending request for url (http://127.0.0.1:3080/)`。该文本没有底层原因，无法判断端口未监听、连接失败还是已经连接后等待响应超时。首页请求尚未成功，不应把这段日志解释为客户端 bundle 解析失败。

## 已执行的隔离对比

下载同版本 Windows 核心发行包和 `billion-context@0.1.179` 的已发布产物，不构建插件，不使用用户档案。Node 为 `25.5.0`。通过临时端口启动真实 CLI，所有数据目录重定向到工作树内，包括 `DSH_HOME`、`DSH_E2E_HOME`、`HOME`、`USERPROFILE`、AppData 与 XDG 路径。连续排空 stdout/stderr，以启动 URL 中的 token 完成真实 cookie 握手，断言 HTTP 200 且页面包含 `__DSH_BOOT__`；10 秒未就绪即失败。只停止本次派生的进程。

| 配置 | 实测首页就绪 |
| --- | --- |
| 默认 web 档案，仅 base 与 web-app bundles | 1976 ms |
| 同配置重复启动 | 2008 ms |
| 加入同版本 billion-context bundle，`BILLION_CONTEXT_PLUGIN=0` 禁用其代理自启动 | 2047 ms |

这些结果只说明上述配置未复现问题。第三组不能排除插件代理自启动、其他 23 个插件、用户配置、旧进程退出竞态、冷文件缓存或机器环境的影响；不能据此认定 billion-context 无关或有问题。隔离探针也没有覆盖完整桌面端编排。调查临时产物不随 PR 提交。

## 本次修复与回归

[首页探测](<../../src-tauri/src/service/workflow/health.rs>) 的后端日志增加 `elapsed_ms`、`connect`、`timeout` 和 reqwest 的底层错误链；返回错误在原前缀下保留类型标记和底层原因，不包含耗时。前端以失败原因变化判断启动进展，因此不能把逐次变化的耗时放进返回错误。错误前缀、5 秒请求超时、就绪判定和前端重试语义保持不变。

回归直接调用生产首页探测，对真实回环 socket 检查：

- 没有监听者：连接错误，非超时，包含底层原因；重复探测返回相同错误，不含耗时。
- 接受连接但不响应：响应超时，非连接错误，包含底层原因，不含耗时。
- HTTP 200 启动页继续解析客户端入口；HTTP 503 继续返回原就绪错误。

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --all-features --locked service::workflow::health::tests -- --nocapture
cargo check --manifest-path src-tauri/Cargo.toml --all-targets --all-features --locked
```

## 继续定位需要的证据

使用包含此诊断改动的版本，在同一 `core-020` 档案重新触发慢启动，导出从停止旧进程到首次就绪或超时的完整桌面日志与服务日志。请同时记录冷启动/再次启动是否有差异，并提供脱敏后的插件名称、版本和档案 bundle/patch 清单；不需要凭据或会话内容。

- `connect=true, timeout=false`：优先检查启动时实际监听地址/端口、进程退出情况与开始监听前的加载路径。
- `connect=false, timeout=true`：结合耗时与底层错误区分已连接但不响应和其他请求阶段超时，再采集 Node 启动 CPU/文件 I/O 证据。
- HTTP 状态错误：请求已拿到响应，应改查鉴权或启动页服务状态，而非继续按网络连接问题处理。

不要在未经复现验证的情况下删除插件、放宽就绪门槛、扩大重试时限或关闭 Windows 隐藏控制台机制。
