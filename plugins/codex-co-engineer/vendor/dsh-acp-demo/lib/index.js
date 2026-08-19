import { join } from 'node:path';
import z from '@deepseek-ai/schemastery';
import * as acp from '@deepseek-ai/dsh-acp';
import * as agentCore from '@deepseek-ai/dsh-agent-spine-demo';
import * as workspaceContext from '@deepseek-ai/dsh-agent-instructions';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import JsonlSessionPersistence, { JsonlCompressionSchema } from '@deepseek-ai/dsh-session-persistence-jsonl';
import * as sessionCheckpointPolicy from '@deepseek-ai/dsh-session-checkpoint-policy';
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite';

const name = 'acp-demo';
const DEFAULT_PERSISTENCE_ROOT = './.sessions';
const Config = z.object({
  provider: z.string().required(),
  model: z.string().required(),
  maxParallelToolCalls: z.number().step(1).min(1),
  persona: z.string(),
  toolOrder: z.array(z.string()).default(undefined),
  tools: ToolRuntime.Config,
  dshHome: z.string(),
  sessionTitle: agentCore.SessionTitleConfigSchema,
  persistenceRoot: z.string().default(DEFAULT_PERSISTENCE_ROOT),
  packChunks: z.boolean().default(true),
  persistenceCompression: JsonlCompressionSchema,
  workspaceContext: z.union([z.const(false), workspaceContext.Config]).required(),
  skills: agentCore.SkillConfigSchema,
  toolBash: agentCore.ToolBashConfigSchema,
  jobs: agentCore.JobsConfigSchema,
  toolJobs: z.union([z.const(false), agentCore.ToolJobsConfigSchema]),
  goals: z.union([z.const(false), agentCore.GoalConfigSchema]),
});

async function apply(context, config) {
  const goals = config.goals ?? {};
  const persistenceRoot = config.persistenceRoot ?? DEFAULT_PERSISTENCE_ROOT;
  await context.effect(async function* composition() {
    const spine = context.plugin(agentCore, { ...agentCore.pickSpineConfig(config), goals });
    await spine;
    yield spine.dispose;
    const persistence = context.plugin(JsonlSessionPersistence, {
      root: persistenceRoot,
      ...(config.packChunks !== undefined ? { packChunks: config.packChunks } : {}),
      ...(config.persistenceCompression === undefined ? {} : { compression: config.persistenceCompression }),
    });
    await persistence;
    yield persistence.dispose;
    const checkpoint = context.plugin(sessionCheckpointPolicy);
    await checkpoint;
    yield checkpoint.dispose;
    const query = context.plugin(SqliteSessionQueryEngine, { path: join(persistenceRoot, 'session-query.db') });
    await query;
    yield query.dispose;
    const transport = context.plugin(acp, { provider: config.provider, model: config.model });
    await transport;
    yield transport.dispose;
  }, 'acp-demo.composition');
}

export { Config, apply, name };
