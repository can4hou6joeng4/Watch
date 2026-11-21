import type { ProcessEvent } from './types.js';

/**
 * 「摘要交接」文档里的凭据隐去（第 329 轮）。
 *
 * `watch prompt` 的产物就是用来复制、粘贴给另一个助手（往往是另一家厂商的服务）的；会话里
 * 只要出现过一次 `cat .env` 或带 `Authorization` 头的 `curl`，密钥原文就会随工具入参 / 输出
 * 一起进文档。Watch 的定位是「不默认搬迁凭据」，这条路径不能例外。
 *
 * 只认**格式固定**的几种（厂商前缀 + 固定字符集与长度、PEM 私钥块、JWT 三段式），以及三种
 * **位置固定**的值（连接串 URL 里的口令、`X-Api-Key` 这类密钥头、`Authorization` 头的值）：
 * 宁可漏，不把普通标识符、
 * 哈希或路径改掉。单独出现的口令、内部地址、没有固定前缀的密钥一律**不识别**——调用方
 * 必须把这条边界写进文档，不能让「已隐去 N 个」读起来像「文档里没有敏感内容」。
 *
 * 纯函数，不读盘、不联网；不记录也不输出凭据原文（去重用的集合只在一次渲染内存活）。
 */

/**
 * `cut` 认的是**被上游截断的**同一种凭据（第 330 轮）：各家 parser 的事件摘要只留首行的前 79 个
 * 码点再加 `…`，一个 36 位的令牌可能在第 35 位被切断——长度不够、整条规则认不出来，于是几乎
 * 完整的令牌留在了文档里。只在紧跟 `…` 时才认，且要求前缀之后至少还有 8 个字符：
 * `ghp_xxxx…`、`sk-ant-…` 这类人手写的占位写法不动。
 */
type CredentialKind = { label: string; pattern: RegExp; cut?: RegExp };

