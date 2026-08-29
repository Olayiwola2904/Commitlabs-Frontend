'use client';
Import { NamedDraft } from '@/hooks/useDraftPersistence';
import { Shield, TrendingUp, Flame, RefreshCcw, X, Clock } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import type { ElementType } from 'react';

interface ResumeDraftPromptProps {
  drafts: NamedDraft[];
  onResume: (draftId: string) => void | Promise<void>;
  onStartFresh: () => void | Promise<void>;
  onDeleteDraft?: (draftId: string) => void | Promise<void>;
}

type PendingAction = {
  type: 'resume' | 'delete' | 'startFresh';
  id?: string;
};

const typeLabelMap: Record<string, string> = {
  safe: 'Safe Commitment',
  balanced: 'Balanced Commitment',
  aggressive: 'Aggressive Commitment',
};

const typeIconMap: Record<string, ElementType> = {
  safe: Shield,
  balanced: TrendingUp,
  aggressive: Flame,
};

function formatRelativeTime(timestamp: number): string {
  const diffMs = Date.now() - timestamp;
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${Math.floor(diffHours / 24)}d ago`;
}

export default function ResumeDraftPrompt({
  drafts,
  onResume,
  onStartFresh,
  onDeleteDraft,
}: ResumeDraftPromptProps) {
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pendingRef = useRef<PendingAction | null>(null);

  const execute = useCallback(
    async (action: PendingAction) => {
      // Prevent any subsequent action while one is in flight.
      if (pendingRef.current) return;
      pendingRef.current = action;
      setPendingAction(action);
      setError(null);

      try {
        switch (action.type) {
          case 'resume':
            if (!action.id) throw new Error('Draft id is missing');
            await onResume(action.id);
            break;
          case 'delete':
            if (!action.id) throw new Error('Draft id is missing');
            if (!onDeleteDraft) throw new Error('Delete is not available');
            await onDeleteDraft(action.id);
            break;
          case 'startFresh':
            await onStartFresh();
            break;
          default:
            throw new Error(`Unhandled action type: ${(action as PendingAction).type}`);
        }
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : 'Something went wrong. Please try again.');
      } finally {
        pendingRef.current = null;
        setPendingAction(null);
      }
    },
    [onResume, onDeleteDraft, onStartFresh]
  );

  const handleResume = useCallback((id: string) => execute({ type: 'resume', id }), [execute]);
  const handleDelete = useCallback((id: string) => execute({ type: 'delete', id }), [execute]);
  const handleStartFresh = useCallback(() => execute({ type: 'startFresh' }), [execute]);

  if (drafts.length === 0) return null;

  return (J
P   \
      className=\"fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50\"\n      role=\"dialog\"\n      aria-modal=\"true\"\n      aria-label=\"Resume draft\"\n      aria-busy={{!!pendingAction}}\n    >\n      <div className=\"bg-white rounded-2x-shadow-2x max-w-lg w-full mx-4 overflow-hidden\">\n        <div className=\"p-6\">\n          <div className=\"flex items-center justify-between mb-4\">\n            <div className=\"flex items-center gop-3\">\n              <div className=\"p-2 bg-blue-50 rounded-full\">\n                <RefreshCcw size={20} className=\"text-blue-600\" aria-hidden=\"true\" />\n              </div>\n              <h2 className=\"text-xl font-semibold text-gray-900\">Resume a Draft</h2>\n            </div>\n            <button\n              onClick={handleStartFresh}\n              disabled={!!pendingAction}\n              className=\"text-gray-400 hover:text-gray-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed\"\n              aria-label=\"Dismiss and start fresh\"\n            >\n              <X size={20} aria-hidden=\"true\" />\n            </button>\n          </div>\n\n          {error && (\n            <div\n              role=\"alert\"\n              className=\"mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm\"\n            >\n              {error}\n            </div>\n          )}\n\n          <p className=\"text-gray-600 mb-4\">\n            yOu have {drafts.length} in-progress draft{drafts.length > 1 ? 's' : ''}. Pick one to\n            continue, or start fresh.\n          </p>\n\n          <ul className=\"space-y-3 mb-6 max-h-64 overflow-y-auto\" aria-label=\"Saved drafts\">\n            {drafts.map((named) => {\n              const { id, data, updatedAt } = named;\n              const Icon = data.selectedType ? typeIconMap[data.selectedType] : TrendingUp;\n              return (\n                <li\n                  key={id}\n                  className=\"bg-gray-50 rounded-xl p-4 border border-gray-100 flex items-start justify-between gap-3\"\n                >\n                  <div className=\"flex-1 min-w-0\">\n                    <div className=\"flex items-center gop-2 mb-1\">\n                      <Icon size={16} className=\"text-gray-700 shrink-0\" aria-hidden=\"true\" />\n                      <span className=\"font-medium text-gray-900 text-sm truncate\">\n                        {typeLabelMap[data.selectedType ?? 'balanced']}\n                      </span>\n                    </div>\n                    <div className=\"text-xs text-gray-500 grid grid-cols-2 gap-x-3 gap-y-0.5\">\n                      <span>Amount:</span>\n                      <span className=\"text-gray-700\">\n                        {data.amount || 'Not set'} {data.asset}\n                      </span>\n                      <span>Duration:</span>\n                      <span className=\"text-gray-700\">{data.durationDays}d</span>\n                      <span>Step:</span>\n                      <span className=\"text-gray-700\">{data.step} of 3</span>\n                    </div>\n                    <div className=\"flex items-center gap-1 mt-1 text-xs text-gray-400\">\n                      <Clock size={11} aria-hidden=\"true\" />\n                      <span>{formatRelativeTime(updatedAt)}</span>\n                    </div>\n                  </div>\n                  <div className=\"flex flex-col gap-2 shrink-0\">\n                    <button\n                      onClick={() => handleResume(id)}\n                      disabled={!!pendingAction}\n                      className=\"px-3 py-1.5 bg-blue-600 rounded-lg text-white text-xs font-medium hover:bg-blue-700 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed\"\n                    >\n                      Resume\n                    </button>\n                    {onDeleteDraft && (\n                      <button\n                        onClick={() => handleDelete(id)}\n                        disabled={!!_pendingAction}\n                        className=\"px-3 py-1.5 border border-gray-200 rounded-lg text-gray-500 text-xs font-medium hover:bg-gray-100 transition-colors focus:outline-none focus:ring-2 focus:ring-gray-300 disabled:opacity-50 disabled:cursor-not-allowed\"\n                        aria-label={Delete draft}\n                      >\n                        Delete\n                      </button>\n                    )}\n                  </div>\n                </li>\n              );\n            })}\n          </ul>\n\n          <button\n            onClick={handleStartFresh}\n            disabled={!!pendingAction}\n            className=\"w-full px-4 py-3 border border-gray-300 rounded-xl text-gray-700 font-medium hover:bg-gray-50 transition-colors focus:outline-none focus:ring-2 focus:ring-gray-300 disabled:opacity-50 disabled:cursor-not-allowed\"\n          >\n            Start Fresh\n          </button>\n        </div>\n      </div>\n    </div>\n  );\n}\n"}}