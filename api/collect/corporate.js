import { createClient } from '@supabase/supabase-js'
import { TECH_KEYWORDS } from '../lib/keywords.js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

// ── DART 전자공시 ──
async function fetchDART(keyword) {
  if (!process.env.DART_KEY) {
    console.warn('DART_KEY 미설정 — 기업 공시 수집 건너뜀')
    return []
  }
  const today = new Date()
  const ago = new Date(today); ago.setMonth(today.getMonth() - 3)
  const bgn = ago.toISOString().slice(0,10).replace(/-/g,'')
  const end = today.toISOString().slice(0,10).replace(/-/g,'')
  const url = `https://opendart.fss.or.kr/api/list.json?crtfc_key=${process.env.DART_KEY}&bgn_de=${bgn}&end_de=${end}&page_count=10&sort=date&sort_mth=desc`
  try {
    const res = await fetch(url)
    if (!res.ok) { console.error(`DART HTTP ${res.status}`); return [] }
    const data = await res.json()
    if (data.status !== '000') { console.warn(`DART: ${data.message}`); return [] }
    const kwLower = keyword.toLowerCase()
    return (data.list || [])
      .filter(i => `${i.corp_name} ${i.report_nm}`.toLowerCase().includes(kwLower))
      .slice(0, 5)
      .map(i => ({
        title: `[${i.corp_name}] ${i.report_nm}`,
        summary: `${i.corp_name} · ${i.rcept_dt}`,
        source_url: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${i.rcept_no}`,
        published_at: i.rcept_dt ? `${i.rcept_dt.slice(0,4)}-${i.rcept_dt.slice(4,6)}-${i.rcept_dt.slice(6,8)}` : new Date().toISOString(),
        country: 'KR', source_name: 'DART 전자공시'
      }))
  } catch (e) { console.error('DART 오류:', e.message); return [] }
}

// ── 정책브리핑 RSS (키 불필요) ──
// ★ URL: https로 변경됨
async function fetchPolicyBriefing(keyword) {
  const url = 'https://www.korea.kr/rss/policy.xml'
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
      const content = `${title} ${description}`.toLowerCase()
      if (title && link && content.includes(keyword.toLowerCase())) {
        items.push({
          title, summary: description?.replace(/<[^>]*>/g, '').slice(0, 300) || null,
          source_url: link, source_name: '정책브리핑',
          published_at: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(), country: 'KR'
        })
      }
    }
    return items.slice(0, 5)
  } catch (e) { console.error('정책브리핑 오류:', e.message); return [] }
}

async function getTrendId(keyword) {
  const { data } = await supabase.from('trends').select('id').eq('keyword', keyword).single()
  return data?.id
}

async function saveEvidence(trendId, items, type) {
  if (!items.length) return 0
  const rows = items.filter(i => i.source_url).map(i => ({
    trend_id: trendId, type, title: i.title, summary: i.summary,
    source_url: i.source_url, source_name: i.source_name,
    country: i.country || 'KR', region: 'Asia', language: 'ko',
    published_at: i.published_at || new Date().toISOString(),
    relevance_score: type === 'policy' ? 0.9 : 0.75
  }))
  if (!rows.length) return 0
  const { data, error } = await supabase.from('evidence')
    .upsert(rows, { onConflict: 'trend_id,source_url', ignoreDuplicates: true }).select('id')
  if (error) { console.error(`${type} 저장 오류:`, error.message); return 0 }
  return data?.length || 0
}

export default async function handler(req, res) {
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  const results = []
  try {
    // ★ 10개씩 배치 처리 (60초 타임아웃 방지)
    const batch = TECH_KEYWORDS.slice(0, 10)
    for (const kw of batch) {
      const trendId = await getTrendId(kw.ko)
      if (!trendId) continue
      const policies = await fetchPolicyBriefing(kw.ko)
      const savedPolicy = await saveEvidence(trendId, policies, 'policy')
      const disclosures = await fetchDART(kw.ko)
      const savedDart = await saveEvidence(trendId, disclosures, 'news')
      results.push({ keyword: kw.ko, policy: savedPolicy, dart: savedDart })
      await new Promise(r => setTimeout(r, 300))
    }
    res.status(200).json({ ok: true, message: `기업·정책 수집 완료 — ${results.length}개`, details: results })
  } catch (e) {
    console.error('기업·정책 수집 오류:', e)
    res.status(500).json({ error: e.message })
  }
}