// 顺序即优先级：PEM 块最先（块里可能含形似其它种类的片段），带厂商前缀的先于通用 `sk-`。
// 左侧一律用否定后行断言卡住边界，避免从更长的标识符中间截出一段「密钥」。
const KINDS: readonly CredentialKind[] = [
  {
    label: 'PEM 私钥',
    // 有 END 行时整块替换（上限 8192 字符，避免把两处相隔很远的标记之间整段吞掉）；
    // 被截断、没有 END 时只吞后续的 base64 行，末尾紧跟 `…` 的半行也一并吞掉。
    // `\\n` 覆盖 JSON 字符串里的字面换行。
    pattern:
      /-----BEGIN ((?:[A-Z0-9]+ )*)PRIVATE KEY-----(?:[\s\S]{0,8192}?-----END \1PRIVATE KEY-----|(?:(?:\r?\n|\\r\\n|\\n)[ \t]*[A-Za-z0-9+/=]{16,})*(?:(?:\r?\n|\\r\\n|\\n)[ \t]*[A-Za-z0-9+/=]*(?=…))?)/g,
  },
  {
    label: 'Anthropic API 密钥',
    pattern: /(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{20,}/g,
    cut: /(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{12,}(?=…)/g,
  },
  {
    label: 'OpenRouter API 密钥',
    pattern: /(?<![A-Za-z0-9_-])sk-or-v1-[A-Za-z0-9]{32,}/g,
    cut: /(?<![A-Za-z0-9_-])sk-or-v1-[A-Za-z0-9]{8,}(?=…)/g,
  },
  {
    label: 'OpenAI API 密钥',
    pattern: /(?<![A-Za-z0-9_-])sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}/g,
    cut: /(?<![A-Za-z0-9_-])sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{8,}(?=…)/g,
  },
  // 不带子前缀的 `sk-`（OpenAI 旧式、DeepSeek、Moonshot 等）：只认纯字母数字、至少 32 位且含数字，
  // 这样 `sk-folding-cube-…` 这类带连字符的 CSS 类名不会命中。
  {
    label: 'sk- 开头的 API 密钥',
    pattern: /(?<![A-Za-z0-9_-])sk-(?=[A-Za-z0-9]*[0-9])[A-Za-z0-9]{32,}/g,
    cut: /(?<![A-Za-z0-9_-])sk-(?=[A-Za-z0-9]*[0-9])[A-Za-z0-9]{12,}(?=…)/g,
  },
  {
    label: 'GitHub 令牌',
    pattern: /(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})/g,
    cut: /(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,})(?=…)/g,
  },
  {
    label: 'GitLab 令牌',
    pattern: /(?<![A-Za-z0-9_-])glpat-[A-Za-z0-9_-]{20,}/g,
    cut: /(?<![A-Za-z0-9_-])glpat-[A-Za-z0-9_-]{8,}(?=…)/g,
  },
  {
    label: 'AWS 访问密钥 ID',
    pattern: /(?<![A-Z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Z])/g,
    cut: /(?<![A-Z0-9])(?:AKIA|ASIA)[0-9A-Z]{8,15}(?=…)/g,
  },
  {
    label: 'Google API 密钥',
    pattern: /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g,
    cut: /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{8,34}(?=…)/g,
  },
  {
    label: 'Slack 令牌',
    pattern: /(?<![A-Za-z0-9])xox[abeprs]-[A-Za-z0-9-]{10,}/g,
    cut: /(?<![A-Za-z0-9])xox[abeprs]-[A-Za-z0-9-]{8,}(?=…)/g,
  },
  {
    label: 'Stripe 密钥',
    pattern: /(?<![A-Za-z0-9_])(?:sk|rk)_live_[A-Za-z0-9]{16,}/g,
    cut: /(?<![A-Za-z0-9_])(?:sk|rk)_live_[A-Za-z0-9]{8,}(?=…)/g,
  },
  {
    label: 'npm 令牌',
    pattern: /(?<![A-Za-z0-9_])npm_[A-Za-z0-9]{36}(?![A-Za-z0-9])/g,
    cut: /(?<![A-Za-z0-9_])npm_[A-Za-z0-9]{8,35}(?=…)/g,
  },
  {
    label: 'Hugging Face 令牌',
    pattern: /(?<![A-Za-z0-9_])hf_[A-Za-z0-9]{30,}/g,
    cut: /(?<![A-Za-z0-9_])hf_[A-Za-z0-9]{8,}(?=…)/g,
  },
  // JWT 不设 `cut`：被截断的 JWT 没有完整签名段，剩下的头部 / 载荷不是可用的凭据。
  { label: 'JWT', pattern: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  // 下面三种靠**位置**而不是前缀识别（第 331 / 334 轮）：值本身没有固定样子，但它出现的位置是固定的。
  // 排在最后——带前缀的令牌已被上面换成占位符，这里不再碰（占位符以 `[` 开头，不在字符集里）。
  // 只换掉值，scheme / 用户名 / 主机与 `Bearer` 字样保留：接手的人仍需要知道连的是哪里。
  {
    // `postgres://user:口令@host/db` 这类连接串。环境变量引用（`$PASS` / `${PASS}`）、
    // `{{模板}}` 与全星号的占位写法不是口令，原样保留。
    label: 'URL 里的口令',
    pattern:
      /(?<=[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/:@"'`<>]*:)(?!\$\{?[A-Za-z_][A-Za-z0-9_]*\}?@)(?!\*+@)[^\s/@"'`<>{}[\]]+(?=@)/g,
  },
  {
    // `X-Api-Key` / `X-Goog-Api-Key` / `api-key` / `X-Auth-Token` 这类把密钥放进自定义头的写法
    // （第 334 轮）：头名本身是固定的，值没有固定格式——与 Authorization 同一条位置判据
    // （至少 16 位、含数字，`YOUR_API_KEY` 这类占位写法不动）。排在后面前缀规则之后：
    // 带厂商前缀的密钥已被换掉，不会重复计数。
    label: 'API 密钥头的值',
    pattern:
      /(?<=(?:X-[A-Za-z0-9-]*Api-Key|api-key|X-Auth-Token)\\?["']?\s*[:=]\s*\\?["']?)(?=[A-Za-z0-9._~+/=-]*[0-9])[A-Za-z0-9._~+/=-]{16,}/gi,
    cut: /(?<=(?:X-[A-Za-z0-9-]*Api-Key|api-key|X-Auth-Token)\\?["']?\s*[:=]\s*\\?["']?)(?=[A-Za-z0-9._~+/=-]*[0-9])[A-Za-z0-9._~+/=-]{8,}(?=…)/gi,
  },
  {
    // `Authorization: Bearer <值>`（也认 JSON 里的 `"Authorization":"Bearer …"` 与转义引号）。
    // Bearer / Token 的值至少 20 位且含数字（`YOUR_API_KEY` 这类占位写法不动），
    // Basic 的值是 base64、至少 16 位。
    label: 'Authorization 头的值',
    // 后行断言写在最前、且以 `\s+` 收尾：绝大多数位置在「前一个字符不是空白」这一步就失败，
    // 不会在每个位置都向前扫一遍（把前瞻放进后行断言里会让长串无数字文本退化成平方级）。
    pattern:
      /(?<=Authorization\\?["']?\s*[:=]\s*\\?["']?(?:Bearer|Token)\s+)(?=[A-Za-z0-9._~+/=-]*[0-9])[A-Za-z0-9._~+/=-]{20,}|(?<=Authorization\\?["']?\s*[:=]\s*\\?["']?Basic\s+)[A-Za-z0-9+/=]{16,}/gi,
    cut: /(?<=Authorization\\?["']?\s*[:=]\s*\\?["']?(?:Bearer|Token|Basic)\s+)(?=[A-Za-z0-9._~+/=-]*[0-9])[A-Za-z0-9._~+/=-]{8,}(?=…)/gi,
  },
];

// 绝大多数字符串一个候选前缀都没有：先用一条廉价的正则挡掉，再逐种类扫描。
const QUICK_CHECK = /sk-|gh[pousr]_|github_pat_|glpat-|AKIA|ASIA|AIza|xox[abeprs]-|_live_|npm_|hf_|eyJ|PRIVATE KEY-----|:\/\/[^\s/]*@|uthorization|api-key|auth-token/i;

/** 一次渲染内的收集器：按种类记下**不同的**凭据原文，用于去重计数。 */
export type CredentialCollector = Map<string, Set<string>>;

export type CredentialMaskReport = {
  /** 被隐去的**不同**凭据个数（同一个值出现多处只算一个） */
  total: number;
  /** 按种类的个数，顺序与识别优先级一致 */
  kinds: Array<{ label: string; count: number }>;
};

export function createCredentialCollector(): CredentialCollector {
  return new Map();
}

/** 把一段文字里格式固定的凭据换成 `[已隐去：种类]`；没有命中时原样返回同一个字符串。 */
export function maskCredentials(text: string, collector: CredentialCollector): string {
  if (!text || !QUICK_CHECK.test(text)) return text;
  let out = text;
  for (const kind of KINDS) {
    const replace = (match: string): string => {
      let seen = collector.get(kind.label);
      if (!seen) {
        seen = new Set();
        collector.set(kind.label, seen);
      }
      seen.add(match);
      return `[已隐去：${kind.label}]`;
    };
    out = out.replace(kind.pattern, replace);
    // 截断的那一截排在整条之后：够长的已经被上一行换掉，这里只剩长度不够、紧跟 `…` 的。
    if (kind.cut) out = out.replace(kind.cut, replace);
  }
  return out;
}

/** 递归处理 JSON 形状的值：只改字符串**值**，键名、数字与布尔原样保留，不改动入参。 */
export function maskCredentialsDeep<T>(value: T, collector: CredentialCollector): T {
  if (typeof value === 'string') return maskCredentials(value, collector) as T;
  if (Array.isArray(value)) return value.map((item) => maskCredentialsDeep(item, collector)) as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = maskCredentialsDeep(item, collector);
    }
    return out as T;
  }
  return value;
}

/** 返回隐去凭据后的事件副本（摘要 / 详情 / 工具名 / 入参）；不改动入参。 */
export function maskEventCredentials(event: ProcessEvent, collector: CredentialCollector): ProcessEvent {
  // `callId` / `timestamp` / `provider` 是配对与归属用的标识，`attachment` 不随文档走：都不动。
  return {
    ...event,
    summary: maskCredentials(event.summary, collector),
    ...(typeof event.detail === 'string' ? { detail: maskCredentials(event.detail, collector) } : {}),
    ...(typeof event.name === 'string' ? { name: maskCredentials(event.name, collector) } : {}),
    ...(event.input !== undefined ? { input: maskCredentialsDeep(event.input, collector) } : {}),
  };
}

/**
 * 各家 parser 的事件摘要本身是截断过的（如 Claude 取入参 JSON 首行的前一段），同一个密钥会以
 * 「完整值」和「被截断的前缀」两种样子出现：前缀只算进它所属的那个完整值，不另计一个。
 */
function countDistinct(values: Set<string>): number {
  const list = [...values];
  return list.filter((value) => !list.some((other) => other !== value && other.startsWith(value))).length;
}

export function credentialMaskReport(collector: CredentialCollector): CredentialMaskReport {
  const kinds = KINDS.filter((kind) => (collector.get(kind.label)?.size ?? 0) > 0).map((kind) => ({
    label: kind.label,
    count: countDistinct(collector.get(kind.label)!),
  }));
  return { total: kinds.reduce((sum, kind) => sum + kind.count, 0), kinds };
}
