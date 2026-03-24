import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import {
  BarChart,
  Bar,
  XAxis,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'
import {
  Search,
  Settings,
  Bell,
  MessageCircle,
  DollarSign,
  TrendingUp,
  Plus,
  ArrowRight,
  ChevronDown,
  Calendar,
  Zap,
  Camera,
  Play,
  Pause,
  X,
  Download,
  Clock,
  FolderOpen,
  Users,
  User,
  UserCheck,
} from 'lucide-react'
import html2canvas from 'html2canvas'
import { supabase } from './lib/supabase'

// ━━━ Screenshot Configuration ━━━━━━━━━━━━━━━━━━━━━━━━━━

const TOTAL_SHOTS = 5
const SHOT_INTERVAL_SEC = 12 // one every 12 s → 5 shots in 60 s

// Each shot captures a different region of the dashboard, bit by bit
const CAPTURE_SEQUENCE = [
  { idx: 0, selector: '#dash-navbar',  label: 'Navbar' },
  { idx: 1, selector: '#dash-chart',   label: 'Conversion Chart' },
  { idx: 2, selector: '#dash-metrics', label: "Today's Metrics" },
  { idx: 3, selector: '#dash-bottom',  label: 'Bottom Row' },
  { idx: 4, selector: '#dash-root',    label: 'Full Dashboard' },
]

// ━━━ Folder Helpers ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function saveScreenshot(filename, dataUrl) {
  const res = await fetch('/api/save-screenshot', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename, dataUrl }),
  })
  if (!res.ok) throw new Error(await res.text())
}

