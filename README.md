# Job Agent — 自动化求职助手

一个自动化的云工程师求职助手：从 50+ 家公司招聘页面抓取职位，根据你的简历智能匹配排序，每天自动发邮件通知你最新的机会。不用打开电脑也能用，手机、平板都能访问。

**目标岗位：** GCP / 云计算 / 平台工程 / SRE，远程优先，面向国内。

---

## 它能做什么

1. **自动抓取招聘网站** — 从 Cloudflare、Stripe、Databricks、SpaceX 等 50+ 家公司的官方招聘页面抓职位，全部免费，不需要付费订阅
2. **智能匹配排序** — 根据你的简历、技能、期望薪资，给每个职位打分（0-120分），分数越高越匹配
3. **在线仪表盘** — 一个网页界面，手机上也能打开，看到所有匹配的职位、你的操作记录
4. **每天自动发邮件** — 每天早上 8 点自动运行，把最新职位发到你邮箱，电脑不用开
5. **持续跟踪** — 你标记过的职位（已申请/已跳过/已收藏）会一直保存，不会重复出现

---

## 工作流程

```
┌─────────────────────┐     ┌─────────────────────┐     ┌─────────────────────┐
│   Cloudflare Worker │     │   GitHub Actions    │     │    你的邮箱          │
│   (每天 7:30 AM)     │────▶│   (每天 8:00 AM)     │────▶│                   │
│                     │     │                     │     │ 收到每日邮件 digest │
│ • 抓 20 家公司职位   │     │ • 抓 50 家公司职位   │     │  附带完整报告附件   │
│ • 存入在线数据库     │     │ • 生成 HTML 报告     │     │                   │
│ • 供仪表盘查询       │     │ • 附报告到邮件       │     │                   │
└─────────────────────┘     └─────────────────────┘     └─────────────────────┘
         │                                                         
         ▼                                                         
  https://job-agent-web....workers.dev                           
  任何设备都能打开的在线仪表盘                                       
```

---

## 在线仪表盘

**地址：** https://job-agent-web.clinton-s-almeida.workers.dev

打开后你可以：
- 查看所有匹配的职位列表，按匹配分数排序
- 点击 **"Apply"** 标记已申请（之后不会再出现）
- 点击 **"Skip"** 标记不感兴趣（跳过此职位）
- 点击 **"Save"** 收藏某个职位
- 点击 **"Scrape Now"** 手动触发一次抓取

所有操作都保存在云端，换设备、换浏览器都能看到你的记录。

---

## 项目结构

```
job-agent-web/
├── worker.js              # Cloudflare Worker — 在线服务（抓取 + 仪表盘 API）
├── server.js              # 本地 Express 服务（可选，本地开发用）
├── main.js                # 命令行入口（直接运行 node main.js --no-ai）
├── wrangler.toml          # Cloudflare Worker 配置（KV 存储 ID 等）
├── .env                   # 你的 API 密钥和邮箱（不被提交到 git）
├── src/
│   ├── scraper.js         # 爬虫 — 从各大招聘源抓职位数据
│   ├── matcher.js         # 匹配引擎 — 根据你的简历打分
│   ├── runner.js          # 流程控制 — 抓数据 → 打分 → 发邮件
│   ├── email.js           # 邮件发送（通过 Resend API）
│   ├── reporter.js        # HTML 报告生成
│   ├── onboarding.js      # 第一次使用的向导程序
│   ├── db.js              # 数据存储（SQLite / JSON 文件）
│   └── tracker.js         # 申请状态跟踪
├── public/
│   ├── index.html         # 仪表盘页面
│   ├── app.js             # 页面交互逻辑
│   └── styles.css         # 页面样式
├── data/
│   └── jobs.db.json       # 本地持久化数据库
└── .github/workflows/
    └── daily-jobs.yml     # GitHub Actions 定时任务（每天 8:00 AM IST）
```

---

## 快速上手（新手指南）

### 第一步：安装依赖

```bash
npm install
```

### 第二步：运行设置向导

```bash
node main.js --setup
```

向导会问你：
- 你的名字和联系方式
- 你期望的工作地点（远程 / 本地城市）
- 你的技能关键词（比如：GCP、Kubernetes、Terraform）
- 你期望的职位类型（GCP Engineer、Cloud Architect 等）
- 最低薪资期望

这些信息保存到 `data/profile.json`，后面匹配职位就用它来打分。

### 第三步：配置邮件通知（可选但推荐）

创建一个 `.env` 文件，填入你的配置：

```bash
# 邮件通知（必须）
RESEND_API_KEY=your_resend_api_key
EMAIL_TO=your@email.com

# AI 简历优化（可选）
ANTHROPIC_API_KEY=your_anthropic_key

# LinkedIn 数据（可选，需要浏览器 cookies）
LINKEDIN_COOKIES=your_session_cookies
```

**怎么获取 Resend API Key：**
1. 访问 https://resend.com
2. 注册免费账号
3. 进入 API Keys 页面 → Create API Key
4. 免费额度：每天 100 封邮件

### 第四步：运行第一次

```bash
# 本地运行（不需要 AI）
node main.js --no-ai

# 或者启动本地仪表盘
npm start
# 然后打开 http://localhost:3000
```

---

## 自动定时运行（GitHub Actions）

**推荐方式。** 在 GitHub 上自动每天运行，你的电脑关机也没关系。

### 配置步骤

1. 去你的 GitHub 仓库 → Settings → Secrets and variables → Actions → New repository secret

