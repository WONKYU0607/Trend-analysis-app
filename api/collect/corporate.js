import { createClient } from '@supabase/supabase-js'
import { TECH_KEYWORDS } from '../lib/keywords.js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

// ── DART 전자공시 (기업 공시) ──
// 기술 키워드 관련 공시를 검색
async function fetchDART(keyword) {
  if (!process.env.DART_KEY) {
    console.warn('DART_KEY 미설정 — 기업 공시 수집 건너뜀')
    return []
  }

  // DART 공시검색 API
  const today = new Date()
  const threeMonthsAgo = new Date(today)
  threeMonthsAgo.setMonth(today.getMonth() - 3)
  const bgn = threeMonthsAgo.toISOString().slice(0, 10).replace(/-/g, '')
  const end = today.toISOString().slice(0, 10).replace(/-/g, '')

  const url = `https://opendart.fss.or.kr/api/list.json?crtfc_key=${process.env.DART_KEY}&bgn_de=${bgn}&end_de=${end}&page_count=10&sort=date&sort_mth=desc`
  try {
    const res = await fetch(url)
    if (!res.ok) { console.error(`DART HTTP ${res.status}`); return [] }
    const data = await res.json()

    if (data.status !== '000') {
      console.warn(`DART 응답: ${data.message}`)
      return []
    }

    // 키워드와 관련된 공시만 필터
    const kwLower = keyword.toLowerCase()
    return (data.list || [])
      .filter(item => {
        const text = `${item.corp_name} ${item.report_nm}`.toLowerCase()
        return text.includes(kwLower) || text.includes(keyword)
      })
      .slice(0, 5)
      .map(item => ({
        title: `[${item.corp_name}] ${item.report_nm}`,
        summary: `${item.corp_name} · ${item.rcept_dt}`,
        source_url: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${item.rcept_no}`,
        published_at: item.rcept_dt
          ? `${item.rcept_dt.slice(0,4)}-${item.rcept_dt.slice(4,6)}-${item.rcept_dt.slice(6,8)}`
          : new Date().toISOString(),
        country: 'KR',
        source_name: 'DART 전자공시'
      }))
  } catch (e) {
    console.error('DART 오류:', e.message)
    return []
  }
}

// ── 정책브리핑 RSS (키 불필요) ──
async function fetchPolicyBriefing(keyword) {
  const url = `https://www.korea.kr/rss/policy.xml`
  try {
    const res = await fetch(url)
    if (!res.ok) { console.error(`정책브리핑 HTTP ${res.status}`); return [] }
    const text = await res.text()
    const items = []
    const re = /<item>([\s\S]*?)<\/item>/g
    let m
    while ((m = re.exec(text)) !== null) {
      const item = m[1]
      const title = item.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1').trim()
      const link = item.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim()
      const description = item.match(/<description>([\s\S]*?)<\/description>/)?.[1]?.replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1').trim()
      const pubDate = item.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1]?.trim()

      // 키워드 관련 정책만 필터
      const content = `${title} ${description}`.toLowerCase()
      if (title && link && content.includes(keyword.toLowerCase())) {
        items.push({
          title,
          summary: description?.replace(/<[^>]*>/g, '').slice(0, 300) || null,
          source_url: link,
          source_name: '정책브리핑',
          published_at: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
          country: 'KR'
        })
      }
    }
    return items.slice(0, 5)
  } catch (e) {
    console.error('정책브리핑 오류:', e.message)
    return []
  }
}

// ── DB ──
async function getTrendId(keyword) {
  const { data } = await supabase
    .from('trends')
    .select('id')
    .eq('keyword', keyword)
    .single()
  return data?.id
}

async function saveEvidence(trendId, items, type) {
  if (!items.length) return 0
  const rows = items
    .filter(item => item.source_url)
    .map(item => ({
      trend_id: trendId,
      type,
      title: item.title,
      summary: item.summary,
      source_url: item.source_url,
      source_name: item.source_name,
      country: item.country || 'KR',
      region: 'Asia',
      language: 'ko',
      published_at: item.published_at || new Date().toISOString(),
      relevance_score: type === 'policy' ? 0.9 : 0.75
    }))

  if (!rows.length) return 0

  const { data, error } = await supabase
    .from('evidence')
    .upsert(rows, { onConflict: 'trend_id,source_url', ignoreDuplicates: true })
    .select('id')

  if (error) { console.error(`${type} 저장 오류:`, error.message); return 0 }
  return data?.length || 0
}

export default async function handler(req, res) {
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const results = []

  try {
    for (const kw of TECH_KEYWORDS) {
      const trendId = await getTrendId(kw.ko)
      if (!trendId) continue

      // 정책브리핑
      const policies = await fetchPolicyBriefing(kw.ko)
      const savedPolicy = await saveEvidence(trendId, policies, 'policy')

      // DART 기업공시
      const disclosures = await fetchDART(kw.ko)
      const savedDart = await saveEvidence(trendId, disclosures, 'news')

      results.push({ keyword: kw.ko, policy: savedPolicy, dart: savedDart })
      await new Promise(r => setTimeout(r, 500))
    }

    res.status(200).json({
      ok: true,
      message: `기업·정책 수집 완료 — ${results.length}개 키워드`,
      details: results
    })
  } catch (e) {
    console.error('기업·정책 수집 오류:', e)
    res.status(500).json({ error: e.message })
  }
}
