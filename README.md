# DSH 实例管理器

一个只在本地运行的 Web 管理面板，用来创建、启动、打开和删除多个 **DeepSeek Harness (DSH)** 实例。

每个实例都拥有：

- 一个可自由选择的**实例根目录**，自动生成程序、数据、会话、插件、工作、日志子目录，且每个子目录都能单独改位置
- 独立的 `DSH_HOME`（会话、设置、登录凭据、存储）与独立的 web profile（插件）
- 可选的**桌面配置继承**：从 DSH Desktop 复制插件、API KEY、模型/权限配置
- 独立的端口、日志和无状态访问令牌

管理器本身不安装、不升级 DSH；它复用本机已安装的 DSH Desktop（自动搜索安装目录），并按需把桌面配置复制到实例自己的目录里。

## v1.1 新增

- **自动搜索 DSH 安装目录**：依次检查设置、`DSH_INSTALL_DIR` / `DSH_NODE_EXECUTABLE` 等环境变量、Windows 注册表卸载项、常见安装位置、`PATH`、开始菜单快捷方式。
- **DSH Desktop 作为核心配置**：新建实例时可以选择复制桌面的插件（bundle + `node_modules`）、API KEY 和配置层，都由用户勾选。
- **目录规划**：新建时显示全部目录，选择根目录后自动生成子目录；每个子目录都可以浏览或手填新位置。自定义的会话/插件目录会通过 Windows 目录联接（junction）映射回 DSH 的标准路径。

## 快速开始

要求：Windows 10/11、已安装 DSH Desktop。Node.js 20.11+ 不是必须的：`start.cmd` 会在 `PATH`、DSH 环境变量、注册表、`%LOCALAPPDATA%\Programs` 和常见安装目录中寻找 DSH 自带的 Node 运行时。

```bat
:: 双击 start.cmd，或在项目目录执行：
node server.js
```

浏览器会自动打开 `http://127.0.0.1:53800/`。端口被占用时管理器会自动尝试后面的端口，并在控制台打印实际地址。

同一个数据目录只允许一个管理器进程运行；重复启动会提示已经运行的管理器 PID。需要同时运行多个管理器时，请为它们设置不同的 `DSHM_DATA`。

常用参数：

```bat
node server.js --port 53900        :: 指定管理端口
node server.js --no-open           :: 不自动打开浏览器
node server.js --host 127.0.0.1    :: 默认只监听本机
```

按 `Ctrl+C` 退出管理器时，会同时停止它启动的所有 DSH 实例。

## 新建实例

1. 点击右上角 **新建实例**。
2. 填写实例名称。
3. 选择**实例根目录**（推荐新建一个空目录）。下面这些子目录会自动生成，并实时显示出来：

   | 目录 | 默认位置 | 说明 |
   |---|---|---|
   | 程序目录 | 自动检测的 DSH 安装目录 | 运行此实例所用的 DSH 程序；留空使用全局自动检测 |
   | 数据目录 | `<根目录>\home` | `DSH_HOME`：设置、凭据、存储、profile |
   | 会话目录 | `<数据目录>\sessions` | 会话历史 |
   | 插件目录 | `<数据目录>\profiles\web` | 插件 bundle 与 `node_modules` |
   | 工作目录 | `<根目录>\work` | 实例内 Agent 的默认工作区，可指向已有项目 |
   | 日志目录 | `<根目录>\logs` | 启动输出与错误日志 |

   修改根目录时，未手动编辑过的子目录会自动跟随；每个子目录都可以点 **浏览…** 单独指定，或点 **按根目录重算** 全部恢复默认。
4. 按需勾选 **从 DSH Desktop 复制配置**：
   - **复制插件**：把桌面 profile 的依赖、bundle 列表和 `node_modules` 复制到实例自己的插件目录（完整复制一份，实例之间完全独立）。
   - **复制 API KEY**：只复制 `.credentials.yaml` 的 `refs`（API KEY 引用），不复制桌面登录会话记录。
   - **复制配置层**：复制桌面的 `cordis.patch.yml`（模型 provider、权限预设、界面设置等）。
5. 端口留空会自动分配；也可以指定 1024–65535 的端口。
6. 创建后点击卡片上的 **启动**，就绪后点击 **打开** 进入该实例的 DSH Web UI。

> 桌面配置只有在 DSH Desktop 至少启动过一次、存在 `profiles/desktop` 时才可用。页面上会显示找到了几个插件、几个 API KEY；找不到时可以在设置里指定桌面配置目录。

## 桌面配置继承

管理器读取的桌面配置位于 `$DSH_HOME/profiles/desktop`，其中 `$DSH_HOME` 默认是 `%USERPROFILE%\.dsh`：

