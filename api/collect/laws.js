import { createClient } from '@supabase/supabase-js'
import { TECH_KEYWORDS, toEn } from '../lib/keywords.js'
import { shouldInclude, trustScore } from '../lib/trust.js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

// 법안 진행 상태 → 신뢰도
function lawTrustByStatus(status) {
  if (!status) return 0.65
  if (status.includes('원안가결') || status.includes('수정가결') || status.includes('대안반영')) return 0.98
  if (status.includes('위원회') && status.includes('가결')) return 0.85
  if (status.includes('계류') || status.includes('진행')) return 0.65
  if (status.includes('폐기') || status.includes('철회') || status.includes('부결')) return 0.10
  return 0.65
}

async function fetchKoreanLaws(keyword) {
  if (!process.env.ASSEMBLY_KEY) { console.warn('ASSEMBLY_KEY 미설정'); return [] }
  const url = `https://open.assembly.go.kr/portal/openapi/nzmimeepazxkubdpn?KEY=${process.env.ASSEMBLY_KEY}&Type=json&pIndex=1&pSize=20&BILL_NAME=${encodeURIComponent(keyword)}`
  try {
    const res = await fetch(url)
    if (!res.ok) return []
    const data = await res.json()
    const bills = data?.nzmimeepazxkubdpn?.[1]?.row || []
    const results = []
    for (const b of bills) {
      const title  = b.BILL_NAME
      const status = b.PROC_RESULT_CD || '계류중'
      const trust  = lawTrustByStatus(status)

      // 폐기된 법안은 제외
      if (trust < 0.2) continue

      const { include, score } = shouldInclude(title, '', '국회', 'law', keyword)
      if (!include) continue

      results.push({
        title,
        summary: `${b.PROPOSER} 발의 · 상태: ${status}`,
        source_url: `https://likms.assembly.go.kr/bill/billDetail.do?billId=${b.BILL_ID}`,
        published_at: b.PROPOSE_DT || new Date().toISOString(),
        country: 'KR',
        law_status: status,
        relevance_score: score,
        trust_score: trust
      })
    }
    return results
  } catch (e) { console.error('국회 API 오류:', e.message); return [] }
}

async function fetchUSLaws(keyword, enKeyword) {
  if (!process.env.CONGRESS_KEY) { console.warn('CONGRESS_KEY 미설정'); return [] }
  const url = `https://api.congress.gov/v3/bill?query=${encodeURIComponent(enKeyword)}&sort=updateDate+desc&limit=15&api_key=${process.env.CONGRESS_KEY}`
  try {
    const res = await fetch(url)
    if (!res.ok) return []
    const data = await res.json()
    const results = []
    for (const b of data.bills || []) {
      const title  = b.title || '(Untitled Bill)'
      const status = b.latestAction?.text || ''
      const trust  = status.toLowerCase().includes('signed') || status.toLowerCase().includes('enacted') ? 0.98
        : status.toLowerCase().includes('passed') ? 0.85
        : 0.65

      const { include, score } = shouldInclude(title, status, 'Congress.gov', 'law', keyword)
      if (!include) continue

      results.push({
        title,
        summary: `${b.type || ''} ${b.number || ''} · ${status}`.trim(),
        source_url: b.number
          ? `https://www.congress.gov/bill/${b.congress}th-congress/${(b.type||'bill').toLowerCase()}/${b.number}`
          : `https://www.congress.gov`,
        published_at: b.introducedDate || new Date().toISOString(),
        country: 'US',
        law_status: status,
        relevance_score: score,
        trust_score: trust
      })
    }
    return results
  } catch (e) { console.error('Congress API 오류:', e.message); return [] }
}

async function getTrendId(keyword) {
  const { data } = await supabase.from('trends').select('id').eq('keyword', keyword).single()
  return data?.id
}

async function saveEvidence(trendId, items, sourceName) {
  if (!items.length) return 0
  const rows = items.filter(i => i.source_url).map(i => ({
    trend_id: trendId, type: 'law',
    title: i.title, summary: i.summary,
    source_url: i.source_url,
    source_name: sourceName || (i.country === 'KR' ? '국회 의안정보시스템' : 'Congress.gov'),
    country: i.country,
    region: i.country === 'KR' ? 'Asia' : 'Americas',
    language: i.country === 'KR' ? 'ko' : 'en',
    published_at: i.published_at || new Date().toISOString(),
    relevance_score: i.relevance_score || 0.8,
    trust_score: i.trust_score || 0.65,
    law_status: i.law_status || null
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
      const [kr, us] = await Promise.all([
        fetchKoreanLaws(kw.ko),
        fetchUSLaws(kw.ko, kw.en)
      ])
      const sKR = await saveEvidence(trendId, kr)
      const sUS = await saveEvidence(trendId, us)
      console.log(`[${kw.ko}] 법안 KR:${sKR} US:${sUS}`)
      results.push({ keyword: kw.ko, KR: sKR, US: sUS })
      await new Promise(r => setTimeout(r, 800))
    }
    res.status(200).json({ ok: true, message: `법안 수집 완료`, details: results })
  } catch (e) {
    console.error('법안 수집 오류:', e)
    res.status(500).json({ error: e.message })
  }
}