// ━━━ Auto Screenshot Hook ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function useAutoScreenshots() {
  const [shots, setShots] = useState([])
  const [running, setRunning] = useState(false)
  const [done, setDone] = useState(false)
  const [countdown, setCountdown] = useState(SHOT_INTERVAL_SEC)
  const [capturing, setCapturing] = useState(false)
  const [nextIdx, setNextIdx] = useState(0)
  const nextIdxRef = useRef(0)
  const countdownRef = useRef(SHOT_INTERVAL_SEC)
  const capturingRef = useRef(false)
  const runningRef = useRef(false)

  const doCapture = useCallback(async () => {
    if (capturingRef.current) return
    const idx = nextIdxRef.current
    if (idx >= TOTAL_SHOTS) return
    const spec = CAPTURE_SEQUENCE[idx]
    const el = document.querySelector(spec.selector)
    if (!el) return
    capturingRef.current = true
    setCapturing(true)
    try {
      const canvas = await html2canvas(el, {
        useCORS: true,
        scale: 1.5,
        logging: false,
        backgroundColor: '#E2E6ED',
        scrollX: -window.scrollX,
        scrollY: -window.scrollY,
      })
      const dataUrl = canvas.toDataURL('image/png')
      const ts = new Date()
      const shotNum = String(idx + 1).padStart(2, '0')
      const safeName = spec.label.replace(/[\s']/g, '-').toLowerCase()
      const filename = `shot-${shotNum}-${safeName}.png`
      await saveScreenshot(filename, dataUrl)
      setShots((prev) => [...prev, { idx, label: spec.label, dataUrl, ts, filename }])
      const next = idx + 1
      nextIdxRef.current = next
      setNextIdx(next)
      if (next >= TOTAL_SHOTS) {
        runningRef.current = false
        setRunning(false)
        setDone(true)
      }
    } finally {
      capturingRef.current = false
      setCapturing(false)
      countdownRef.current = SHOT_INTERVAL_SEC
      setCountdown(SHOT_INTERVAL_SEC)
    }
  }, [])

  const start = useCallback(() => {
    setShots([])
    setDone(false)
    nextIdxRef.current = 0
    countdownRef.current = SHOT_INTERVAL_SEC
    capturingRef.current = false
    setNextIdx(0)
    setCountdown(SHOT_INTERVAL_SEC)
    runningRef.current = true
    setRunning(true)
  }, [])

  const stop = useCallback(() => {
    runningRef.current = false
    setRunning(false)
  }, [])

  useEffect(() => {
    if (!running) return
    const tick = setInterval(() => {
      if (!runningRef.current) return
      countdownRef.current -= 1
      setCountdown(countdownRef.current)
      if (countdownRef.current <= 0) {
        doCapture()
      }
    }, 1000)
    return () => clearInterval(tick)
  }, [running, doCapture])

  return { shots, running, done, countdown, capturing, nextIdx, start, stop }
}

// ━━━ Screenshot Panel ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function ScreenshotPanel() {
  const [open, setOpen] = useState(false)
  const [lightbox, setLightbox] = useState(null)
  const { shots, running, done, countdown, capturing, nextIdx, start, stop } =
    useAutoScreenshots()

  const download = (shot) => {
    const a = document.createElement('a')
    a.href = shot.dataUrl
    a.download = shot.filename
    a.click()
  }

  const fmt = (ts) =>
    ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

  const nextSpec = CAPTURE_SEQUENCE[nextIdx]

  return (
    <>
      {/* Floating FAB */}
      <div className="fixed bottom-6 right-6 z-50 flex flex-col items-end gap-2">
        {running && (
          <div className={`flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-full shadow ${
            capturing ? 'bg-orange-500 text-white' : 'bg-[#5B7BF8] text-white'
          }`}>
            <Clock className="w-3 h-3" />
            {capturing
              ? `Capturing: ${nextSpec?.label ?? ''}…`
              : `Next (${nextSpec?.label ?? ''}) in ${countdown}s`}
          </div>
        )}
        {done && (
          <div className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-full shadow bg-green-500 text-white">
            ✓ 5/5 shots saved
          </div>
        )}
        <button
          onClick={() => setOpen((o) => !o)}
          className={`relative rounded-full shadow-xl flex items-center justify-center transition-all ${
            capturing ? 'bg-orange-500 scale-90' : running ? 'bg-[#5B7BF8] hover:bg-indigo-500' : 'bg-slate-700 hover:bg-slate-600'
          }`}
          style={{ width: 52, height: 52 }}
          title="Screenshot panel"
        >
          <Camera className="w-5 h-5 text-white" />
          {shots.length > 0 && (
            <span className="absolute -top-1 -right-1 w-5 h-5 bg-orange-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center">
              {shots.length}
            </span>
          )}
        </button>
      </div>

      {/* Side panel */}
      <div className={`fixed top-0 right-0 h-full w-80 bg-white shadow-2xl z-40 flex flex-col transition-transform duration-300 ease-in-out ${
        open ? 'translate-x-0' : 'translate-x-full'
      }`}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <div className="flex items-center gap-2">
            <Camera className="w-4 h-4 text-[#5B7BF8]" />
            <span className="font-bold text-slate-800 text-sm">Temp Screenshots</span>
            <span className="text-xs bg-slate-100 text-slate-500 px-2 py-0.5 rounded-full">
              {shots.length}/{TOTAL_SHOTS}
            </span>
          </div>
          <button onClick={() => setOpen(false)} className="p-1.5 text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-100 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Folder info */}
        <div className="px-5 py-2.5 border-b border-slate-100 flex items-center gap-2">
          <FolderOpen className="w-4 h-4 text-slate-400 flex-shrink-0" />
          <p className="text-xs text-slate-500 truncate">
            Saved to: <span className="font-medium text-slate-700">temp screenshots/</span>
          </p>
        </div>

        {/* Controls */}
        <div className="px-5 py-4 border-b border-slate-100 space-y-3">
          {/* Progress bar */}
          <div>
            <div className="flex justify-between text-xs text-slate-400 mb-1.5">
              <span>Sequence progress</span>
              <span>{shots.length}/{TOTAL_SHOTS}</span>
            </div>
            <div className="w-full bg-slate-100 rounded-full h-1.5 overflow-hidden">
              <div
                className="h-1.5 rounded-full bg-[#5B7BF8] transition-all duration-500"
                style={{ width: `${(shots.length / TOTAL_SHOTS) * 100}%` }}
              />
            </div>
          </div>

          {/* Sequence checklist */}
          <div className="space-y-1">
            {CAPTURE_SEQUENCE.map((spec) => {
              const isCaptured = shots.some((s) => s.idx === spec.idx)
              const isNext = spec.idx === nextIdx && running
              return (
                <div
                  key={spec.idx}
                  className={`flex items-center gap-2 text-xs px-2 py-1.5 rounded-lg ${
                    isCaptured ? 'bg-green-50' : isNext ? 'bg-[#5B7BF8]/10' : ''
                  }`}
                >
                  <div className={`w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-bold flex-shrink-0 ${
                    isCaptured ? 'bg-green-500 text-white' :
                    isNext ? 'bg-[#5B7BF8] text-white' :
                    'bg-slate-200 text-slate-400'
                  }`}>
                    {isCaptured ? '✓' : spec.idx + 1}
                  </div>
                  <span className={isCaptured ? 'text-green-700' : isNext ? 'text-[#5B7BF8] font-medium' : 'text-slate-400'}>
                    {spec.label}
                  </span>
                  {isNext && !capturing && (
                    <span className="ml-auto text-[10px] text-[#5B7BF8] font-medium">{countdown}s</span>
                  )}
                  {isNext && capturing && (
                    <span className="ml-auto text-[10px] text-orange-500 font-medium">saving…</span>
                  )}
                </div>
              )
            })}
          </div>

          {/* Action buttons */}
          <div className="flex gap-2">
            {!running && !done && (
              <button
                onClick={start}
                className="flex-1 flex items-center justify-center gap-1.5 text-sm font-medium text-white bg-[#5B7BF8] hover:bg-indigo-500 py-2 rounded-xl transition-colors"
              >
                <Play className="w-3.5 h-3.5" /> Start (5 shots / 60s)
              </button>
            )}
            {running && (
              <button
                onClick={stop}
                className="flex-1 flex items-center justify-center gap-1.5 text-sm font-medium text-slate-600 bg-slate-100 hover:bg-slate-200 py-2 rounded-xl transition-colors"
              >
                <Pause className="w-3.5 h-3.5" /> Stop
              </button>
            )}
            {done && (
              <button
                onClick={start}
                className="flex-1 flex items-center justify-center gap-1.5 text-sm font-medium text-white bg-green-500 hover:bg-green-600 py-2 rounded-xl transition-colors"
              >
                ↺ Run again
              </button>
            )}
          </div>
        </div>

        {/* Thumbnails */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
          {shots.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-32 text-slate-300">
              <Camera className="w-8 h-8 mb-2" />
              <p className="text-sm text-center">No screenshots yet.<br />Press Start to begin.</p>
            </div>
          ) : (
            shots.map((shot) => (
              <div
                key={shot.idx}
                className="group relative rounded-xl overflow-hidden border border-slate-100 cursor-pointer hover:border-[#5B7BF8]/40 transition-colors"
                onClick={() => setLightbox(shot)}
              >
                <img src={shot.dataUrl} alt={shot.label} className="w-full h-auto block" />
                <div className="absolute inset-0 bg-slate-900/0 group-hover:bg-slate-900/10 transition-colors" />
                <div className="flex items-center justify-between px-2.5 py-2 bg-white border-t border-slate-100">
                  <div>
                    <p className="text-[11px] font-medium text-slate-700">{shot.label}</p>
                    <p className="text-[10px] text-slate-400">{fmt(shot.ts)}</p>
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); download(shot) }}
                    className="p-1 text-slate-400 hover:text-[#5B7BF8] rounded transition-colors"
                    title="Download"
                  >
                    <Download className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Overlay */}
      {open && <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />}

      {/* Lightbox */}
      {lightbox && (
        <div
          className="fixed inset-0 z-50 bg-slate-900/80 flex items-center justify-center p-6"
          onClick={() => setLightbox(null)}
        >
          <div
            className="relative max-w-5xl w-full rounded-2xl overflow-hidden shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <img src={lightbox.dataUrl} alt={lightbox.label} className="w-full h-auto block" />
            <div className="absolute top-3 right-3 flex gap-2">
              <button onClick={() => download(lightbox)} className="p-2 bg-white/90 hover:bg-white rounded-lg text-slate-600">
                <Download className="w-4 h-4" />
              </button>
              <button onClick={() => setLightbox(null)} className="p-2 bg-white/90 hover:bg-white rounded-lg text-slate-600">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="absolute bottom-3 left-3 bg-slate-900/70 text-white text-xs px-3 py-1.5 rounded-lg">
              <span className="font-medium">{lightbox.label}</span> · {lightbox.ts.toLocaleString()}
            </div>
          </div>
        </div>
      )}
    </>
  )
}

// ━━━ Mock Data ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// Mock constants removed — weekly data now comes from useWeeklyData hook

// ━━━ Supabase Data Hook ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
// Fetches from 12:00 AM today (local time) through end of day.
// Falls back to mock data when VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY
// are not set in .env.local.

// ── Creator picker ──
function useCreators() {
  const [creators, setCreators] = useState([])
  useEffect(() => {
    if (!supabase) return
    supabase
      .from('content_inventory_onlyfans')
      .select('creator_uuid, creator_name')
      .not('creator_uuid', 'is', null)
      .not('creator_name', 'is', null)
      .then(({ data }) => {
        if (!data) return
        const seen = new Map()
        for (const row of data) {
          if (!seen.has(row.creator_uuid)) seen.set(row.creator_uuid, row.creator_name)
        }
        setCreators([...seen.entries()].map(([uuid, name]) => ({ uuid, name })))
      })
  }, [])
  return creators
}

