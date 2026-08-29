# 桌面发布 / 签名链路设计（file-editor）

> **范围**: 本文档描述 file-editor 项目自身的发布链路设计与实现，独立成文。
> **覆盖**: GitHub Actions 全部 workflow、分发构建脚本、electron-builder 配置、签名/信任模型、完整性治理。
> **版本**: 2026-08-30 · 配套实现：`.github/workflows/`（5 个 workflow）+ `scripts/dist.mjs` + `scripts/verify-artifacts.mjs`

---

## 0. 一句话结论

发布链路是一条 **「验证 (CI) → 编排 (Release) → 平台构建 (mac/win/linux) → 分发 (GH Release assets)」** 的四层流水线：CI 层纯验证、零产物；Release 层由 `release.published` 触发、解析版本号后三平台并行；mac 无证书时自动降级 **ad-hoc 签名**（Gatekeeper 从「已损坏」降级为「右键打开」）、win 无证书时产出未签名安装包、linux 无需签名。全链路配套 **SHA256SUMS 校验文件 + OIDC 构建来源证明（attestation）**，在零预算、无正式代码签名的前提下给出可验证的完整性锚点。

---

## 1. 全景架构

```
┌────────────────────────────────────────────────────────────────────┐
│ L0  验证层   (.github/workflows/ci.yml)                              │
│      install(frozen) / tsc+eslint / electron-vite build 冒烟         │
│      纯验证、零产物、不触发发布                                        │
└────────────────────────────────────────────────────────────────────┘
                        │  release.published（打 tag 后发 Release 才触发）
                        │  workflow_dispatch（手动 dry-run，只产 artifact）
                        ▼
┌────────────────────────────────────────────────────────────────────┐
│ L1  发布编排层  (.github/workflows/release-desktop.yml)              │
│      resolve-version ──┬──▶ build-mac     (workflow_call + inherit) │
│                        ├──▶ build-windows (workflow_call + inherit) │
│                        └──▶ build-linux   (workflow_call + inherit) │
└────────────────────────────────────────────────────────────────────┘
         │                    │                    │
         ▼                    ▼                    ▼
┌──────────────────┐ ┌──────────────────┐ ┌──────────────────────┐
│ L2a macOS          │ │ L2b Windows       │ │ L2c Linux             │
│ build-mac.yml     │ │ build-windows.yml │ │ build-linux.yml       │
│  matrix:          │ │  单 job 双架构     │ │  单 job 双架构         │
│   arm64→macos-latest│ │  dist:win (NSIS) │ │  dist:linux           │
│   x64→macos-15-intel│ │  CSC_LINK 通道    │ │  无证书需求            │
│  证书→临时 keychain │ │  无证书→未签名    │ │  maintainer 注入       │
│  无证书→ad-hoc     │ └──────────────────┘ └──────────────────────┘
└──────────────────┘
         │                    │                    │
         ▼                    ▼                    ▼
┌────────────────────────────────────────────────────────────────────┐
│ L3  分发层                                                          │
│     每平台: verify-artifacts.mjs 生成 SHA256SUMS.{mac,win,linux}    │
│     attest-build-provenance（OIDC 构建来源证明）                      │
│     release.published 时 attach 到触发 release（softprops/action-gh-release）│
│     产物: dmg×2 / exe×2 / AppImage×2 + deb×2 / SHA256SUMS×3          │
└────────────────────────────────────────────────────────────────────┘
```

**文件与职责映射**：

| 文件 | 层 | 职责 |
|---|---|---|
| `.github/workflows/ci.yml` | L0 | 日常验证（frozen install + check + build 冒烟） |
| `.github/workflows/release-desktop.yml` | L1 | 发布编排器（版本解析 + 三平台扇出） |
| `.github/workflows/build-mac.yml` | L2a | macOS 构建（架构矩阵 + 证书导入 + 汇总 job） |
| `.github/workflows/build-windows.yml` | L2b | Windows 构建（NSIS 双架构） |
| `.github/workflows/build-linux.yml` | L2c | Linux 构建（AppImage + deb 双架构） |
| `scripts/dist.mjs` | L2 | 统一分发构建包装器（`--version` 注入 / ad-hoc 降级） |
| `scripts/verify-artifacts.mjs` | L3 | 产物命名校验 + SHA256SUMS 生成 |
| `electron-builder.yml` | L2 | 三端打包配置（签名开关所在） |

