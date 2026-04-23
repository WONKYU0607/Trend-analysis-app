import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  if (req.method === 'OPTIONS') return res.status(200).end()

  const { id } = req.query

  try {
    // ── 상세 조회 ──────────────────────────────────────────
    if (id) {
      const { data: trend, error: tErr } = await supabase
        .from('trends').select('*').eq('id', id).single()
      if (tErr || !trend) return res.status(404).json({ error: 'not found' })

      const { data: report } = await supabase
        .from('reports').select('*').eq('trend_id', id).single()

      const { data: evRows } = await supabase
        .from('evidence').select('*')
        .eq('trend_id', id)
        .gt('relevance_score', 0)              // 관련없음(0점) 제외
        .order('relevance_score', { ascending: false })
        .order('published_at', { ascending: false })
        .limit(100)

      const evidence = { paper: [], patent: [], law: [], policy: [], news: [] }
      for (const e of evRows || []) {
        if (evidence[e.type]) evidence[e.type].push(e)
      }

      return res.status(200).json({ trend, report: report || null, evidence })
    }

    // ── 목록 조회 ──────────────────────────────────────────
    const { data: trends, error: lErr } = await supabase
      .from('trends')
      .select('id, keyword, category, score, prev_score, weekly_change, confidence_level, updated_at')
      .order('score', { ascending: false })
      .limit(60)

    if (lErr) throw lErr

    // ★ join 대신 별도 쿼리 — Supabase join 타입 불일치 버그 우회
    const { data: reports } = await supabase
      .from('reports')
      .select('trend_id, summary, sector, time_horizon')

    const reportMap = {}
    for (const r of reports || []) {
      reportMap[r.trend_id] = r
    }

    // trends에 report 붙이기
    const trendsWithReport = (trends || []).map(t => ({
      ...t,
      report: reportMap[t.id] || null
    }))

    // stats
    const { data: evCount } = await supabase.rpc('get_evidence_count')
    const { data: countries } = await supabase
      .from('evidence').select('country')
    const countryCount = new Set(
      (countries || []).map(r => r.country).filter(Boolean)
    ).size

    return res.status(200).json({
      trends: trendsWithReport,
      stats: {
        trendCount:    trendsWithReport.length,
        evidenceCount: Number(evCount) || 0,
        countryCount
      }
    })
  } catch (e) {
    console.error('[trends] error:', e)
    return res.status(500).json({ error: e.message || 'internal error' })
  }
}