// ── Fallback mock ──
const MOCK_CHATTED = [
  { id: '1', name: 'Alex Johnson' }, { id: '2', name: 'Maria Garcia' },
  { id: '3', name: 'James Wilson' }, { id: '4', name: 'Emma Davis' },
  { id: '5', name: 'Liam Brown' },  { id: '6', name: 'Sophia Lee' },
  { id: '7', name: 'Noah Martinez' },{ id: '8', name: 'Olivia Taylor' },
]
const MOCK_PAID = [
  { id: '2', name: 'Maria Garcia', amount: 40 },
  { id: '4', name: 'Emma Davis',   amount: 15 },
  { id: '6', name: 'Sophia Lee',   amount: 30 },
  { id: '8', name: 'Olivia Taylor',amount: 20 },
]

function useTodayMetrics(creatorUuid, startDate, endDate) {
  const [chattedList, setChattedList] = useState([])
  const [paidList, setPaidList]       = useState([])
  const [loading, setLoading]         = useState(true)
  const [error, setError]             = useState(null)

  const load = useCallback(async () => {
    // ── No credentials → use mock ──
    if (!supabase) {
      setChattedList(MOCK_CHATTED)
      setPaidList(MOCK_PAID)
      setLoading(false)
      return
    }

    setLoading(true)
    setError(null)
    try {
      // Build ISO boundaries from the date strings (YYYY-MM-DD)
      const from = new Date(startDate + 'T00:00:00')
      const to   = new Date(endDate   + 'T23:59:59.999')
      const isoFrom = from.toISOString()
      const isoTo   = to.toISOString()

      // ── 1. Fans who sent an inbound message in range ──
      let intQ = supabase
        .from('fan_interactions_onlyfans')
        .select('fan_id, fans_onlyfans(display_name)')
        .eq('direction', 'inbound')
        .gte('created_at', isoFrom)
        .lte('created_at', isoTo)
      if (creatorUuid) intQ = intQ.eq('creatoruuid', creatorUuid)

      const { data: interactions, error: err1 } = await intQ
      if (err1) throw err1

      const seenFans = new Map()
      for (const row of interactions ?? []) {
        if (row.fan_id && !seenFans.has(row.fan_id)) {
          seenFans.set(row.fan_id, row.fans_onlyfans?.display_name ?? 'Unknown Fan')
        }
      }
      setChattedList([...seenFans.entries()].map(([id, name]) => ({ id, name })))

      // ── 2. Purchases in range ──
      let purQ = supabase
        .from('purchases_onlyfans')
        .select('fan_uuid, amount')
        .gte('purchased_at', isoFrom)
        .lte('purchased_at', isoTo)
      if (creatorUuid) purQ = purQ.eq('creator_uuid', creatorUuid)

      const { data: purchases, error: err2 } = await purQ
      if (err2) throw err2

      // Get display names for each unique fan_uuid
      const fanUuids = [...new Set((purchases ?? []).map((p) => p.fan_uuid).filter(Boolean))]
      let fanNameMap = {}
      if (fanUuids.length > 0) {
        const { data: fans } = await supabase
          .from('fans_onlyfans')
          .select('fanvue_id, display_name')
          .in('fanvue_id', fanUuids)
        fanNameMap = Object.fromEntries(
          (fans ?? []).map((f) => [f.fanvue_id, f.display_name ?? 'Unknown Fan']),
        )
      }

      // Aggregate by fan: sum all purchases from the same fan today
      const payMap = {}
      for (const p of purchases ?? []) {
        if (!p.fan_uuid) continue
        if (!payMap[p.fan_uuid]) {
          payMap[p.fan_uuid] = {
            id: p.fan_uuid,
            name: fanNameMap[p.fan_uuid] ?? 'Unknown Fan',
            amount: 0,
          }
        }
        payMap[p.fan_uuid].amount += Number(p.amount) || 0
      }
      setPaidList(Object.values(payMap))
    } catch (e) {
      console.error('[Dashboard] Supabase fetch error:', e)
      setError(e.message ?? 'Failed to load metrics')
    } finally {
      setLoading(false)
    }
  }, [creatorUuid, startDate, endDate])

  useEffect(() => { load() }, [load])

  // Realtime: re-fetch on any new interaction or purchase
  useEffect(() => {
    if (!supabase) return
    const ch1 = supabase
      .channel('today-interactions')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'fan_interactions_onlyfans' }, load)
      .subscribe()
    const ch2 = supabase
      .channel('today-purchases')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'purchases_onlyfans' }, load)
      .subscribe()
    return () => { supabase.removeChannel(ch1); supabase.removeChannel(ch2) }
  }, [load])

  // Midnight reset: reload at start of next day so "today" window resets
  useEffect(() => {
    const now = new Date()
    const msUntilMidnight =
      new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - now.getTime()
    const t = setTimeout(() => load(), msUntilMidnight + 500)
    return () => clearTimeout(t)
  }, [load])

  return { chattedList, paidList, loading, error, refetch: load }
}

// ── Weekly data hook (last 7 days) ──
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function useWeeklyData(creatorUuid) {
  const [weeklyData, setWeeklyData] = useState([])
  const [todayIdx, setTodayIdx]     = useState(-1)
  const [loading, setLoading]       = useState(true)

  const load = useCallback(async () => {
    // Build array of last 7 days
    const days = []
    const now = new Date()
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now)
      d.setDate(d.getDate() - i)
      d.setHours(0, 0, 0, 0)
      days.push({ date: d, day: DAY_NAMES[d.getDay()], chatted: 0, paid: 0 })
    }
    setTodayIdx(6) // last entry is today

    if (!supabase) {
      // Mock fallback
      const mock = [
        { day: 'Sun', chatted: 45, paid: 5 }, { day: 'Mon', chatted: 52, paid: 8 },
        { day: 'Tue', chatted: 64, paid: 10 }, { day: 'Wed', chatted: 58, paid: 9 },
        { day: 'Thu', chatted: 70, paid: 12 }, { day: 'Fri', chatted: 48, paid: 7 },
        { day: 'Sat', chatted: 35, paid: 4 },
      ]
      setWeeklyData(mock)
      setLoading(false)
      return
    }

    setLoading(true)
    try {
      const weekAgo = days[0].date.toISOString()

      // Chatted per day
      let intQ = supabase
        .from('fan_interactions_onlyfans')
        .select('fan_id, created_at')
        .eq('direction', 'inbound')
        .gte('created_at', weekAgo)
      if (creatorUuid) intQ = intQ.eq('creatoruuid', creatorUuid)
      const { data: ints } = await intQ

      // Purchases per day
      let purQ = supabase
        .from('purchases_onlyfans')
        .select('fan_uuid, purchased_at')
        .gte('purchased_at', weekAgo)
      if (creatorUuid) purQ = purQ.eq('creator_uuid', creatorUuid)
      const { data: purs } = await purQ

      // Bucket interactions by day (unique fans per day)
      const seenFansPerDay = {}
      for (const row of ints ?? []) {
        const d = new Date(row.created_at)
        d.setHours(0, 0, 0, 0)
        const ts = d.getTime()
        const key = ts + '_' + row.fan_id
        if (seenFansPerDay[key]) continue
        seenFansPerDay[key] = true
        const dayEntry = days.find((dd) => dd.date.getTime() === ts)
        if (dayEntry) dayEntry.chatted++
      }

      // Bucket purchases by day (unique fans per day)
      const seenPaidPerDay = {}
      for (const row of purs ?? []) {
        const d = new Date(row.purchased_at)
        d.setHours(0, 0, 0, 0)
        const ts = d.getTime()
        const key = ts + '_' + row.fan_uuid
        if (seenPaidPerDay[key]) continue
        seenPaidPerDay[key] = true
        const dayEntry = days.find((dd) => dd.date.getTime() === ts)
        if (dayEntry) dayEntry.paid++
      }

      setWeeklyData(days)
    } catch (e) {
      console.error('[Dashboard] Weekly data error:', e)
      setWeeklyData(days)
    } finally {
      setLoading(false)
    }
  }, [creatorUuid])

  useEffect(() => { load() }, [load])

  // Realtime: re-fetch weekly chart on new interactions or purchases
  useEffect(() => {
    if (!supabase) return
    const ch1 = supabase
      .channel('weekly-interactions')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'fan_interactions_onlyfans' }, load)
      .subscribe()
    const ch2 = supabase
      .channel('weekly-purchases')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'purchases_onlyfans' }, load)
      .subscribe()
    return () => { supabase.removeChannel(ch1); supabase.removeChannel(ch2) }
  }, [load])

  // Midnight reset: rebuild the 7-day window at start of next day
  useEffect(() => {
    const now = new Date()
    const msUntilMidnight =
      new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - now.getTime()
    const t = setTimeout(() => load(), msUntilMidnight + 500)
    return () => clearTimeout(t)
  }, [load])

  return { weeklyData, todayIdx, loading }
}

