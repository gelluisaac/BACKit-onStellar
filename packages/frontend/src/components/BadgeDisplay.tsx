'use client'

import { BadgeType, UserBadge } from '@/types'
import { cn } from '@/lib/utils'
import type { ComponentType } from 'react'
import { Crown, Flame, Gem, Sparkles, Target } from 'lucide-react'

type BadgeMeta = {
  label: BadgeType
  description: string
  icon: ComponentType<{ className?: string }>
  chipClassName: string
  iconClassName: string
  glowClassName: string
}

const BADGE_META: Record<BadgeType, BadgeMeta> = {
  'Early Adopter': {
    label: 'Early Adopter',
    description: 'Joined early and helped shape the community from the start.',
    icon: Sparkles,
    chipClassName: 'bg-amber-50 text-amber-900 border-amber-200',
    iconClassName: 'text-amber-600',
    glowClassName: 'hover:shadow-[0_0_24px_rgba(245,158,11,0.35)]',
  },
  'Top Predictor': {
    label: 'Top Predictor',
    description: 'Maintains a strong prediction record with consistently sharp calls.',
    icon: Target,
    chipClassName: 'bg-emerald-50 text-emerald-900 border-emerald-200',
    iconClassName: 'text-emerald-600',
    glowClassName: 'hover:shadow-[0_0_24px_rgba(16,185,129,0.35)]',
  },
  Whale: {
    label: 'Whale',
    description: 'Regularly makes high-value predictions and moves meaningful volume.',
    icon: Gem,
    chipClassName: 'bg-cyan-50 text-cyan-900 border-cyan-200',
    iconClassName: 'text-cyan-600',
    glowClassName: 'hover:shadow-[0_0_24px_rgba(14,165,233,0.35)]',
  },
  'Hot Streak': {
    label: 'Hot Streak',
    description: 'On a winning streak with a run of recent correct predictions.',
    icon: Flame,
    chipClassName: 'bg-rose-50 text-rose-900 border-rose-200',
    iconClassName: 'text-rose-600',
    glowClassName: 'hover:shadow-[0_0_24px_rgba(244,63,94,0.35)]',
  },
  'Community Leader': {
    label: 'Community Leader',
    description: 'Earns trust through helpful participation and strong community presence.',
    icon: Crown,
    chipClassName: 'bg-violet-50 text-violet-900 border-violet-200',
    iconClassName: 'text-violet-600',
    glowClassName: 'hover:shadow-[0_0_24px_rgba(139,92,246,0.35)]',
  },
}

interface BadgeDisplayProps {
  badges?: UserBadge[]
}

export default function BadgeDisplay({ badges = [] }: BadgeDisplayProps) {
  if (badges.length === 0) {
    return (
      <p className="inline-flex items-center rounded-full border border-dashed border-gray-300 bg-gray-50 px-3 py-1.5 text-sm font-medium text-gray-500">
        No badges yet — start predicting!
      </p>
    )
  }

  return (
    <div className="flex flex-wrap gap-2" role="list" aria-label="User achievement badges">
      {badges.map((badge) => {
        const meta = BADGE_META[badge.type]
        const Icon = meta.icon

        return (
          <div
            key={`${badge.type}-${badge.earnedAt ?? 'earned'}`}
            className="group relative"
            role="listitem"
          >
            <div
              className={cn(
                'inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-semibold shadow-sm transition-all duration-300 ease-out',
                'hover:-translate-y-0.5 hover:scale-[1.02]',
                'focus-within:-translate-y-0.5 focus-within:scale-[1.02]',
                meta.chipClassName,
                meta.glowClassName
              )}
              title={meta.description}
            >
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-white/80 shadow-sm ring-1 ring-inset ring-black/5">
                <Icon className={cn('h-3.5 w-3.5 transition-transform duration-300 group-hover:scale-110', meta.iconClassName)} />
              </span>
              <span>{meta.label}</span>
            </div>

            <span className="pointer-events-none absolute left-1/2 top-full z-10 mt-2 w-max max-w-[240px] -translate-x-1/2 rounded-lg bg-gray-900 px-2.5 py-1.5 text-xs leading-snug text-white opacity-0 shadow-lg transition-opacity duration-200 group-hover:opacity-100">
              {meta.description}
            </span>
          </div>
        )
      })}
    </div>
  )
}
