/**
 * llm-client — 用宿主已有模型做「辅助任务」的最小客户端。
 *
 * 目的：记忆抽取需要理解语义，规则正则做不好（用户已多次指出断句、错归属、
 * 把助手的话当用户事实）。但项目本身不引入任何外部 API / 新密钥：
 *   · 复用宿主 ctx.llm（同一 Provider、同一模型、同一额度与计费）；
 *   · 辅助请求用宿主公开的 prepareCall + BlockAssembler 接口，超时/取消可控；
 *   · 路由（provider/model）优先取配置，否则用本会话最近一次真实请求的路由
 *     （监听 llm/stream 记录），保证和对话使用同一模型；
 *   · 任何失败都返回 null，由调用方降级，绝不阻塞主对话。
 */
import { clip } from '../util.js';

/** 记录到的路由最多沿用多久（避免用半小时前的路由做后台调用）。 */
const ROUTE_MAX_AGE_MS = 30 * 60_000;

let sdkPromise = null;

/** 懒加载宿主 LLM SDK（@deepseek-ai/dsh-llm 由宿主提供；加载失败则降级）。 */
async function loadSdk() {
  if (!sdkPromise) {
    sdkPromise = import('@deepseek-ai/dsh-llm').then((mod) => ({
      BlockAssembler: mod.BlockAssembler,
      createUserMessage: mod.createUserMessage,
    })).catch(() => null);
  }
  return sdkPromise;
}

