import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  if (req.method === 'OPTIONS') return res.status(200).end()

  try {
    // ① 전체 트렌드 통계
    const { data: stats } = await supabase
      .from('trend_stats')
      .select('*')
      .order('score', { ascending: false })

    // ② 최근 30일 일별 집계
    const { data: daily } = await supabase
      .from('evidence_daily')
      .select('*')
      .order('day', { ascending: true })

    // ③ 카테고리별 집계
    const categoryMap = {}
    for (const t of stats || []) {
      const cat = t.category || '기타'
      if (!categoryMap[cat]) categoryMap[cat] = { total: 0, news: 0, paper: 0, patent: 0, law: 0 }
      categoryMap[cat].total   += t.total_evidence || 0
      categoryMap[cat].news    += t.news_count   || 0
      categoryMap[cat].paper   += t.paper_count  || 0
      categoryMap[cat].patent  += t.patent_count || 0
      categoryMap[cat].law     += t.law_count    || 0
    }

    // ④ 급등 트렌드 (검색량 + 점수 동시 상승)
    const hotTrends = (stats || [])
      .filter(t => (t.search_change || 0) > 10 || (t.weekly_change || 0) > 5)
      .sort((a, b) => ((b.search_change||0) + (b.weekly_change||0)) - ((a.search_change||0) + (a.weekly_change||0)))
      .slice(0, 5)

    // ⑤ 국가별 데이터 수
    const { data: countryData } = await supabase
      .from('evidence')
      .select('country')
      .gt('relevance_score', 0)
    const countryCount = {}
    for (const { country } of countryData || []) {
      if (!country || country === 'global') continue
      countryCount[country] = (countryCount[country] || 0) + 1
    }

    return res.status(200).json({
      trends:     stats || [],
      daily:      daily || [],
      categories: categoryMap,
      hotTrends,
      countries:  countryCount
    })
  } catch (e) {
    console.error('[stats] error:', e)
    return res.status(500).json({ error: e.message })
  }
}
