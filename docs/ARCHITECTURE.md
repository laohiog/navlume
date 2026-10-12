# Navlume — Architecture

**Status:** Baseline
**Architecture Scope:** MVP

本文件定义固定技术基线和架构边界。

除非存在明确技术阻塞、安全问题或已经确认的需求无法实现，否则不得修改这些决策。

## 1. Architecture Principles

优先顺序：

1. Correctness
2. Security
3. Data Integrity
4. UX
5. Simplicity
6. Maintainability
7. Development Speed
8. Extensibility
9. Novelty

优先选择：

**最简单、明确、依赖少、容易测试和维护的方案。**

## 2. Fixed Technology Baseline

Runtime:

* Node.js
* TypeScript

Backend:

* Hono

Frontend:

* React
* Vite
* TypeScript SPA

Database:

* SQLite
* better-sqlite3
* Drizzle ORM

Authentication:

* Better Auth

Deployment:

* Single Git Repository
* Single Application
* Single SQLite Database
* Frontend / Backend Same-Origin
* Single Docker Application Container
* Persistent Volume

Package Manager:

* npm

## 3. Explicitly Avoid

MVP 默认禁止引入：

* Microservices
* Redis
* PostgreSQL
* MySQL
* MongoDB
* GraphQL
* tRPC
* Kubernetes
* Monorepo
* SSR
* Event Bus
* CQRS
* 不必要的抽象层

不得因为“未来可能需要”提前加入。

## 4. Runtime Topology

目标部署模型：

Browser
→ HTTPS / Reverse Proxy
→ Navigation Application

* React static assets
* Hono API
* Authentication
* SQLite access
  → Persistent Volume

Persistent Volume 至少保存：

* SQLite database
* uploaded brand assets
* backup-related persistent files

## 5. Same-Origin Rule

Frontend 和 API 使用同一 Origin。

示例：

* `/`
* `/api/*`

这样可以降低：

* CORS
* cross-origin cookies
* auth/session configuration

的复杂度。

除非已经证明有必要，否则不得拆分前后端域名。

## 6. Application Boundaries

推荐代码区域：

`src/client/`

负责：

* React UI
* pages
* components
* client-side search
* API client
* Quick Add UX

`src/server/`

负责：

* Hono routes
* middleware
* authorization
* server-side validation
* auth integration
* import/export
* static frontend serving

`src/db/`

负责：

* database connection
* Drizzle schema
* migrations

不要建立大量无实际价值的架构层。

## 7. Server as Source of Truth

个人导航的事实源是服务器 SQLite。

MVP 不建立复杂 Sync Engine。

设备：

Office PC
Home PC
Phone

都直接访问服务器。

数据修改直接写服务器数据库。

其它设备重新加载或重新获取数据即可看到变化。

MVP 不需要：

* WebSocket
* CRDT
* Realtime Database
* background sync

并发修改采用简单策略，不为低频导航数据提前设计复杂冲突系统。

## 8. Authentication

认证由 Better Auth 提供。

不得自行实现：

* password hashing framework
* custom session token system
* home-grown authentication framework

公司模式默认关闭 Public Signup。

用户由管理员创建。

Authorization 必须在 Server 执行。

## 9. Security Boundaries

### Personal resources

资源归属必须来自：

**authenticated server session user ID**

不得信任客户端提供的 `userId`。

### Admin resources

Admin authorization 必须在 Server 验证。

隐藏前端按钮不构成权限保护。

### XSS

用户输入默认按文本处理。

### URL

只允许 HTTP/HTTPS。

### Server-side URL fetch

MVP 禁止服务器访问任意用户 URL。

### Upload

后续实现上传时必须限制：

* MIME/type
* size

服务器生成存储文件名。

## 10. Architecture Change Policy

P1 开始后以下决策视为冻结：

* Node + TypeScript
* Hono
* React/Vite
* SQLite
* Drizzle
* Better Auth
* single repo
* single app
* single database
* same-origin
* Docker

架构修改必须先说明：

* 当前方案的明确阻塞；
* 修改收益；
* 新增复杂度；
* 返工成本；
* MVP 周期影响。

重大修改需要 Human Decision。