---

## 2. L0 验证层（ci.yml）

单 job `verify`，ubuntu-latest：

| Step | 内容 | 失败语义 |
|---|---|---|
| pnpm install --frozen-lockfile | 锁文件与 package.json 严格一致 | 锁文件漂移即红（fail-closed） |
| pnpm check | tsc --noEmit + eslint 全量 | 代码质量门禁 |
| pnpm build | electron-vite 三进程构建冒烟 | 构建链路断裂即红 |

**触发策略**：
- `push` 到默认分支 + 任意 `pull_request`；`paths-ignore` 排除 `docs/**`、`README*`、`**/*.md`（文档改动不排队）。
- `concurrency` 按 ref 分组 + `cancel-in-progress: true`：同一分支连续 push 只保留最新一次。
- `permissions: contents: read`（最小权限）。

设计要点：**本层永远不产 artifact、不碰发布**。发布是显式动作（发 Release 或手动 dispatch），日常提交不会被误发布。

---

## 3. L1 发布编排层（release-desktop.yml）

### 3.1 触发与权限

| 触发 | 语义 |
|---|---|
| `release.types: [published]` | **打 tag 不触发**；必须「打 tag + 创建 Release + 点 Publish」才触发，产物 attach 到该 release |
| `workflow_dispatch` | 手动 dry-run：填 semver 版本号，三平台冒烟打包，产物只作为 workflow artifact 存档，**不碰任何 release** |

- `permissions: contents: write, id-token: write`（attach assets + attestation 需要）。
- `concurrency` 按 release tag / ref 分组 + `cancel-in-progress: false`：**同一 release 的发布不互相取消**（发布中断是危险动作）。

### 3.2 版本解析（resolve-version）

单一职责 job：release 模式取 `github.event.release.tag_name`，dry-run 取手动输入；统一 strip `v` 前缀写 `GITHUB_OUTPUT.version`，同时输出原始 `tag` 供 attach 用。**版本号是全链路唯一传递参数**，三平台各自从 `inputs.version` 消费，杜绝各端自行推断。

### 3.3 扇出

```yaml
build-mac:      needs: resolve-version, uses: ./.github/workflows/build-mac.yml
build-windows:  needs: resolve-version, uses: ./.github/workflows/build-windows.yml
build-linux:    needs: resolve-version, uses: ./.github/workflows/build-linux.yml
```

- 三平台用 `workflow_call` 三个独立 job 而非 matrix：**win/mac/linux 构建步骤差异大**（证书机制、runner、产物格式完全不同），matrix 强行合并只会让条件分支爆炸。
- `secrets: inherit`：子 workflow 直接读取 GitHub Secrets（`${{ secrets.MAC_CERTIFICATE_BASE64 }}` 等），无需在 `on.workflow_call.secrets` 里逐一声明映射。
- `upload-to-release: ${{ github.event_name == 'release' }}` 传给各平台 workflow：release 事件才 attach，dry-run 只留 artifact —— 同一流水线双模式。

---

## 4. L2 平台构建层

**产物目录规划**（`scripts/dist.mjs` 按平台循环调用 electron-builder，注入 `-c.directories.output=dist/<platform>`；`directories.output` 是全局配置，多平台同批构建会混入同一目录，故拆成每平台一次调用）：

```
dist/
├── mac/        # *.dmg（x64 + arm64）+ SHA256SUMS.mac（checksums job 汇总生成于 artifacts/ 后 attach）
├── win/        # *.exe（NSIS）+ SHA256SUMS.win
└── linux/      # *.AppImage + *.deb + SHA256SUMS.linux
```

- `out/`（electron-vite 中间产物）与 `dist/`（安装包）分层：`pnpm clean` 分别清理，CI 只消费 `dist/<platform>/`。
- 各平台 workflow 的 verify 用 `--dir dist/<platform> --out dist/<platform>/SHA256SUMS.<platform>`，上传/attach glob 同步指向子目录。

### 4.1 macOS（build-mac.yml）

**架构矩阵（双 job 并行）**：

| 架构 | runner | 理由 |
|---|---|---|
| arm64 | macos-latest | Apple Silicon 原生 |
| x64 | macos-15-intel | Intel 原生，避免在 arm64 runner 上交叉 |

`fail-fast: false`：一个架构失败不拖累另一个。