2. 添加以下密钥：

| 密钥名 | 值 |
|--------|-----|
| `RESEND_API_KEY` | 你的 Resend API Key |
| `EMAIL_TO` | 你的收件邮箱 |

可选密钥：
| 密钥名 | 值 |
|--------|-----|
| `ANTHROPIC_API_KEY` | Anthropic API Key（用于 AI 简历优化） |
| `LINKEDIN_COOKIES` | LinkedIn 登录 cookies |

3. 每天自动运行时间：**北京时间早上 8:00**

### 运行效果

每次运行你会收到两封邮件：
1. **摘要邮件** — 包含 Top 5 推荐职位 + 仪表盘链接
2. **附件邮件** — 完整的 HTML 报告（含所有匹配职位）

### 手动触发测试

在 GitHub 仓库页面 → Actions → Daily Job Agent → "Run workflow"

---

## Cloudflare Workers 部署（可选）

如果你希望仪表盘 **永远在线**，可以在 Cloudflare 上部署。

### 前提条件

- 有一个 Cloudflare 账号（免费注册）
- 安装了 Wrangler CLI

### 部署步骤

```bash
# 1. 安装 Wrangler
npm install -g wrangler

# 2. 登录 Cloudflare
wrangler login

# 3. 创建 KV 存储（用来保存职位数据）
wrangler kv namespace create JOBS_KV

# 4. 把得到的 ID 填入 wrangler.toml 中的 id 和 preview_id

# 5. 设置密钥
wrangler secret put RESEND_API_KEY
wrangler secret put EMAIL_TO

# 6. 部署
wrangler deploy
```

部署后你的仪表盘会在：`https://job-agent-web.<你的子域名>.workers.dev`

### 注意事项

- Cloudflare 免费版有 CPU 时间限制，所以在线抓取只用了 20 家公司（速度更快）
- GitHub Actions 全天运行，会用全部 50 家公司（数据更全）
- 两个系统独立工作，互不影响

---

## 职位来源

### 已确认可用的来源

| 来源 | 数量 | 说明 |
|------|------|------|
| **Greenhouse API** | 50 家 | 直接使用公司招聘 API，无付费墙 |
| **LinkedIn RSS** | 实时 | 软性抓取，结果有限 |

### 已尝试但被屏蔽的来源

| 来源 | 状态 | 原因 |
|------|------|------|
| Naukri / Indeed | ❌ | 阻止自动化访问 |
| RemoteOK / WeWorkRemotely | ❌ | 需要付费订阅 |

### 常用的 Greenhouse 公司示例

**国内热门：** 百度、滴滴、Coupang（韩国）、Mercari（日本）

**海外远程友好：** Cloudflare、Stripe、Datadog、Databricks、MongoDB、Elastic、Okta、Figma、Vercel、Airbnb、Discord、Twitch、Reddit

**航天/军工：** SpaceX、RocketLab、Relativity Space

> 想添加更多公司？在 `src/scraper.js` 的 `boards` 数组中添加公司名称即可。

---

## 职位打分规则

每个职位根据以下维度打分（满分 120+）：

| 维度 | 权重 | 说明 |
|------|------|------|
| 职位标题精确匹配 | 40 分 | 完全匹配你期望的职位类型 |
| 职位标题模糊匹配 | 25 分 | 相似但不同表述（如 "云平台工程师" vs "GCP Engineer"） |
| 核心技能匹配 | 15 分 | 要求你在技能列表中 |
| 加分技能匹配 | 5 分 | 额外的技术栈匹配 |
| 远程支持 | 20 分 | 确认提供远程工作 |
| 混合办公 | 10 分 | 混合办公且在你喜欢的城市 |
| 地点匹配 | 15 分 | 工作地点在你的偏好范围内 |
| 全职/永久 | 10 分 | 正式全职岗位 |
| 薪资达标 | 10 分 | 符合你的最低薪资期望 |
| 发布时间 | 10 分 | 7 天内发布的优先 |

**自动过滤规则：**
- 销售/市场/HR 类职位会被直接排除
- 薪资不符合要求的职位会降低排名
- 低于 20 分的职位不会出现在结果中

---

## 常见问题

### 没有搜到职位怎么办？

手动测试抓取：
```bash
node -e "const { scrapeAllSources } = require('./src/scraper'); scrapeAllSources(['GCP']).then(j => console.log(j.length, 'jobs'))"
```

### 仪表盘打不开？

```bash
# 检查是否有进程占用了 3000 端口
netstat -ano | findstr :3000

# 杀掉旧进程
taskkill /IM node.exe /F

# 重新启动
npm start
```

### 收不到邮件？

1. 检查 `.env` 里 `RESEND_API_KEY` 是否正确
2. 查看垃圾邮件文件夹
3. 访问 https://resend.com 查看发送记录

### LinkedIn 返回空结果？

Cookie 过期了。需要重新获取：
1. 登录 LinkedIn
2. 按 F12 → Network 标签 → 刷新页面
3. 点任意请求 → Headers → Request Headers
4. 找到 `cookie:` 那一行，复制值
5. 填入 `.env` 的 `LINKEDIN_COOKIES`

> 注意：LinkedIn cookies 几天后会失效，需要定期更新。

### 在线仪表盘显示的是旧数据？

点击右上角的 **"Scrape Now"** 按钮手动刷新，或者等明天早上 7:30 自动更新。

---

## License

ISC
