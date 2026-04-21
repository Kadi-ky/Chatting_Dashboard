import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'

/**
 * Load all chat_messages for a creator (or across creators if uuid is null),
 * grouped by fan, with realtime updates.
 *
 * Returns:
 *   threads  — [{ fan_id, name, username, avatar, messages: [...] }]
 *   loading
 *   error
 *   refetch
 */
export function useChatMessages(creatorUuid) {
  const [messages, setMessages] = useState([])
  const [subscribers, setSubscribers] = useState({})  // fan_id → subscriber row
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    if (!supabase) {
      setMessages([])
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      let msgQuery = supabase
        .from('chat_messages')
        .select('id, creator_uuid, fan_id, onlyfans_account_id, direction, role, content, status, mood, intent, classifier_conf, model_used, created_at')
        .order('created_at', { ascending: true })
        .limit(500)
      if (creatorUuid) msgQuery = msgQuery.eq('creator_uuid', creatorUuid)

      let subQuery = supabase
        .from('onlyfans_subscribers')
        .select('fan_id, onlyfans_account_id, name, username, avatar, ai_paused, interaction_depth, rapport_score')
      if (creatorUuid) subQuery = subQuery.eq('creator_uuid', creatorUuid)

      const [msgRes, subRes] = await Promise.all([msgQuery, subQuery])
      if (msgRes.error) throw msgRes.error
      if (subRes.error) throw subRes.error

      const subMap = {}
      for (const s of subRes.data ?? []) subMap[s.fan_id] = s
      setMessages(msgRes.data ?? [])
      setSubscribers(subMap)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [creatorUuid])

  useEffect(() => { load() }, [load])

  // Realtime: re-fetch on any chat_messages change
  useEffect(() => {
    if (!supabase) return
    const channel = supabase
      .channel('chat-messages-realtime')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'chat_messages',
          ...(creatorUuid ? { filter: `creator_uuid=eq.${creatorUuid}` } : {}),
        },
        () => load(),
      )
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [creatorUuid, load])

  // Group messages by fan_id
  const threadMap = {}
  for (const m of messages) {
    if (!threadMap[m.fan_id]) threadMap[m.fan_id] = []
    threadMap[m.fan_id].push(m)
  }
  const threads = Object.entries(threadMap)
    .map(([fanId, msgs]) => {
      const sub = subscribers[fanId] ?? {}
      const last = msgs[msgs.length - 1]
      return {
        fan_id: Number(fanId),
        onlyfans_account_id: sub.onlyfans_account_id || msgs[0]?.onlyfans_account_id || "acct_TEST",
        name: sub.name ?? `Fan ${fanId}`,
        username: sub.username ?? null,
        avatar: sub.avatar ?? null,
        ai_paused: sub.ai_paused ?? false,
        interaction_depth: sub.interaction_depth ?? 'cold',
        rapport_score: sub.rapport_score ?? 0,
        messages: msgs,
        last_message_at: last?.created_at ?? null,
        last_content: last?.content ?? '',
      }
    })
    .sort((a, b) => (b.last_message_at ?? '').localeCompare(a.last_message_at ?? ''))

  return { threads, loading, error, refetch: load }
}