**签名路径**：
- 有 `MAC_CERTIFICATE_BASE64`：导入临时 keychain（`security create-keychain` + `set-key-partition-list`），通过 `CSC_LINK`/`CSC_KEY_PASSWORD` 交给 electron-builder 正式签名；配齐 `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID` 三件套可走公证。
- 无证书：`CSC_LINK` 为空 → `scripts/dist.mjs` 自动附加 `-c.mac.identity=- -c.mac.hardenedRuntime=false`（ad-hoc，详见 §5）。

**产物流转（构建/汇总分离）**：
1. `build` job（每个架构）：`pnpm dist:mac:<arch> --version <v>` → attestation → upload artifact（`file-editor-mac-<arch>`）；
2. `checksums` job（needs build）：download 双架构 dmg → `verify-artifacts.mjs` 汇总生成一份 `SHA256SUMS.mac` → upload artifact + 条件 attach release。

**为什么汇总 job**：双架构并行时若各自写 `SHA256SUMS.mac` 会同名互相覆盖（attach 与 artifact 都冲突）；由汇总 job 合并两份 dmg 生成一份校验文件，release 页面每个 mac 产物对应一份完整校验，语义干净。

### 4.2 Windows（build-windows.yml）

- 单 job 双架构（x64 + arm64，NSIS 安装包），`dist:win` 默认行为。
- 签名：有 `WIN_CERTIFICATE_BASE64` → `CSC_LINK` 通道（`data:application/x-pkcs12;base64,...`）→ electron-builder 自动调 signtool；无证书 → 未签名安装包（SmartScreen 提示未知发布者，属预期降级）。
- 完整性：`verify-artifacts.mjs --platform win --dir dist/win --out dist/win/SHA256SUMS.win` + attestation；条件 attach（`dist/win/*.exe` + `dist/win/SHA256SUMS.win`）。

### 4.3 Linux（build-linux.yml）

- 单 job 双架构（AppImage + deb 每架构一个）。
- **无代码签名**（Linux 包格式信任模型见 §5 表格）；deb `maintainer` 由 `dist.mjs` 注入（默认 `sounds-great-ai <rouroumaibing@qq.com>`，与 `electron-builder.yml` 兜底一致）。
- 完整性：`verify-artifacts.mjs --platform linux --dir dist/linux --out dist/linux/SHA256SUMS.linux` + attestation；条件 attach（`dist/linux/*.AppImage` + `*.deb` + `SHA256SUMS.linux`）。

---

## 5. 签名与信任模型（核心专题）

### 5.1 决策总览

| 平台 | 有证书时 | 无证书时（当前默认） | 用户侧效果 |
|---|---|---|---|
| macOS | 正式 Developer ID 签名 + 可选公证 | **ad-hoc 签名**（`identity=-` + `hardenedRuntime=false`） | Gatekeeper 显示「未识别开发者」→ **右键 → 打开** 首次放行；非「已损坏」 |
| Windows | signtool 代码签名 | 未签名安装包 | SmartScreen 显示「未知发布者」；下载可能二次警告 |
| Linux | —（无需签名） | — | 发行版包管理器正常安装 |
| 完整性 | — | `SHA256SUMS` + OIDC attestation（每平台） | 用户可校验下载物与构建来源 |

### 5.2 为什么 ad-hoc（mac 无证书路径）

1. **目的不是安全签名**：ad-hoc 没有身份背书，人人可做。它的唯一作用是让 Gatekeeper 把 app 从「已损坏」（完全无法打开）降级为「未识别开发者」（右键 → 打开 可放行）—— 本质上是一个「免损坏标记」。
2. **必须同时关 hardenedRuntime**：`hardenedRuntime` 与 ad-hoc 不兼容 —— 未公证的 hardened-runtime app 在 Gatekeeper 下无法通过右键放行（会直接拒绝）。electron-builder 中 `hardenedRuntime` 的消费逻辑是 `!== false` 严格比较（macPackager），CLI 传 `-c.mac.hardenedRuntime=false` 会被 config 校验阶段（AJV `coerceTypes: true`）转成 boolean `false` 后生效。
3. **零成本**：不买证书、不配公证，本地与 CI 行为一致（`CSC_IDENTITY_AUTO_DISCOVERY=false` 时跳过正式签名探测）。