| 内容 | 来源 | 复制方式 |
|---|---|---|
| 插件 | `profiles/desktop/package.json` 的 `dependencies` 与 `dsh.profile.bundles` | 合并进实例 `profiles/web/package.json`，并复制 `node_modules`、`pnpm-lock.yaml` |
| 配置 | `profiles/desktop/cordis.patch.yml`（若存在，也包括 `$DSH_HOME/cordis.patch.yml`） | 写入实例 profile / 实例 home 的配置层 |
| API KEY | `$DSH_HOME/.credentials.yaml` 的 `refs` | 合并进实例自己的 `.credentials.yaml` |

规则：

- 只复制用户勾选的内容；没有勾选的不会被复制。
- 复制是一次性的快照。之后桌面新增/升级插件不会自动同步到实例，需要在实例详情里点 **从桌面同步**（先停止实例）。
- 同步不会覆盖实例中已有的插件文件与 API KEY，只补充缺失项；配置层会按当前桌面内容更新。
- 实例的凭据与桌面从此相互独立，轮换 API KEY 时分别更新即可。
- 复制插件需要能调用到 `dsh` 启动器（用于初始化实例 profile）。如果自动检测失败，请在设置中指定 DSH 安装目录。

## 目录与隔离

实例启动时执行：

```text
cwd            = 工作目录
DSH_HOME       = 数据目录
DSH_AGENTS_HOME= <数据目录>/agents
dsh --profile web --port <独立端口> --no-open
```

自定义子目录如何生效：

- **数据目录**直接通过 `DSH_HOME` 指定，可以放在任意位置。
- **会话目录**、**插件目录**若不在 `<数据目录>\sessions`、`<数据目录>\profiles\web`，管理器会在 DSH 的标准路径上创建 **目录联接（junction）** 指向你选择的位置。DSH 仍然按标准路径读写，但实际文件落在自定义目录中。
- 目录联接由 Node 直接创建，无需管理员权限；创建前会先迁移标准路径下已有的文件。
- 工作目录、日志目录、程序目录直接按配置使用。

启动子进程前会清除继承来的 `DSH_*` 环境变量，避免把桌面端或其他实例的配置带进去。因此每个实例的会话、设置、凭据、插件、存储都是独立的。一个实例中安装/升级/删除插件，不会影响桌面或其他实例。

> 说明：这是“DSH 配置与工作区”级别的隔离，不是 Windows 账户级或虚拟机级隔离。DSH 的 shell 工具仍然遵循该实例自身的文件策略；如果需要强隔离，请配合 DSH 沙箱或不同系统账户使用。

## 删除实例

- 停止实例并删除管理器记录。
- 勾选“同时删除实例数据”时：
  - 若实例根目录位于管理器的 `data` 目录内（默认情况），会删除整个根目录；
  - 若根目录是用户自定义位置（例如 `D:\DSH\我的实例`），则**不会删除**，页面会提示保留路径，方便手动清理。
- **永远不会删除工作目录中的项目文件**（工作目录默认在根目录下，若自定义到项目目录更不会被删除）。

## 自动检测 DSH 安装

管理器按以下顺序查找 `dsh` 启动器，并在界面上显示来源：

1. 设置中保存的“DSH 命令路径” / “DSH 安装目录”
2. 环境变量 `DSHM_DSH_INSTALL_DIR`、`DSH_INSTALL_DIR`、`DSH_NODE_EXECUTABLE`、`DSHM_DSH_COMMAND`、`DSH_CLI`
3. Windows 注册表卸载项中的 `InstallLocation` / `DisplayIcon`
4. 常见安装位置：`%LOCALAPPDATA%\Programs\DeepSeek Harness`、`%ProgramFiles%\DeepSeek Harness`、`C:\Soft\DSH`、其他磁盘的 `Soft\DSH` 等，以及 `%LOCALAPPDATA%\Programs` 下的所有应用目录
5. `PATH` 中的 `dsh`
6. 开始菜单 / 桌面快捷方式指向的程序

安装目录标准结构：

```text
<安装目录>\resources\runtime\cli\bin\dsh.cmd
```

检测结果会识别 env 里指向 `app.asar` 内部的 `DSH_INSTALL_DIR`，并还原出真正的安装根目录。

## 复制到其他 Windows 机器

- **只复用管理器**：关闭管理器后复制整个项目文件夹（至少复制除 `data/` 外的一切），到新机器双击 `start.cmd`。管理器会自动搜索新机器上的 DSH 安装目录；如未找到，在设置中指定。
- **连同实例迁移**：`data/config.json` 和实例中保存的是旧机器的绝对路径。迁移后请在每个实例的“编辑”里重新选择根目录/子目录，或在新机器上重新创建实例。磁盘盘符变化会导致路径失效。
- **不要直接复制正在运行的 `data/manager.lock`**：管理器用主机名 + PID 识别过期锁，通常会自动清理，但关闭管理器后再复制更稳妥。
- 自定义根目录里的实例数据（会话、插件、凭据）可以整体拷走，只要在新机器上把实例的目录规划重新指向它。

