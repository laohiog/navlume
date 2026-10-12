# Navlume — Product Definition

**Status:** Baseline
**Phase:** MVP
**Authority:** 本文件定义产品目标、用户模型、MVP Scope 和 UX 原则。

如果本文件与实现发生冲突，不应静默修改产品定义；重大 Scope Change 需要 Human Decision。

## 1. Product Vision

Navlume 是一个：

**轻量、自托管、可品牌化、支持公共导航、个人导航和多设备同步的网址导航平台。**

核心原则：

**Simple · Brandable · Self-hosted · Portable · Fast**

典型用途包括公司导航和个人导航站。产品本身不绑定任何实例品牌。

## 2. Core Product

Core 只围绕：

1. 找到并打开网址；
2. 添加、整理、搜索和同步网址；
3. 公共导航和个人导航；
4. 品牌化；
5. 简单部署、迁移和维护。

本项目不是 Dashboard 平台。

天气、RSS、服务器监控、Docker/NAS 状态、AI 和复杂 Widget 不属于 Core。

## 3. Deployment Model

采用：

**Single-instance, Multi-brandable**

不是：

**Multi-tenant SaaS**

每个部署实例拥有自己的：

* Branding
* Users
* Public Navigation
* Personal Navigation
* SQLite Database

同一套代码可部署成：

* Example Company Navigation
* Personal Navigation
* Other Brand Navigation

品牌变化不得要求修改业务代码。

## 4. User States

MVP 只有三种用户状态：

### Guest

可以查看允许公开访问的公共导航。

### User

可以：

* 查看公共导航；
* 查看自己的个人导航；
* 管理自己的个人分类；
* 管理自己的个人网址；
* 使用“我的常用”；
* 在不同设备登录后看到同一套个人数据。

### Admin

拥有 User 能力，并可以：

* 管理公共分类；
* 管理公共网址；
* 管理用户；
* 修改 Branding；
* 执行管理员级导入导出和备份相关操作。

MVP 不增加 Editor、Reviewer、Department Admin 等复杂角色。

## 5. Data Ownership

公共导航属于站点，由 Admin 管理。

个人导航属于具体用户。

每个用户拥有：

* 我的常用；
* Personal Categories；
* Personal Links。

个人数据必须保存在服务器。

服务器数据库是跨设备同步的事实源。

用户在：

* 办公室电脑；
* 家里电脑；
* 手机；

登录同一账号后，应获得同一套个人导航。

## 6. MVP Primary Journey

MVP 必须完成以下闭环：

部署
→ 创建管理员
→ 创建用户
→ 用户登录
→ 查看公共导航
→ 查看个人导航
→ 复制一个网址
→ 点击“＋ 添加网址”
→ Clipboard 或手动粘贴
→ 保存到“我的常用”或指定分类
→ 换另一设备登录
→ 看到同一网址。

这个闭环是 MVP 的核心产品验收标准。

## 7. MVP In Scope

* Public Navigation
* Personal Navigation
* Multi-device Sync
* Authentication
* Authorization
* User Data Isolation
* 我的常用
* Category CRUD
* Link CRUD
* Quick Add
* Clipboard Read
* Manual Paste Fallback
* Contextual Add
* Ctrl+V Quick Add
* URL Validation
* Search
* Responsive Desktop/Mobile UI
* Admin
* Branding
* JSON Import/Export
* SQLite Backup/Restore
* Docker Deployment

## 8. MVP Out of Scope

明确禁止进入 MVP：

* Multi-tenant SaaS
* Organization/Department permission system
* SSO / LDAP
* Social Login
* Passkey / 2FA
* PWA
* Browser Extension
* Mobile App
* Share Target
* WebSocket
* CRDT
* Complex realtime sync
* Offline conflict resolution
* AI Search / AI Classification
* Metadata Crawler
* Web Archive
* Weather
* RSS
* CPU/RAM Monitor
* Docker/NAS Monitor
* Plugin System
* Widget System
* Theme Marketplace
* Page Builder
* Complex Analytics
* Blog / Comments / Social Features

未来真实需求不得成为当前架构复杂化的理由。

## 9. UX Principles

适老化和低学习成本是核心要求。

普通用户应能在约 10 秒内完成：

**复制网址 → 加入自己的导航**

始终保留明显入口：

**＋ 添加网址**

Clipboard API 只是增强能力。

读取失败时必须自动退回手动粘贴，不向普通用户显示 Clipboard API、DOMException 或权限技术错误。

快捷键属于增强能力，不能替代显式 UI。

## 10. URL Rules

MVP 仅接受：

* HTTP
* HTTPS

用户输入 `example.com` 时可尝试补全为：

`https://example.com`

拒绝：

* javascript:
* data:
* file:
* ftp:

不要激进修改 Query Parameters。

## 11. Metadata Policy

MVP 不允许服务器主动访问任意用户提交 URL 来抓取：

* title
* OpenGraph
* description
* favicon

避免引入 SSRF 风险。

MVP 可以使用 hostname 作为默认标题，并使用安全的客户端 favicon fallback 或默认图标。

## 12. MVP Completion

P0–P6 全部通过 Required Verification 后，MVP 即完成。

不得因为 Future Features 尚未开发而延迟 MVP Release。