/** 从模型返回文本里取出 JSON 对象（容忍 ```json 围栏与前后废话）。 */
export function extractJsonObject(text) {
  const raw = String(text ?? '').trim();
  if (raw === '') return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * 创建辅助 LLM 客户端。
 * @param {object} ctx 插件上下文（cordis）
 * @param {object} config 插件配置（extractProvider/extractModel/extractMaxTokens/extractTimeoutMs）
 * @param {object} logger
 * @returns {{available:boolean, routeFor:(sessionId:string)=>object|null, callJson:Function, dispose:Function}}
 */
export function createLlmClient(ctx, config, logger) {
  const disposers = [];
  const routes = new Map();
  let lastRoute = null;
  let api = null;
  let routeLogged = false;

  // 记录每个会话真实请求用的路由：辅助抽取默认跟随对话模型，不写死模型名。
  // 第一次拿到路由时回调 onRoute：用于把「进程启动前遗留的未抽取回合」补做抽取。
  try {
    disposers.push(ctx.on('llm/stream', (options, next) => {
      try {
        if (options && typeof options === 'object' && options.provider && options.model) {
          const route = { provider: String(options.provider), model: String(options.model), at: Date.now() };
          lastRoute = route;
          if (options.sessionId) routes.set(String(options.sessionId), route);
          if (!routeLogged) {
            routeLogged = true;
            logger?.info?.(`已捕获模型路由 ${route.provider}/${route.model}（语义抽取将跟随该路由）`);
          }
          try {
            api?.onRoute?.(route);
          } catch {
            // onRoute 回调失败不影响主请求。
          }
        }
      } catch {
        // 路由记录失败不影响主请求。
      }
      return next();
    }));
  } catch (error) {
    logger?.debug?.('llm/stream 监听不可用（辅助抽取将依赖配置路由）', error?.message ?? error);
  }

  function configuredRoute() {
    const provider = String(config?.extractProvider ?? '').trim();
    const model = String(config?.extractModel ?? '').trim();
    return provider !== '' && model !== '' ? { provider, model } : null;
  }

  function routeFor(sessionId) {
    const explicit = configuredRoute();
    if (explicit) return explicit;
    const cached = routes.get(String(sessionId ?? ''));
    if (cached && Date.now() - cached.at <= ROUTE_MAX_AGE_MS) return cached;
    if (lastRoute && Date.now() - lastRoute.at <= ROUTE_MAX_AGE_MS) return lastRoute;
    return null;
  }

  /** 是否已经能确定一个可用路由（配置或本进程内捕获过真实请求）。 */
  function hasRoute() {
    if (configuredRoute() !== null) return true;
    return Boolean(routeFor(''));
  }

  // ctx.get(name, strict=false) 在服务未激活时返回 undefined（不抛错）。
  let llm = null;
  try {
    llm = ctx.get ? ctx.get('llm', false) : null;
  } catch {
    llm = null;
  }

  /**
   * 发起一次辅助 JSON 请求。
   * @returns {Promise<{ok:boolean, json?:object, text?:string, reason?:string}>}
   */
  async function callJson({ sessionId = '', system = '', input = '', maxTokens = 900, timeoutMs = 30_000, purpose = 'soul-memory' } = {}) {
    if (!llm || typeof llm.prepareCall !== 'function') return { ok: false, reason: 'llm-service-unavailable' };
    const route = routeFor(sessionId);
    if (!route) return { ok: false, reason: 'no-route' };
    const sdk = await loadSdk();
    if (!sdk?.BlockAssembler || !sdk?.createUserMessage) return { ok: false, reason: 'llm-sdk-unavailable' };
    const timeout = Math.max(2_000, Math.min(180_000, Number(timeoutMs) || 30_000));
    const signal = AbortSignal.timeout(timeout);
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const call = await llm.prepareCall({ ...route, maxTokens }, signal);
        const options = {
          ...call.config,
          messages: [sdk.createUserMessage({
            content: [{ type: 'text', text: input }],
            source: { kind: 'soul-memory' },
          })],
          system,
          sessionId,
          purpose,
          signal,
        };
        const assembler = new sdk.BlockAssembler();
        for await (const chunk of call.stream(options)) {
          if (signal.aborted) break;
          assembler.push(chunk);
        }
        const finish = assembler.finish ?? null;
        if (finish && finish.kind !== 'stop' && finish.kind !== 'max-tokens') {
          return { ok: false, reason: `finish-${finish.kind ?? 'unknown'}` };
        }
        const blocks = typeof assembler.blocks === 'function' ? assembler.blocks() : [];
        const text = (Array.isArray(blocks) ? blocks : [])
          .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('\n')
          .trim();
        if (text === '') {
          // 偶发空返回：同回合重试一次，仍空再降级为程序侧日志，避免整轮记忆丢失。
          if (attempt === 0) {
            logger?.debug?.('辅助抽取返回空内容，800ms 后重试一次');
            await new Promise((resolve) => {
              const timer = setTimeout(resolve, 800);
              timer.unref?.();
            });
            continue;
          }
          return { ok: false, reason: 'empty-response' };
        }
        const json = extractJsonObject(text);
        if (!json) return { ok: false, reason: 'invalid-json', text: clip(text, 500) };
        return { ok: true, json, text };
      } catch (error) {
        lastError = error;
        const code = String(error?.code ?? '');
        const message = String(error?.message ?? '');
        // 路由注册/回收存在瞬时窗口（尤其 headless 进程收尾时），重试一次再降级。
        if (attempt === 0 && /NO_ADAPTER|no adapter|not registered/i.test(code + ' ' + message)) {
          try {
            logger?.debug?.(`辅助模型路由瞬断（${code || 'error'}），1.2s 后重试一次`);
          } catch { /* 日志失败忽略 */ }
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, 1200);
            timer.unref?.();
          });
          continue;
        }
        break;
      }
    }
    return {
      ok: false,
      reason: String(lastError?.code ?? lastError?.name ?? 'error'),
      detail: clip(String(lastError?.message ?? lastError ?? 'unknown'), 300),
    };
  }

  api = {
    available: Boolean(llm),
    routeFor,
    hasRoute,
    callJson,
    /** 首次得到可用路由时触发（由 index/hooks 挂接恢复逻辑）。 */
    onRoute: null,
    dispose() {
      for (const dispose of disposers) {
        try { dispose?.(); } catch { /* 忽略 */ }
      }
      disposers.length = 0;
    },
  };
  return api;
}
