import { createClient } from '@supabase/supabase-js'
import { TECH_KEYWORDS, toEn } from '../lib/keywords.js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

function regionOf(country) {
  const map = { KR: 'Asia', US: 'Americas', EU: 'Europe' }
  return map[country] || 'Global'
}

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

async function getTrendId(keyword) {
  const { data } = await supabase.from('trends').select('id').eq('keyword', keyword).single()
  return data?.id
}

async function saveEvidence(trendId, items) {
  if (!items.length) return 0
  const sourceMap = { KR: '국회 의안정보시스템', US: 'Congress.gov' }
  const rows = items.filter(item => item.source_url).map(item => ({
    trend_id: trendId, type: 'law', title: item.title, summary: item.summary,
    source_url: item.source_url, source_name: sourceMap[item.country] || item.country,
    country: item.country, region: regionOf(item.country),
    language: item.country === 'KR' ? 'ko' : 'en',
    published_at: item.published_at || new Date().toISOString(), relevance_score: 0.9
  }))
  if (!rows.length) return 0
  const { data, error } = await supabase.from('evidence')
    .upsert(rows, { onConflict: 'trend_id,source_url', ignoreDuplicates: true }).select('id')
  if (error) { console.error('법안 저장 오류:', error.message); return 0 }
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
      const krLaws = await fetchKoreanLaws(kw.ko)
      const savedKR = await saveEvidence(trendId, krLaws)
      const usLaws = await fetchUSLaws(kw.en)
      const savedUS = await saveEvidence(trendId, usLaws)
      results.push({ keyword: kw.ko, KR: savedKR, US: savedUS })
      await new Promise(r => setTimeout(r, 800))
    }
    res.status(200).json({ ok: true, message: `법안 수집 완료 — ${results.length}개 키워드 (KR+US)`, details: results })
  } catch (e) {
    console.error('법안 수집 오류:', e)
    res.status(500).json({ error: e.message })
  }
}
