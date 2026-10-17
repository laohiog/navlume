# UI-REDESIGN-v2 P0 验收记录

完成日期：2026-10-17。范围为 P0-1～P0-10：原生删除确认及其结果判断修复、图片显式尺寸与占位、主按钮品牌色、搜索无结果与计数、个人空状态、错误恢复、移动浮动导航、QuickAdd 模态、theme-color 与跳转主内容。保留既有业务、权限、API、URL 和剪贴板契约，不包含 P1/P2。

2026-10-17，Chris 批准将**全站首次启动 CLS < 0.1** 移出本轮 P0 的阻断验收条件。首页异步加载 CLS 仍是独立已知问题，**未修复，生产环境未验证**；不采用延迟展示已可用公共导航结果的方案，也不修改历史设计原稿。

图片尺寸与稳定占位仍是 P0 要求。现有 4 处图片均有显式 width/height；既有隔离 Chromium 测量覆盖 375×812 和 1440×1000 视口，9 次启动场景将图片加载延迟 5 秒，额外布局位移均为 0，图片及卡片盒子保持不变。这是模拟 API 下的图片占位证据，不代表整体 CLS 达标或生产性能验证。

最小核验：`npm run typecheck`、`npm run lint` 通过；以下定向测试共 138 项通过：

- `tests/client/p0-accessibility-view.test.tsx`
- `tests/client/confirmation-result.test.ts`
- `tests/client/quick-add.test.ts`
- `tests/client/navigation-search.test.ts`

复用相同客户端源码版本的浏览器证据：QuickAdd 三入口、剪贴板回退、键盘与焦点、搜索、移动视口和主题/品牌组合已检查；确认框仅在 `status === 'ok'` 时关闭，失败可重试，忙碌期间防重复，保留上层会话处理。真实部署和真实数据写入未作本轮浏览器验证。

Git 检查点基于 `756041d0c041ce9519ca2e0ab66684de0b0d7c61`，本记录随 `feat(ui): complete UI-REDESIGN-v2 P0 usability and accessibility` 本地提交保存，可用 `git log -1 -- docs/UI-REDESIGN-v2-P0.md` 定位。候选 `tokens.css` 未导入、未纳入检查点；未推送、未发布或部署。
