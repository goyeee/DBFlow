## 项目简介

DBFlow 是一个数据库结构与数据同步工具（类 Navicat），基于 Tauri 2 的桌面应用。

- **前端**：React 19 + TypeScript + Ant Design 6 + Vite + Zustand
- **后端**：Rust（`src-tauri/`），Tauri 2 框架
- **包管理**：pnpm

## 注意事项

有疑问时记得询问，不要私自做决定

不要私自commit，被要求提交时写commit内容不要包含任何Ai工具名称，允许后才可push

## 常用命令

```bash
pnpm dev            # 前端 dev server（localhost:1420）
pnpm tauri dev      # 启动桌面客户端开发模式
pnpm build          # 前端构建（tsc + vite build）
pnpm test           # 运行 vitest 测试
pnpm tauri build    # 打完整安装包
```

## Git 工作流

1. **不要直接在 main 分支上开发**。从 main 切出 feature 分支（如 `feature/xxx`），改完合并回 main。
2. 本仓库使用 git worktree 进行并行开发，注意当前工作目录属于哪个分支。
3. 提交信息使用中文，格式参考：`feat:xxx` / `fix:xxx` / `chore:xxx`。
4. 提交前确保 `pnpm test` 通过。

## 版本号与发版（重要）

版本号存在于 **4 个位置**，发布时必须一致：

- `package.json`
- `src-tauri/Cargo.toml`
- `src-tauri/Cargo.lock`（`name = "dbflow"` 条目）
- `src-tauri/tauri.conf.json`

**禁止手动逐个修改这些文件来发版**，统一走自动化流程：

```bash
pnpm version <版本号>   # 例：pnpm version 0.2.3 或 0.2.3-beta.1
```

该命令会自动：更新 package.json → 运行 `scripts/sync-version.mjs` 同步其余三个文件 → 自动 commit → 打 tag（`v<版本号>`）→ 推送到远程 → 触发 GitHub Actions（`.github/workflows/release.yml`）构建产物。

注意事项：

- 打 tag 前确认远程没有同名 tag：`git tag -l` / `git ls-remote --tags origin`
- 版本号格式为 `x.y.z` 或 `x.y.z-beta.N`（历史上曾误拼为 `beat`，已废弃，勿再用）
- 构建进度可用 `gh run watch` 查看（需先 `gh auth login`）
- Release Notes 由 workflow 的 `notes` job 自动生成（取 tag 之间的提交记录）并自动发布，无需手写；
  因此**发版前的功能提交要写清楚提交信息**，它就是用户看到的更新日志

## 文档同步

以下情况下必须同步更新文档：

- **README.md**：新增/修改了用户可感知的功能、界面交互、支持的数据库类型、构建方式时，更新 README 中对应描述。
- **产品文档**（如已建立）：涉及功能行为、操作流程的变更需同步更新，保持文档与实际行为一致。
- 文档与代码不符时，以代码实际行为为准修正文档。

## 代码规范

- 前端遵循项目现有 React + antd 风格；组件内注释密度与现有代码保持一致。
- Rust 代码位于 `src-tauri/src/`，遵循 Rust 标准惯例。
- 新增业务逻辑需配套测试（参考 `src/stores/*.test.ts` 的写法）。
- 不要引入新的重型依赖，除非确有必要。