// ── Subscriber hook (reads onlyfans_subscribers + realtime) ──

function useSubscribers(creatorUuid) {
  const [subscribers, setSubscribers] = useState([])
  const [loading, setLoading]         = useState(true)
  const [error, setError]             = useState(null)
  const [lastResetAt, setLastResetAt] = useState(null)

  const load = useCallback(async () => {
    if (!supabase) {
      setSubscribers([])
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      let q = supabase
        .from('onlyfans_subscribers')
        .select('*')
        .eq('is_active', true)
        .order('total_spent', { ascending: false })
      if (creatorUuid) q = q.eq('creator_uuid', creatorUuid)
      const { data, error: err } = await q
      if (err) throw err
      setSubscribers(data ?? [])

      // Get last sync time
      let syncQ = supabase
        .from('onlyfans_subscriber_sync_runs')
        .select('finished_at')
        .eq('status', 'success')
        .order('finished_at', { ascending: false })
        .limit(1)
      if (creatorUuid) syncQ = syncQ.eq('creator_uuid', creatorUuid)
      const { data: syncData } = await syncQ
      if (syncData?.[0]?.finished_at) setLastResetAt(syncData[0].finished_at)
    } catch (e) {
      console.error('[Dashboard] Subscriber fetch error:', e)
      setError(e.message ?? 'Failed to load subscribers')
    } finally {
      setLoading(false)
    }
  }, [creatorUuid])

  useEffect(() => { load() }, [load])

  // Realtime subscription
  useEffect(() => {
    if (!supabase) return
    const channel = supabase
      .channel('subscribers-realtime')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'onlyfans_subscribers',
          ...(creatorUuid ? { filter: `creator_uuid=eq.${creatorUuid}` } : {}),
        },
        () => {
          // Re-fetch on any change
          load()
        },
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [creatorUuid, load])

  return { subscribers, activeCount: subscribers.length, loading, error, lastResetAt, refetch: load }
}

// ━━━ Chart Helpers ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const DAY_LABELS = { Sun: 'S', Mon: 'M', Tue: 'T', Wed: 'W', Thu: 'T', Fri: 'F', Sat: 'S' }

function makeDayTick(todayDay) {
  return function DayTick({ x, y, payload }) {
    const isToday = payload.value === todayDay
    return (
      <g transform={`translate(${x},${y + 16})`}>
        {isToday && <circle r={13} fill="#5B7BF8" />}
        <text
          textAnchor="middle"
          dy={4.5}
          fill={isToday ? '#fff' : '#94A3B8'}
          fontSize={12}
          fontWeight={isToday ? 600 : 400}
          fontFamily="Inter, sans-serif"
        >
          {DAY_LABELS[payload.value]}
        </text>
      </g>
    )
  }
}

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-slate-800 text-white text-xs px-3 py-2 rounded-lg shadow-lg">
      <p className="font-semibold mb-0.5">{label}</p>
      <p className="text-slate-300">
        Chatted: <span className="text-white font-medium">{payload[0]?.value}</span>
      </p>
      <p className="text-slate-300">
        Paid: <span className="text-white font-medium">{payload[1]?.value}</span>
      </p>
    </div>
  )
}

// ━━━ Navbar ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function Navbar({ creators, creatorUuid, onCreatorChange }) {
  return (
    <nav id="dash-navbar" className="bg-white/10 backdrop-blur-md border border-white/10 rounded-[20px] px-6 py-3.5 flex items-center justify-between">
      <div className="flex items-center gap-8">
        <div className="flex items-center gap-2.5">
          {/* OnlyFans logo mark */}
          <svg width="34" height="34" viewBox="0 0 34 34" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="17" cy="17" r="17" fill="#00AFF0"/>
            <text x="17" y="22" textAnchor="middle" fill="white" fontSize="13" fontWeight="800" fontFamily="Inter, Arial, sans-serif">OF</text>
          </svg>
          <div className="leading-none">
            <span className="font-extrabold text-white text-sm tracking-wide block">DOSS AGENCY</span>
            <span className="text-[10px] text-[#00AFF0] font-semibold tracking-widest uppercase">OnlyFans</span>
          </div>
        </div>
        <div className="hidden md:flex items-center gap-6">
          {['Home', 'Messages', 'Discover', 'Wallet', 'Projects'].map(
            (item) => (
              <button
                key={item}
                className={`text-sm transition-colors ${
                  item === 'Home'
                    ? 'text-white font-semibold'
                    : 'text-white/40 hover:text-white/70'
                }`}
              >
                {item}
              </button>
            ),
          )}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <div className="hidden sm:flex items-center bg-white/10 rounded-xl px-4 py-2 gap-2 w-56">
          <Search className="w-4 h-4 text-white/50 flex-shrink-0" />
          <input
            type="text"
            placeholder="Enter your search request..."
            className="bg-transparent text-sm text-white/80 placeholder-white/30 outline-none flex-1"
          />
        </div>
        <button className="p-2 text-slate-400 hover:text-slate-600 rounded-xl hover:bg-slate-100 transition-colors sm:hidden">
          <Search className="w-5 h-5" />
        </button>
        {creators.length > 0 && (
          <div className="hidden sm:flex items-center gap-1.5 bg-white/10 rounded-xl px-3 py-1.5">
            <User className="w-3.5 h-3.5 text-white/50 flex-shrink-0" />
            <select
              value={creatorUuid ?? ''}
              onChange={(e) => onCreatorChange(e.target.value || null)}
              className="bg-transparent text-sm text-white/80 outline-none cursor-pointer max-w-[160px]"
            >
              <option value="" className="bg-slate-800 text-white">All Creators</option>
              {creators.map((c) => (
                <option key={c.uuid} value={c.uuid} className="bg-slate-800 text-white">{c.name}</option>
              ))}
            </select>
          </div>
        )}
        <button className="p-2 text-white/50 hover:text-white/80 rounded-xl hover:bg-white/10 transition-colors hidden sm:block">
          <Settings className="w-5 h-5" />
        </button>
        <button className="p-2 text-white/50 hover:text-white/80 rounded-xl hover:bg-white/10 transition-colors">
          <Bell className="w-5 h-5" />
        </button>
        <div className="w-9 h-9 rounded-full bg-gradient-to-br from-orange-400 to-rose-500 ring-2 ring-white cursor-pointer" />
      </div>
    </nav>
  )
}

