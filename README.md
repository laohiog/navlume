<div align="center">

# Navlume

### 让常用网址，有一个真正属于自己的地方。

轻量、自托管、可品牌化的网址导航平台。
为个人整理收藏，也为团队建立统一入口。

**Simple · Brandable · Self-hosted · Portable · Fast**

[![Release](https://img.shields.io/badge/Release-v0.1.3-334155?style=flat-square)](https://github.com/laohiog/navlume/releases/tag/v0.1.3)
[![Docker](https://img.shields.io/badge/Deployment-Docker-2563EB?style=flat-square)](#快速开始)
[![License](https://img.shields.io/badge/License-MIT-64748B?style=flat-square)](./LICENSE)

[功能介绍](#功能介绍) · [快速开始](#快速开始) · [首次使用](#首次使用) · [备份与升级](#备份与升级) · [项目文档](#项目文档)

</div>

---

## 认识 Navlume

Navlume 专注于三件事：**找到网址、保存网址、在不同设备上继续使用自己的网址。**

个人可以把它用作简洁的浏览器首页；团队可以统一维护公共导航，同时让每位成员拥有自己的分类和收藏。网址数据保存在自己的服务器上，登录同一账号即可在不同设备使用。

每个 Navlume 实例独立管理品牌、用户和数据。它不是多租户 SaaS，也不追求成为集成天气、监控等小组件的仪表盘。

## 功能介绍

| 功能 | 你可以做什么 |
| --- | --- |
| **公共与个人导航** | 使用公共网址入口，同时管理只有自己能看到的收藏与分类 |
| **快速添加网址** | 点击「＋ 添加网址」，从剪贴板读取或手动粘贴后保存 |
| **搜索与整理** | 搜索网址、调整分类与排序；长页面可快速切换分类、返回顶部 |
| **多设备使用** | 在电脑或手机上登录同一账号，使用服务器保存的个人导航 |
| **品牌化** | 设置站点名称、标志、图标、品牌颜色和显示风格 |
| **管理后台** | 维护公共导航、管理用户和站点设置 |
| **数据迁移与备份** | JSON 导入导出；完整备份和恢复 SQLite 数据库与上传文件 |

**部署保持简单：一个应用容器、一个持久化数据卷。** 无需单独部署数据库、缓存或前后端服务。

## 快速开始

### 选择部署方式

只需 Docker 和 Docker Compose（或能导入 Compose 配置的容器管理工具），**不需要**为安装预先准备 Node.js、MySQL 或 PostgreSQL。

| 使用场景 | 推荐方式 | 访问地址示例 |
| --- | --- | --- |
| 云服务器、VPS、家庭服务器或 NAS，准备通过域名访问 | [标准模式 + HTTPS](#标准模式docker-compose) | `https://nav.example.com` |
| 安装 Docker 的个人电脑，本机试用 | [标准模式](#标准模式docker-compose) | `http://localhost:3000` |
| 仅在可信家庭或办公局域网使用，没有 HTTPS | [局域网 HTTP 模式](#局域网-http-模式) | `http://192.168.1.100:3000` |
| 想修改代码或自行构建 | [从源码运行](#从源码运行) | 本地开发地址 |

> **兼容性：** 当前预构建镜像已验证 **Linux AMD64 / x86-64**。ARM64 和具体 NAS 设备的实机运行尚未验证。使用 Windows、macOS 或 NAS 时，也须确认其 Docker 环境能运行该架构的 Linux 容器。以下终端命令以 Linux Shell 为例；图形化管理面板可导入相同配置，但具体操作取决于平台。

### 标准模式（Docker Compose）

适合 **HTTPS 正式部署**，也可在运行 Docker 的电脑上通过 `localhost` 先行体验。这是默认推荐的安装方式。

**1. 获取安装文件**

在准备运行 Docker 的设备上创建目录，并下载当前仓库的标准安装模板：

```bash
mkdir navlume && cd navlume

curl -fL -o compose.install.yml \
  https://raw.githubusercontent.com/laohiog/navlume/main/compose.install.yml

curl -fL -o .env \
  https://raw.githubusercontent.com/laohiog/navlume/main/.env.install.example

chmod 600 .env
```

也可以手动下载上述两个文件并保存为 `compose.install.yml` 和 `.env`，然后导入自己的 Docker 管理工具。**这两个文件应来自同一版本的模板。** 若使用发行页的历史附件，请同时使用该发行版配套的环境模板和镜像引用，避免混用。

**2. 配置访问地址和认证密钥**

执行以下命令生成随机密钥：

```bash
openssl rand -base64 32
```

打开 `.env`，将结果填入 `BETTER_AUTH_SECRET`，并确认访问地址：

```dotenv
NAV_IMAGE=ghcr.io/laohiog/navlume:latest
BETTER_AUTH_SECRET=这里替换为生成的随机密钥
BETTER_AUTH_URL=http://localhost:3000
NAV_BIND_IP=127.0.0.1
NAV_PORT=3000
```

- **本机试用：** 使用上述 `localhost` 配置，仅从运行 Docker 的本机浏览器访问。
- **使用域名：** 将 `BETTER_AUTH_URL` 改为用户实际访问的 HTTPS 地址，例如 `https://nav.example.com`，不要附加页面路径。
- **密钥保管：** 密钥不能为空、不能公开，日后升级须保持原值；不要把填好的 `.env` 提交到 Git 仓库。
- **镜像版本：** `latest` 是经稳定版发布流程推进的**可变别名**，拉取和重建容器才会更新。需要锁定版本时，可以改用下方列出的 v0.1.3 固定镜像摘要。

默认 `NAV_BIND_IP=127.0.0.1`，不会将应用端口直接开放到公网。

**3. 启动应用**

```bash
docker compose -f compose.install.yml config --quiet
docker compose -f compose.install.yml pull
docker compose -f compose.install.yml up -d --no-build
docker compose -f compose.install.yml ps
```

在 Docker 所在设备上检查健康状态：

```bash
curl http://127.0.0.1:3000/api/health
```

正常时返回 `{"status":"ok"}`。首次启动会自动建立数据库并执行迁移，不会创建默认管理员或填充演示网址。

> **正式使用需 HTTPS。** 标准生产模式使用安全会话 Cookie，不能直接把 `http://服务器IP:3000` 当作远程登录入口。请先完成[HTTPS 与反向代理](#https-与反向代理)配置；本机 `localhost` 试用除外。

### 局域网 HTTP 模式

适合只在**可信私有网络**使用的 NAS、家庭服务器或办公室设备，无需域名及反向代理。

1. 获取 [compose.lan.yml](https://github.com/laohiog/navlume/blob/main/compose.lan.yml)，保存到独立目录，或将其内容导入容器管理面板。
2. 将文件中**两处** `192.168.1.100` 改成 Docker 设备实际的私有 IPv4 地址。如果主机端口冲突，同时修改端口映射的主机端口及 `BETTER_AUTH_URL` 中的端口，容器内部仍使用 `3000`。
3. 启动服务：

   ```bash
   docker compose -f compose.lan.yml up -d
   ```

4. 在同一可信局域网内打开 `http://你的设备IP:3000`，立即完成管理员初始化。

该模板使用 `INSTALL_MODE: lan-http`，自动生成并持久化认证密钥，无需单独编辑 `.env` 或查看管理员初始化验证码。该模式只接受明确的**私有 IPv4 HTTP 地址**，不接受域名、`localhost` 或公网 IP。

> **重要：HTTP 不加密密码和会话。** 请通过防火墙限制访问，禁止路由器将应用端口转发至公网。任何能访问尚未初始化站点的人都有可能抢先创建管理员。**该模板用于全新安装**；已有站点切换模式涉及数据卷与原密钥，必须先阅读[安装和迁移指南](./docs/INSTALL.md)，不可直接用新模板替换旧项目。

### HTTPS 与反向代理

Navlume 不依赖某一种反向代理或服务器面板。可以使用现有的 **Nginx、Caddy、Traefik、Nginx Proxy Manager** 或其他能提供 HTTPS 的反向代理。

```text
浏览器 ── HTTPS ──> 反向代理 ── HTTP ──> Navlume :3000
                                              │
                                              └── 持久化数据卷 /data
```

确保域名正确指向服务器、配置有效的 HTTPS 证书，并将流量代理到 Navlume 的 `3000` 端口。`BETTER_AUTH_URL` 必须与浏览器使用的协议、域名和端口完全一致。

| 反向代理所在位置 | 连接方式 |
| --- | --- |
| 与 Navlume 运行在同一宿主机上 | 通常可使用默认的 `127.0.0.1:3000` |
| 与 Navlume 运行在不同 Docker 容器中 | 连接到同一个 Docker 网络，以应用的容器网络名称访问 `3000`，并按需修改 Compose 网络设置 |
| 在另一台设备上 | 让应用只绑定可由代理访问的私有地址，并通过防火墙限制来源 |

**注意：** 容器内的 `127.0.0.1` 指向该容器自身；默认标准安装文件也不会自动加入你已有代理的 Docker 网络。不同平台的代理配置请参见[部署说明](./docs/DEPLOYMENT.md)。

## 首次使用

Navlume **没有默认管理员账号或密码**，普通用户也不能自行公开注册。

**标准模式：**

1. 打开配置好的 Navlume 网址，进入欢迎页面。
2. 读取应用日志中的 `[setup] First-run initialization code`：

   ```bash
   docker compose -f compose.install.yml logs app
   ```

3. 在欢迎页面填写用户名、邮箱、密码和一次性验证码，创建首位管理员；然后进入登录页面。

验证码仅在首次初始化开放时生成，有效期 **60 分钟**。过期后可重启容器获取新验证码（前提是尚未完成初始化）。不要公开日志或验证码。

**局域网 HTTP 模式：** 直接通过配置的私有 IPv4 网址打开欢迎页面创建管理员，不需要日志验证码。启动后应立即完成此步骤。

完成登录后，可点击 **「＋ 添加网址」→ 从剪贴板读取或手动粘贴 → 保存**。管理员还可以创建成员账户、维护公共导航和自定义品牌。

## 备份与升级

### 数据存在哪里？

Docker 的持久化卷会保存：

```text
/data/
├── nav.sqlite       # 用户、网址、分类及站点设置
└── uploads/         # 上传的品牌图片等文件
```

**同一个 Compose 项目名不等于同一个目录，反过来也一样。** Compose 项目名影响默认数据卷的名称。不要通过新建项目、更改挂载卷或直接删除容器的方式尝试迁移数据。

### 完整备份

JSON 导出适用于导航内容的迁移；**完整恢复一个实例**则需要数据库、整个 `uploads` 目录，以及标准模式的原认证密钥。

标准 Compose 部署可在 Docker 所在设备上执行以下命令（适用于仓库提供的默认安装模板）：

```bash
# 停止应用后才能备份数据库与上传文件的一致状态
docker compose -f compose.install.yml stop app

# 生成并验证完整备份
docker compose -f compose.install.yml run --rm -T app \
  node dist/server/server/backup.js --app-stopped --output /data/backups

# 将备份从数据卷复制到宿主机
mkdir -p ./backups
docker compose -f compose.install.yml cp app:/data/backups/. ./backups/

# 重新启动应用
docker compose -f compose.install.yml start app
```

确认命令输出 `backup verified`，并将 `./backups/` **另存到独立存储设备**。如果备份或复制失败，先检查错误，不要把不完整的文件视为有效备份。标准模式还应单独安全保存 `.env` 中的密钥；局域网模式的完整 `uploads` 备份包含自动生成的隐藏密钥文件。

恢复会覆盖现有数据，**不要凭猜测直接恢复**。详见[备份与恢复指南](./docs/BACKUP_RESTORE.md)。

### 手动升级

1. 先完成完整备份，并确认原 Compose 项目、数据卷、访问地址和认证密钥。
2. 阅读[发行说明](https://github.com/laohiog/navlume/releases)。使用 `latest` 的实例可手动拉取稳定版；使用固定镜像摘要的实例应在确认目标版本后更新镜像引用。
3. 在**原安装目录、原 Compose 配置**中执行：

   ```bash
   docker compose -f compose.install.yml pull
   docker compose -f compose.install.yml up -d --no-build
   ```

4. 检查容器健康状态、登录、原有导航与品牌图片。

> 保持原数据卷、`BETTER_AUTH_SECRET`、`BETTER_AUTH_URL` 和 Compose 项目名不变。**不要运行 `docker compose down -v`**，也不要删除数据卷。局域网模式将上述命令中的文件名换为 `compose.lan.yml`；使用 NAS 或管理面板时，在**原项目**中更新镜像，而非新建另一个空实例。

## 发行版本与兼容性

- **当前文档对应发行：** [Navlume v0.1.3](https://github.com/laohiog/navlume/releases/tag/v0.1.3)。该版本增加长页面浮动分类选择、返回顶部及更方便的网址排序操作。
- **镜像：** `ghcr.io/laohiog/navlume:latest` 是人工推进的稳定版别名，**不是不可变版本号**，也不会自动更新运行中的容器。
- **固定 v0.1.3 镜像（适合锁定版本和回退）：**

  ```text
  ghcr.io/laohiog/navlume@sha256:81081c094488af19bda6fa1d0b37a582c76053084ce9410d358f15efe70af857
  ```

- **支持边界：** 已验证的预构建镜像平台为 Linux AMD64；ARM64 和具体 NAS 硬件未完成实机验证。不同平台的 Compose 管理工具界面也未逐一验证。
- **版本核对：** v0.1.3 的镜像运行源码与发行文档提交是不同的 Git 提交。需要复现构建或验证发行身份，请使用[原版发行附件](https://github.com/laohiog/navlume/releases/tag/v0.1.3)中的 `RELEASE-IDENTITY.json` 与 `SHA256SUMS`；不要混用不同版本的附件。

## 常见问题

<details>
<summary><strong>页面打开了，为什么无法登录？</strong></summary>

首先检查 `BETTER_AUTH_URL` 是否与浏览器实际访问地址一致。标准模式的远程访问需要 HTTPS；普通 HTTP 服务器 IP 不能替代正确的 HTTPS 站点。仅在 Docker 所在本机使用 `localhost` 时才可按默认配置试用。

</details>

<details>
<summary><strong>反向代理出现 502，或者无法访问容器？</strong></summary>

查看 `docker compose -f compose.install.yml ps` 与应用日志，确认服务健康、端口为 `3000`，并确认代理能连接到真实上游地址。容器之间不能把 `127.0.0.1` 当作其他容器的地址。

</details>

<details>
<summary><strong>更新或更换目录后，为什么出现一个全新空站点？</strong></summary>

先不要重新初始化或继续写入。检查 Compose 项目名、实际挂载的数据卷及 `/data` 路径。更换项目名可能导致创建新卷，**不代表旧数据已被删除**。先确认旧卷并参考安装指南处理。

</details>

<details>
<summary><strong>可以直接安装在 ARM64 NAS 或树莓派吗？</strong></summary>

目前发行镜像只验证了 Linux AMD64；ARM64 和真实 NAS 设备的运行兼容性没有完成验证，不承诺开箱即用。请先确认硬件架构，不要将模拟运行视为正式支持。

</details>

## 从源码运行

项目使用 **Node.js 24 · TypeScript · Hono · React 19 · Vite · SQLite · Drizzle ORM · Better Auth**。前端和后端同源部署，使用单应用、单数据库架构。

开发者可在源码目录中执行：

```bash
cp .env.example .env
npm ci
npm run db:migrate
npm run dev
```

按 `.env.example` 配置开发环境，默认访问 `http://localhost:5173`。首次初始化验证码可在开发服务器日志中读取。常用检查命令：

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

自行构建 Docker 镜像与生产部署的详细说明参见[部署文档](./docs/DEPLOYMENT.md)。

## 项目文档

| 文档 | 内容 |
| --- | --- |
| [安装指南](./docs/INSTALL.md) | 标准 HTTPS、局域网安装与模式迁移 |
| [部署说明](./docs/DEPLOYMENT.md) | 环境变量、Docker 与反向代理配置 |
| [备份与恢复](./docs/BACKUP_RESTORE.md) | 物理备份、验证和恢复操作 |
| [产品说明](./docs/PRODUCT.md) | 产品定位、功能与边界 |
| [技术架构](./docs/ARCHITECTURE.md) | 项目架构与技术选型 |
| [数据模型](./docs/DATA_MODEL.md) | 数据结构和归属设计 |
| [安全反馈](./SECURITY.md) | 私密报告安全问题的方式 |

一般问题或建议可使用 [GitHub Issues](https://github.com/laohiog/navlume/issues)；安全漏洞请阅读 [SECURITY.md](./SECURITY.md)，避免在公开 Issue 中披露敏感信息。

## 开源许可

Navlume 基于 [MIT License](./LICENSE) 开源。第三方依赖和资源遵循各自的许可条款。

---

<div align="center">

**Navlume** · *Your links. Your space. Your brand.*

</div>
