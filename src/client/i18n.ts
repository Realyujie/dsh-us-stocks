/**
 * Copy owned by this plugin, in the two locales the host supports.
 *
 * Server-side error text is deliberately not translated. Those messages are
 * written for the model as much as for the reader, and one wording keeps the
 * two audiences seeing the same thing; the card labels them as coming from the
 * data source and prints them verbatim.
 */

import type { Bar } from './envelope.ts'
import { formatBarDateTime, formatPrice, formatVolume } from './geometry.ts'

export type Locale = 'zh' | 'en'

interface Copy {
  readonly hover: (bar: Bar) => string
  readonly loading: string
  readonly unreadable: string
  readonly noBars: string
  readonly volume: string
  readonly changeTitle: (fromDate: string, fromClose: number, toDate: string, toClose: number) => string
  readonly bars: (count: number) => string
  readonly chartLabel: (count: number, from: string, to: string) => string
  readonly sourceError: string
  readonly disclaimer: string
}


/**
 * One bar's four prices and volume. The letters are the international
 * abbreviations; the Chinese labels are what mainland terminals print.
 */
function hoverLine(bar: Bar, labels: readonly [string, string, string, string, string]): string {
  const open = bar.open ?? bar.close
  const high = bar.high ?? bar.close
  const low = bar.low ?? bar.close
  const parts = [
    `${labels[0]} ${formatPrice(open)}`,
    `${labels[1]} ${formatPrice(high)}`,
    `${labels[2]} ${formatPrice(low)}`,
    `${labels[3]} ${formatPrice(bar.close)}`,
  ]
  if (bar.volume !== undefined) parts.push(`${labels[4]} ${formatVolume(bar.volume)}`)
  return `${formatBarDateTime(bar.date)}  ${parts.join('  ')}`
}


const EN: Copy = {
  hover: (bar) => hoverLine(bar, ['O', 'H', 'L', 'C', 'V']),
  loading: 'Loading price history…',
  unreadable: 'Price history unavailable in a readable form.',
  noBars: 'No bars in the requested window.',
  volume: 'Vol',
  changeTitle: (fd, fc, td, tc) => `Close ${fc} on ${fd} → ${tc} on ${td}`,
  bars: (count) => `${count} bars`,
  chartLabel: (count, from, to) => `Candlestick chart, ${count} bars from ${from} to ${to}`,
  sourceError: 'Data source:',
  disclaimer: 'Data via Yahoo Finance, an unofficial API. Not investment advice.',
}

const ZH: Copy = {
  hover: (bar) => hoverLine(bar, ['开', '高', '低', '收', '量']),
  loading: '正在加载历史行情…',
  unreadable: '历史行情数据无法解析。',
  noBars: '所选时间窗口内没有 K 线数据。',
  volume: '成交量',
  changeTitle: (fd, fc, td, tc) => `${fd} 收盘 ${fc} → ${td} 收盘 ${tc}`,
  bars: (count) => `${count} 根`,
  chartLabel: (count, from, to) => `K 线图，${from} 至 ${to} 共 ${count} 根`,
  sourceError: '数据源返回：',
  disclaimer: '数据来自 Yahoo Finance（非官方接口）。不构成投资建议。',
}

export function copyFor(locale: Locale): Copy {
  return locale === 'zh' ? ZH : EN
}
