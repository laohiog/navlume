# Navlume v0.1.3 Docker 安装（Linux / NAS）

**版本与发行资料已获批准，尚未公开发布。** `v0.1.3` Tag 和 GitHub Release 尚未创建，
公开发布仍需单独授权。真实发行文档提交记录于随包的 `RELEASE-IDENTITY.json`；
`SHA256SUMS` 从配套附件的实际字节计算，不代表附件已上传。

安装者只需要 Docker、Compose 和安装文件，不需要源码、Node.js 或 npm。
仅支持 **Linux AMD64 / x86-64**。ARM64 尚未构建和运行验证，标记为
**UNVERIFIED**，请勿在 ARM NAS 上把模拟运行当作正式支持。

本文用于 **v0.1.3**，保留标准 HTTPS 与显式局域网 HTTP 两种安装方式。
公开源码：[laohiog/navlume](https://github.com/laohiog/navlume)。
已发布、已验收镜像的实际源码为 `361aaa6439ba16e3579d097629ac75fe2df4fc91`，
实际 SHA Tag 为 `sha-361aaa6439ba16e3579d097629ac75fe2df4fc91`。发行文档提交
与该运行源码不同；不能用文档提交替代 OCI revision，也不因文档更新重建镜像。
身份与尚未生成的发布信息见附件 `RELEASE-IDENTITY.json`。固定 Registry 镜像引用为：

```text
ghcr.io/laohiog/navlume@sha256:81081c094488af19bda6fa1d0b37a582c76053084ce9410d358f15efe70af857
```

v0.1.3 增加长页浮动分类选择和返回顶部、个人及管理员公共网址的置顶/置底/指定位置移动；
原 ↑/↓、搜索和「＋ 添加网址 → 剪贴板或手动粘贴 → 保存」保持。没有 API、Auth、
Schema、依赖或安装架构改动。

**历史版本：**[v0.1.2 发行说明](https://github.com/laohiog/navlume/releases/tag/v0.1.2)
及原附件继续有效；其运行源码为 `3a9ad4c716b0f961dd089969c387603e4e631576`，
发行文档提交为 `fd97f3c6d0f04f5c0e91e99bc9ad27003f16d087`，旧镜像 Digest 见第 6 节。
v0.1.1 支持标准网页初始化，但不支持 `INSTALL_MODE=lan-http`；不要用旧镜像启用 LAN。

**历史兼容说明：v0.1.0 镜像不包含首次网页创建管理员。** 已有 v0.1.0 实例
可以按第 6 节保留数据升级；CLI 管理员创建方式作为备用保留。

## 局域网 HTTP 快捷安装（绿联 UGOS Pro 等 Compose 环境）

**全新实例**：`compose.lan.yml` 是可直接粘贴到 UGOS Pro Compose 项目的单文件配置，无需 `.env`、
OpenSSL、SSH 或管理员 CLI。使用本包中的 `compose.lan.yml`，
镜像已固定为上面的已验证 Digest。建立全新项目和新卷，不复用或覆盖已有安装；
已有实例按下方迁移说明先备份、核实原卷与原密钥。

1. 将单文件配置粘贴或导入新 Compose 项目；将两处 `192.168.1.100` 改成 NAS 的实际私有 IPv4。
2. 主机端口冲突时，同时修改映射中的主机端口与 `BETTER_AUTH_URL` 的端口，保留
   容器端口和 `PORT: 3000`。
3. 启动项目，打开准确的 `http://NAS-IP:主机端口`，创建管理员，进入登录页面并登录。

必须显式设置 `INSTALL_MODE: lan-http`。只接受准确的 RFC1918 IPv4 HTTP Origin：
`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`；不接受域名、IPv6、localhost、
公网 IP、路径或多个别名。配置错误拒绝启动，Host 和转发头不会扩大可信 Origin。
保留 `NODE_ENV=production`，会话 Cookie 明确不设 Secure，仍有 HttpOnly、SameSite=Lax。
LAN 不生成或要求验证码；标准模式保留 60 分钟验证码和每分钟 5 次错误限制。

**HTTP 不提供传输加密，私有 IP 校验不能替代防火墙。** 密码和会话可能被同网段
设备监听。只在可信局域网使用，用 NAS 防火墙限制来源，不要转发公网端口；公网或
不可信网络使用标准 HTTPS。首次管理员创建前，能访问此地址的人都能抢先初始化，
请启动后立即完成。真实 DXP2800 / UGOS Pro 图形界面、防火墙效果：**UNVERIFIED**。

LAN 自动密钥保存于 `/data/uploads/.auth-secret`（0600），位于公开品牌目录之外。
保持数据卷和 uploads 路径，重启、升级及完整 v1 物理恢复会复用原密钥。不要删除、
编辑或共享密钥文件。旧实例迁入 LAN 时提供原 `BETTER_AUTH_SECRET`，首次在支持 LAN 的版本启动
会持久化它；已有用户或已初始化却缺少密钥、文件损坏、变量与文件不一致均拒绝启动。
标准模式沿用 v0.1.1 的非空密钥接受行为，不会自动换钥；历史 31 字符等短密钥
继续在标准 HTTPS 模式使用。LAN 要求原密钥至少 32 字符，且不能使用开发默认密钥；
不符合时明确拒绝迁入。不要为绕过检查生成新密钥替换旧值，密钥政策调整不在本流程内。

自 v0.1.2 起，初始化关闭状态写入现有数据库，网页和 CLI 共用；删除全部用户或重启都不
重新开放。已有用户的旧实例在 v0.1.2 启动时补记关闭状态。真正回到未初始化状态时，
按既有停机流程恢复创建管理员前的完整物理备份，或为新实例使用新的独立卷。
旧版本在升级前已删空且没有标记时，无法判断过去是否初始化过，不声称覆盖该历史情形。

备份恢复步骤仍见第 5 节及 [BACKUP_RESTORE.md](./BACKUP_RESTORE.md)，LAN 命令改用
`-f compose.lan.yml`。完整 uploads 备份必须保留隐藏密钥文件；初始化后备份会保留
关闭状态，即便没有用户。标准环境密钥仍需另行保存，JSON 或仅 SQLite 不能替代物理备份。

### 全新卷与已有实例迁移的区别

标准文件的项目名是 `navigation`，LAN 文件是 `navlume-lan`。默认情况下，同名
`navigation-data` 会分别生成 **`navigation_navigation-data`** 和
**`navlume-lan_navigation-data`**，它们不是同一个卷。`-p`、`COMPOSE_PROJECT_NAME`
或 NAS 图形界面的项目名还可能改变前缀。直接启动未修改的 LAN 模板会建立新实例，
不能当作旧实例迁移。全新安装保持上方单文件流程不变。

### 已有标准实例迁入 LAN

只用于原文件将 `/data` 挂载为 Docker Named Volume 的标准实例。**先完成停机备份
和离卷备份，再修改 LAN 文件或启动新项目。禁止 `docker compose down -v`、
`docker volume rm`、清空目录、删除/覆盖/重建原卷；不要同时启动新旧应用容器。**
若实际使用 bind mount、自定义数据路径或已丢失原密钥，停止并先核实实际布局。

在原标准项目目录操作，保留原 Compose 文件和 `.env`（含原认证密钥），不要分享它。
原密钥不足 32 字符时保持标准 HTTPS，不执行下面的 LAN 切换。所有命令必须成功；
任何一步失败都停止，不继续启动新项目。

1. 在 `docker ps -a` 中找到原应用容器名，填写变量并读取它的实际项目名、卷名。
   不凭文件名猜卷名。以下 Bash 命令使用示例文件名，源码部署应填写自己的原文件：

```bash
OLD_CONTAINER=你的原应用容器名
OLD_COMPOSE=compose.install.yml
OLD_PROJECT=$(docker inspect "$OLD_CONTAINER" --format '{{ index .Config.Labels "com.docker.compose.project" }}')
OLD_VOLUME_TYPE=$(docker inspect "$OLD_CONTAINER" --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Type}}{{end}}{{end}}')
OLD_VOLUME=$(docker inspect "$OLD_CONTAINER" --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}')
test -n "$OLD_PROJECT" && test "$OLD_VOLUME_TYPE" = volume && test -n "$OLD_VOLUME" || exit 1
printf '原项目：%s\n原数据卷：%s\n' "$OLD_PROJECT" "$OLD_VOLUME"
```

2. 使用实际原项目名停止应用，按既有 v1 流程备份并复制到卷外；此时保持原容器和卷。
   检查输出 `backup verified`，再把时间戳备份目录另存到安全位置：

```bash
docker compose -p "$OLD_PROJECT" -f "$OLD_COMPOSE" stop app
docker compose -p "$OLD_PROJECT" -f "$OLD_COMPOSE" run --rm -T app \
  node dist/server/server/backup.js --app-stopped --output /data/backups
mkdir -p ./backups
docker compose -p "$OLD_PROJECT" -f "$OLD_COMPOSE" cp app:/data/backups/. ./backups/
```

3. 使用本版的单文件 `compose.lan.yml`（已固定镜像），填写 NAS IP 和端口。
   在 app 的 `environment` 中加入以下一行，让原 `.env` 提供**同一个**密钥：

```yaml
      BETTER_AUTH_SECRET: "${BETTER_AUTH_SECRET:?Use the original instance secret}"
```

   将文件底部的卷定义改成下面的样式，`name` 必须填写第 1 步得到的真实 `OLD_VOLUME`，
   不保留示例值。`external: true` 只使用已有卷，名字错误或卷不存在时拒绝启动，
   不会悄悄建立空卷：

```yaml
volumes:
  navigation-data:
    external: true
    name: navigation_navigation-data  # 替换成实际 OLD_VOLUME
```

4. 新项目显式使用独立项目名（例如原项目名加 `-lan`），但 `/data` 绑定到原卷。
   在同一目录使用原 `.env`，先核对配置，再启动；不同时启动旧项目：

```bash
NEW_PROJECT="${OLD_PROJECT}-lan"
docker compose -p "$NEW_PROJECT" --env-file .env -f compose.lan.yml config --quiet
docker compose -p "$NEW_PROJECT" --env-file .env -f compose.lan.yml up -d --no-build
NEW_CONTAINER=$(docker compose -p "$NEW_PROJECT" --env-file .env -f compose.lan.yml ps -q app)
docker inspect "$NEW_CONTAINER" --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}'
```

核对输出仍为 `OLD_VOLUME`，容器健康后用原账号登录，检查原导航及 uploads，确认
没有回到初始化页。首次 LAN 启动仅在原 uploads 中持久化同一密钥并保留/补记关闭标记，
不移动数据库或复制成新卷。之后保持 external 卷定义、同一新项目名和 uploads 路径。
标准与 LAN 的 Origin/Cookie 属性不同，切换模式后需重新登录；同一标准模式升级则
保留原密钥和已签名会话。

如新项目启动失败，停止新 app 后用原 Compose、原 `.env` 和 `OLD_PROJECT` 启动旧 app。
原卷仍在，不通过删卷“修复”失败，也不在两项目间并发运行同一个 SQLite 实例。

## 1. 标准安装：准备安装文件

Linux 安装 Docker Engine 和 Compose 插件；NAS 安装厂商的容器应用。检查：

```bash
docker info
docker compose version
```

使用随包的以下发行附件输入；它们尚未上传为 v0.1.3 Release：

- `compose.install.yml`
- `default.env.install.example`
- `INSTALL.md`（本说明）
- `BACKUP_RESTORE.md`（备份与恢复）
- `RELEASE-IDENTITY.json` 与 `SHA256SUMS`（身份及配套附件的实际字节校验）

放在独立目录 `navigation`。发行附件中的 `default.env.install.example` 需先
改名为 `.env.install.example`。附件方式无需克隆仓库；直接使用本工作区时，
取 `compose.install.yml`、`.env.install.example` 和 `docs/INSTALL.md`，原环境模板
无需改名。v0.1.3 Tag 尚不存在，不假定源码压缩包或下载 URL 已可用。

```bash
cd navigation
# 使用发行附件时先改名；源码压缩包方式跳过这一行
mv default.env.install.example .env.install.example
cp .env.install.example .env
chmod 600 .env
openssl rand -base64 32
```

用文本编辑器填写 `.env`：

| 配置 | 填什么 |
| --- | --- |
| `NAV_IMAGE` | 本版模板已填上方固定 Registry Digest，保留即可；如核对 SHA Tag，只认完整运行源码 361aaa6439ba16e3579d097629ac75fe2df4fc91，不用文档提交 SHA 或旧镜像 |
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

标准生产 Cookie 保持 `Secure`、`HttpOnly`、`SameSite=Lax`。不通过更改
`NODE_ENV` 适配 HTTP；只有上方显式 LAN 模式才使用非 Secure Cookie。不默认绑定
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

标准模式首次安装的推荐流程：**Docker Compose → 容器日志 → 一次性初始化验证码 →
网页创建管理员 → 登录**。

1. 在 NAS 的 **Docker → 容器 → 日志**（群晖 Container Manager 或威联通
   Container Station 中的 app 容器日志）找到 `[setup] First-run initialization code`。
   也可执行 `docker compose -f compose.install.yml logs app`。
2. 浏览器打开配置的 `BETTER_AUTH_URL`，看到“欢迎使用 Navlume”。填写管理员
   用户名、邮箱、密码、确认密码和一次性初始化验证码，点击“创建管理员账户”。
   用户名为 3–30 位字母、数字、下划线或点；密码为 8–128 位。
3. 创建成功后点击“进入登录页面”，使用新用户名和密码登录。然后在管理后台
   创建普通用户。

没有默认管理员密码。验证码仅在初始化尚未关闭且没有任何用户的全新实例启动时随机生成，
只输出一次到容器日志，有效期 60 分钟。**不要分享验证码，并限制容器日志
的查看权限**；日志读取权限相当于首次管理员创建授权。验证码不由网页返回。
过期后重启 app 并查看新的日志；重启前的验证码失效。错误验证码尝试过多时，
等待一分钟再试。

创建成功后网页初始化立即且持久关闭，删除全部用户后也不自动重开。已有任何用户的实例（包括只有普通用户的
实例）不会重新开放此入口；CLI 已创建管理员时也会关闭。首次初始化不等于
公开注册。标准模式非 localhost 访问仍须可信 HTTPS，与第 1 节 Origin 和 Secure Cookie
规则一致。

### CLI 备用方式（可选）

v0.1.3 沿用 v0.1.2 的网页流程；需要时仍可使用 CLI。历史版本 v0.1.0
没有网页初始化，创建首位管理员必须使用 CLI。

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
不要建立第二个应用项目。自 v0.1.2 起，标准模式可在容器日志中获取验证码，通过
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

### v0.1.2 → v0.1.3：只更换镜像

v0.1.3 无新增 Schema 迁移、API 或认证更改，沿用原 Docker 安装模型。以下步骤
适用于已审查的两个 Digest；不要据此推断任意未来版本都可直接降级。

1. 记录当前镜像 Digest、实际 Compose 项目名和 `/data` 卷名，保留原 Compose 与
   `.env`。可用 `docker inspect 原应用容器名` 核对项目标签与挂载；不要凭文件名猜卷名。
2. 按第 5 节停止原应用，完成数据库和完整 uploads 的物理备份，确认 `backup verified`，
   再复制到卷外并另存到安全位置。单独保存标准模式的原认证密钥与 Origin；LAN 必须
   保留完整 uploads，包括隐藏的 `.auth-secret`。卷内备份不是卷外备份。
3. 标准模式只修改原 `.env` 的 `NAV_IMAGE`；LAN 只修改**原** Compose 的 `image`，
   改为本文开头的 I2 Digest。保留原 Origin、认证密钥、项目名、数据卷及已有的
   external 卷配置、端口和安装模式。不要用全新 LAN 模板覆盖已有配置，也不要重新生成密钥。
4. 在原目录继续使用原 Compose 文件、项目和环境文件。下例为标准文件；LAN 将
   `-f` 改成原 `compose.lan.yml`。原来使用 `-p`、`--env-file` 或 NAS 项目名的，
   每条命令继续带相同设置，不另建项目：

```bash
docker compose -f compose.install.yml config --quiet
docker compose -f compose.install.yml pull
docker compose -f compose.install.yml up -d --no-build
docker compose -f compose.install.yml ps
```

5. 等待 `healthy`，用原账号登录，检查个人/公共网址、排序、管理员隐藏项、品牌与
   上传图片，再检查分类/顶部入口、个人和后台的移动操作。按原命令重启后确认保存状态。
   启动仍执行既有迁移检查，v0.1.3 没有新增迁移。

### 必要时回退至原 v0.1.2 镜像

已验证的 v0.1.2 Registry 引用为：

```text
ghcr.io/laohiog/navlume@sha256:f1178e3a8954c00e56e5c178006224d3421ee93b739a2d71025a1a71bb80be4d
```

先停止新 app，将原配置中的 image / NAV_IMAGE 改回上述 Digest，然后按同一项目、
同一卷、同一 Origin 和同一认证密钥执行 `pull`、`up -d --no-build`、`ps`。
不要并行运行两个共享 SQLite 卷的应用。健康后检查原账号、网址、排序、隐藏状态、
品牌、上传图片及重启持久化。

这两个版本已用隔离合成 v0.1.2 数据验证升级和**原卷回退**：新镜像写入的网址与
顺序修改在回退后仍保留。该证据不覆盖所有历史实例或未来版本。回退默认只换镜像，
**不把升级前备份覆盖到当前数据**。只有确认需要灾难恢复、接受丢失备份后数据时，
才另按第 5 节恢复；若发现真实数据或认证不兼容，停止操作并保留当前卷和日志。

`docker compose ... down` 保留 Named Volume，但 **`down -v` 会删除数据卷**。
不要执行 `down -v`，也不要在 NAS 界面勾选删除卷或数据。重建容器不会删除卷。
