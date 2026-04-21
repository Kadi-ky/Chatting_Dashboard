import { useState, useMemo } from 'react'
import { MessageCircle, Sparkles, AlertCircle } from 'lucide-react'
import { useChatMessages } from '../hooks/useChatMessages'

// ── Helpers ─────────────────────────────────────────────

function initials(name) {
  if (!name) return '?'
  return name.split(' ').map(s => s[0]).slice(0, 2).join('').toUpperCase()
}

function formatTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

const MOOD_COLORS = {
  horny:      'bg-pink-500/20 text-pink-300',
  lonely:     'bg-blue-500/20 text-blue-300',
  chatty:     'bg-emerald-500/20 text-emerald-300',
  aggressive: 'bg-red-500/20 text-red-300',
  hesitant:   'bg-amber-500/20 text-amber-300',
}

const INTENT_COLORS = {
  just_talking:           'bg-slate-500/20 text-slate-300',
  demanding_free_content: 'bg-orange-500/20 text-orange-300',
  ready_to_buy:           'bg-emerald-500/20 text-emerald-300',
  complaining:            'bg-red-500/20 text-red-300',
}

function ClassBadge({ label, variant }) {
  const cls = variant === 'mood'
    ? (MOOD_COLORS[label] ?? 'bg-white/10 text-white/60')
    : (INTENT_COLORS[label] ?? 'bg-white/10 text-white/60')
  return (
    <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ${cls}`}>
      {label}
    </span>
  )
}

// ── Thread list item ────────────────────────────────────

function ThreadItem({ thread, active, onClick }) {
  const lastMsg = thread.messages[thread.messages.length - 1]
  return (
    <button
      onClick={onClick}
      className={`w-full text-left flex items-center gap-3 px-3 py-2.5 rounded-xl transition-colors ${
        active ? 'bg-white/15' : 'hover:bg-white/5'
      }`}
    >
      {thread.avatar ? (
        <img src={thread.avatar} alt="" className="w-10 h-10 rounded-full flex-shrink-0 object-cover" />
      ) : (
        <div className="w-10 h-10 rounded-full bg-gradient-to-br from-indigo-400 to-blue-500 flex items-center justify-center text-xs font-bold text-white flex-shrink-0">
          {initials(thread.name)}
        </div>
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-sm text-white font-medium truncate">{thread.name}</span>
          {thread.ai_paused && (
            <span className="text-[9px] bg-amber-500/20 text-amber-300 px-1.5 py-0.5 rounded">paused</span>
          )}
        </div>
        <div className="text-xs text-white/50 truncate">{lastMsg?.content ?? ''}</div>
      </div>
      <div className="text-[10px] text-white/40 flex-shrink-0">{formatTime(thread.last_message_at)}</div>
    </button>
  )
}

// ── Message bubble ──────────────────────────────────────

function MessageBubble({ msg }) {
  const isOut = msg.direction === 'out'
  const isDraft = msg.status === 'drafted'
  const isSuppressed = msg.status === 'suppressed'

  return (
    <div className={`flex ${isOut ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[75%] rounded-2xl px-3.5 py-2 ${
        isOut
          ? (isDraft ? 'bg-indigo-500/30 border border-indigo-400/40' : 'bg-indigo-500/50')
          : (isSuppressed ? 'bg-white/5 border border-white/10 opacity-60' : 'bg-white/10')
      }`}>
        <div className="text-sm text-white whitespace-pre-wrap">{msg.content}</div>
        <div className="flex items-center gap-1.5 mt-1 flex-wrap">
          {isDraft && (
            <span className="text-[10px] text-indigo-200 uppercase tracking-wider flex items-center gap-1">
              <Sparkles className="w-2.5 h-2.5" /> draft
            </span>
          )}
          {isSuppressed && (
            <span className="text-[10px] text-white/40 uppercase tracking-wider flex items-center gap-1">
              <AlertCircle className="w-2.5 h-2.5" /> suppressed
            </span>
          )}
          {msg.mood && <ClassBadge label={msg.mood} variant="mood" />}
          {msg.intent && <ClassBadge label={msg.intent} variant="intent" />}
          {msg.classifier_conf != null && (
            <span className="text-[10px] text-white/40">{Math.round(msg.classifier_conf * 100)}%</span>
          )}
          <span className="text-[10px] text-white/40 ml-auto">{formatTime(msg.created_at)}</span>
        </div>
      </div>
    </div>
  )
}

// ── Main component ─────────────────────────────────────

export default function ConversationsTab({ creatorUuid }) {
  const { threads, loading, error } = useChatMessages(creatorUuid)
  const [selectedFan, setSelectedFan] = useState(null)

  const selected = useMemo(
    () => threads.find(t => t.fan_id === selectedFan) ?? threads[0] ?? null,
    [threads, selectedFan],
  )

  return (
    <div className="mt-3 sm:mt-5 grid grid-cols-1 lg:grid-cols-3 gap-3 sm:gap-5">
      {/* Thread list */}
      <div className="lg:col-span-1 bg-white/10 backdrop-blur-md border border-white/10 rounded-[20px] p-3 shadow-sm max-h-[75vh] overflow-y-auto">
        <div className="flex items-center gap-2 px-3 py-2">
          <MessageCircle className="w-4 h-4 text-white/60" />
          <h2 className="text-white font-semibold text-sm">Conversations</h2>
          <span className="ml-auto text-xs text-white/40">{threads.length}</span>
        </div>
        {loading && <div className="text-sm text-white/40 px-3 py-4">Loading…</div>}
        {error && <div className="text-sm text-red-400 px-3 py-4">{error}</div>}
        {!loading && threads.length === 0 && (
          <div className="text-sm text-white/40 px-3 py-8 text-center">
            No conversations yet. Send a test webhook to <code className="text-white/70">/chat-inbound</code>.
          </div>
        )}
        <div className="flex flex-col gap-0.5">
          {threads.map(t => (
            <ThreadItem
              key={t.fan_id}
              thread={t}
              active={selected?.fan_id === t.fan_id}
              onClick={() => setSelectedFan(t.fan_id)}
            />
          ))}
        </div>
      </div>

      {/* Thread detail */}
      <div className="lg:col-span-2 bg-white/10 backdrop-blur-md border border-white/10 rounded-[20px] p-5 shadow-sm min-h-[60vh] flex flex-col">
        {!selected && (
          <div className="flex-1 flex items-center justify-center text-white/40 text-sm">
            Select a conversation
          </div>
        )}
        {selected && (
          <>
            <div className="flex items-center gap-3 pb-4 border-b border-white/10">
              {selected.avatar ? (
                <img src={selected.avatar} alt="" className="w-10 h-10 rounded-full object-cover" />
              ) : (
                <div className="w-10 h-10 rounded-full bg-gradient-to-br from-indigo-400 to-blue-500 flex items-center justify-center text-xs font-bold text-white">
                  {initials(selected.name)}
                </div>
              )}
              <div className="flex-1 min-w-0">
                <div className="text-white font-medium text-sm">{selected.name}</div>
                {selected.username && (
                  <div className="text-white/50 text-xs">@{selected.username}</div>
                )}
              </div>
              <div className="flex items-center gap-2 text-xs text-white/50">
                <span>depth: <span className="text-white/80">{selected.interaction_depth}</span></span>
                <span>·</span>
                <span>rapport: <span className="text-white/80">{selected.rapport_score}</span></span>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto py-4 space-y-2">
              {selected.messages.map(m => (
                <MessageBubble key={m.id} msg={m} />
              ))}
            </div>

            <div className="pt-3 border-t border-white/10 text-xs text-white/40">
              Phase 1: drafts are read-only — no outbound send. Confirm the classifier
              and generator behaviour before wiring the sender.
            </div>
          </>
        )}
      </div>
    </div>
  )
}
