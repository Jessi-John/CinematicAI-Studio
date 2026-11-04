'use client';

import { motion } from 'framer-motion';
import { TrendingUp } from 'lucide-react';
import type { YouTubeSEO } from '@/types';

interface StorySeoTabProps {
  seo: YouTubeSEO;
}

export function StorySeoTab({ seo }: StorySeoTabProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.12 }}
      className="mb-8"
    >
      <div className="flex items-center gap-2 mb-4">
        <TrendingUp className="w-5 h-5 text-red-400" />
        <h2 className="text-lg font-semibold">YouTube SEO</h2>
      </div>
      <div className="bg-gradient-to-r from-red-500/10 via-orange-500/10 to-yellow-500/10 rounded-xl border border-red-500/20 p-6 space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="p-4 bg-[var(--bg-tertiary)] rounded-lg">
            <p className="text-sm text-[var(--text-tertiary)] mb-2">YouTube Title</p>
            <p className="text-white font-medium">{seo.title}</p>
          </div>
          <div className="p-4 bg-[var(--bg-tertiary)] rounded-lg">
            <p className="text-sm text-[var(--text-tertiary)] mb-2">Description</p>
            <p className="text-white text-sm">{seo.description}</p>
          </div>
        </div>

        <div>
          <p className="text-sm text-[var(--text-tertiary)] mb-2">Tags</p>
          <div className="flex flex-wrap gap-2">
            {seo.tags.map((tag, idx) => (
              <span key={idx} className="px-3 py-1 bg-red-500/20 text-red-400 rounded-full text-xs">#{tag}</span>
            ))}
          </div>
        </div>

        <div>
          <p className="text-sm text-[var(--text-tertiary)] mb-2">Thumbnail Suggestions</p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {seo.thumbnailSuggestions.map((thumb, idx) => (
              <div key={idx} className="p-3 bg-[var(--bg-secondary)] rounded-lg border border-[var(--border)]">
                <p className="text-xs text-[var(--text-secondary)]">{thumb}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="p-4 bg-[var(--bg-tertiary)] rounded-lg">
            <p className="text-sm text-[var(--text-tertiary)] mb-2">Video Template</p>
            <p className="text-white text-sm">{seo.videoTemplate}</p>
          </div>
          <div className="p-4 bg-[var(--bg-tertiary)] rounded-lg">
            <p className="text-sm text-[var(--text-tertiary)] mb-2">Hook Script</p>
            <p className="text-white text-sm italic">&ldquo;{seo.hookScript}&rdquo;</p>
          </div>
        </div>

        <div>
          <p className="text-sm text-[var(--text-tertiary)] mb-2">Algorithm Boost Tips</p>
          <ul className="space-y-2">
            {seo.algorithmBoostTips.map((tip, idx) => (
              <li key={idx} className="flex items-start gap-2 text-sm text-[var(--text-secondary)]">
                <span className="text-green-400">•</span>
                {tip}
              </li>
            ))}
          </ul>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="p-4 bg-[var(--bg-tertiary)] rounded-lg text-center">
            <p className="text-sm text-[var(--text-tertiary)] mb-1">Viral Potential</p>
            <p className="text-2xl font-bold text-red-400">{seo.viralPotential}/100</p>
          </div>
          <div className="p-4 bg-[var(--bg-tertiary)] rounded-lg text-center">
            <p className="text-sm text-[var(--text-tertiary)] mb-1">Duration</p>
            <p className="text-white text-sm">{seo.recommendedDuration}</p>
          </div>
          <div className="p-4 bg-[var(--bg-tertiary)] rounded-lg text-center">
            <p className="text-sm text-[var(--text-tertiary)] mb-1">Target Audience</p>
            <p className="text-white text-xs">{seo.targetAudience}</p>
          </div>
          <div className="p-4 bg-[var(--bg-tertiary)] rounded-lg text-center">
            <p className="text-sm text-[var(--text-tertiary)] mb-1">CTA Script</p>
            <p className="text-white text-xs truncate">{seo.ctaScript}</p>
          </div>
        </div>

        <div>
          <p className="text-sm text-[var(--text-tertiary)] mb-2">Trending Keywords</p>
          <div className="flex flex-wrap gap-2">
            {seo.trendingKeywords.map((keyword, idx) => (
              <span key={idx} className="px-3 py-1 bg-yellow-500/20 text-yellow-400 rounded-full text-xs">{keyword}</span>
            ))}
          </div>
        </div>
      </div>
    </motion.div>
  );
}