### 5.3 完整性治理（零预算信任补位）

| 机制 | 做什么 | 免费？ |
|---|---|---|
| `SHA256SUMS.{mac,win,linux}` | 每平台产物 hash 清单（`shasum -a 256 -c` 可验），随产物一起 attach | 是（自研脚本） |
| `actions/attest-build-provenance` | 基于 OIDC 的构建来源证明，GitHub 签发并绑定到 release/commit，声明「此产物由本仓库 CI 构建」 | 是（GitHub 原生） |

**这层是「无正式签名」前提下最重要的信任锚**：正式代码签名提供「发布者身份」，而 attestation + checksum 提供「来源与完整性」——用户拿到 dmg/exe 后：① 对 SHA256SUMS 验 hash（防传输损坏/篡改）；② 看 release 页面的 attestations（防冒充分发）。两者都无需花一分钱。

### 5.4 威胁模型（诚实评价）

| 威胁 | 能防吗 | 说明 |
|---|---|---|
| 打包 bug 导致 bundle 损坏 | ✅ 部分 | ad-hoc 让 Gatekeeper 报「未识别开发者」而非「已损坏」；SHA256SUMS 可进一步自查 |
| 恶意第三方篡改安装包 | ❌ 不能 | ad-hoc/未签名无身份，攻击者可重签；需要用户配合 SHA256SUMS 校验 |
| 冒充官方分发 | ⚠️ 部分 | attestation 绑定仓库 + release 页 URL 可信，但用户需点进官方 repo 而非镜像站 |
| 供应链（依赖投毒） | ❌ 不在本层 | 无 SBOM；依赖锁定到 pnpm-lock（frozen install）但无运行时 SBOM |
| 传输损坏 | ✅ 能 | SHA256SUMS 精确校验 |

**结论**：信任根 = ① GitHub 官方 release 页面 URL；② attestation（构建来源）；③ 用户对 SHA256SUMS 的校验习惯。没有任何密码学「发布者身份」。

### 5.5 演进代价（若要补正式签名）

- **macOS**：Apple Developer 年费 → Developer ID 证书 → `CSC_LINK` secrets → 恢复 `hardenedRuntime` → notarytool 公证 + stapler（App Store Connect 凭据）。
- **Windows**：2023-06 起 CA/B Forum（ballot CSC-17）要求 OV/EV 私钥存 FIPS 140-2 L2+ 硬件、不可导出 —— 旧「.pfx 塞 GitHub Secrets」路径对 2023 年后签发的商业证书已不可行；需云端签名服务（Azure Trusted Signing、SSL.com eSigner 等）或自托管 runner 插 USB token。
- **附带收益**：只有正式签名后才能启用 electron-updater 自动更新（当前为手动下载重装模式）。

---

## 6. 版本链（贯穿全链路的唯一参数）

```
release tag (v0.2.0) 或 dispatch 输入 (0.2.0)
   │
   ├─ release-desktop.yml: resolve-version → strip 'v' → GITHUB_OUTPUT.version
   │
   ├─ build-mac.yml / build-windows.yml / build-linux.yml: inputs.version
   │     └─ pnpm dist:<platform> --version <v>
   │           └─ dist.mjs: -c.extraMetadata.version=<v>（注入 electron-builder，不改写 package.json）
   │                 └─ 产物命名（FileEditor-<v>-<arch>.dmg / FileEditor-Setup-<v>-<arch>.exe / ...）
   │
   └─ verify-artifacts.mjs: --version <v> → 校验每个产物文件名包含该版本号（防命名漂移）
```

**为什么不改写 package.json**：文本改写脆弱（字段结构变化会静默失配）。`-c.extraMetadata.version` 是 electron-builder 原生注入通道，运行时覆盖 `version` 字段，源文件零改动。

---

## 6.5 两种更新模式与版本锚定纪律

### 6.5.1 两种更新模式（Source / Desktop）

项目存在**两条正交的更新链路**，CI 已按此分离，本文档在此明确定义边界：