## 目录结构

```text
dsh-instance-manager/
├─ server.js              HTTP 服务、API、静态页面
├─ lib/
│  ├─ manager.js          实例生命周期、日志、端口、启动就绪检测
│  ├─ layout.js           目录规划、校验、junction 落地
│  ├─ desktop.js          桌面 profile 检查与插件/配置/API KEY 复制
│  ├─ dsh.js              DSH 安装目录检测、环境构造、进程树停止
│  ├─ store.js            配置与实例元数据持久化（v2，自动迁移 v1）
│  └─ util.js             文件/JSON/日志/复制/目录联接工具
├─ public/
│  ├─ index.html          管理界面
│  ├─ app.js              前端交互
│  ├─ style.css           样式
│  └─ favicon.svg
├─ test/
│  ├─ unit.test.js        目录规划、桌面配置解析与复制、检测、迁移测试
│  └─ smoke.test.js       端到端冒烟测试
├─ data/                  运行时生成
│  ├─ config.json
│  └─ instances/<id>/...
├─ start.cmd
└─ start.sh
```

`data/config.json` 只保存管理器设置和实例元数据（名称、目录规划、端口等），不保存 DSH 访问令牌，也不保存 API KEY 值。实例令牌来自 DSH 启动输出，仅保存在管理器内存中；管理器重启后，DSH 会打印新的令牌。

## 插件安装

每个实例的插件目录（默认）：

```text
data/instances/<实例ID>/home/profiles/web
```

两种安装方式：

1. 打开实例的 DSH Web UI → **设置 → 插件**，在该实例内安装。
2. 在实例卡片的 **详情** 中复制安装命令，在自己的终端执行。例如：

```bat
set DSH_HOME=D:\...\data\instances\<实例ID>\home
"C:\Users\you\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile web add <包名>
```

两种方式都会写入该实例自己的 web profile，不会影响其他实例。

## 设置

点击右上角齿轮：

- **DSH 安装目录**：留空自动搜索；可手动指定，保存前会校验目录里存在 `resources\runtime\cli\bin\dsh.cmd`。
- **桌面配置目录（DSH_HOME）**：留空使用 `DSH_HOME` 或 `~/.dsh`；用于读取桌面插件、配置与 API KEY 名称。
- **DSH 命令路径（高级）**：仅当 `dsh.cmd` 不在标准位置时使用。
- 查看管理端口、数据目录、版本，以及当前检测结果。

也可以通过命令行指定数据目录：

```bat
set DSHM_DATA=D:\somewhere\dsh-manager-data
node server.js
```

## 安全说明

- 默认只监听 `127.0.0.1`，不要随意改成 `0.0.0.0`。
- 页面内嵌一次性管理器令牌，所有 `/api/*` 请求都需要该令牌；同时校验同源 `Origin`，降低本地 CSRF 风险。
- 每个 DSH 实例仍使用 DSH 自己的令牌/cookie 认证。
- 目录浏览 API 可以访问本机任意可读目录——这是“手动选择目录”的需要，请只在可信的本机环境运行。
- 复制 API KEY 时只写入实例自己的 `$DSH_HOME/.credentials.yaml`（权限 0600），不会出现在管理器配置、日志或界面中；界面上只显示 KEY 名称。

## 测试

```bat
npm test
```

测试会使用独立的临时数据目录：

- 单元测试：桌面配置解析（不泄露凭据值）、插件/配置/API KEY 复制、目录规划与 junction、v1→v2 配置迁移、安装目录检测
- 冒烟测试：真实创建并启动一个 DSH 实例，验证自定义根目录与子目录、桌面配置继承、目录联接、带令牌的 DSH UI、停止/同步/删除，以及自定义根目录在删除时被保留

## 已知限制

- 管理器退出时实例会停止；它不是 Windows 服务，不提供开机自启/守护。停止实例时会尝试清理实例目录中由插件派生的残留进程（例如 dsh-ops 的 shell 运行时）。
- 管理器被强制结束（任务管理器、直接关闭控制台窗口）时，极少数情况下可能留下 DSH 子进程；重新启动管理器后可在任务管理器结束遗留进程。
- 端口、目录的修改对运行中的实例不会热生效，需要停止后重新启动。
- 复制桌面插件会完整复制 `node_modules`（本机约 150 MB），首次创建会多花几秒，但实例之间完全独立；磁盘紧张时可以在新建时取消“复制插件”。
- 目录联接只在 Windows 本地 NTFS 卷上可靠；网络盘/非 NTFS 卷可能失败并提示错误。
- 仅针对本机使用设计，不适合直接暴露到局域网或公网。
