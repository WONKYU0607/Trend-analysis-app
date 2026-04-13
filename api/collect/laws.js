import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const KR_KEYWORDS = ['인공지능', '반도체', '양자', '바이오', '우주', '로봇', '신재생에너지']
const US_KEYWORDS = ['artificial intelligence', 'semiconductor', 'quantum', 'biotechnology', 'clean energy']

function regionOf(country) {
  const map = { KR: 'Asia', US: 'Americas', EU: 'Europe' }
  return map[country] || 'Global'
}

// ── 한국 국회 법안 ──
async function fetchKoreanLaws(keyword) {
  if (!process.env.ASSEMBLY_KEY) {
    console.warn('ASSEMBLY_KEY 미설정 — 국회 법안 수집 건너뜀')
    return []
  }

  const url = `https://open.assembly.go.kr/portal/openapi/nzmimeepazxkubdpn?KEY=${process.env.ASSEMBLY_KEY}&Type=json&pIndex=1&pSize=10&BILL_NAME=${encodeURIComponent(keyword)}`
  try {
    const res = await fetch(url)
    if (!res.ok) { console.error(`국회 API HTTP ${res.status}`); return [] }
    const data = await res.json()
    const bills = data?.nzmimeepazxkubdpn?.[1]?.row || []
    return bills.map(b => ({
      title: b.BILL_NAME,
      summary: `${b.PROPOSER} 발의 · 상태: ${b.PROC_RESULT_CD || '진행중'}`,
      source_url: `https://likms.assembly.go.kr/bill/billDetail.do?billId=${b.BILL_ID}`,
      published_at: b.PROPOSE_DT || new Date().toISOString(),
      country: 'KR'
    })).filter(b => b.source_url)
  } catch (e) {
    console.error('국회 API 오류:', e.message)
    return []
  }
}

// ── 미국 Congress ──
async function fetchUSLaws(keyword) {
  if (!process.env.CONGRESS_KEY) {
    console.warn('CONGRESS_KEY 미설정 — US 법안 수집 건너뜀')
    return []
  }

  const url = `https://api.congress.gov/v3/bill?query=${encodeURIComponent(keyword)}&sort=updateDate+desc&limit=10&api_key=${process.env.CONGRESS_KEY}`
  try {
    const res = await fetch(url)
    if (!res.ok) { console.error(`Congress API HTTP ${res.status}`); return [] }
    const data = await res.json()
    return (data.bills || []).map(b => ({
      title: b.title || '(Untitled Bill)',
      summary: `${b.type || ''} ${b.number || ''} · ${b.latestAction?.text || ''}`.trim(),
      source_url: b.number
        ? `https://www.congress.gov/bill/${b.congress}th-congress/${(b.type || 'bill').toLowerCase()}/${b.number}`
        : `https://www.congress.gov/search?q=${encodeURIComponent(keyword)}`,
      published_at: b.introducedDate || new Date().toISOString(),
      country: 'US'
    })).filter(b => b.source_url)
  } catch (e) {
    console.error('Congress API 오류:', e.message)
    return []
  }
}

// ── EUR-Lex (유럽 법안) ──
// EUR-Lex는 공개 JSON API를 제공하지 않음
// 향후 CELLAR SPARQL 엔드포인트로 연동 예정
async function fetchEURLex(keyword) {
  // TODO: SPARQL 연동 구현
  // https://eur-lex.europa.eu/content/tools/webservices/SearchWebServiceUserManual_v2.00.pdf
  console.log(`EUR-Lex: "${keyword}" — SPARQL 연동 미구현, 건너뜀`)
  return []
}

async function getTrend(keyword) {
  const { data } = await supabase
    .from('trends')
    .select('id')
    .ilike('keyword', `%${keyword}%`)
    .limit(1)
  return data?.[0]
}

// ★ 중복 방지: upsert + ignoreDuplicates
async function saveEvidence(trendId, items) {
  if (!items.length) return 0

  const sourceMap = { KR: '국회 의안정보시스템', US: 'Congress.gov', EU: 'EUR-Lex' }

  const rows = items
    .filter(item => item.source_url)
    .map(item => ({
      trend_id: trendId,
      type: 'law',
      title: item.title,
      summary: item.summary,
      source_url: item.source_url,
      source_name: sourceMap[item.country] || item.country,
      country: item.country,
      region: regionOf(item.country),
      published_at: item.published_at || new Date().toISOString(),
      relevance_score: 0.9
    }))

  if (!rows.length) return 0

  const { data, error } = await supabase
    .from('evidence')
    .upsert(rows, {
      onConflict: 'trend_id,source_url',
      ignoreDuplicates: true
    })
    .select('id')

  if (error) {
    console.error('law evidence error:', error.message)
    return 0
  }
  return data?.length || 0
}

export default async function handler(req, res) {
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const results = []

  try {
    // 한국 법안 수집
    for (const keyword of KR_KEYWORDS) {
      const trend = await getTrend(keyword)
      if (!trend) continue
      const laws = await fetchKoreanLaws(keyword)
      const saved = await saveEvidence(trend.id, laws)
      results.push({ keyword, country: 'KR', saved })
      await new Promise(r => setTimeout(r, 800))
    }

    // 미국 + EU 법안 수집
    for (const keyword of US_KEYWORDS) {
      const trend = await getTrend(keyword)
      if (!trend) continue
      const [us, eu] = await Promise.all([fetchUSLaws(keyword), fetchEURLex(keyword)])
      const sUS = await saveEvidence(trend.id, us)
      const sEU = await saveEvidence(trend.id, eu)
      results.push({ keyword, US: sUS, EU: sEU })
      await new Promise(r => setTimeout(r, 800))
    }

    res.status(200).json({
      ok: true,
      message: '법안 수집 완료 (KR+US+EU)',
      details: results
    })
  } catch (e) {
    console.error('laws handler error:', e)
    res.status(500).json({ error: e.message })
  }
}
