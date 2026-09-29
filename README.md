# DBFlow

类 Navicat 的数据库**结构同步 + 数据同步**桌面工具。当前已实现：连接管理、结构对比与同步、数据对比与同步。

## 功能

### 连接管理

- **连接管理**：新建/编辑/复制/删除 MySQL 连接，连接分组、颜色标签
- **安全存储**：密码存系统钥匙串（macOS Keychain / Windows Credential Manager），配置文件零明文
- **测试连接**：表单内一键测试，返回服务器版本与延迟，错误提示中文化
- **库/表树浏览**：连接 → 数据库 → 表 懒加载展开，双击表查看列结构（类型/主键/注释）
- **SSH 隧道**：经跳板机连接内网数据库，支持密码/私钥认证、主机指纹确认、隧道复用与空闲回收
- **Navicat 迁移**：自动扫描本机 Navicat 连接配置（含密码解密，支持 Navicat 11/12+），勾选批量导入
- **连接选择搜索**：同步等场景选择连接时支持关键字过滤，多连接下快速定位

### 结构同步（工具 → 结构同步）

- **三步流程**：选择源/目标库 → 对比结果 → 部署执行，交互参照 Navicat 结构同步
- **差异分析**：表（增/删）、列（类型/可空/默认值/自增/注释）、索引（增/删/变更）
- **结果树表**：按操作分组（要修改/要创建/要删除），勾选要同步的项，DROP 类危险操作默认不勾
- **DDL 比较**：选中表行双栏对照两端建表语句；部署脚本跟随选中行实时过滤
- **部署执行**：逐条执行、单条失败不中断，逐条反馈成功/失败与耗时
- **版本兼容**：对比引擎兼容 MySQL 5.6 与 8.x（information_schema 标准查询 + 跨版本归一化）

### 数据同步（工具 → 数据同步）

- **三步流程**：选择源/目标库 → 对比结果 → 部署执行，与结构同步交互一致
- **单/多目标**：支持一对一同步，也支持一对多批量分发
- **行级差异**：基于主键/唯一索引逐行比对增删改，无主键表自动置灰排除
- **对比范围**：可勾选参与对比的表，跳过无关表
- **部署执行**：生成 INSERT/UPDATE/DELETE 同步语句，逐表反馈执行结果
- **结果缓存**：对比结果按目标缓存，切换界面不重复拉取

## 技术栈

| 层 | 选型 |
|---|---|
| 框架 | Tauri 2 + Rust |
| 数据库驱动 | sqlx（MySQL，trait 抽象，预留 PG/SQL Server） |
| SSH | russh（纯 Rust，本地端口转发） |
| 前端 | React 19 + TypeScript + Ant Design 6 + zustand |

## 开发

```bash
# 依赖：Node 22+ / pnpm / Rust (rustup, stable ≥1.85) / Xcode CLT
pnpm install
pnpm tauri dev      # 开发模式
pnpm tauri build    # 产出安装包
```

### 测试

```bash
# 前端单元测试（结构/数据对比状态机 / 结果树构建 / 连接表单）
pnpm test

# 后端单元测试（Navicat 解密 / 配置读写 / 结构与数据对比引擎 / SQL 生成）
cd src-tauri && cargo test

# 端到端测试：先起 Docker 测试环境（mysql×2 + mysql5.6 + sshd 跳板），再：
docker compose -f docker/testenv/docker-compose.yml up -d
DBFLOW_E2E=1 cargo test --lib e2e -- --nocapture

# 钥匙串读写（会真实写一条测试密码再删除）
cargo test --lib -- --ignored
```

测试环境账号：

| 服务 | 地址 | 账号 |
|---|---|---|
| mysql-a（直连） | 127.0.0.1:3306 | root / dbflow-a-2026 |
| mysql-b（仅内网） | 跳板内 mysql-b:3306 | root / dbflow-b-2026 |
| mysql56（旧版本兼容） | 127.0.0.1:3307 | root / 123123 |
| sshd 跳板 | 127.0.0.1:2222 | dbjump / dbflow-jump-2026 |

`docker/testenv/demo-src.sql` / `demo-tgt.sql` 是一对预置演示库（db_demo），涵盖列类型/注释/精度、索引变更、引擎差异、整表增删等差异样本，手工演示结构同步时直接对两个环境各建一份即可。

## 结构

```
src/               React 前端（components / stores / api）
  components/compare/  结构同步弹窗（三步流程 / 差异树表 / SQL 高亮面板）
  components/datacmp/  数据同步弹窗（单/多目标 / 行级差异 / 部署）
src-tauri/src/
  commands/        Tauri command（connections / groups / explore / navicat / compare / datacmp）
  config/          connections.json 原子读写
  secret/          系统钥匙串封装（db:{id} / ssh:{id}）
  datasource/      LiveConnection trait + MySQL 实现（扩展多库只改这里）
  compare/         结构对比引擎（diff 纯函数）+ 同步 SQL 生成
  tunnel/          SSH 隧道（russh，引用计数 + 空闲回收）
  navicat/         配置扫描 + 密码解密（Blowfish / AES）
docker/testenv/    开发期测试环境
```

## 路线图

- [x] 连接管理
- [x] 结构对比与同步（表/列/索引差异分析、生成同步 SQL、勾选部署）
- [x] 数据对比与同步（行级差异分析、单/多目标分发、生成同步语句）
- [ ] PostgreSQL / SQL Server 支持

## License

见 [LICENSE](LICENSE)。
