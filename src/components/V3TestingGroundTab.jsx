import { useState, useEffect, useCallback, useMemo } from 'react'
import { MessageCircle, Sparkles, Send, PlusCircle, RefreshCw, AlertCircle, Pause, Play, Eye, Lock, Check, DollarSign } from 'lucide-react'
import { v3api, v3Configured } from '../lib/v3api'

// %% Helpers %%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%

function initials(name) {
  if (!name) return '?'
  return name.split(' ').map((s) => s[0]).slice(0, 2).join('').toUpperCase()
}

function formatTime(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

const PHASE_COLORS = {
  WARMUP: 'bg-sky-500/20 text-sky-300',
  RAPPORT: 'bg-emerald-500/20 text-emerald-300',
  QUALIFYING: 'bg-amber-500/20 text-amber-300',
  MONETIZING: 'bg-pink-500/20 text-pink-300',
  WHALE: 'bg-purple-500/20 text-purple-300',
  REACTIVATION: 'bg-orange-500/20 text-orange-300',
  COLD: 'bg-slate-500/20 text-slate-300',
}

function PhaseBadge({ phase }) {
  const cls = PHASE_COLORS[phase] || 'bg-white/10 text-white/60'
  return (
    <span className={`text-[10px] uppercase tracking-wider px-2 py-0.5 rounded ${cls}`}>
      {phase}
    </span>
  )
}

// %% New fan modal %%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%

function NewFanForm({ onSend, sending }) {
  const [externalId, setExternalId] = useState('')
  const [name, setName] = useState('')
  const [msg, setMsg] = useState('')

  const submit = async (e) => {
    e.preventDefault()
    if (!externalId.trim() || !msg.trim()) return
    await onSend({
      subscriberExternalId: externalId.trim(),
      subscriberName: name.trim() || externalId.trim(),
      text: msg.trim(),
    })
    setMsg('')
  }

  return (
    <form onSubmit={submit} className="bg-white/5 border border-white/10 rounded-xl p-3 space-y-2">
      <div className="text-xs text-white/60 font-medium flex items-center gap-1.5">
        <PlusCircle className="w-3.5 h-3.5" /> Start a new test conversation
      </div>
      <div className="flex gap-2">
        <input
          value={externalId}
          onChange={(e) => setExternalId(e.target.value)}
          placeholder="Fan external id (e.g. test-fan-001)"
          className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white placeholder-white/30 focus:outline-none focus:border-indigo-500"
        />
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Display name (optional)"
          className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white placeholder-white/30 focus:outline-none focus:border-indigo-500"
        />
      </div>
      <div className="flex gap-2">
        <input
          value={msg}
          onChange={(e) => setMsg(e.target.value)}
          placeholder="First message from the fan..."
          className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-xs text-white placeholder-white/30 focus:outline-none focus:border-indigo-500"
        />
        <button
          type="submit"
          disabled={sending || !externalId.trim() || !msg.trim()}
          className="bg-indigo-500 hover:bg-indigo-600 disabled:opacity-50 text-white rounded-lg px-3 py-2 text-xs font-medium flex items-center gap-1.5 shrink-0"
        >
          <Send className="w-3 h-3" /> Inject
        </button>
      </div>
    </form>
  )
}

// %% Existing-thread input %%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%

function ReplyAsFan({ thread, onSend, sending }) {
  const [msg, setMsg] = useState('')

  const submit = async (e) => {
    e.preventDefault()
    if (!msg.trim()) return
    await onSend({
      subscriberExternalId: thread.subscriberExternalId,
      subscriberName: thread.displayName,
      text: msg.trim(),
    })
    setMsg('')
  }

  return (
    <form onSubmit={submit} className="pt-3 border-t border-white/10 flex items-center gap-2 mt-4">
      <input
        type="text"
        autoFocus
        value={msg}
        onChange={(e) => setMsg(e.target.value)}
        placeholder={`Message as ${thread.displayName || thread.subscriberExternalId}...`}
        className="flex-1 bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white placeholder-white/30 focus:outline-none focus:border-indigo-500 focus:bg-white/10 transition-colors"
      />
      <button
        type="submit"
        disabled={sending || !msg.trim()}
        className="bg-indigo-500 hover:bg-indigo-600 disabled:opacity-50 text-white rounded-xl px-5 py-2.5 text-sm font-medium transition-colors flex items-center gap-2 shrink-0"
      >
        <Send className="w-4 h-4" /> Inject
      </button>
    </form>
  )
}

// %% Message bubble %%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%

function PpvCard({ msg, onBuy, buying }) {
  const ppv = msg.ppv
  const isPending = !msg.sentAt
  const unlocked = ppv?.outcome === 'unlocked'
  const expired = ppv?.outcome === 'expired'
  const priceDollars = ppv ? (ppv.priceCents / 100).toFixed(2) : '—'

  const state = isPending
    ? 'sending'
    : unlocked
      ? 'unlocked'
      : expired
        ? 'expired'
        : 'locked'

  return (
    <div className="flex justify-end">
      <div className="max-w-[80%] w-[320px] rounded-2xl overflow-hidden border border-pink-400/40 bg-gradient-to-br from-pink-500/20 to-purple-500/20 shadow-lg">
        {/* Caption from the bot */}
        {msg.text && (
          <div className="px-3.5 py-2 text-sm text-white whitespace-pre-wrap">{msg.text}</div>
        )}
        {/* Locked media preview */}
        <div className="relative bg-black/50 h-40 flex items-center justify-center">
          {state === 'unlocked' ? (
            <div className="flex flex-col items-center gap-1 text-emerald-300">
              <Check className="w-8 h-8" />
              <span className="text-xs uppercase tracking-wider">unlocked</span>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-1 text-white/70">
              <Lock className="w-8 h-8" />
              <span className="text-xs uppercase tracking-wider">
                {state === 'sending' ? 'sending...' : state === 'expired' ? 'expired' : 'locked'}
              </span>
            </div>
          )}
        </div>
        {/* Price + Buy button */}
        <div className="px-3.5 py-2.5 flex items-center justify-between bg-black/30">
          <div className="flex items-center gap-1 text-white font-semibold">
            <DollarSign className="w-4 h-4" />
            <span>{priceDollars}</span>
          </div>
          <div className="flex items-center gap-2 text-[10px] text-pink-200/80">
            {ppv?.assetTitle && (
              <span className="truncate max-w-[120px]" title={ppv.assetTitle}>{ppv.assetTitle}</span>
            )}
          </div>
          {state === 'locked' && (
            <button
              onClick={() => onBuy(msg)}
              disabled={buying}
              className="bg-pink-500 hover:bg-pink-600 disabled:opacity-50 text-white text-xs font-medium rounded-lg px-3 py-1.5 transition-colors"
              title="Simulate fan purchase — triggers the same ppv.unlocked event flow as a real webhook"
            >
              {buying ? 'Buying...' : 'Buy'}
            </button>
          )}
          {state === 'unlocked' && ppv?.unlockedAt && (
            <span className="text-[10px] text-emerald-300">
              {formatTime(ppv.unlockedAt)}
            </span>
          )}
        </div>
        <div className="px-3.5 pb-2 text-[10px] text-white/40 flex items-center gap-1.5">
          <Sparkles className="w-2.5 h-2.5 text-pink-300" />
          <span className="uppercase tracking-wider">ppv</span>
          <span className="ml-auto">{formatTime(msg.sentAt || msg.createdAt)}</span>
        </div>
      </div>
    </div>
  )
}

function MessageBubble({ msg, onBuy, buying }) {
  const isOut = msg.direction === 'outbound'
  const isPPV = msg.kind === 'ppv'
  const isPending = isOut && !msg.sentAt

  if (isPPV && isOut) {
    return <PpvCard msg={msg} onBuy={onBuy} buying={buying} />
  }

  return (
    <div className={`flex ${isOut ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[75%] rounded-2xl px-3.5 py-2 ${
          isOut
            ? isPending
              ? 'bg-indigo-500/30 border border-indigo-400/40'
              : 'bg-indigo-500/50'
            : 'bg-white/10'
        }`}
      >
        <div className="text-sm text-white whitespace-pre-wrap">{msg.text}</div>
        <div className="flex items-center gap-1.5 mt-1 flex-wrap">
          {isPending && (
            <span className="text-[10px] text-indigo-200 uppercase tracking-wider flex items-center gap-1">
              <Sparkles className="w-2.5 h-2.5" /> sending...
            </span>
          )}
          {!isPending && (
            <span className="text-[10px] text-white/40 ml-auto">{formatTime(msg.sentAt || msg.createdAt)}</span>
          )}
        </div>
      </div>
    </div>
  )
}

// %% Why-drawer %%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%

function WhyDrawer({ conversationId, onClose }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let alive = true
    v3api.why(conversationId)
      .then((d) => { if (alive) setData(d) })
      .catch((e) => { if (alive) setError(e.message) })
    return () => { alive = false }
  }, [conversationId])

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/80 flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-slate-900 border border-white/10 rounded-2xl w-full max-w-4xl max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between p-4 border-b border-white/10 sticky top-0 bg-slate-900">
          <h3 className="text-white font-semibold">Why this reply</h3>
          <button onClick={onClose} className="text-white/60 hover:text-white">✕</button>
        </div>
        <div className="p-4 text-xs text-white/70">
          {error && <div className="text-red-400">{error}</div>}
          {!data && !error && <div>Loading...</div>}
          {data && !data.found && <div>No turn audit found for this conversation yet.</div>}
          {data?.found && (
            <div className="space-y-3">
              <div><span className="text-white/50">Provider:</span> <span className="text-white">{data.provider} / {data.model}</span></div>
              <div><span className="text-white/50">Created:</span> <span className="text-white">{new Date(data.createdAt).toLocaleString()}</span></div>
              <details>
                <summary className="cursor-pointer text-white/80 font-medium">Request</summary>
                <pre className="bg-black/40 rounded p-2 mt-2 overflow-x-auto text-[11px]">{JSON.stringify(data.request, null, 2)}</pre>
              </details>
              <details>
                <summary className="cursor-pointer text-white/80 font-medium">Response</summary>
                <pre className="bg-black/40 rounded p-2 mt-2 overflow-x-auto text-[11px]">{JSON.stringify(data.response, null, 2)}</pre>
              </details>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// %% Main component %%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%

export default function V3TestingGroundTab() {
  const [threads, setThreads] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [selectedDetail, setSelectedDetail] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [sending, setSending] = useState(false)
  const [takeoverBusy, setTakeoverBusy] = useState(false)
  const [takeoverOn, setTakeoverOn] = useState(false)
  const [showWhy, setShowWhy] = useState(false)
  const [buyingMessageId, setBuyingMessageId] = useState(null)

  const loadThreads = useCallback(async () => {
    if (!v3Configured) {
      setError('VITE_V3_ADMIN_URL / VITE_V3_ADMIN_TOKEN not set in .env.local')
      setLoading(false)
      return
    }
    try {
      const { threads: t } = await v3api.listThreads()
      setThreads(t || [])
      setError(null)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  const loadDetail = useCallback(async (id) => {
    if (!id || !v3Configured) return
    try {
      const detail = await v3api.getThread(id)
      if (detail.found) {
        setSelectedDetail(detail)
        const t = await v3api.getTakeover(id)
        setTakeoverOn(Boolean(t.takeover))
      }
    } catch (err) {
      setError(err.message)
    }
  }, [])

  // Initial load + 2s poll for thread list (realtime alternative)
  useEffect(() => {
    loadThreads()
    const iv = setInterval(loadThreads, 2000)
    return () => clearInterval(iv)
  }, [loadThreads])

  // 1s poll for the selected thread — faster so you see replies materialize
  useEffect(() => {
    if (!selectedId) return
    loadDetail(selectedId)
    const iv = setInterval(() => loadDetail(selectedId), 1000)
    return () => clearInterval(iv)
  }, [selectedId, loadDetail])

  // Default-select the most recent thread on load
  useEffect(() => {
    if (!selectedId && threads.length > 0) {
      setSelectedId(threads[0].conversationId)
    }
  }, [threads, selectedId])

  const handleInject = async (payload) => {
    setSending(true)
    try {
      await v3api.injectMessage(payload)
      await loadThreads()
      // If injecting to a brand-new fan, select the new thread once it shows up
      setTimeout(() => loadThreads(), 600)
    } catch (err) {
      setError(err.message)
    } finally {
      setSending(false)
    }
  }

  const handleBuyPpv = async (msg) => {
    if (!selectedId) return
    setBuyingMessageId(msg.id)
    try {
      await v3api.buyPpv({ conversationId: selectedId, messageId: msg.id })
      // Force-refresh the thread so the PPV card flips to "unlocked" immediately.
      await loadDetail(selectedId)
    } catch (err) {
      setError(err.message)
    } finally {
      setBuyingMessageId(null)
    }
  }

  const toggleTakeover = async () => {
    if (!selectedId) return
    setTakeoverBusy(true)
    try {
      const r = await v3api.setTakeover(selectedId, !takeoverOn)
      setTakeoverOn(Boolean(r.takeover))
    } catch (err) {
      setError(err.message)
    } finally {
      setTakeoverBusy(false)
    }
  }

  const selectedThread = useMemo(() => threads.find((t) => t.conversationId === selectedId) ?? null, [threads, selectedId])
  const conv = selectedDetail?.conversation
  const archetype = selectedDetail?.archetype
  const messages = selectedDetail?.messages ?? []

  if (!v3Configured) {
    return (
      <div className="mt-3 sm:mt-5 bg-white/10 backdrop-blur-md border border-white/10 rounded-[20px] p-6 text-sm text-white/70">
        <div className="flex items-center gap-2 mb-3 text-amber-300">
          <AlertCircle className="w-4 h-4" /> V3 backend not configured
        </div>
        <p className="mb-2">To use the V3 Testing Ground, add these to your <code className="text-indigo-300">.env.local</code>:</p>
        <pre className="bg-black/40 rounded-lg p-3 text-xs overflow-x-auto">{`VITE_V3_ADMIN_URL=http://localhost:8787
VITE_V3_ADMIN_TOKEN=your-admin-token`}</pre>
        <p className="mt-3 text-white/50">Then start the backend: <code className="text-indigo-300">cd backend && npm run dev</code></p>
      </div>
    )
  }

  return (
    <div className="mt-3 sm:mt-5 grid grid-cols-1 lg:grid-cols-3 gap-3 sm:gap-5">
      {/* Thread list */}
      <div className="lg:col-span-1 bg-white/10 backdrop-blur-md border border-white/10 rounded-[20px] p-3 shadow-sm max-h-[75vh] overflow-y-auto">
        <div className="flex items-center gap-2 px-3 py-2 mb-2">
          <MessageCircle className="w-4 h-4 text-white/60" />
          <h2 className="text-white font-semibold text-sm">V3 Testing</h2>
          <span className="ml-auto text-xs text-white/40">{threads.length}</span>
          <button
            onClick={loadThreads}
            className="text-white/40 hover:text-white/80"
            title="Refresh"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="px-1 pb-2">
          <NewFanForm onSend={handleInject} sending={sending} />
        </div>

        {error && (
          <div className="text-xs text-red-400 px-3 py-2 flex items-start gap-1.5">
            <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" /> {error}
          </div>
        )}
        {loading && <div className="text-sm text-white/40 px-3 py-4">Loading...</div>}
        {!loading && threads.length === 0 && !error && (
          <div className="text-sm text-white/40 px-3 py-8 text-center">
            No conversations yet. Inject a test message above to start one!
          </div>
        )}

        <div className="flex flex-col gap-0.5 mt-2">
          {threads.map((t) => (
            <button
              key={t.conversationId}
              onClick={() => setSelectedId(t.conversationId)}
              className={`w-full text-left flex items-center gap-3 px-3 py-2.5 rounded-xl transition-colors ${
                selectedId === t.conversationId ? 'bg-white/15' : 'hover:bg-white/5'
              }`}
            >
              <div className="w-10 h-10 rounded-full bg-gradient-to-br from-indigo-400 to-blue-500 flex items-center justify-center text-xs font-bold text-white flex-shrink-0">
                {initials(t.displayName || t.subscriberExternalId)}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-sm text-white font-medium truncate">
                    {t.displayName || t.subscriberExternalId}
                  </span>
                  <PhaseBadge phase={t.phase} />
                </div>
                <div className="text-xs text-white/50 truncate">
                  {t.lastMessage ? `${t.lastMessage.direction === 'outbound' ? '→ ' : ''}${t.lastMessage.text?.slice(0, 60) || '(no text)'}` : '(no messages)'}
                </div>
              </div>
              <div className="text-[10px] text-white/40 flex-shrink-0">{formatTime(t.lastActivityAt)}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Thread detail */}
      <div className="lg:col-span-2 bg-white/10 backdrop-blur-md border border-white/10 rounded-[20px] p-5 shadow-sm min-h-[60vh] flex flex-col">
        {!selectedThread && (
          <div className="flex-1 flex items-center justify-center text-white/40 text-sm">
            Select a conversation or inject a new one
          </div>
        )}
        {selectedThread && conv && (
          <>
            <div className="flex items-center gap-3 pb-4 border-b border-white/10">
              <div className="w-10 h-10 rounded-full bg-gradient-to-br from-indigo-400 to-blue-500 flex items-center justify-center text-xs font-bold text-white">
                {initials(conv.displayName || conv.subscriberExternalId)}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-white font-medium text-sm flex items-center gap-2">
                  {conv.displayName || conv.subscriberExternalId}
                  <PhaseBadge phase={conv.phase} />
                  {conv.substate && (
                    <span className="text-[10px] text-white/50 uppercase tracking-wider">
                      {conv.substate}
                    </span>
                  )}
                </div>
                <div className="text-white/50 text-xs flex items-center gap-3 mt-0.5">
                  <span>turn: <span className="text-white/80">{conv.turnsInPhase}</span></span>
                  <span>spend: <span className="text-white/80">${(conv.totalSpendCents / 100).toFixed(2)}</span></span>
                  {archetype && (
                    <span>archetype: <span className="text-white/80">{archetype.spenderTier}/{archetype.engagementLevel}</span></span>
                  )}
                </div>
              </div>
              <button
                onClick={() => setShowWhy(true)}
                className="text-xs text-white/60 hover:text-white bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg px-2.5 py-1.5 flex items-center gap-1.5"
                title="Inspect last LLM turn"
              >
                <Eye className="w-3.5 h-3.5" /> Why
              </button>
              <button
                onClick={toggleTakeover}
                disabled={takeoverBusy}
                className={`text-xs rounded-lg px-2.5 py-1.5 flex items-center gap-1.5 border ${
                  takeoverOn
                    ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                    : 'bg-white/5 text-white/60 border-white/10 hover:bg-white/10'
                }`}
                title="Operator takeover — pauses auto-reply"
              >
                {takeoverOn ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
                {takeoverOn ? 'Resume AI' : 'Take Over'}
              </button>
            </div>

            <div className="flex-1 overflow-y-auto py-4 space-y-2">
              {messages.length === 0 && (
                <div className="text-white/40 text-sm text-center py-8">No messages yet</div>
              )}
              {messages.map((m) => (
                <MessageBubble
                  key={m.id}
                  msg={m}
                  onBuy={handleBuyPpv}
                  buying={buyingMessageId === m.id}
                />
              ))}
            </div>

            <ReplyAsFan
              thread={{
                subscriberExternalId: conv.subscriberExternalId,
                displayName: conv.displayName,
              }}
              onSend={handleInject}
              sending={sending}
            />
          </>
        )}
      </div>

      {showWhy && selectedId && (
        <WhyDrawer conversationId={selectedId} onClose={() => setShowWhy(false)} />
      )}
    </div>
  )
}
