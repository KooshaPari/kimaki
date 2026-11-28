// The projection boundary of the bot seam, kept as data so the seam file stays
// readable. Four observer envelopes become bot events; every other client type
// is named here instead of being dropped silently or synthesized.

/**
 * The only envelopes this seam projects into the bot's V2 event stream. A
 * persisted record carries: the user message that started a turn (started), the
 * assistant text (text.ended), its `token_usage` (step.ended) and, because the
 * record only holds a finished reply, the end of that execution (succeeded).
 */
export const JCODE_BOT_PROJECTED_EVENTS = [
  'session.execution.started',
  'session.text.ended',
  'session.step.ended',
  'session.execution.succeeded',
] as const

/**
 * Every V2 event type this seam does NOT project. The list is exhaustive for the
 * client's union except the two projected; it is exported so a caller can state
 * the gap instead of discovering it from missing output.
 */
export const JCODE_BOT_NOT_PROJECTED = [
  'location.shutdown',
  'models.dev.refreshed',
  'credential.updated',
  'credential.switched',
  'integration.updated',
  'provider.updated',
  'model.updated',
  'agent.updated',
  'session.created',
  'session.agent.selected',
  'session.model.selected',
  'session.moved',
  'session.renamed',
  'session.metadata.updated',
  'session.permissions',
  'session.viewed',
  'session.usage.updated',
  'session.deleted',
  'session.forked',
  'session.inbox.delivered',
  'session.inbox.enqueued',
  'session.inbox.cancelled',
  'session.inbox.delivery.changed',
  'session.execution.failed',
  'session.execution.interrupted',
  'session.instructions.updated',
  'session.synthetic',
  'session.skill.activated',
  'session.shell.started',
  'session.shell.ended',
  'session.step.started',
  'session.step.streamed',
  'session.step.failed',
  'session.text.started',
  'session.text.delta',
  'session.reasoning.started',
  'session.reasoning.delta',
  'session.reasoning.ended',
  'session.tool.input.started',
  'session.tool.input.delta',
  'session.tool.input.ended',
  'session.tool.called',
  'session.tool.progress',
  'session.tool.success',
  'session.tool.failed',
  'session.retry.scheduled',
  'session.compaction.started',
  'session.compaction.delta',
  'session.compaction.ended',
  'session.compaction.failed',
  'session.revert.staged',
  'session.revert.cleared',
  'session.revert.committed',
  'filesystem.changed',
  'reference.updated',
  'permission.asked',
  'permission.replied',
  'plugin.updated',
  'project.updated',
  'worktree.updated',
  'worktree.resolved',
  'command.updated',
  'config.updated',
  'skill.updated',
  'pty.created',
  'pty.updated',
  'pty.exited',
  'pty.deleted',
  'persistent.pty.added',
  'persistent.pty.removed',
  'shell.created',
  'shell.exited',
  'shell.deleted',
  'form.created',
  'form.replied',
  'form.cancelled',
  'websearch.updated',
  'session.status.updated',
  'session.idle',
  'tui.prompt.append',
  'tui.command.execute',
  'tui.toast.show',
  'tui.session.select',
  'installation.updated',
  'installation.update.available',
  'vcs.branch.updated',
  'mcp.status.changed',
  'mcp.resources.changed',
  'server.connected',
] as const

/** Why exactly these types are absent, in one place for the report. */
export const JCODE_BOT_NOT_PROJECTED_REASON =
  'A persisted Jcode record holds messages only: a user message, assistant text and that message\'s token_usage. It carries no separate execution-start marker (the last user message is the start), no step lifecycle beyond the finished reply, no tool/reasoning records, no permission or form requests and no catalog hints, so this seam emits nothing for those types rather than synthesizing them.'
