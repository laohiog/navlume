# Navlume Docker 安装（Linux / NAS）

安装者只需要 Docker、Compose 和安装文件，不需要源码、Node.js 或 npm。
仅支持 **Linux AMD64 / x86-64**。ARM64 尚未构建和运行验证，标记为
**UNVERIFIED**，请勿在 ARM NAS 上把模拟运行当作正式支持。

已发布版本为 Navlume **v0.1.0**。公开源码：[laohiog/navlume](https://github.com/laohiog/navlume)。
镜像为 `ghcr.io/laohiog/navlume`；准确的源码 Commit、SHA Tag 和 Registry Digest
见 [v0.1.0 发行说明](https://github.com/laohiog/navlume/releases/tag/v0.1.0)。
使用发行说明中的已验证镜像引用，不能使用模板占位符启动。

**版本提示：v0.1.0 镜像不包含首次网页创建管理员。** 本文第 3 节的网页流程
适用于本次源码 Candidate，以及后续经审核并正式发布的版本；目前没有因此
发布新镜像。安装 v0.1.0 时使用第 3 节保留的 CLI 备用方式。

## 1. 准备安装文件

Linux 安装 Docker Engine 和 Compose 插件；NAS 安装厂商的容器应用。检查：

```bash
docker info
docker compose version
```

使用同一版本的 [compose.install.yml](https://raw.githubusercontent.com/laohiog/navlume/v0.1.0/compose.install.yml)、
[.env.install.example](https://raw.githubusercontent.com/laohiog/navlume/v0.1.0/.env.install.example)
和本说明，放在独立目录 `navigation`。无需克隆仓库；也可下载
[v0.1.0 源码压缩包](https://github.com/laohiog/navlume/archive/refs/tags/v0.1.0.zip)，
只取出这两个安装文件。

```bash
cd navigation
cp .env.install.example .env
chmod 600 .env
openssl rand -base64 32
```

用文本编辑器填写 `.env`：

| 配置 | 填什么 |
| --- | --- |
| `NAV_IMAGE` | 发布者给出的 `ghcr.io/laohiog/navlume:sha-<完整Commit>`；更推荐 `ghcr.io/laohiog/navlume@sha256:<Digest>` |
| `BETTER_AUTH_SECRET` | 上一步生成的随机密钥；妥善保存，升级时保留 |
| `BETTER_AUTH_URL` | 浏览器实际访问的准确 Origin（协议、主机、端口），不加页面路径 |
| `NAV_BIND_IP` | 默认 `127.0.0.1`；只允许本机访问应用端口 |
| `NAV_PORT` | 默认 `3000`；冲突时换成空闲端口 |

不要分享 `.env` 或把它上传到 Git。不要使用 `latest` 作为安装/升级版本。
Compose 会拒绝空镜像、空密钥和空访问网址；填写错误的镜像版本会在拉取时报错。

### 访问方式

- **本机试用**：在 Docker 所在电脑访问 `http://localhost:3000`，保持默认设置。
  `localhost` 指浏览器所在设备；在电脑浏览器输入它不会访问另一台 NAS。
- **LAN / NAS**：通过现有 NAS 反向代理或已有代理提供浏览器信任的 HTTPS，
  例如 `https://nav.example.com`；代理上游是 NAS 本机的 `127.0.0.1:3000`。
  设置 `BETTER_AUTH_URL` 为该 HTTPS Origin。普通 `http://NAS-IP:3000`
  可检查健康，但不是可登录的生产访问方式。
- **正式 HTTPS**：将同一个 HTTPS Origin 代理到应用，前端与 `/api/*` 共用
  Origin。应用自身不提供 TLS。代理如在另一台设备或容器内，需按实际网络
  显式绑定服务器的私有 LAN IP，并用防火墙仅允许代理访问该端口。
  代理容器中的 `127.0.0.1` 是代理容器自身，不是 NAS 主机。

生产 Cookie 保持 `Secure`、`HttpOnly`、`SameSite=Lax`。不通过更改
`NODE_ENV` 或降低 Cookie 属性来适配普通 HTTP IP 地址。不默认绑定
`0.0.0.0`，不直接把未加密的应用端口转发到公网。

## 2. 拉取镜像并启动

公开 GHCR 镜像无需登录。只有维护者明确交付受限预览镜像时，才需要有包读取
权限的 GitHub 账号及 classic PAT（至少 `read:packages`，必要时授权组织 SSO）。
在 NAS 上操作时，应登录实际拉取镜像的 NAS Docker 环境；桌面电脑的登录
不会自动传给 NAS。受限预览可在 Bash 中先执行以下命令，Token 不回显：

```bash
read -r -p 'GitHub username: ' GH_USER
read -r -s -p 'GHCR read token: ' GH_TOKEN; printf '\n'
printf '%s' "$GH_TOKEN" | docker login ghcr.io -u "$GH_USER" --password-stdin
unset GH_TOKEN
```

公开版本直接执行以下命令；受限预览在登录成功后执行：

```bash
docker compose -f compose.install.yml config --quiet
docker compose -f compose.install.yml pull
docker compose -f compose.install.yml up -d --no-build
docker compose -f compose.install.yml ps
```

Docker 会在其本机凭据存储中保存仓库登录；保护该目录或配置凭据助手。
GHCR Token 不放进 `.env` 或 Compose。私有包权限不足时停止并联系发布者，
不要修改包可见性。

等 `app` 显示 `healthy`（通常约 30 秒），再创建管理员。必要时查看：

```bash
docker compose -f compose.install.yml logs --tail 100 app
curl http://localhost:3000/api/health
# {"status":"ok"}
```

在 NAS SSH 终端运行 `curl`，这里的 localhost 才指向 NAS。改过端口时同步
修改测试地址。Docker 健康检查使用容器内部地址，不依赖公开网址能否访问。

首次启动会自动迁移空数据库，无默认账号、默认密码或演示导航。应用和
工具使用同一个数据卷：`/data/nav.sqlite` 和 `/data/uploads`。

## 3. 创建首位管理员并登录

包含新功能的版本推荐流程：**Compose 部署 → 容器日志获取初始化验证码 →
浏览器创建管理员 → 登录**。

1. 在 NAS 的 **Docker → 容器 → 日志**（群晖 Container Manager 或威联通
   Container Station 中的 app 容器日志）找到 `[setup] First-run initialization code`。
   也可执行 `docker compose -f compose.install.yml logs app`。
2. 浏览器打开配置的 `BETTER_AUTH_URL`，看到“欢迎使用 Navlume”。填写管理员
   用户名、邮箱、密码、确认密码和一次性初始化验证码，点击“创建管理员账户”。
   用户名为 3–30 位字母、数字、下划线或点；密码为 8–128 位。
3. 创建成功后点击“进入登录页面”，使用新用户名和密码登录。然后在管理后台
   创建普通用户。

没有默认管理员密码。验证码仅在没有任何用户的全新实例启动时随机生成，
只输出一次到容器日志，有效期 60 分钟。**不要分享验证码，并限制容器日志
的查看权限**；日志读取权限相当于首次管理员创建授权。验证码不由网页返回。
过期后重启 app 并查看新的日志；重启前的验证码失效。错误验证码尝试过多时，
等待一分钟再试。

创建成功后网页初始化立即关闭。已有任何用户的实例（包括只有普通用户的
实例）不会重新开放此入口；CLI 已创建管理员时也会关闭。首次初始化不等于
公开注册。非 localhost 访问仍须可信 HTTPS，与第 1 节 Origin 和 Secure Cookie
规则一致。

### CLI 备用方式（v0.1.0 必须使用）

在服务器/NAS 的 Bash 终端执行。先把示例邮箱和用户名改为自己的值：

```bash
read -r -s -p 'First administrator password: ' BOOTSTRAP_ADMIN_PASSWORD; printf '\n'
export BOOTSTRAP_ADMIN_PASSWORD
docker compose -f compose.install.yml run --rm -T \
  -e BOOTSTRAP_ADMIN_USERNAME=admin \
  -e BOOTSTRAP_ADMIN_EMAIL=admin@example.com \
  -e BOOTSTRAP_ADMIN_PASSWORD \
  app node dist/server/server/bootstrap-admin.js
unset BOOTSTRAP_ADMIN_PASSWORD
```

成功输出 `[bootstrap] created administrator "admin"`。密码通过一次性环境传入，
不写进命令参数值、长期 Compose 或日志；不要启用 shell 的 `set -x`。
已有管理员时再次初始化会被拒绝，不覆盖原账号。请使用强且独立的密码。

浏览器打开 `BETTER_AUTH_URL` 并用用户名、密码登录；然后在管理后台创建普通
用户。普通用户没有管理权限，公开注册默认关闭。若容器健康但登录失败，先
核对浏览器网址与 `BETTER_AUTH_URL` 完全一致、HTTPS 证书可信，以及代理路径。

## 4. 群晖与威联通

### 群晖 Container Manager

在 **Project / 项目**中新建项目，选择安装目录并导入 `compose.install.yml`。
将填好的 `.env` 放在同一项目目录，并确认项目读取了它。使用现有反向代理
配置 HTTPS；本包不增加代理服务。

### 威联通 Container Station

使用 **Applications / 应用 → Create / 创建应用**，导入或粘贴同一份 Compose
YAML。确认应用的环境变量配置提供了 `.env` 中的值，并在部署前验证 YAML。

NAS 图形界面的环境文件和私有 registry 凭据处理随版本而异。若界面不能
读取 `.env` 或私有 GHCR 登录，使用 NAS SSH 终端按第 2 节启动同一份文件，
不要建立第二个应用项目。包含新功能的版本可在容器日志中获取验证码，通过
浏览器创建管理员；CLI 备用初始化、备份和恢复也可在 NAS SSH 终端执行。
始终保留相同项目名 `navigation`；如果一开始使用 `-p` 指定其他名称，之后
所有命令都必须使用该名称。换项目名会指向另一个数据卷，看起来像空安装。

厂商操作入口参考：[群晖项目说明](https://kb.synology.com/en-global/DSM/help/ContainerManager/docker_project)、
[威联通 Container Station 3 说明](https://www.qnap.com/en-us/how-to/tutorial/article/how-to-use-container-station-3)。
这里覆盖 Compose 导入流程，不代表已在真实 NAS 硬件完成操作验证。

## 5. 备份与恢复

**备份和恢复都必须先停止应用。** `--app-stopped` 是操作者的确认，工具不会
代你检测服务是否已停止。只停止 `app`，保留容器和卷，便于复制备份。

```bash
docker compose -f compose.install.yml stop app
docker compose -f compose.install.yml run --rm -T app \
  node dist/server/server/backup.js --app-stopped --output /data/backups
mkdir -p ./backups
docker compose -f compose.install.yml cp app:/data/backups/. ./backups/
docker compose -f compose.install.yml start app
```

检查备份命令成功、输出 `backup verified`。每份备份位于主机的
`./backups/backup-<timestamp>/`，该时间戳目录内包含 `manifest.json`、
`nav.sqlite`、`uploads/`；它们不直接位于 `./backups` 根目录。
源路径末尾的 `/.` 表示复制目录内容，首次和重复复制都保持同一层级，
不会新增 `./backups/backups/`。再把所需的时间戳备份目录复制到另一台设备。
卷内 `/data/backups` 不是离机备份。单独安全保存 `.env`（含认证密钥）和
当前镜像 Digest，它们不包含在物理备份中。失败时先查看错误，不把不完整
目录当作备份。

**恢复会覆盖当前数据库和整个上传目录，包括账号、导航和品牌图片；备份
之后创建的数据会丢失。** 先保留当前恢复点，再确认目标和版本相匹配。
卷内备份按工具打印的完整时间戳路径使用：

```bash
docker compose -f compose.install.yml stop app
docker compose -f compose.install.yml run --rm -T app \
  node dist/server/server/restore.js --app-stopped --confirm-restore \
  --backup /data/backups/backup-<timestamp>
docker compose -f compose.install.yml start app
```

如果只有离机备份，先在应用停止时用
`docker compose -f compose.install.yml cp ./backups/. app:/data/backups`
将主机备份根目录的内容放回 `/data/backups`（目标目录存在或不存在均保持
相同层级），再选择 `/data/backups/backup-<timestamp>` 执行恢复。
不要把备份放进 `/data/uploads`。恢复退出码
`1` 表示失败/拒绝；`2` 表示回滚未完成，保留工具报告的恢复文件，停止进一步
操作。仅在成功恢复后启动应用。完整规则见 [物理备份与恢复](BACKUP_RESTORE.md)。

逻辑 JSON 导入/导出继续在原有页面使用；它不包含账号凭据和上传图片，不能
替代整实例物理备份。

## 6. 保留数据升级

先按第 5 节停机备份并复制离机，再把 `.env` 的 `NAV_IMAGE` 改为发布者给出的
**新固定版本或 Digest**。保留认证密钥、访问网址、Compose 项目名和数据卷：

```bash
docker compose -f compose.install.yml pull
docker compose -f compose.install.yml up -d --no-build
docker compose -f compose.install.yml ps
```

等待 `healthy` 并核对登录、导航和品牌图片。启动时自动迁移。不要盲目降级
已迁移的数据；回退需要兼容的旧镜像和升级前恢复点。

`docker compose ... down` 保留 Named Volume，但 **`down -v` 会删除数据卷**。
不要执行 `down -v`，也不要在 NAS 界面勾选删除卷或数据。重建容器不会删除卷。
