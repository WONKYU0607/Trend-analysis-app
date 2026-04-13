import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const KR_KEYWORDS = ['인공지능', '반도체', '양자', '바이오', '우주', '로봇', '신재생에너지']
const US_KEYWORDS = ['artificial intelligence', 'semiconductor', 'quantum', 'biotechnology', 'clean energy']

async function fetchKoreanLaws(keyword) {
  const url = `https://open.assembly.go.kr/portal/openapi/nzmimeepazxkubdpn?KEY=${process.env.ASSEMBLY_KEY}&Type=json&pIndex=1&pSize=10&BILL_NAME=${encodeURIComponent(keyword)}`
  try {
    const res = await fetch(url)
    const data = await res.json()
    const bills = data?.nzmimeepazxkubdpn?.[1]?.row || []
    return bills.map(b => ({
      title: b.BILL_NAME,
      summary: `${b.PROPOSER} 발의 · 상태: ${b.PROC_RESULT_CD}`,
      source_url: `https://likms.assembly.go.kr/bill/billDetail.do?billId=${b.BILL_ID}`,
      published_at: b.PROPOSE_DT,
      country: 'KR'
    }))
  } catch (e) {
    console.error('국회 API 오류:', e.message)
    return []
  }
}

async function fetchUSLaws(keyword) {
  const url = `https://api.congress.gov/v3/bill?query=${encodeURIComponent(keyword)}&sort=updateDate+desc&limit=10&api_key=${process.env.CONGRESS_KEY}`
  try {
    const res = await fetch(url)
    const data = await res.json()
    return (data.bills || []).map(b => ({
      title: b.title,
      summary: `${b.type} ${b.number} · ${b.latestAction?.text || ''}`,
      source_url: `https://www.congress.gov/bill/${b.congress}th-congress/${b.type?.toLowerCase()}/${b.number}`,
      published_at: b.introducedDate,
      country: 'US'
    }))
  } catch (e) {
    console.error('Congress API 오류:', e.message)
    return []
  }
}

async function fetchEURLex(keyword) {
  try {
    const res = await fetch(
      `https://eur-lex.europa.eu/search.html?scope=EURLEX&text=${encodeURIComponent(keyword)}&lang=en&format=json`
    )
    if (!res.ok) return []
    const data = await res.json()
    return (data.results || []).slice(0, 5).map(r => ({
      title: r.title,
      summary: r.summary?.slice(0, 300),
      source_url: r.uri,
      published_at: r.date,
      country: 'EU'
    }))
  } catch (e) {
    console.error('EUR-Lex 오류:', e.message)
    return []
  }
}

async function getTrend(keyword) {
  const { data } = await supabase
    .from('trends')
    .select('id')
    .ilike('keyword', `%${keyword}%`)
    .limit(1)
  return data?.[0]
}

async function saveEvidence(trendId, items) {
  if (!items.length) return
  const sourceMap = { KR: '국회 의안정보시스템', US: 'Congress.gov', EU: 'EUR-Lex' }
  const regionMap = { KR: 'Asia', US: 'Americas', EU: 'Europe' }
  const rows = items.map(item => ({
    trend_id: trendId,
    type: 'law',
    title: item.title,
    summary: item.summary,
    source_url: item.source_url,
    source_name: sourceMap[item.country] || item.country,
    country: item.country,
    region: regionMap[item.country] || 'Global',
    published_at: item.published_at,
    relevance_score: 0.9
  }))
  const { error } = await supabase.from('evidence').insert(rows)
  if (error) console.error('law evidence error:', error)
}

export default async function handler(req, res) {
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  try {
    for (const keyword of KR_KEYWORDS) {
      const trend = await getTrend(keyword)
      if (!trend) continue
      const laws = await fetchKoreanLaws(keyword)
      await saveEvidence(trend.id, laws)
      await new Promise(r => setTimeout(r, 800))
    }
    for (const keyword of US_KEYWORDS) {
      const trend = await getTrend(keyword)
      if (!trend) continue
      const [us, eu] = await Promise.all([fetchUSLaws(keyword), fetchEURLex(keyword)])
      await saveEvidence(trend.id, us)
      await saveEvidence(trend.id, eu)
      await new Promise(r => setTimeout(r, 800))
    }
    res.status(200).json({ ok: true, message: '법안 수집 완료 (KR+US+EU)' })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
}
