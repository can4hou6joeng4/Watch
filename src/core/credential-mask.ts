import type { ProcessEvent } from './types.js';

/**
 * 「摘要交接」文档里的凭据隐去（第 329 轮）。
 *
 * `watch prompt` 的产物就是用来复制、粘贴给另一个助手（往往是另一家厂商的服务）的；会话里
 * 只要出现过一次 `cat .env` 或带 `Authorization` 头的 `curl`，密钥原文就会随工具入参 / 输出
 * 一起进文档。Watch 的定位是「不默认搬迁凭据」，这条路径不能例外。
 *
 * 只认**格式固定**的几种（厂商前缀 + 固定字符集与长度、PEM 私钥块、JWT 三段式），以及四种
 * **位置固定**的值（连接串 URL 里的口令、`X-Api-Key` 这类密钥头、`Cookie` / `Set-Cookie` 头的值、
 * `Authorization` 头的值）：宁可漏，不把普通标识符、
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
type ReplaceCredential = (match: string, cut?: boolean) => string;

/**
 * 上游截断的省略号在**字段末尾**（或紧跟 JSON 收尾字符）；正文里的说明性省略号
 * （`完整值…（这是完整值）`）不是截断信号，不能把一个完整凭据误归为残片。
 */
function isTruncatedMatch(match: string, args: unknown[]): boolean {
  const whole = args[args.length - 1];
  const offset = args[args.length - 2];
  if (typeof whole !== 'string' || typeof offset !== 'number') return false;
  const after = offset + match.length;
  if (whole[after] !== '…') return false;
  const next = whole[after + 1];
  return next === undefined || /["'\\})\]},;\s]/.test(next);
}

type CredentialKind = { label: string; normalize?: (match: string) => string } & (
  | { pattern: RegExp; cut?: RegExp; residual?: (match: string) => boolean }
  | { mask: (text: string, replace: ReplaceCredential) => string }
);

// Cookie 头与带引号的 --cookie 参数可包含空格和多个键值对。无引号的参数到下一个 shell 分隔符为止。
const cookieHeaderSeparator = /(?:\\?["'])?[ \t]*[:=][ \t]*(?:\\?["'])?/;
const cookieHeader = `(?<=(?<![\\w-])(?:Set-)?Cookie${cookieHeaderSeparator.source})`;
const requestCookieHeader = `(?<=(?<![\\w-])Cookie${cookieHeaderSeparator.source})`;
const responseCookieHeader = `(?<=(?<![\\w-])Set-Cookie${cookieHeaderSeparator.source})`;
// 续扫要覆盖 `Set-Cookie` 的后续键值对：变量引用 / 已隐去标记会截断第一遍整段匹配。
// 断言放在 `Set-` 前卡住边界，既不把 `X-Cookie` 当请求头，也不把 `--cookie` 参数放宽。
const quotedCookieOption = /(?<=(?<![\w-])--cookie(?:=|[ \t]+)\\?["'])/;
const bareCookieOption = /(?<=(?<![\w-])--cookie(?:=|[ \t]+))/;
const cookiePairName = /[^\s="'`\\…\[\]{}$<>;|&()]+=/;
// 带引号的值可以有空格和逗号；裸值到 RFC 6265 的分隔符为止。此前头字段误用宽字符类，
// 把 `Cookie: sid=abcdefgh1234, 说明` 的后续正文整个吞进占位符，计数也少算一个键值对。
const cookieHeaderValue = /[^"'`\\…\[\]{}$<>;\r\n]/;
const bareCookieHeaderValue = /[^\s"'`\\…\[\]{}$<>;,]/;
const bareCookieValue = /[^\s"'`\\…\[\]{}$<>;|&()]/;
const cookieQuote = /\\?"/;

function cookieValuePattern(minLength: number, end: string): RegExp {
  // Cookie 自身的双引号只包裹值，JSON 序列化后会多一层反斜杠；截断分支可以没有闭合引号。
  const quoted = `${cookieQuote.source}${cookieHeaderValue.source}{${minLength},}${end ? '' : cookieQuote.source}`;
  // 先跳过空白，避免在每个空白字符上重复执行后行断言。
  return new RegExp(
    `(?=\\S)(?:(?:${cookieHeader}|${quotedCookieOption.source})${cookiePairName.source}(?:${quoted}|${bareCookieHeaderValue.source}{${minLength},})` +
      `|${bareCookieOption.source}${cookiePairName.source}${bareCookieValue.source}{${minLength},})${end}`,
    'gi',
  );
}

const cookieValue = cookieValuePattern(8, '');
const cutCookieValue = cookieValuePattern(3, '(?=…)');
// 仅在等号后接收 Cookie 自身成对的双引号；外层 shell / JSON 引号仍是列表边界。
const cookieListValue = /(?:[^"'`\\\r\n]+|(?<==)\\?"[^"\\;\r\n]*(?:\\?"|(?<=…)(?=$|[\r\n])))+/;
const requestCookieList = new RegExp(`(?=\\S)(?:${requestCookieHeader}|${quotedCookieOption.source})${cookieListValue.source}`, 'gi');
const responseCookieList = new RegExp(`(?=\\S)(?:${responseCookieHeader})${cookieListValue.source}`, 'gi');
// 第一遍只认识头名后的第一对；`Cookie: sid=… token=…` 这种同一行空格分隔的后续对
// 由这一步接上。锚在头名后且要求从占位符 / 键值对开始，后面 `explanation: sid=…`
// 这类说明文字不会被当成 Cookie 续扫命中。
const cookiePlaceholder = /\[已隐去：[^\]\r\n]+\]/;
const inlineCookiePairChain = new RegExp(
  `(?:${cookieHeader}|${quotedCookieOption.source}|${bareCookieOption.source})` +
    `(?:${cookiePlaceholder.source}|${cookiePairName.source}${bareCookieHeaderValue.source}{8,})` +
    `(?:[ \\t]+${cookiePairName.source}${bareCookieHeaderValue.source}{8,})+`,
  'gi',
);
const laterInlineCookiePair = new RegExp(
  `(^|[ \\t])(${cookiePairName.source}${bareCookieHeaderValue.source}{8,})`,
  'gi',
);

function cookiePairPattern(minLength: number, cutLength: number, response: boolean): RegExp {
  // 请求 Cookie 与 `--cookie` 参数里 `Path` / `Domain` 是合法的键名；只有 Set-Cookie 响应头
  // 才排除固定属性，并要求更长的值，避免把 `tenant=production123` 这类未知属性当凭据隐去。
  const guard = response
    ? '(?!(?:Path|Domain|Expires|Max-Age|SameSite|Secure|HttpOnly|Priority|Partitioned|MaxAge)\\s*=)'
    : '';
  // 第三个捕获组区分「完整长度」与「紧跟省略号的残片」：残片单独计数，不能和完整值混在一起。
  return new RegExp(
    `^([ \\t]*)${guard}(${cookiePairName.source}(?:${cookieQuote.source}${cookieHeaderValue.source}{${minLength},}${cookieQuote.source}` +
      `|${bareCookieHeaderValue.source}{${minLength},}|((?:${cookieQuote.source})?${cookieHeaderValue.source}{${cutLength},})(?=…)))`,
    'gi',
  );
}

const nextCookiePair = cookiePairPattern(8, 3, false);
const nextSetCookiePair = cookiePairPattern(16, 8, true);

function continueCookiePairs(
  list: string,
  pairPattern: RegExp,
  replace: ReplaceCredential,
): string {
  // 第一遍已处理头名后的第一对；续扫从第二对开始。分隔符按捕获组保留，逗号 / 空白后跟
  // `name=value` 时也要分别遮蔽与计数，而不是把后续说明文字吞进第一对的占位符。
  const pairs = list.split(/([;,])/);
  for (let i = 2; i < pairs.length; i += 2) {
    pairs[i] = pairs[i]!.replace(pairPattern, (match: string, ...args: unknown[]) => {
      const space = typeof args[0] === 'string' ? args[0] : '';
      const pair = typeof args[1] === 'string' ? args[1] : match;
      return space + replace(pair, args[2] !== undefined || isTruncatedMatch(match, args));
    });
  }
  return pairs.join('');
}

function maskCookie(text: string, replace: ReplaceCredential): string {
  const out = text
    .replace(cookieValue, (match: string, ...args: unknown[]) => replace(match, isTruncatedMatch(match, args)))
    .replace(cutCookieValue, (match) => replace(match, true))
    .replace(inlineCookiePairChain, (chain) =>
      chain.replace(laterInlineCookiePair, (_whole, space: string, pair: string) => space + replace(pair)),
    );
  // 变量引用或已隐去标记会截断整段匹配；逗号 / 分号后的键值对同样要续扫。
  // 请求头 / 带引号的选项与 Set-Cookie 用不同的续扫口径。
  return out
    .replace(responseCookieList, (list) => continueCookiePairs(list, nextSetCookiePair, replace))
    .replace(requestCookieList, (list) => continueCookiePairs(list, nextCookiePair, replace));
}

// 顺序即优先级：PEM 块最先（块里可能含形似其它种类的片段），带厂商前缀的先于通用 `sk-`。
// 左侧一律用否定后行断言卡住边界，避免从更长的标识符中间截出一段「密钥」。
const KINDS: readonly CredentialKind[] = [
  {
    // PGP armored 私钥块（第 340 轮）：与 PEM 一样是固定头尾的文本块。
    // 只认完整块；摘要截断后只剩头行，没有可用的密钥正文。
    label: 'PGP 私钥',
    pattern: /-----BEGIN PGP PRIVATE KEY BLOCK-----[\s\S]{0,16384}?-----END PGP PRIVATE KEY BLOCK-----/g,
  },
  {
    label: 'PEM 私钥',
    // 有 END 行时整块替换（上限 8192 字符，避免把两处相隔很远的标记之间整段吞掉）；
    // 被截断、没有 END 时只吞后续的 base64 行，末尾紧跟 `…` 的半行也一并吞掉。
    // `\\n` 覆盖 JSON 字符串里的字面换行。
    pattern:
      /-----BEGIN ((?:[A-Z0-9]+ )*)PRIVATE KEY-----(?:[\s\S]{0,8192}?-----END \1PRIVATE KEY-----|(?:(?:\r?\n|\\r\\n|\\n)[ \t]*[A-Za-z0-9+/=]{16,})*(?:(?:\r?\n|\\r\\n|\\n)[ \t]*[A-Za-z0-9+/=]*(?=…))?)/g,
    // summarize() 只取首行时没有 `…`：只有 BEGIN 头、没有 END 的匹配也是上游截断残片。
    residual: (match) => !match.includes('-----END '),
    // 事件详情经 JSON.stringify，结构化 input 保留原换行；去重与残片归属使用同一种换行表示。
    normalize: (match) => match.replace(/\\r\\n|\\n|\\r|\r\n?/g, '\n'),
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
    // 第 340 轮补上 runner（`glrt-`）与 deploy（`gldt-`）令牌。
    pattern: /(?<![A-Za-z0-9_-])gl(?:pat|rt|dt)-[A-Za-z0-9_-]{20,}/g,
    cut: /(?<![A-Za-z0-9_-])gl(?:pat|rt|dt)-[A-Za-z0-9_-]{8,}(?=…)/g,
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
    // 第 340 轮补上浏览器会话（`xoxc-` / `xoxd-`）、刷新（`xoxe-`）与 app-level（`xapp-`）令牌。
    pattern: /(?<![A-Za-z0-9])(?:xox[abcdeprs]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,})/g,
    cut: /(?<![A-Za-z0-9])(?:xox[abcdeprs]-[A-Za-z0-9-]{8,}|xapp-[A-Za-z0-9-]{8,})(?=…)/g,
  },
  {
    label: 'Stripe 密钥',
    // 第 340 轮补上 webhook 签名密钥（`whsec_`）。
    pattern: /(?<![A-Za-z0-9_])(?:(?:sk|rk)_live_|whsec_)[A-Za-z0-9]{16,}/g,
    cut: /(?<![A-Za-z0-9_])(?:(?:sk|rk)_live_|whsec_)[A-Za-z0-9]{8,}(?=…)/g,
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
  // 下面四种靠**位置**而不是前缀识别（第 331 / 334 / 336 轮）：值本身没有固定样子，但它出现的位置是固定的。
  // 排在最后——带前缀的令牌已被上面换成占位符，这里不再碰（占位符里的 `[` 不在字符集里）。
  // 只换掉值，scheme / 用户名 / 主机与 `Bearer` 字样保留：接手的人仍需要知道连的是哪里。
  {
    // `postgres://user:口令@host/db` 这类连接串。环境变量引用（`$PASS` / `${PASS}`）、
    // `{{模板}}`、`<模板>`、`[模板]` 与全星号的占位写法不是口令，原样保留。
    // 第 340 轮起口令字符集不再排除 `[]{}<>`：客户端接受这些原始字符并自动 percent-encode，
    // 按字符排除会让整条 URL 认不出来（是整段不掩，不是部分掩）。已隐去的占位符形如
    // `[已隐去：…]@`，由专门的前瞻跳过，不会被二次计数。
    // 上游摘要只有 79 码点 + `…`：`@` 被截掉时整条规则失配，`cut` 按剩余 ≥8 位兜底。
    label: 'URL 里的口令',
    pattern:
      /(?<=[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/:@"'`<>{}[\]]*:)(?!\$\{?[A-Za-z_][A-Za-z0-9_]*\}?@)(?!\*+@)(?!\{\{)(?!<)(?!\[[^\]]*\]@)[^\s/@"'`]+(?=@)/g,
    cut:
      /(?<=[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/:@"'`<>{}[\]]*:)(?!\$\{?[A-Za-z_][A-Za-z0-9_]*\}?(?:…|@))(?!\*+…)(?!\{\{)(?!<)(?!\[[^\]]*\](?:…|@))[^\s/@"'`]{8,}(?=…)/g,
  },
  {
    // `X-Api-Key` / `X-Goog-Api-Key` / `api-key` / `X-Auth-Token` 这类把密钥放进自定义头的写法
    // （第 334 轮）；第 340 轮补上 Cloudflare Global API Key 的 `X-Auth-Key` 与 Vault 的
    // `X-Vault-Token`；第 341 轮补上配置里裸写的 `apikey:` / `apiKey:`（要求词边界，
    // `myapikey:` 不认）。头名 / 键名本身是固定的，值没有固定格式——与 Authorization 同一条
    // 位置判据（至少 16 位、含数字，`YOUR_API_KEY` 这类占位写法不动）。排在后面前缀规则之后：
    // 带厂商前缀的密钥已被换掉，不会重复计数。
    label: 'API 密钥头的值',
    pattern:
      /(?<=(?:X-[A-Za-z0-9-]*Api-Key|api-key|X-Auth-Token|X-Auth-Key|X-Vault-Token)\\?["']?\s*[:=]\s*\\?["']?|(?<![\w-])apikey\\?["']?\s*[:=]\s*\\?["']?)(?=[A-Za-z0-9._~+/=-]*[0-9])[A-Za-z0-9._~+/=-]{16,}/gi,
    cut: /(?<=(?:X-[A-Za-z0-9-]*Api-Key|api-key|X-Auth-Token|X-Auth-Key|X-Vault-Token)\\?["']?\s*[:=]\s*\\?["']?|(?<![\w-])apikey\\?["']?\s*[:=]\s*\\?["']?)(?=[A-Za-z0-9._~+/=-]*[0-9])[A-Za-z0-9._~+/=-]{8,}(?=…)/gi,
  },
  {
    // 识别常见的 Cookie / Set-Cookie 头和 --cookie 参数。`name=value` 的等号后至少有 8 个字符。
    // 引号和反斜杠标记文本边界，方括号、`$` 和模板括号保护已隐去的值及变量引用。
    label: 'Cookie 头的值',
    mask: maskCookie,
    // 同一键值对的裸值、双引号和 JSON 转义引号共用去重键；截断值可缺少闭合引号。
    normalize: (match) => match.replace(/=\\?"([^"\\]*)(?:\\?")?$/, '=$1'),
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
    cut: /(?<=Authorization\\?["']?\s*[:=]\s*\\?["']?(?:Bearer|Token)\s+)(?=[A-Za-z0-9._~+/=-]*[0-9])[A-Za-z0-9._~+/=-]{8,}(?=…)|(?<=Authorization\\?["']?\s*[:=]\s*\\?["']?Basic\s+)[A-Za-z0-9+/=]{8,}(?=…)/gi,
  },
];

// 绝大多数字符串一个候选前缀都没有：先用一条廉价的正则挡掉，再逐种类扫描。
// 第 340 轮补上 glrt-/gldt-、xapp-、xoxc/xoxd/xoxe、whsec_、X-Auth-Key / X-Vault-Token、
// PGP 头，以及被截断的连接串（只剩 `scheme://user:` 与 `…`，没有 `@`）；第 341 轮补上裸 `apikey`。
const QUICK_CHECK = /sk-|gh[pousr]_|github_pat_|gl(?:pat|rt|dt)-|AKIA|ASIA|AIza|xox[abcdeprs]-|xapp-|_live_|whsec_|npm_|hf_|eyJ|PRIVATE KEY-----|PGP PRIVATE KEY BLOCK|:\/\/[^\s/]*[:@]|uthorization|api-key|apikey|auth-key|auth-token|vault-token|cookie/i;

/** 一次渲染内的收集器：按种类记下完整值与被截断的残片，避免把两个独立密钥误合并。 */
type CollectedKind = { values: Set<string>; cuts: Set<string> };
export type CredentialCollector = Map<string, CollectedKind>;

export type CredentialMaskReport = {
  /** 被隐去的**不同**凭据个数（同一个值出现多处只算一个） */
  total: number;
  /** 按种类的个数，顺序与识别优先级一致 */
  kinds: Array<{ label: string; count: number }>;
};

export function createCredentialCollector(): CredentialCollector {
  return new Map();
}

/** 占位符前缀。截断侧要靠它认出「这里是一个 Watch 生成的占位符」，不能从中间切开。 */
export const CREDENTIAL_PLACEHOLDER_PREFIX = '[已隐去：';

/** 把一段文字里格式固定的凭据换成 `[已隐去：种类]`；没有命中时原样返回同一个字符串。 */
export function maskCredentials(text: string, collector: CredentialCollector): string {
  if (!text || !QUICK_CHECK.test(text)) return text;
  let out = text;
  for (const kind of KINDS) {
    const replace: ReplaceCredential = (match, cut = false) => {
      let seen = collector.get(kind.label);
      if (!seen) {
        seen = { values: new Set(), cuts: new Set() };
        collector.set(kind.label, seen);
      }
      // 尾随空白不属于凭据原文；同一键值对在续扫里带 TAB 时仍要归并到同一个值。
      const value = match.replace(/[ \t]+$/, '');
      const trailing = match.slice(value.length);
      const residual = 'residual' in kind && kind.residual?.(value) === true;
      (cut || residual ? seen.cuts : seen.values).add(kind.normalize?.(value) ?? value);
      return `${CREDENTIAL_PLACEHOLDER_PREFIX}${kind.label}]${trailing}`;
    };
    if ('mask' in kind) {
      out = kind.mask(out, replace);
      continue;
    }
    out = out.replace(kind.pattern, (match: string, ...args: unknown[]) =>
      replace(match, isTruncatedMatch(match, args)),
    );
    // 截断的那一截排在整条之后：够长的已经被上一行换掉，这里只剩长度不够、紧跟 `…` 的。
    if (kind.cut) out = out.replace(kind.cut, (match) => replace(match, true));
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
 * 完整值与截断残片分开去重（第 573 轮）：
 * - 两个**完整**凭据即使一个是另一个的前缀，也必须是两个（两个不同的口令恰好共用前缀）；
 * - 残片若是某个完整值的前缀，则归属那个完整值，不另计一个；
 * - 没有对应完整值的残片之间仍按前缀去重（同一条令牌被截到不同长度）。
 */
function countDistinct(collected: CollectedKind): number {
  const values = [...collected.values];
  const cuts = [...collected.cuts];
  const independentCuts = cuts.filter((cut) => !values.some((value) => value.startsWith(cut)));
  const distinctCuts = independentCuts.filter(
    (cut) => !independentCuts.some((other) => other !== cut && other.startsWith(cut)),
  );
  return values.length + distinctCuts.length;
}

export function credentialMaskReport(collector: CredentialCollector): CredentialMaskReport {
  const kinds = KINDS.filter((kind) => {
    const seen = collector.get(kind.label);
    return seen !== undefined && (seen.values.size > 0 || seen.cuts.size > 0);
  }).map((kind) => ({
    label: kind.label,
    count: countDistinct(collector.get(kind.label)!),
  }));
  return { total: kinds.reduce((sum, kind) => sum + kind.count, 0), kinds };
}