| 维度 | 源码更新模式（Source） | 桌面应用更新模式（Desktop） |
|---|---|---|
| 受众 | 开发者（本项目维护者） | 安装 dmg/exe 的终端用户 |
| 更新载体 | git 源码 + 依赖 + 构建产物 | 安装包 + SHA256SUMS |
| 标准动作 | `git pull` → `pnpm install` → `pnpm build` → 重启 | 下载新版安装包 → 替换旧版 |
| CI 对应 | L0 `ci.yml`（push/PR 纯验证，零产物） | L1 `release-desktop.yml`（release.published 分发 / dispatch dry-run） |
| 版本锚点 | git tag（源码级，无需建 Release） | Release tag（语义化 `vX.Y.Z`，必须建 Release 才分发） |
| 回滚 | `git checkout` 任意历史提交 | 下载 GitHub 历史 Release 安装包 |

**边界约定**：
- 源码模式与桌面模式共用**同一版本号**——`package.json version` 与 Release tag 必须对齐，禁止各自漂移。
- 打 tag 是源码模式的完整动作；**只有**「打 tag + 建 Release + 点 Publish」才进入桌面分发（§3.1 触发策略）。

### 6.5.2 版本锚定纪律（三条可验证约定）

1. **唯一事实来源 = git tag**：`package.json version`（无 `v` 前缀，如 `0.2.0`）必须与 Release tag（`v0.2.0`）对齐。发布前执行 `pnpm version <v>` 对齐后再打 tag；CI `resolve-version` 以 tag 为准（strip `v`），`extraMetadata` 运行时覆盖，不改写 package.json。
2. **源码模式推进即打 tag**：每完成一批可发布功能，`git tag vX.Y.Z`（可只打 tag 不建 Release；建 Release 才触发桌面分发）。tag 粒度 = CHANGELOG 段落粒度。
3. **CHANGELOG.md 维护**：每次打 tag 同步更新 `CHANGELOG.md`（`Unreleased` → 版本段落），记录 Added / Changed / Fixed；tag 与 CHANGELOG 段落一一对应，禁止无日志打 tag。

**验证 gate**：发布前对照检查——① `package.json version` == tag（去 `v`）；② CHANGELOG 存在且含该版本段落；③ 上次 tag 与 CHANGELOG 末尾版本一致。三条任一不满足则不发布。

---

## 7. 关键设计决策清单（trade-off 速览）

| # | 决策 | 选型 | 弃用方案 | 理由 |
|---|---|---|---|---|
| D1 | 发布触发 | `release.published` + dispatch 双模式 | push tag 即构建 | 打 tag 只算「预发布」，发 Release 才是「真发布」；dispatch 可 dry-run 产 artifact 不碰 release |
| D2 | 三平台结构 | workflow_call 三 job 扇出 + secrets: inherit | matrix 单 job | 平台构建步骤差异大；inherit 免去逐 secret 映射 |
| D3 | 版本注入 | `-c.extraMetadata.version`（CLI 注入） | node -e 改写 package.json | 规避文本改写脆弱性，源文件零改动 |
| D4 | mac 无证书签名 | ad-hoc（`identity=-` + `hardenedRuntime=false`） | 不签名 / 内置签名 | 让 Gatekeeper 从「已损坏」降级为「右键打开」；`hardenedRuntime` 必须同关否则右键也打不开 |
| D5 | 完整性治理 | SHA256SUMS + attest-build-provenance | 无 | 零预算下的信任补位：防传输损坏 + 构建来源证明 |
| D6 | 分发 | softprops/action-gh-release 条件 attach | electron-builder publish | release 事件 attach 到触发 release；dry-run 自动跳过 |
| D7 | mac 架构矩阵 | arm64→macos-latest，x64→macos-15-intel | 单 runner 双架构串行 | 双 job 并行提速；x64 原生 runner 避免交叉 |
| D8 | 校验文件组织 | 平台级 SHA256SUMS.{mac,win,linux}，mac 汇总 job 合并双架构 | 每架构各一份 | 避免双架构 job 同名覆盖；release 页面一份完整校验 |
| D9 | 签名凭据降级 | 缺凭据自动降级（mac→ad-hoc / win→未签名） | 缺凭据 fail | 开源零预算下保持发布可用，降级语义写进 workflow 注释 |

---

## 8. 简化取舍（本项目主动不做的部分）

以下能力**刻意不做**，理由随项目规模与产物形态给出：

