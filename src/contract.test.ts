import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ★★★ 为什么有这份测试(2026-08-09)
//
// 服务端把 CMO 收进单个 workspace 那次,"feed 的作用域是什么"这一个事实同时写在
// 四个地方:Rails 控制器、本包的工具描述、autowhisper-skill 的 api-reference.md、
// SKILL.md。改了控制器,另外三份靠人记得跟上 —— 结果三份全留在旧契约上,对着模型
// 说"这个接口跨全部工作区"。
//
// 对 MCP 来说【工具描述就是行为】:模型读到 "Optional workspace id." 就以为不传
// 等于全都给它。它不会报错,只是安静地看得更少,而且它不知道。
//
// 服务端现在把作用域声明成单一数据源并公开在 GET /api/contract。这份测试拉它下来,
// 核对本包的描述有没有漂走。服务端改了作用域而这里没跟上 ⇒ 红。
//
// 离线/CI 无网时【跳过而不是假绿】—— 一个连不上就默默通过的检查,和没有这个检查
// 是一回事,而且更糟:它看着像有防护。

const CONTRACT_URL =
  process.env.AUTOWHISPER_CONTRACT_URL || "https://autowhisper.xyz/api/contract";

type Contract = {
  version: string;
  scope_field_values: string[];
  endpoints: Array<{
    path: string;
    scope: "workspace" | "account" | "none";
    takes_workspace_id?: boolean;
    discovery?: boolean;
  }>;
};

// 读【编译产物】而不是 src/index.ts:测试跑在 dist/ 里,而且这样验的是真正被
// 打包发出去的那一份描述 —— 源码改了但忘了 build 的情况同样会被抓到。
const SOURCE = readFileSync(new URL("./index.js", import.meta.url), "utf8");

async function fetchContract(): Promise<Contract | null> {
  try {
    const res = await fetch(CONTRACT_URL, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    return (await res.json()) as Contract;
  } catch {
    return null;
  }
}

test("每个 workspace 作用域的接口,本包都告诉模型它不跨工作区", async (t) => {
  const contract = await fetchContract();
  if (!contract) return t.skip(`契约拉不到(${CONTRACT_URL}) — 跳过而不是假装通过`);

  // 本包实际请求的路径 → 它在 index.ts 里的工具描述必须说清作用域。
  // 判据是"描述里有没有 CURRENT workspace 这个说法",不是它有多长。
  const wsScoped = contract.endpoints.filter((e) => e.scope === "workspace");
  assert.ok(wsScoped.length >= 3, "契约里 workspace 作用域的接口太少,断言等于没验");

  for (const ep of wsScoped) {
    if (!SOURCE.includes(ep.path)) continue; // 本包没用到这个接口
    const claimsScope =
      SOURCE.includes("CURRENT workspace") || SOURCE.includes("current one unless workspace_id");
    assert.ok(
      claimsScope,
      `${ep.path} 是单工作区的,但本包的描述里找不到任何"只是当前工作区"的说法 —— ` +
        `模型会以为不传 workspace_id 就是全都给它`,
    );
  }
});

test("跨账号的发现接口不许被描述成单工作区", async (t) => {
  const contract = await fetchContract();
  if (!contract) return t.skip(`契约拉不到(${CONTRACT_URL})`);

  const accountScoped = contract.endpoints.filter((e) => e.scope === "account");
  for (const ep of accountScoped) {
    if (!SOURCE.includes(ep.path)) continue;
    // products/summary 是仅有的跨工作区读接口,描述必须说出来 —— 否则模型不知道
    // 该用哪个工具回答"我一共有多少产品"。
    assert.ok(
      SOURCE.includes("spans EVERY workspace") || SOURCE.includes("account-wide AND per workspace"),
      `${ep.path} 跨全部工作区,但本包没在描述里说明 —— 模型会拿单工作区的工具去回答账号级问题`,
    );
  }
});

test("收窄作用域的接口必须有发现出口,且本包把它指出来", async (t) => {
  const contract = await fetchContract();
  if (!contract) return t.skip(`契约拉不到(${CONTRACT_URL})`);

  const discovery = contract.endpoints.filter((e) => e.discovery);
  assert.ok(discovery.length > 0, "服务端没有任何发现入口 —— 调用方会被永久锁在第一个工作区");

  // 模型得知道去哪里拿 workspace id,否则"可以传 workspace_id"是句空话。
  assert.ok(
    SOURCE.includes("get its id from autowhisper_status") ||
      SOURCE.includes("discover workspace ids"),
    "工具描述里没有告诉模型去哪儿取 workspace id",
  );
});

test("scope 字段的取值与服务端一致", async (t) => {
  const contract = await fetchContract();
  if (!contract) return t.skip(`契约拉不到(${CONTRACT_URL})`);

  // 本包的 scopeLine 里若还留着服务端已经不返回的取值,那是过期分支;
  // 留着不算错(兼容旧服务端),但服务端【新增】取值时本包必须跟上。
  for (const v of contract.scope_field_values) {
    assert.ok(
      SOURCE.includes(`"${v}"`),
      `服务端会返回 scope="${v}",但本包没有处理它 —— 渲染出来的作用域说明会是错的`,
    );
  }
});
