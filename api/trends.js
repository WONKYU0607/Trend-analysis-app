import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Cache-Control', 's-maxage=300') // 5분 캐시

  const { id, type, country } = req.query

  try {
    // 단일 트렌드 상세 (근거자료 포함)
    if (id) {
      const { data: trend } = await supabase
        .from('trends')
        .select('*')
        .eq('id', id)
        .single()

      const { data: report } = await supabase
        .from('reports')
        .select('*')
        .eq('trend_id', id)
        .single()

      let evidenceQuery = supabase
        .from('evidence')
        .select('*')
        .eq('trend_id', id)
        .order('relevance_score', { ascending: false })

      if (type) evidenceQuery = evidenceQuery.eq('type', type)
      if (country) evidenceQuery = evidenceQuery.eq('country', country)

      const { data: evidence } = await evidenceQuery.limit(50)

      // 타입별 그룹핑
      const grouped = {
        paper: [],
        patent: [],
        law: [],
        policy: [],
        news: []
      }
      for (const e of (evidence || [])) {
        if (grouped[e.type]) grouped[e.type].push(e)
      }

      return res.status(200).json({ trend, report, evidence: grouped })
    }

    // 전체 트렌드 목록 (스코어 순)
    const { data: trends } = await supabase
      .from('trends')
      .select(`
        id, keyword, category, score, weekly_change,
        confidence_level, updated_at,
        reports (summary, sector, time_horizon)
      `)
      .order('score', { ascending: false })
      .limit(20)

    res.status(200).json({ trends })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
}