| 不做 | 理由 |
|---|---|
| 自造 DMG（hdiutil 两阶段 + Finder 布局脚本） | electron-builder dmg 原生产出已够用；本项目 bundle 规模小（asar 打包，无运行时 node_modules 注入），不存在 dmgbuild 容量分配问题 |
| 自编译安装器（Inno Setup）与便携包 | NSIS 安装包即装即用；无需 tar.gz 归档加速（无 3 万+ 文件逐条目解压问题） |
| 跨平台资源泄漏断言 | 无 `extraResources` 注入（electron-builder.yml 仅 `files: out/**`），mac/win 产物无跨平台资源可泄漏 |
| 目录规模防腐化（warn/error 阈值 + 限时异常） | 项目文件数远低于阈值，收益不抵维护成本；若规模增长再引入 |
| SBOM 生成 | 依赖锁定由 `pnpm-lock.yaml` + frozen install 保证；运行时 SBOM 在正式分发规模化后再补 |

若未来 bundle 变大（引入原生模块、运行时注入 node_modules），D7 清单中「自造 DMG / tar.gz / 泄漏断言」需重新评估。

---

## 9. 发布 SOP（验收清单）

### 9.1 代码落地检查（本批次已完成）

- [x] 5 个 workflow 通过 js-yaml 语法校验
- [x] `dist.mjs --version` 注入与 ad-hoc 分支经 dry-run 实测（有/无证书两分支参数拼装正确）
- [x] `verify-artifacts.mjs` 正常路径（SHA256SUMS 生成）与失败路径（版本漂移 fail-closed）实测
- [x] 全仓旧 `release.yml` 引用同步更新（README 双语 / electron-builder.yml 注释 / 主设计文档 §CI）

### 9.2 dry-run 验收（workflow_dispatch，不发布）

1. Actions → `release-desktop` → Run workflow → 填 `version`（如 `0.0.0-dryrun`）。
2. 预期：resolve-version → 三平台并行构建 → 产物上传为 workflow artifact（`file-editor-mac-*` / `file-editor-windows` / `file-editor-linux`），**不产生任何 release**。
3. 核对每个 artifact 内：产物文件名带注入版本号 + SHA256SUMS 存在且可 `shasum -a 256 -c` 通过。

### 9.3 正式发布验收（release.published）

1. `git tag v0.2.0 && git push --tags` → GitHub 创建 Release（指向该 tag）→ 点 **Publish**。
2. 预期：三平台并行构建 → 产物 attach 到该 release。
3. **release 页面核对清单**（6+2 项）：
   - mac: `FileEditor-0.2.0-arm64.dmg`、`FileEditor-0.2.0-x64.dmg` + `SHA256SUMS.mac`
   - win: `FileEditor-Setup-0.2.0-x64.exe`、`FileEditor-Setup-0.2.0-arm64.exe` + `SHA256SUMS.win`
   - linux: `FileEditor-0.2.0-<arch>.AppImage` ×2、`FileEditor-0.2.0-<arch>.deb` ×2 + `SHA256SUMS.linux`
   - 每个产物旁有 attestation 标记（build provenance）
4. 安装验收：mac 右键 → 打开（ad-hoc 首次放行）；win 出现 SmartScreen 提示（未签名预期）；linux 安装器直接安装。

---

## 10. 已知限制与演进建议

1. **无发布者身份**：ad-hoc/未签名无密码学身份，任何能触达 release 流程的账号都可被钓鱼冒充 —— 已用 attestation + SHA256SUMS 缓解，正式分发规模化后应上正式签名（§5.5）。
2. **macos-15-intel 依赖 GitHub runner 供给**：若该标签被下线，x64 需要回退到 arm64 runner 交叉打包（纯 JS 项目无原生依赖，交叉可行，只是略慢）。
3. **公证缺失**：ad-hoc 仅免「已损坏」；若未来面向大众分发，公证 + hardened runtime + entitlements 是硬门槛。
4. **版本号链**：`resolve-version` 与 `dist.mjs` 的 semver 正则双重校验，但 tag 与 package.json 版本不一致时以 tag 为准（extraMetadata 覆盖）——版本对齐纪律见 §6.5.2（发布前 `pnpm version` 对齐 + CHANGELOG + 三条 gate）。
5. **attestation 只在 GitHub 内有效**：离开 GitHub 分发（如自建镜像）时 attestation 无法核验，需依赖 SHA256SUMS + 签名。

---

*本文档为 file-editor 项目独立设计文档，随发布链路代码变更联动更新（工作流、脚本、配置改动时同步修订 §2-§8）。*
