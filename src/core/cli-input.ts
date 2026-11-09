/**
 * 命令行里「用户手输的标识符」——链名、会话 id、provider id——的首尾空白。
 *
 * 写入侧早就 `trim()` 过了：`Store.createChain()` 与 `Store.renameChain()` 都是先
 * `name.trim()` 再入库（`assertChainNameUsable()` 校验的也是 trim 后的值），所以本地库里
 * **不可能**存在首尾带空白的链名；会话 id 是各家 CLI 生成的 UUID，同样不会以空白开头结尾；
 * provider id 是注册表键（`src/providers/registry.ts` 的 `adapters[].id`：claude / codex /
 * pi / kimi / opencode / grok），六家全是固定小写、无空白。三者同一类。
 * 而读取侧过去按原串精确比较（`WHERE cwd=? AND name=?`），于是同一个名字「写得进去、抄不回来」：
 *
 * ```
 * $ watch chain new ' gamma ' --cwd … --json
 * {"ok":true,"chain":{…,"name":"gamma",…}}      ← 建出来叫 gamma
 * $ watch chain list --cwd …
 *   gamma ← 当前  4d0f1b2c-…
 * $ watch chain use ' gamma ' --cwd … --json
 * {"ok":false,"error":"找不到链:  gamma ；本目录的链: alpha / beta / gamma"}
 * ```
 *
 * 最后一句自相矛盾：报错里列的清单正含那个名字。`chain list` 是用户唯一能照抄的来源，
 * 连空格一起复制（终端选中、IDE 复制、`$(…)` 带出的换行都常见）就再也用不了这条链；
 * `--chain` 给 `usage` / `status` / `sessions`、`chain archive` / `rename`、`open " <id> "`、
 * `adopt --session " <id> "` 是同一处根因（2026-11-09 实测，回归见 `tests/cli-name-whitespace.test.ts`）。
 * provider id 的同类缺口是 2026-11-09 补的：`switch " claude "` / `new " claude "` /
 * `adopt " codex "` / `open --to " codex "` / `open <id> --provider " claude "` 五条命令
 * 六处 `unknownProviderMessage()` 都按原串比较，报的是「未知 provider:  claude ；可用: claude / …」
 * ——清单里正含那个名字（回归见 `tests/cli-provider-whitespace.test.ts`）。
 *
 * 这里做对称 `trim()` 而不是像 git 那样直接拒绝（`git branch " x "` →
 * `fatal: ' x ' is not a valid branch name`）：这个归一化是无损的——库里不存在带首尾空白的
 * 链名，也不存在带首尾空白的会话 id，provider id 更是固定的小写注册表键，去掉空白**不可能**
 * 指向另一个对象，所以它不是猜测用户的意思，而是把「写入侧早就在做的那一步」在读取侧补上。
 * 静默处理与 `parseArgs` 对 `--cwd` 做 `path.resolve()` 是同一档：输入写法不同、语义相同，
 * 多一句提示只是噪音。
 */
export function trimUserKey(raw: string): string {
  return raw.trim();
}
