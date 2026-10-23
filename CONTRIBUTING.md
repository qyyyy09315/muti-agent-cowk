# 贡献指南（CONTRIBUTING）

感谢参与本项目。本仓库采用 **PR 工作流**：所有改动先开 Pull Request，由仓库所有者 [@qyyyy09315](https://github.com/qyyyy09315) 审阅后合并。`main` 分支受保护，直接推送会被拒绝。

## 1. 分支与提交

**分支命名**：`类型/简短描述`，与 PR 标题对应。

```
fix/dashboard-date-time      # 缺陷修复
feat/worker-message-listener # 新功能
docs/readme-structure        # 文档
chore/deps-update            # 构建、依赖
```

**提交信息**：遵循 Conventional Commits，格式 `类型(范围): 摘要`。

```
fix(hub): 控制台时间显示补充完整日期
feat(monitor): light theme and actionable token permission errors
docs(readme): rewrite in Chinese with academic structure and diagrams
```

常用类型：`feat`、`fix`、`docs`、`refactor`、`test`、`chore`；范围使用受影响的模块名（`hub`、`worker`、`monitor`、`uvcs` 等）。提交前确认本地 `git config user.email` 使用 GitHub noreply 邮箱（形如 `ID+用户名@users.noreply.github.com`），不要用真实邮箱。

## 2. 开发流程

```bash
# 1. 从最新 main 建分支
git checkout main && git pull origin main
git checkout -b feat/your-branch-name

# 2. 开发，保持改动聚焦
# 3. 构建与全量测试（见第 3 节）
pnpm install
pnpm build
pnpm test

# 4. 界面改动需自行运行并截图（见第 4 节）

# 5. 推送并开 PR
git push -u origin feat/your-branch-name
```

**改动聚焦**：一个 PR 只解决一件事。不要夹带无关的格式化、重构或依赖变更；确需附带时在描述中单列说明。

## 3. 测试要求（高标准）

`pnpm test` 是合并的**最低门槛**，包含契约、Hub、Worker、UVCS、本机监视台与协作运行时全部自动化测试（当前 64 项）。PR 描述中必须贴出实际运行结果：

```
pnpm test
# contracts      7 passed
# uvcs-workspace 4 passed
# hub           12 passed
# worker        13 passed
# monitor       10 passed
# collaboration 18 passed
```

在此之上：

1. **新行为必须有对应测试**。修 bug 先写能复现的失败测试再修；新功能带集成或单元测试。只改注释、纯文档的 PR 可豁免。
2. **禁止为通过测试而放松断言**。如果一条断言挡住了你，先判断是代码错了还是断言错了；确属后者时在 PR 中说明理由。
3. **端到端改动跑真实链路**。涉及 Worker、Hub 调度或消息流转的 PR，跑 `node --test tests/e2e-workflow.test.mjs tests/message-listener.test.mjs`，并在本地起 Hub 验证一遍真实 HTTP 流程。
4. **故障路径优先**。涉及租约、锁、清理、重试的逻辑，必须覆盖失败场景（日志缺失、锁竞争、租约过期、备份失败），确认系统按预期熔断或冻结，而不是只在成功路径上通过。
5. **不调用生产环境**。所有测试使用本地 Hub、模拟子进程与临时目录；任何测试不得携带真实域名、令牌或指向线上服务。

## 4. 界面改动：自行运行测试并提供截图

凡是改动用户可见界面的 PR（Hub 控制台 `apps/hub/public/index.html`、本机监视台 `scripts/worker-monitor/public/`），除自动化测试外**必须**：

1. **实际运行界面**：
   - 控制台：本地起 Hub 后打开页面，操作受影响的区域（表格、弹窗、页签、筛选等）；
   - 监视台：`node scripts/worker-monitor/server.mjs --profile <profile>` 后打开 `http://127.0.0.1:8787/`。
2. **在 PR 中附截图**：至少一张改动区域的截图；改动大或影响布局/交互时，提供前后对比（改前 + 改后），必要时补窄屏（≤760px）视图。
3. **说明验证内容**：截图中能看到什么、手动验证了哪些状态（空数据、加载中、错误态、正常数据）。

截图直接拖进 PR 描述输入框即可上传。没有截图的界面改动 PR 不会被批准。

> 判断标准：改动很大时提供改前/改后与多状态截图；只调整一处样式时，一张改后截图 + 一句验证说明即可。

## 5. PR 描述模板

```markdown
## 问题与修改
<背景：现在的行为哪里不对；本 PR 做了什么。>

## 实现说明
<关键决策、改动面（涉及哪些模块、是否触碰鉴权/调度/存储）。>

## 验证
- pnpm test 输出（各包通过数）
- 界面改动：运行方式 + 截图
- 手动验证过的失败路径

## 部署
<是否包含线上部署；不含则由仓库方决定发布时机。>
```

## 6. 审阅与合并

- **只有 [@qyyyy09315](https://github.com/qyyyy09315) 可以批准并合并 PR**；`main` 的分支保护强制了这一点。
- 审阅意见分两级：**阻断项**（安全、正确性、缺测试、缺截图）必须解决后重审；**建议项**（样式、措辞）标注“不阻断”，作者自行取舍。
- 合并方式为 merge commit；合并后分支自动删除。
- PR 描述未声明部署的，默认不含部署，线上发布由仓库方执行。

## 7. 安全红线

以下内容**严禁**出现在代码、测试夹具、文档、截图和提交历史中：

- 真实域名、公网 IP、服务器地址
- 任何令牌、口令、Cookie、密钥（包括测试用的真实凭据；夹具一律用 `example`、`fixture`、`do-not-leak` 类占位值）
- 账号名、主机名、本机绝对路径等可识别部署环境的信息

提交前自查：`git diff | grep -nE "jidian|([0-9]{1,3}\.){3}[0-9]{1,3}|ac_[A-Za-z0-9]{16,}|123456"`。发现已提交的泄露立即报告仓库所有者，不要自行 force push。

## 8. 联系

行为问题、安全上报或其他需要私下沟通的事项，直接联系 [@qyyyy09315](https://github.com/qyyyy09315)。
