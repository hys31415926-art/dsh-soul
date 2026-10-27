/**
 * skill — 把「长期协作工作流」注册成宿主技能（skills 服务可用时）。
 *
 * 技能只负责告诉主模型流程：先查长期记忆/项目状态，再动手；用 soul_* 工具
 * 维护项目与记忆；完成前验证真实结果。持久化与检索仍由插件程序完成。
 */
import { readFileSync } from 'node:fs';

export function registerSkill(ctx, { paths, logger }) {
  const skills = typeof ctx.get === 'function' ? ctx.get('skills') : undefined;
  if (!skills || typeof skills.register !== 'function') {
    logger?.warn?.('skills 服务不可用：soul-workflow 技能未注册');
    return () => {};
  }

  let content = '';
  try {
    content = readFileSync(paths.skill, 'utf8').trim();
  } catch (error) {
    logger?.warn?.(`读取技能文件失败（${paths.skill}）：${error?.message ?? error}`);
    return () => {};
  }
  if (content === '') {
    logger?.warn?.(`技能文件为空：${paths.skill}`);
    return () => {};
  }

  return skills.register({
    name: 'soul-workflow',
    description: '长期共同工作流程：从长期记忆与项目档案恢复上下文，用 soul_* 工具维护项目/任务/记忆，执行真实工具并验证结果，收尾时更新状态。',
    content,
    invocation: { modelInvocable: true, userInvocable: true },
  });
}
