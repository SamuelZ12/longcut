# LongCut 完整排错清单与优化方法

> 版本: 1.0
> 更新: 2025-01-31
> 基于: 三位审核者的架构审查意见

---

## 目录

1. [问题清单（按优先级）](#一问题清单按优先级)
2. [功能排查清单（按场景）](#二功能排查清单按场景)
3. [数据完整性验证](#三数据完整性验证)
4. [环境一致性检查](#四环境一致性检查)
5. [功能走查测试方案](#五功能走查测试方案)
6. [前端稳定性验证](#六前端稳定性验证)
7. [日志与监控建议](#七日志与监控建议)
8. [快速诊断命令](#八快速诊断命令)

---

## 一、问题清单（按优先级）

### P0 - 高优先级（安全/功能漏洞）

#### 1. 空数组永久缓存问题
**文件**: `app/api/video-analysis/route.ts:130`

```typescript
// 当前逻辑（有问题）
const isCachedAnalysis = Boolean(cachedVideo?.topics);

if (!forceRegenerate && cachedVideo && cachedVideo.topics) {
  return cachedVideo; // ❌ 空数组 [] 也会通过
}
```

**问题**: 如果历史上因异常/中断保存了 `topics: []`，用户将永远得到空结果，无法恢复

**排查 SQL**:
```sql
SELECT youtube_id, title, created_at
FROM video_analyses
WHERE topics = '[]' OR topics IS NULL;
```

**解决方法**:
```typescript
// 方案 1: 将空数组视为无效缓存
const isValidCache = cachedVideo?.topics && cachedVideo.topics.length > 0;

// 方案 2: 空缓存触发再生成并覆盖
if (cachedVideo?.topics?.length === 0) {
  forceRegenerate = true;
}
```

---

#### 2. CORS 环境变量错误
**文件**: `lib/security-middleware.ts:169`

```typescript
// 当前（错误）
const allowedOrigins = [
  process.env.NEXT_PUBLIC_BASE_URL,  // ❌
  'http://localhost:3000',
];

// 应为
const allowedOrigins = [
  process.env.NEXT_PUBLIC_APP_URL,  // ✓
  'http://localhost:3000',
];
```

**排查**: 检查 `.env.local` 中 `NEXT_PUBLIC_APP_URL` 是否正确设置

**影响**: 跨域请求可能失败，CORS 配置不生效

---

#### 3. Signout 端点缺少 CSRF 保护
**文件**: `app/api/auth/signout/route.ts`

**问题**: 允许跨站登出攻击（CSRF）

**解决方法**:
```typescript
import { withSecurity } from '@/lib/security-middleware';

async function handler(req: NextRequest) {
  // 现有逻辑
}

export const POST = withSecurity(handler, {
  requireAuth: true,
  csrfProtection: true,
  allowedMethods: ['POST']
});
```

---

#### 4. 速率限制使用完整 URL 作为 key
**文件**: `lib/rate-limiter.ts:72`

**问题**: `/api/check-video-cache?videoId=abc` 和 `?videoId=xyz` 有独立限制

**当前逻辑**:
```typescript
const rateLimitKey = `ratelimit:${key}:${identifier}`;
// key 来自 req.url，包含查询字符串
```

**解决方法**:
```typescript
// 只使用路径作为 key
const url = new URL(req.url);
const pathKey = `${url.pathname}:${identifier}`;
```

---

### P1 - 中优先级（稳定性/性能）

#### 5. Provider Preference 端点缺少速率限制
**文件**: `app/api/ai/provider/route.ts`

**问题**: GET/POST 端点无速率限制，可能被滥用

**解决方法**:
```typescript
import { withSecurity, SECURITY_PRESETS } from '@/lib/security-middleware';

export const GET = withSecurity(handler, SECURITY_PRESETS.READ_ONLY);

export const POST = withSecurity(postHandler, {
  ...SECURITY_PRESETS.PUBLIC,
  rateLimit: { windowMs: 60000, maxRequests: 10 }
});
```

---

#### 6. 前端状态机竞态条件
**文件**: `app/analyze/[videoId]/page.tsx` (2,582 行)

**问题表现**:
- 主题切换触发并发请求
- 语言切换与 AI 生成同时进行导致状态错位
- 多次快速点击视频 URL 导致重复分析

**排查方法**:
1. 打开浏览器 Network 面板
2. 快速切换主题/语言
3. 观察是否有多个 `/api/video-analysis` 请求同时进行
4. 检查最终状态是否与最后一次请求一致

**临时缓解**:
- 前端添加请求防抖/节流
- 使用 AbortManager 取消进行中的请求

**根本解决**: 拆分大组件，独立状态管理

---

#### 7. AI Provider Fallback 不完整
**文件**: `lib/ai-providers/registry.ts:81-93`

**当前逻辑**:
```typescript
function isRetryableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const lowerMessage = message.toLowerCase();
  return (
    lowerMessage.includes('service unavailable') ||
    lowerMessage.includes('503') ||
    lowerMessage.includes('502') ||
    lowerMessage.includes('504') ||
    lowerMessage.includes('timeout') ||
    lowerMessage.includes('overload')
  );
}
```

**问题**:
- 配置缺失（API Key 未设置）不会触发 fallback
- JSON 解析失败可能不被识别为可重试

**排查**:
- 测试各 provider API Key 失效时的行为
- 测试结构化输出返回无效 JSON 时的行为

---

#### 8. 非原子速率限制清理
**文件**: `lib/rate-limiter.ts:122-125`

**问题**: 每次请求执行全表 `DELETE`，高并发时性能问题

**当前逻辑**:
```typescript
// 每次请求都执行全表清理
await supabase
  .from('rate_limits')
  .delete()
  .lt('timestamp', new Date(windowStart).toISOString());
```

**解决方法**: 只清理当前 key 的旧记录

---

### P2 - 低优先级（可维护性）

#### 9. 大组件文件
**文件**: `app/analyze/[videoId]/page.tsx` (2,582 行)

**影响**: 可维护性降低

**建议拆分**:
```
hooks/
  ├── useVideoAnalysis.ts      # 分析状态管理
  ├── usePlaybackCommand.ts    # 播放命令逻辑
  └── useThemeTopics.ts        # 主题话题管理

components/analyze/
  ├── AnalysisWorkspace.tsx    # 主布局
  ├── LeftPanel.tsx            # 左侧面板
  ├── RightPanel.tsx           # 右侧面板
  └── LoadingStages.tsx        # 加载阶段展示
```

---

#### 10. 缺少关键流程日志
**影响**: 无法快速定位问题来源

**需要添加日志的关键点**:

| 流程 | 当前状态 | 建议 |
|------|----------|------|
| 转录获取 | 基础日志 | 添加单位判定结果 |
| AI 生成 | Provider 日志 | 添加 fallback 路径 |
| 保存到数据库 | 重试日志 | 添加 video_id 关联 |
| 计费消费 | 错误日志 | 添加用户/视频关联 |
| 限流拦截 | 当前状态 | 添加 key/remaining/retryAfter |
| 前端状态转换 | 无日志 | 添加状态变更/耗时 |

---

## 二、功能排查清单（按场景）

### 场景 1: 视频分析失败/卡住

| 检查项 | 位置 | 操作 |
|--------|------|------|
| 环境变量完整 | `.env.local` | 确认 XAI/Gemini/SUPADATA/Supabase/CSRF 变量 |
| API Key 有效 | 各服务提供商控制台 | 验证密钥未过期 |
| 转录获取成功 | `app/api/transcript/route.ts:85` | 检查单位判定逻辑 |
| 速率限制触发 | `lib/rate-limiter.ts` | 清理 `rate_limits` 表旧记录 |
| CSRF Token 有效 | 浏览器开发者工具 | 检查 `csrf-token` cookie |
| AI Provider 可用 | `lib/ai-providers/registry.ts` | 确认至少一个 provider 配置正确 |

---

### 场景 2: 点击高亮不跳转/跳转偏移

| 检查项 | 位置 | 操作 |
|--------|------|------|
| 时间戳单位 | `app/api/transcript/route.ts:85` | 确认毫秒/秒转换正确 |
| 引用匹配 | `lib/quote-matcher.ts` | 验证 Boyer-Moore 搜索结果 |
| 段落索引 | Topic.segments | 检查 startSegmentIdx/endSegmentIdx |
| 字符偏移 | Topic.segments | 检查 startCharOffset/endCharOffset |

---

### 场景 3: 收到 401/403/429 错误

| 检查项 | 位置 | 操作 |
|--------|------|------|
| 认证状态 | `lib/security-middleware.ts:50` | 确认用户登录有效 |
| CSRF Token | `lib/csrf-protection.ts:70` | 重新获取 token |
| 速率限制 | `lib/rate-limiter.ts:140` | 检查 remaining/retryAfter |
| CORS 配置 | `lib/security-middleware.ts:167` | 验证 origin 是否在允许列表 |
| 调用方式 | 前端代码 | 确认使用 `csrfFetch` 而非原生 `fetch` |

---

### 场景 4: 缓存内容未更新/显示旧数据

| 检查项 | 位置 | 操作 |
|--------|------|------|
| 缓存命中 | `app/api/video-analysis/route.ts:120` | 检查 cachedVideo |
| 空数组陷阱 | `app/api/video-analysis/route.ts:130` | 检查 topics 是否为空数组 |
| 强制再生成 | 前端调用 | 传入 `forceRegenerate: true` |
| 数据库记录 | Supabase `video_analyses` | 手动删除旧记录 |

---

### 场景 5: CSP 阻止请求

| 检查项 | 位置 | 操作 |
|--------|------|------|
| CSP 规则 | `middleware.ts:24` | 检查 connect-src |
| Supabase 域名 | `.env.local` | 确认 `NEXT_PUBLIC_SUPABASE_URL` 正确 |
| 控制台错误 | 浏览器开发者工具 | 查找 CSP 违规报告 |

---

### 场景 6: Provider Fallback 未生效

| 检查项 | 位置 | 操作 |
|--------|------|------|
| 配置检查 | `.env.local` | 确认至少两个 provider 配置了 API Key |
| 错误识别 | `lib/ai-providers/registry.ts:81` | 检查 `isRetryableError` 逻辑 |
| 控制台日志 | 浏览器控制台 | 查找 provider 切换日志 |

---

## 三、数据完整性验证

### 检查 1: 空缓存数据
```sql
-- 查找问题缓存（空数组）
SELECT
  youtube_id,
  title,
  jsonb_array_length(topics) as topic_count,
  created_at
FROM video_analyses
WHERE topics = '[]'
   OR topics IS NULL
   OR jsonb_array_length(topics) = 0
ORDER BY created_at DESC;
```

---

### 检查 2: 转录格式兼容性
```sql
-- 检查是否需要迁移（合并格式 vs 分离格式）
SELECT
  id,
  youtube_id,
  CASE
    WHEN jsonb_typeof(transcript->'0') = 'object' THEN 'merged'
    WHEN jsonb_typeof(transcript->'0') = 'array' THEN 'split'
    ELSE 'unknown'
  END as transcript_format,
  created_at
FROM video_analyses
ORDER BY created_at DESC
LIMIT 20;
```

---

### 检查 3: 重复计费
```sql
-- 检查同一视频是否被重复计费（最近30天）
SELECT
  user_id,
  youtube_id,
  COUNT(*) as charge_count,
  SUM(counted_toward_limit::int) as counted_count,
  MIN(created_at) as first_charge,
  MAX(created_at) as last_charge
FROM video_generations
WHERE created_at > NOW() - INTERVAL '30 days'
GROUP BY user_id, youtube_id
HAVING COUNT(*) > 1
ORDER BY charge_count DESC;
```

---

### 检查 4: 限流记录健康度
```sql
-- 检查是否有异常清理或堆积
SELECT
  key,
  COUNT(*) as record_count,
  COUNT(DISTINCT identifier) as unique_users,
  MIN(timestamp) as oldest_record,
  MAX(timestamp) as newest_record
FROM rate_limits
WHERE timestamp > NOW() - INTERVAL '7 days'
GROUP BY key
ORDER BY record_count DESC
LIMIT 20;
```

---

### 检查 5: AI 生成成功率
```sql
-- 检查 AI 生成失败率
SELECT
  model_used,
  COUNT(*) as total,
  COUNT(*) FILTER (WHERE topics IS NULL OR jsonb_array_length(topics) = 0) as failed,
  ROUND(100.0 * COUNT(*) FILTER (WHERE topics IS NULL OR jsonb_array_length(topics) = 0) / COUNT(*), 2) as failure_rate
FROM video_analyses
WHERE created_at > NOW() - INTERVAL '30 days'
  AND model_used IS NOT NULL
GROUP BY model_used
ORDER BY failure_rate DESC;
```

---

## 四、环境一致性检查

### 检查清单 1: URL 环境变量

**`.env.local` 中检查**:
```bash
# 必需且正确
NEXT_PUBLIC_APP_URL=https://your-domain.com

# 应该删除或与 APP_URL 一致（避免混淆）
# NEXT_PUBLIC_BASE_URL=

# Supabase 配置
NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGc...

# AI Provider（至少配置一个）
XAI_API_KEY=sk-xxx          # Grok (xAI)
GEMINI_API_KEY=AIzaxxx     # Gemini
DEEPSEEK_API_KEY=sk-xxx    # DeepSeek

# 其他必需
SUPADATA_API_KEY=xxx
CSRF_SALT=random_string_here
```

---

### 检查清单 2: Supabase 配置

登录 [Supabase Dashboard](https://supabase.com/dashboard) 检查:

**Authentication → URL Configuration**:
- [ ] Site URL 与 `NEXT_PUBLIC_APP_URL` 一致
- [ ] Redirect URLs 包含你的域名

**API → URL**:
- [ ] URL 与 `NEXT_PUBLIC_SUPABASE_URL` 一致

**Database → Tables**:
- [ ] `video_analyses` 表存在
- [ ] `video_generations` 表存在
- [ ] `rate_limits` 表存在
- [ ] `profiles` 表存在
- [ ] `stripe_events` 表存在

---

### 检查清单 3: Provider 配置验证

```bash
# 本地验证（运行以下命令）
# 检查环境变量是否加载
echo "APP_URL: $NEXT_PUBLIC_APP_URL"
echo "SUPABASE_URL: $NEXT_PUBLIC_SUPABASE_URL"
echo "XAI_KEY: ${XAI_API_KEY:+SET}"
echo "GEMINI_KEY: ${GEMINI_API_KEY:+SET}"
echo "DEEPSEEK_KEY: ${DEEPSEEK_API_KEY:+SET}"
```

---

## 五、功能走查测试方案

### 测试用例 1: 完整链路（正常流程）

| 步骤 | 操作 | 预期结果 | 失败指标 |
|------|------|----------|----------|
| 1 | 输入新 YouTube URL | 进入分析页面，显示加载中 | 卡在首页 |
| 2 | 等待转录获取 | 进入"理解中"阶段 | 报错"转录失败" |
| 3 | 等待 AI 生成 | 进入"生成中"阶段 | 报错"AI 失败" |
| 4 | 生成完成 | 显示 5 个话题 + 主题选择器 | 显示空结果 |
| 5 | 选择一个主题 | 生成 5 个新话题 | 无响应 |
| 6 | 点击话题播放 | 视频跳转到正确位置 | 跳转位置错误 |
| 7 | 刷新页面 | 瞬间加载缓存数据 | 重新生成 |

---

### 测试用例 2: 异常恢复

| 步骤 | 操作 | 预期结果 | 失败指标 |
|------|------|----------|----------|
| 1 | 在生成过程中刷新页面 | 重新进入生成流程 | 页面崩溃 |
| 2 | 生成一半断开网络 | 显示友好的错误信息 | 无限加载 |
| 3 | 网络恢复后重试 | 能够重新生成 | 无法操作 |
| 4 | AI 生成失败（模拟） | Fallback 到其他 provider 或报错 | 沉默失败 |

---

### 测试用例 3: 边界条件

| 步骤 | 操作 | 预期结果 | 失败指标 |
|------|------|----------|----------|
| 1 | 使用无效 API Key | Fallback 到其他 provider | 整体失败 |
| 2 | 所有 API Key 无效 | 清晰的错误提示 | 技术错误堆栈 |
| 3 | 极短视频（<1分钟） | 正常处理或提示 | 崩溃 |
| 4 | 无字幕视频 | 提示字幕不可用 | 沉默失败 |
| 5 | 超长视频（>4小时） | 正常处理或提示 | 超时 |

---

### 测试用例 4: 认证与限流

| 步骤 | 操作 | 预期结果 | 失败指标 |
|------|------|----------|----------|
| 1 | 匿名用户生成第1个视频 | 成功 | 被拒绝 |
| 2 | 匿名用户生成第2个视频 | 提示登录 | 仍然成功 |
| 3 | 登录后生成视频 | 扣除额度 | 不扣额度 |
| 4 | 达到免费额度 | 提示升级 | 仍然生成 |
| 5 | 退出登录 | 清除 cookies | 仍然登录 |

---

## 六、前端稳定性验证

### 测试 1: 竞态条件检测

**在浏览器控制台运行**:
```javascript
// 快速触发多次主题切换
const themes = ['技术', '商业', '教育'];
for (let i = 0; i < 10; i++) {
  setTimeout(() => {
    // 模拟点击主题（根据实际调整选择器）
    document.querySelector(`[data-theme="${themes[i % 3]}"]`)?.click();
  }, i * 100);
}

// 观察:
// 1. 网络请求数量（应该是 10 个或被节流减少）
// 2. 最终显示的主题是否与最后一次点击一致
// 3. 是否有未处理的 Promise
```

---

### 测试 2: 重渲染检测

**使用 React DevTools**:
1. 安装 React DevTools 浏览器扩展
2. 打开 Components 面板
3. 勾选 "Highlight updates when components render"
4. 执行常见操作:
   - 切换主题
   - 播放视频
   - 发送聊天消息
   - 切换标签页
5. 观察:
   - 是否有不必要的组件重渲染
   - 重渲染频率是否过高

---

### 测试 3: 内存泄漏检测

**在浏览器控制台运行**:
```javascript
// 记录初始内存
const initialMemory = performance.memory.usedJSHeapSize;

// 执行多次操作
for (let i = 0; i < 10; i++) {
  // 模拟切换视频
  window.location.href = `/analyze/test_video_${i}`;
  await new Promise(r => setTimeout(r, 2000));
  // 返回首页
  window.location.href = '/';
  await new Promise(r => setTimeout(r, 1000));
}

// 检查内存增长（需要多次刷新页面观察趋势）
console.log('内存使用:', performance.memory.usedJSHeapSize - initialMemory);
```

---

### 测试 4: 状态一致性

**手动测试步骤**:
1. 打开分析页面
2. 快速依次执行:
   - 选择主题 A
   - 切换到摘要标签
   - 选择主题 B
   - 切换到聊天标签
   - 发送消息
   - 切换回话题标签
3. 检查:
   - 显示的是哪个主题的话题？
   - 聊天历史是否完整？
   - 视频播放状态是否正确？

---

## 七、日志与监控建议

### 统一请求追踪

**为每个请求生成唯一 ID**:
```typescript
// 在 API 路由开始时
const requestId = crypto.randomUUID();

// 所有日志都包含此 ID
console.log(`[${requestId}] Starting video analysis`, {
  videoId,
  userId,
  timestamp: new Date().toISOString()
});
console.log(`[${requestId}] AI provider: ${provider}`);
console.log(`[${requestId}] Generated ${topics.length} topics`);
console.log(`[${requestId}] Saved to database:`, {
  videoAnalysisId: result.videoId
});
```

---

### 日志分级

```typescript
enum LogLevel {
  DEBUG = 'debug',    // 详细调试信息
  INFO = 'info',      // 正常流程节点
  WARN = 'warn',      // 可恢复的异常
  ERROR = 'error',    // 需要关注的错误
}

// 使用示例
logger.info('Video analysis started', { videoId, userId });
logger.warn('Provider fallback triggered', {
  from: 'grok',
  to: 'gemini'
});
logger.error('AI generation failed', {
  error,
  provider,
  retryCount
});
```

---

### 错误分类

```typescript
enum ErrorCategory {
  USER_ERROR = 'user',         // 用户输入问题（无效URL等）
  PROVIDER_ERROR = 'provider', // AI/转录服务问题
  SYSTEM_ERROR = 'system',     // 内部系统问题（数据库等）
  NETWORK_ERROR = 'network',   // 网络问题
}

// 使用示例
logger.error('Analysis failed', {
  category: ErrorCategory.PROVIDER_ERROR,
  provider: 'grok',
  error: error.message,
  userId,
  videoId
});
```

---

### 关键流程日志点

| 流程 | 日志点 | 记录内容 |
|------|--------|----------|
| 转录获取 | 开始/成功/失败 | URL、单位判定结果、耗时 |
| AI 生成 | 开始/fallback/成功/失败 | Provider、模型、话题数量、耗时 |
| 保存数据库 | 开始/重试/成功/失败 | video_id、重试次数 |
| 计费消费 | 开始/成功/失败 | 用户ID、视频ID、剩余额度 |
| 限流拦截 | 触发时 | key、remaining、retryAfter |
| 前端状态 | 状态变更 | 从状态、到状态、触发原因 |

---

### 日志查询示例

```sql
-- 查找特定视频的所有日志
SELECT * FROM audit_logs
WHERE resource_id = 'video_id_here'
ORDER BY created_at DESC;

-- 查找特定用户的所有错误
SELECT * FROM audit_logs
WHERE user_id = 'user_id_here'
  AND action IN ('ERROR', 'FATAL')
ORDER BY created_at DESC;

-- 查找 Provider 失败统计
SELECT
  details->>'provider' as provider,
  COUNT(*) as fail_count,
  MIN(created_at) as first_fail,
  MAX(created_at) as last_fail
FROM audit_logs
WHERE action = 'AI_GENERATION_FAILED'
GROUP BY details->>'provider'
ORDER BY fail_count DESC;
```

---

## 八、快速诊断命令

### 本地环境检查

```bash
# 1. 检查环境变量（必需项）
grep -E "^(NEXT_PUBLIC_APP_URL|NEXT_PUBLIC_SUPABASE_URL|XAI_API_KEY|GEMINI_API_KEY|SUPADATA_API_KEY|CSRF_SALT)" .env.local

# 2. 检查依赖安装
npm list --depth=0 | grep -E "(next|@supabase|zod)"

# 3. 运行类型检查
npm run build  # 或 npx tsc --noEmit

# 4. 运行 linter
npm run lint
```

---

### 数据库快速查询

```sql
-- 1. 检查空缓存数量
SELECT COUNT(*) as empty_cache_count
FROM video_analyses
WHERE topics = '[]' OR topics IS NULL;

-- 2. 检查最近的失败生成
SELECT youtube_id, model_used, created_at
FROM video_analyses
WHERE (topics IS NULL OR jsonb_array_length(topics) = 0)
  AND created_at > NOW() - INTERVAL '7 days'
ORDER BY created_at DESC
LIMIT 10;

-- 3. 检查限流堆积
SELECT key, COUNT(*) as count
FROM rate_limits
GROUP BY key
ORDER BY count DESC
LIMIT 10;

-- 4. 检查重复计费
SELECT user_id, youtube_id, COUNT(*) as charge_count
FROM video_generations
WHERE created_at > NOW() - INTERVAL '30 days'
GROUP BY user_id, youtube_id
HAVING COUNT(*) > 1;

-- 5. 检查 AI Provider 使用分布
SELECT model_used, COUNT(*) as count
FROM video_analyses
WHERE created_at > NOW() - INTERVAL '30 days'
GROUP BY model_used
ORDER BY count DESC;
```

---

### 修复空缓存的 SQL

```sql
-- 标记空缓存以便重新生成（添加标记字段）
UPDATE video_analyses
SET needs_regeneration = true
WHERE topics = '[]' OR topics IS NULL;

-- 或直接删除空缓存（触发重新生成）
DELETE FROM video_analyses
WHERE topics = '[]' OR topics IS NULL;
```

---

### 清理限流记录的 SQL

```sql
-- 清理 7 天前的限流记录
DELETE FROM rate_limits
WHERE timestamp < NOW() - INTERVAL '7 days';

-- 清理特定 key 的旧记录
DELETE FROM rate_limits
WHERE key = 'ratelimit:video-analysis:*'
  AND timestamp < NOW() - INTERVAL '1 day';
```

---

## 九、问题优先级总结

| 优先级 | 问题 | 影响 | 类型 | 文件位置 |
|--------|------|------|------|----------|
| P0 | 空数组永久缓存 | 功能不可恢复 | 功能 | `app/api/video-analysis/route.ts:130` |
| P0 | CORS 环境变量 | 跨域请求失败 | 安全 | `lib/security-middleware.ts:169` |
| P0 | Signout 无 CSRF | 安全漏洞 | 安全 | `app/api/auth/signout/route.ts` |
| P1 | 速率限制 key | 限流不准确 | 功能 | `lib/rate-limiter.ts:72` |
| P1 | Provider 端点无限制 | 可被滥用 | 安全 | `app/api/ai/provider/route.ts` |
| P1 | 前端状态机竞态 | 用户体验 | 稳定性 | `app/analyze/[videoId]/page.tsx` |
| P1 | Provider Fallback | 生成成功率 | 稳定性 | `lib/ai-providers/registry.ts:81` |
| P2 | 大组件文件 | 可维护性 | 架构 | `app/analyze/[videoId]/page.tsx` |
| P2 | 全表清理限流 | 性能 | 性能 | `lib/rate-limiter.ts:122` |
| P2 | 关键日志缺失 | 可追溯性 | 可维护性 | 多处 |

---

## 十、快速参考

### 关键文件位置

| 功能 | 文件 |
|------|------|
| 主分析页面 | `app/analyze/[videoId]/page.tsx` |
| 视频分析 API | `app/api/video-analysis/route.ts` |
| 转录获取 API | `app/api/transcript/route.ts` |
| 安全中间件 | `lib/security-middleware.ts` |
| 速率限制 | `lib/rate-limiter.ts` |
| CSRF 保护 | `lib/csrf-protection.ts` |
| AI 提供方注册表 | `lib/ai-providers/registry.ts` |
| 引用匹配 | `lib/quote-matcher.ts` |
| 全局 CSP/会话 | `middleware.ts` |

---

### 环境变量模板

```bash
# === 应用配置 ===
NEXT_PUBLIC_APP_URL=https://your-domain.com

# === Supabase ===
NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGc...

# === AI Provider（至少配置一个）===
XAI_API_KEY=sk-xxx
GEMINI_API_KEY=AIzaxxx
DEEPSEEK_API_KEY=sk-xxx

# === 外部服务 ===
SUPADATA_API_KEY=xxx

# === 安全 ===
CSRF_SALT=random_string_here

# === 可选 ===
AI_DEFAULT_MODEL=grok-4-1-fast-non-reasoning
UNLIMITED_VIDEO_USERS=user@email.com
```

---

### 常用诊断流程

```
问题报告
    ↓
1. 检查环境变量 → 确认配置完整
    ↓
2. 查看数据库 → 运行诊断 SQL
    ↓
3. 检查日志 → 查找相关 requestId
    ↓
4. 复现问题 → 按测试用例执行
    ↓
5. 定位根因 → 对照问题清单
    ↓
6. 实施修复 → 按解决方法执行
    ↓
7. 验证修复 → 重新测试
```

---

> **文档维护**: 本文档应随着代码更新和问题修复同步更新。
> **问题报告**: 发现新问题请按"错误分类"记录到审计日志。