// ━━━ Conversion Tracker (Left Card) ━━━━━━━━━━━━━━━━━━━

function ConversionTracker({ weeklyData, todayIdx, weeklyLoading }) {
  const totalChatted = weeklyData.reduce((s, d) => s + d.chatted, 0)
  const totalPaid    = weeklyData.reduce((s, d) => s + d.paid, 0)
  const rate         = totalChatted > 0 ? ((totalPaid / totalChatted) * 100).toFixed(1) : '0'
  const todayDay     = weeklyData[todayIdx]?.day ?? ''
  const DayTickComp  = useMemo(() => makeDayTick(todayDay), [todayDay])

  return (
    <div id="dash-chart" className="bg-white/10 backdrop-blur-md border border-white/10 rounded-[20px] p-7 shadow-sm">
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2.5 mb-1.5">
            <div className="w-8 h-8 bg-white/10 rounded-lg flex items-center justify-center">
              <TrendingUp className="w-4 h-4 text-[#00AFF0]" />
            </div>
            <h2 className="text-[22px] font-bold text-white">
              Conversion Tracker
            </h2>
          </div>
          <p className="text-[13px] text-white/40 ml-[42px]">
            Track chatters who convert to paying customers over time
          </p>
        </div>
        <span className="text-sm text-white/50 bg-white/10 px-3.5 py-1.5 rounded-full">
          Last 7 days
        </span>
      </div>

      <div className="mt-8 mb-1">
        {weeklyLoading ? (
          <div className="h-10 w-24 bg-white/10 rounded animate-pulse" />
        ) : (
          <span className="text-4xl font-bold text-white">{rate}%</span>
        )}
      </div>
      <p className="text-[13px] text-white/40 mb-6">
        {totalPaid} paid out of {totalChatted} chatted this week
      </p>

      {/* Legend */}
      <div className="flex items-center gap-5 mb-4">
        <div className="flex items-center gap-1.5">
          <div className="w-2.5 h-2.5 rounded-full bg-white/30" />
          <span className="text-xs text-white/40">Chatted</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-2.5 h-2.5 rounded-full bg-[#00AFF0]" />
          <span className="text-xs text-white/40">Paid</span>
        </div>
      </div>

      {/* Chart */}
      <div className="h-[200px]">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={weeklyData} barGap={2} barCategoryGap="25%">
            <XAxis
              dataKey="day"
              tick={<DayTickComp />}
              axisLine={false}
              tickLine={false}
              height={45}
            />
            <Tooltip content={<ChartTooltip />} cursor={false} />
            <Bar
              dataKey="chatted"
              fill="#CBD5E1"
              radius={[6, 6, 6, 6]}
              barSize={8}
            />
            <Bar
              dataKey="paid"
              fill="#5B7BF8"
              radius={[6, 6, 6, 6]}
              barSize={8}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

// ━━━ Today's Metrics (Right Side) ━━━━━━━━━━━━━━━━━━━━━

const AVATAR_BG = [
  'bg-rose-100 text-rose-600',
  'bg-blue-100 text-blue-600',
  'bg-amber-100 text-amber-600',
  'bg-emerald-100 text-emerald-600',
  'bg-violet-100 text-violet-600',
  'bg-cyan-100 text-cyan-600',
]

function initials(name) {
  return (name ?? '?')
    .split(' ')
    .map((w) => w[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase()
}

function ChattersModal({ open, onClose, chattedList, paidList }) {
  const [tab, setTab] = useState('all')
  if (!open) return null

  // Build a unified "all" list: everyone who chatted, with paid amount if applicable
  const paidMap = Object.fromEntries(paidList.map((p) => [p.id, p.amount]))
  const allMap = new Map()
  for (const c of chattedList) allMap.set(c.id, { id: c.id, name: c.name, amount: paidMap[c.id] ?? null })
  for (const p of paidList)   if (!allMap.has(p.id)) allMap.set(p.id, { id: p.id, name: p.name, amount: p.amount })
  const allList       = [...allMap.values()]
  const chattedOnly   = allList.filter((r) => r.amount === null)
  const paidOnly      = paidList

  const tabData = tab === 'chatted' ? chattedOnly : tab === 'paid' ? paidOnly : allList
  const totalPaid = paidOnly.reduce((s, p) => s + p.amount, 0)
  const conversion = allList.length > 0 ? ((paidOnly.length / allList.length) * 100).toFixed(1) : '0.0'

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
          <div className="flex items-center gap-2.5">
            <Users className="w-5 h-5 text-[#5B7BF8]" />
            <h2 className="font-bold text-slate-800">Today's Chatters</h2>
            <span className="text-xs bg-slate-100 text-slate-500 px-2 py-0.5 rounded-full">
              {allList.length} total
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-100 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 px-6 pt-4 pb-2">
          {[
            { key: 'all',     label: 'All',          count: allList.length },
            { key: 'chatted', label: 'Chatted Only',  count: chattedOnly.length },
            { key: 'paid',    label: 'Paid',          count: paidOnly.length },
          ].map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`text-xs font-medium px-3 py-1.5 rounded-full transition-colors ${
                tab === t.key
                  ? 'bg-[#5B7BF8] text-white'
                  : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
              }`}
            >
              {t.label} ({t.count})
            </button>
          ))}
        </div>

        {/* Table */}
        <div className="flex-1 overflow-y-auto px-6 pb-2">
          <table className="w-full">
            <thead className="sticky top-0 bg-white">
              <tr className="text-left text-[11px] text-slate-400 uppercase tracking-wider border-b border-slate-100">
                <th className="py-2.5 font-medium">#</th>
                <th className="py-2.5 font-medium">Display Name</th>
                <th className="py-2.5 font-medium text-center">Status</th>
                <th className="py-2.5 font-medium text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {tabData.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-8 text-center text-sm text-slate-400">
                    No records found
                  </td>
                </tr>
              )}
              {tabData.map((row, i) => (
                <tr
                  key={row.id}
                  className={`border-t border-slate-100 transition-colors hover:brightness-95 ${i % 2 === 0 ? 'bg-white' : 'bg-slate-50/70'}`}
                >
                  <td className="py-2.5 text-[11px] text-slate-400 w-8">{i + 1}</td>
                  <td className="py-2.5">
                    <div className="flex items-center gap-2.5">
                      <div
                        className={`w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold flex-shrink-0 ${
                          AVATAR_BG[i % AVATAR_BG.length]
                        }`}
                      >
                        {initials(row.name)}
                      </div>
                      <span className="text-sm text-slate-700 font-medium">{row.name}</span>
                    </div>
                  </td>
                  <td className="py-2.5 text-center">
                    {row.amount !== null ? (
                      <span className="text-[11px] bg-green-50 text-green-600 font-medium px-2 py-0.5 rounded-full">
                        Paid
                      </span>
                    ) : (
                      <span className="text-[11px] bg-slate-100 text-slate-500 font-medium px-2 py-0.5 rounded-full">
                        Chatted
                      </span>
                    )}
                  </td>
                  <td className="py-2.5 text-right">
                    <span className={`text-sm font-semibold ${
                      row.amount !== null ? 'text-green-600' : 'text-slate-300'
                    }`}>
                      {row.amount !== null ? `$${row.amount.toFixed(2)}` : '—'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Footer totals */}
        <div className="px-6 py-3 border-t border-slate-100 flex items-center justify-between">
          <span className="text-xs text-slate-400">
            {paidOnly.length} of {allList.length} converted
            {allList.length > 0 && (
              <span className="ml-1 font-semibold text-[#5B7BF8]">({conversion}%)</span>
            )}
          </span>
          <div className="text-right">
            <span className="text-xs text-slate-400 mr-1">Total revenue today:</span>
            <span className="text-sm font-bold text-green-600">
              ${totalPaid.toFixed(2)}
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

function toLocalDateStr(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}

function TodayMetrics({ creatorUuid, subscriberData }) {
  const [showModal, setShowModal] = useState(false)
  const [showSubModal, setShowSubModal] = useState(false)

  const todayStr = toLocalDateStr(new Date())
  const [startDate, setStartDate] = useState(todayStr)
  const [endDate, setEndDate]     = useState(todayStr)

  const { chattedList, paidList, loading, error, refetch } = useTodayMetrics(creatorUuid, startDate, endDate)
  const { subscribers, activeCount, loading: subLoading, lastResetAt } = subscriberData

  const chattedCount = chattedList.length
  const paidCount    = paidList.length
  const conversion   = chattedCount > 0 ? ((paidCount / chattedCount) * 100).toFixed(1) : '0.0'

  const isSingleDay = startDate === endDate
  const isToday     = isSingleDay && startDate === todayStr

  // Format a YYYY-MM-DD string as "March 17, 2026"
  const fmtDate = (d) => new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })

  const startRef = useRef(null)
  const endRef   = useRef(null)

  return (
    <div id="dash-metrics" className="flex flex-col">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-bold text-white">Today's Metrics</h2>
        <div className="flex items-center gap-2">
          {/* Date pickers — entire box is clickable */}
          <div className="flex items-center gap-1">
            <div
              onClick={() => startRef.current?.showPicker()}
              className="relative bg-white/10 border border-white/10 rounded-md px-2 py-1 cursor-pointer hover:bg-white/15 transition-colors"
            >
              <span className="text-white text-[10px]">{fmtDate(startDate)}</span>
              <input
                ref={startRef}
                type="date"
                value={startDate}
                max={endDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="absolute inset-0 opacity-0 cursor-pointer [color-scheme:dark]"
                tabIndex={-1}
              />
            </div>
            <span className="text-white/40 text-[10px]">to</span>
            <div
              onClick={() => endRef.current?.showPicker()}
              className="relative bg-white/10 border border-white/10 rounded-md px-2 py-1 cursor-pointer hover:bg-white/15 transition-colors"
            >
              <span className="text-white text-[10px]">{fmtDate(endDate)}</span>
              <input
                ref={endRef}
                type="date"
                value={endDate}
                min={startDate}
                max={todayStr}
                onChange={(e) => setEndDate(e.target.value)}
                className="absolute inset-0 opacity-0 cursor-pointer [color-scheme:dark]"
                tabIndex={-1}
              />
            </div>
          </div>
          {error && (
            <button onClick={refetch} className="text-[11px] text-red-400 hover:text-red-300 transition-colors">
              Retry
            </button>
          )}
          <button
            onClick={() => setShowModal(true)}
            className="text-sm text-[#00AFF0] hover:text-sky-300 font-medium transition-colors"
          >
            See all
          </button>
        </div>
      </div>

      {error && (
        <div className="text-[11px] text-red-400 bg-red-50 rounded-xl px-3 py-2 mb-3">
          {error}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        {/* Chatters Card */}
        <div className="bg-white/10 backdrop-blur-md border border-white/10 rounded-[20px] p-4 shadow-lg flex flex-col" style={{ minHeight: 120 }}>
          <div className="flex items-center gap-2 min-h-[2.5rem]">
            <div className="w-8 h-8 bg-white/20 rounded-lg flex items-center justify-center flex-shrink-0">
              <MessageCircle className="w-4 h-4 text-white" />
            </div>
            <h3 className="font-semibold text-white text-sm leading-tight">Chatters Who Chatted</h3>
            <span className="text-[10px] bg-white/20 text-white font-medium px-1.5 py-0.5 rounded-full ml-auto flex-shrink-0">
              Active
            </span>
          </div>
          {loading ? (
            <div className="h-7 w-14 bg-white/20 rounded animate-pulse mt-2" />
          ) : (
            <p className="text-2xl font-bold text-white mt-2">{chattedCount}</p>
          )}
          <div className="flex items-center gap-1.5 mt-1">
            <span className="text-[10px] bg-white/20 text-white px-1.5 py-0.5 rounded-full">{isToday ? 'Live' : 'Historical'}</span>
            <span className="text-[10px] bg-white/20 text-white px-1.5 py-0.5 rounded-full">Today</span>
          </div>
        </div>

        {/* Paid Card */}
        <div className="bg-white/10 backdrop-blur-md border border-white/10 rounded-[20px] p-4 shadow-lg flex flex-col" style={{ minHeight: 120 }}>
          <div className="flex items-center gap-2 min-h-[2.5rem]">
            <div className="w-8 h-8 bg-white/20 rounded-lg flex items-center justify-center flex-shrink-0">
              <DollarSign className="w-4 h-4 text-white" />
            </div>
            <h3 className="font-semibold text-white text-sm leading-tight">Chatters Who Paid</h3>
            <span className="text-[10px] bg-white/20 text-white font-medium px-1.5 py-0.5 rounded-full ml-auto flex-shrink-0">
              Paid
            </span>
          </div>
          {loading ? (
            <div className="h-7 w-14 bg-white/20 rounded animate-pulse mt-2" />
          ) : (
            <p className="text-2xl font-bold text-white mt-2">{paidCount}</p>
          )}
          <p className="text-[11px] text-white/70 mt-1">
            Conversion rate:{' '}
            <span className="font-semibold text-white">{conversion}%</span>
          </p>
        </div>

        {/* Conversion Rate Card */}
        <div className="bg-white/10 backdrop-blur-md border border-white/10 rounded-[20px] p-4 shadow-lg flex flex-col" style={{ minHeight: 120 }}>
          <div className="flex items-center gap-2 min-h-[2.5rem]">
            <div className="w-8 h-8 bg-white/20 rounded-lg flex items-center justify-center flex-shrink-0">
              <TrendingUp className="w-4 h-4 text-white" />
            </div>
            <h3 className="font-semibold text-white text-sm leading-tight">Conversion Rate</h3>
          </div>
          {loading ? (
            <div className="h-7 w-16 bg-white/20 rounded animate-pulse mt-2" />
          ) : (
            <p className="text-2xl font-bold text-white mt-2">{conversion}%</p>
          )}
          <p className="text-[11px] text-white/70 mt-1">
            {paidCount} paid / {chattedCount} chatted
          </p>
        </div>

        {/* Active Subscribers Card */}
        <div className="bg-white/10 backdrop-blur-md border border-white/10 rounded-[20px] p-4 shadow-lg flex flex-col" style={{ minHeight: 120 }}>
          <div className="flex items-center gap-2 min-h-[2.5rem]">
            <div className="w-8 h-8 bg-white/20 rounded-lg flex items-center justify-center flex-shrink-0">
              <UserCheck className="w-4 h-4 text-white" />
            </div>
            <h3 className="font-semibold text-white text-sm leading-tight">Active Subscribers</h3>
            <span className="text-[10px] bg-white/20 text-white font-medium px-1.5 py-0.5 rounded-full ml-auto flex-shrink-0">
              Live
            </span>
          </div>
          {subLoading ? (
            <div className="h-7 w-14 bg-white/20 rounded animate-pulse mt-2" />
          ) : (
            <p className="text-2xl font-bold text-white mt-2">{activeCount}</p>
          )}
          <div className="flex items-center gap-1.5 mt-1">
            <button
              onClick={() => setShowSubModal(true)}
              className="text-[10px] text-white font-semibold hover:text-white/80 transition-colors underline underline-offset-2"
            >
              View all
            </button>
            {lastResetAt && (
              <span className="text-[10px] text-white/60">
                Synced {new Date(lastResetAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            )}
          </div>
        </div>
      </div>

      <ChattersModal
        open={showModal}
        onClose={() => setShowModal(false)}
        chattedList={chattedList}
        paidList={paidList}
      />
      <SubscribersModal
        open={showSubModal}
        onClose={() => setShowSubModal(false)}
        subscribers={subscribers}
        lastResetAt={lastResetAt}
      />
    </div>
  )
}

// ━━━ Subscribers Modal ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function SubscribersModal({ open, onClose, subscribers, lastResetAt }) {
  const [search, setSearch] = useState('')
  if (!open) return null

  const filtered = search
    ? subscribers.filter(
        (s) =>
          (s.name ?? '').toLowerCase().includes(search.toLowerCase()) ||
          (s.username ?? '').toLowerCase().includes(search.toLowerCase()),
      )
    : subscribers

  const totalSpent = subscribers.reduce((s, sub) => s + (Number(sub.total_spent) || 0), 0)

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
          <div className="flex items-center gap-2.5">
            <UserCheck className="w-5 h-5 text-emerald-500" />
            <h2 className="font-bold text-slate-800">Active Subscribers</h2>
            <span className="text-xs bg-emerald-50 text-emerald-600 px-2 py-0.5 rounded-full">
              {subscribers.length} active
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-100 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Search */}
        <div className="px-6 pt-3 pb-2">
          <div className="flex items-center bg-slate-100 rounded-xl px-3 py-2 gap-2">
            <Search className="w-4 h-4 text-slate-400 flex-shrink-0" />
            <input
              type="text"
              placeholder="Search by name or username..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="bg-transparent text-sm text-slate-600 placeholder-slate-400 outline-none flex-1"
            />
          </div>
        </div>

        {/* Table */}
        <div className="flex-1 overflow-y-auto px-6 pb-2">
          <table className="w-full">
            <thead className="sticky top-0 bg-white">
              <tr className="text-left text-[11px] text-slate-400 uppercase tracking-wider border-b border-slate-100">
                <th className="py-2.5 font-medium">#</th>
                <th className="py-2.5 font-medium">Subscriber</th>
                <th className="py-2.5 font-medium text-center">Status</th>
                <th className="py-2.5 font-medium text-right">Price</th>
                <th className="py-2.5 font-medium text-right">Total Spent</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-sm text-slate-400">
                    {search ? 'No matching subscribers' : 'No active subscribers'}
                  </td>
                </tr>
              )}
              {filtered.map((sub, i) => (
                <tr
                  key={sub.fan_id}
                  className={`border-t border-slate-100 transition-colors hover:brightness-95 ${i % 2 === 0 ? 'bg-white' : 'bg-emerald-50/40'}`}
                >
                  <td className="py-2.5 text-[11px] text-slate-400 w-8">{i + 1}</td>
                  <td className="py-2.5">
                    <div className="flex items-center gap-2.5">
                      {sub.avatar ? (
                        <img
                          src={sub.avatar}
                          alt=""
                          className="w-7 h-7 rounded-full object-cover flex-shrink-0"
                        />
                      ) : (
                        <div
                          className={`w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold flex-shrink-0 ${
                            AVATAR_BG[i % AVATAR_BG.length]
                          }`}
                        >
                          {initials(sub.name)}
                        </div>
                      )}
                      <div className="min-w-0">
                        <span className="text-sm text-slate-700 font-medium block truncate">
                          {sub.name || sub.username || 'Unknown'}
                        </span>
                        {sub.username && (
                          <span className="text-[10px] text-slate-400 block truncate">
                            @{sub.username}
                          </span>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="py-2.5 text-center">
                    <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${
                      sub.subscription_status === 'active'
                        ? 'bg-green-50 text-green-600'
                        : sub.subscription_status === 'Set to Expire'
                        ? 'bg-amber-50 text-amber-600'
                        : 'bg-slate-100 text-slate-500'
                    }`}>
                      {sub.subscription_status || 'active'}
                    </span>
                  </td>
                  <td className="py-2.5 text-right text-sm text-slate-600">
                    {sub.subscribe_price != null ? `$${Number(sub.subscribe_price).toFixed(2)}` : '—'}
                  </td>
                  <td className="py-2.5 text-right">
                    <span className="text-sm font-semibold text-green-600">
                      ${(Number(sub.total_spent) || 0).toFixed(2)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-slate-100 flex items-center justify-between">
          <span className="text-xs text-slate-400">
            {lastResetAt
              ? `Last sync: ${new Date(lastResetAt).toLocaleString()}`
              : 'Not synced yet'}
          </span>
          <div className="text-right">
            <span className="text-xs text-slate-400 mr-1">Total spent:</span>
            <span className="text-sm font-bold text-green-600">
              ${totalSpent.toFixed(2)}
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

// ━━━ Top Chatters (Bottom Left) ━━━━━━━━━━━━━━━━━━━━━━━

const LEVEL_COLORS = {
  Senior: 'bg-orange-500 text-white',
  Middle: 'bg-blue-500 text-white',
}
const AVATAR_COLORS = ['bg-amber-100 text-amber-700', 'bg-violet-100 text-violet-700']

function TopChatters({ paidList, loading }) {
  // Show top 5 fans by purchase amount today
  const top = useMemo(() => {
    return [...paidList].sort((a, b) => b.amount - a.amount).slice(0, 5)
  }, [paidList])

  return (
    <div className="bg-gradient-to-br from-[#1a1a2e] to-[#16213e] rounded-[20px] p-6 shadow-lg">
      <div className="flex items-center justify-between mb-5">
        <h3 className="font-bold text-white">Top Spenders Today</h3>
        <span className="text-xs text-white/40 bg-white/10 px-2.5 py-1 rounded-full">{paidList.length} paid</span>
      </div>

      {loading ? (
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-white/10 animate-pulse" />
              <div className="flex-1">
                <div className="h-4 w-24 bg-white/10 rounded animate-pulse mb-1" />
                <div className="h-3 w-16 bg-white/10 rounded animate-pulse" />
              </div>
            </div>
          ))}
        </div>
      ) : top.length === 0 ? (
        <p className="text-sm text-white/30 text-center py-8">No purchases today yet</p>
      ) : (
        <div className="space-y-3">
          {top.map((fan, i) => {
            const rankColors = ['from-amber-400 to-orange-500', 'from-slate-300 to-slate-400', 'from-amber-600 to-amber-700', 'from-blue-400 to-indigo-500', 'from-rose-400 to-pink-500']
            return (
              <div key={fan.id} className="flex items-center gap-3 bg-white/5 rounded-xl px-3 py-2.5 hover:bg-white/10 transition-colors">
                <div
                  className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold text-white bg-gradient-to-br ${rankColors[i] ?? 'from-slate-500 to-slate-600'}`}
                >
                  {initials(fan.name)}
                </div>
                <div className="flex-1 min-w-0">
                  <span className="font-medium text-white text-sm block truncate">{fan.name}</span>
                  <p className="text-[11px] text-white/40">#{i + 1} spender</p>
                </div>
                <span className="text-sm font-bold text-emerald-400">${fan.amount.toFixed(2)}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ━━━ Conversion Progress (Bottom Right) ━━━━━━━━━━━━━━━

function SparkBars({ values, accent = '#F97316' }) {
  const max = Math.max(...values, 1)
  return (
    <div className="flex items-end gap-[2px] mt-3" style={{ height: 32, overflow: 'hidden' }}>
      {values.map((v, i) => (
        <div
          key={i}
          className="w-[3px] rounded-full"
          style={{
            height: v > 0 ? Math.max(2, Math.round((v / max) * 32)) : 0,
            backgroundColor: v > 0 ? accent : '#E2E8F0',
          }}
        />
      ))}
    </div>
  )
}

function ConversionProgress({ weeklyData }) {
  const totalChatted = weeklyData.reduce((s, d) => s + d.chatted, 0)
  const totalPaid    = weeklyData.reduce((s, d) => s + d.paid, 0)
  const avgRate      = totalChatted > 0 ? ((totalPaid / totalChatted) * 100).toFixed(1) : '0'

  const sparkChatted = weeklyData.map((d) => d.chatted)
  const sparkPaid    = weeklyData.map((d) => d.paid)
  const sparkRate    = weeklyData.map((d) =>
    d.chatted > 0 ? parseFloat(((d.paid / d.chatted) * 100).toFixed(1)) : 0,
  )

  const today = new Date()
  const dateStr = today.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })

  return (
    <div className="bg-gradient-to-br from-indigo-600 via-blue-700 to-[#00AFF0] rounded-[20px] p-6 shadow-lg">
      <div className="flex items-center justify-between mb-5">
        <h3 className="font-bold text-white">Conversion Progress</h3>
        <span className="flex items-center gap-1.5 text-sm text-white/60">
          <Calendar className="w-3.5 h-3.5" />
          {dateStr}
        </span>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div className="bg-white/10 rounded-xl p-3">
          <p className="text-xs text-white/60 mb-1">Total Chatted</p>
          <p className="text-2xl font-bold text-white">{totalChatted}</p>
          <SparkBars values={sparkChatted} accent="#ffffff" />
        </div>
        <div className="bg-white/10 rounded-xl p-3">
          <p className="text-xs text-white/60 mb-1">Total Paid</p>
          <p className="text-2xl font-bold text-white">{totalPaid}</p>
          <SparkBars values={sparkPaid} accent="#fbbf24" />
        </div>
        <div className="bg-white/10 rounded-xl p-3">
          <p className="text-xs text-white/60 mb-1">Avg Rate</p>
          <p className="text-2xl font-bold text-white">{avgRate}%</p>
          <SparkBars values={sparkRate} accent="#34d399" />
        </div>
      </div>
    </div>
  )
}

// ━━━ App ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export default function App() {
  const creators = useCreators()
  const [creatorUuid, setCreatorUuid] = useState(null)
  const { weeklyData, todayIdx, loading: weeklyLoading } = useWeeklyData(creatorUuid)
  const { chattedList, paidList, loading: metricsLoading } = useTodayMetrics(creatorUuid)
  const subscriberData = useSubscribers(creatorUuid)

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#0f172a] via-[#1a1f3a] to-[#0f1729] p-5">
      <div id="dash-root" className="max-w-[1320px] mx-auto">
        <Navbar creators={creators} creatorUuid={creatorUuid} onCreatorChange={setCreatorUuid} />

        {/* Main Row */}
        <div className="mt-5 grid grid-cols-1 lg:grid-cols-5 gap-5">
          <div className="lg:col-span-3">
            <ConversionTracker weeklyData={weeklyData} todayIdx={todayIdx} weeklyLoading={weeklyLoading} />
          </div>
          <div className="lg:col-span-2">
            <TodayMetrics creatorUuid={creatorUuid} subscriberData={subscriberData} />
          </div>
        </div>

        {/* Bottom Row */}
        <div id="dash-bottom" className="mt-5 grid grid-cols-1 md:grid-cols-2 gap-5">
          <TopChatters paidList={paidList} loading={metricsLoading} />
          <ConversionProgress weeklyData={weeklyData} />
        </div>
      </div>

      <ScreenshotPanel />
    </div>
  )
}
