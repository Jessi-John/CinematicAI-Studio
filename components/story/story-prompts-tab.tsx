'use client';

import { useState } from 'react';
import { motion } from 'framer-motion';
import { Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface PromptItem {
  episode: number;
  scene: number;
  content: string;
}

interface StoryPromptsTabProps {
  title: string;
  icon: string;
  prompts: PromptItem[];
  episodeCount: number;
  onCopy: (text: string) => Promise<void>;
}

export function StoryPromptsTab({ title, icon, prompts, episodeCount, onCopy }: StoryPromptsTabProps) {
  const [copyFormat, setCopyFormat] = useState<'compact' | 'verbose'>('compact');

  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="mb-8">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <span aria-hidden>{icon}</span> {title}
          </h2>
          <p className="text-sm text-[var(--text-tertiary)] mt-1">
            {prompts.length} prompts across {episodeCount} episodes
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => {
            const text = copyFormat === 'compact'
              ? prompts.map((p) => `[E${p.episode}·S${p.scene}] ${p.content}`).join('\n\n')
              : prompts.map((p) => `[Episode ${p.episode}, Scene ${p.scene}]\n${p.content}`).join('\n\n');
            void onCopy(text);
          }}>
            <Copy className="w-4 h-4 mr-2" />
            Copy All {copyFormat === 'compact' ? '(E·S)' : '(Full)'}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setCopyFormat(copyFormat === 'compact' ? 'verbose' : 'compact')}>
            {copyFormat === 'compact' ? 'Verbose' : 'Compact'}
          </Button>
        </div>
      </div>
      <div className="space-y-3">
        {prompts.map((prompt) => (
          <div key={`${title}-${prompt.episode}-${prompt.scene}`} className="p-4 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-xl">
            <div className="flex items-center gap-2 mb-2">
              <span className="px-2 py-0.5 bg-purple-500/20 text-purple-400 rounded text-xs font-mono">
                E{prompt.episode}·S{prompt.scene}
              </span>
              <button type="button" onClick={() => void onCopy(prompt.content)} className="ml-auto p-1 rounded hover:bg-white/10" aria-label="Copy prompt">
                <Copy className="w-3.5 h-3.5" />
              </button>
            </div>
            <pre className="text-sm font-mono text-[var(--text-secondary)] whitespace-pre-wrap line-clamp-4">
              {prompt.content}
            </pre>
          </div>
        ))}
      </div>
    </motion.div>
  );
}
