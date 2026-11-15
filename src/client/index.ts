// Side-effect-free imports for their module augmentations: these are what put
// `locale` and `slots` on the context type. DSH 0.2 dropped
// dsh-client-runtime; `slots` now comes from the UI renderer, and the client
// context is cordis's own `Context`.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
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
