// Side-effect-free import for its module augmentation: this is what puts
// `locale` on the context type.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { HistoryCard } from './HistoryCard.tsx'
import { bindLocale } from './locale.ts'

/**
 * Browser half of the plugin. It owns how `get_history` calls render inside a
 * turn and nothing else — every other tool keeps the host's generic card, and a
 * client that never loads this file loses nothing but the chart.
 */
export const name = 'dsh-us-stocks'
export const inject = ['slots', 'locale']

/** Keyed by wire tool name; an unclaimed key falls back to the generic row. */
const HISTORY_TOOL = 'get_history'

export function apply(ctx: ClientContext): void {
  bindLocale(ctx.locale)

  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
    {
      name: 'tool.call.toolview',
      key: HISTORY_TOOL,
      registrant: 'dsh-us-stocks',
    },
    HistoryCard,
  ))
}
