# Navlume — Data Model

**Status:** Logical model

本文件描述数据归属、逻辑实体和不变量。实际字段、约束与迁移以
`src/db/schema.ts`、`src/db/auth-schema.ts` 和 `src/db/migrations/` 为准。

## 1. Data Ownership Model

数据分为两类：

### Public Data

属于站点。

由 Admin 管理。

包括：

* site_settings
* public_categories
* public_links

### Personal Data

属于具体 authenticated user。

包括：

* personal_categories
* personal_links

Authentication tables 由 Better Auth 管理。

## 2. Why Public and Personal Tables Are Separate

MVP 不采用：

`links + scope + owner + tenant`

这样的万能表。

使用显式表：

* public_categories
* public_links
* personal_categories
* personal_links

允许少量字段重复，以换取：

* 更简单的 Authorization
* 更清晰的数据归属
* 更低的跨用户泄漏风险
* 更容易让开发 Agent 理解和测试

## 3. site_settings

逻辑字段：

* id
* site_name
* tagline
* logo_path
* favicon_path
* primary_color
* page_background_color
* surface_color
* background_image_path
* default_theme
* footer_text
* access_mode
* created_at
* updated_at

`access_mode`：

* public
* login_required

MVP 只需要一个有效站点配置。

BRP1.1 品牌扩展：`page_background_color`、`surface_color` 是 nullable 的严格
`#RRGGBB` 颜色，存储时统一大写；`background_image_path` 是 nullable 的服务端管理
图片路径。三个字段迁移时默认 NULL。当前设置更新省略新颜色时保留已有值，显式
null 清除。逻辑 JSON v1 携带两个颜色；Logo、Favicon、Background 图片路径均为
实例本地资源，导入时保留目标实例路径，不参与逻辑导出。

## 4. public_categories

逻辑字段：

* id
* name
* icon
* sort_order
* is_visible
* created_at
* updated_at

## 5. public_links

逻辑字段：

* id
* category_id
* title
* url
* description
* icon_url
* sort_order
* is_visible
* created_at
* updated_at

关系：

public_link 属于一个 public_category。

## 6. personal_categories

逻辑字段：

* id
* user_id
* name
* sort_order
* is_default
* created_at
* updated_at

每个新用户首次使用个人导航时需要：

**我的常用**

默认：

`is_default = true`

具体唯一性约束在实现阶段根据最简单可靠方案确定，但必须保证用户有明确默认添加目标。

## 7. personal_links

逻辑字段：

* id
* user_id
* category_id
* title
* url
* normalized_url
* icon_url
* sort_order
* created_at
* updated_at

关系：

personal_link：

* 属于一个 authenticated user；
* 属于该用户自己的 personal_category。

## 8. Critical Ownership Invariant

任何 Personal Data 查询和写入都必须绑定：

`current authenticated user`

概念上必须等价于：

`WHERE user_id = currentUser.id`

`currentUser.id` 必须来自服务端认证 Session。

不得根据 Request Body、Query String 或客户端状态中的 userId 决定资源归属。

## 9. Cross-user Isolation

必须保证：

User A：

* 不能读取 User B personal categories；
* 不能读取 User B personal links；
* 不能修改或删除 User B 数据。

User 不得修改 Public Data。

Admin 才能执行 Public Data 管理。

这是 P2/P3 的 C 级严格验证内容。

## 10. URL Data Rules

原始 URL 保存在：

`url`

规范化 URL 保存在：

`normalized_url`

允许的规范化范围：

* trim
* scheme normalization
* hostname lowercase
* remove fragment
* standard URL serialization

不得随意删除 Query Parameters。

只接受 HTTP/HTTPS。

## 11. Ordering

Category 和 Link 使用：

`sort_order`

实现应保持排序逻辑简单、可预测。

不得为 MVP 引入复杂 ranking 系统。

## 12. Delete / Migration Integrity

删除、级联行为和数据库级 constraints 应在相关实现阶段明确设计并验证。

不得在 P0 假装已经确定尚未实现的数据库行为。

原则：

* 不产生 orphan records；
* 不跨用户影响数据；
* Migration 可重复执行并可验证；
* Import 必须 validate 后再 transaction 写入。
