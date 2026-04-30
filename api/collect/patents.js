import { createClient } from '@supabase/supabase-js'
import { TECH_KEYWORDS, toEn } from '../lib/keywords.js'
import { shouldInclude, trustScore } from '../lib/trust.js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

function regionOf(country) {
  const map = { KR: 'Asia', JP: 'Asia', US: 'Americas', EU: 'Europe' }
  return map[country] || 'Global'
}

// ── USPTO 미국 특허 (키 불필요) ──
async function fetchUSPTO(keyword, enKeyword) {
  const url = `https://developer.uspto.gov/ibd-api/v1/patent/application?searchText=${encodeURIComponent(enKeyword)}&start=0&rows=15&dateRangeField=applDateText&dateRangeStart=2023-01-01&dateRangeEnd=2026-12-31`
  try {
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json' }
    })
    if (!res.ok) { console.error(`USPTO HTTP ${res.status}`); return [] }
    const data = await res.json()
    const results = []
    for (const p of data.results || []) {
      const title   = p.inventionTitle || ''
      const appNo   = p.patentApplicationNumber || ''
      const appDate = p.filingDate || ''
      if (!title) continue

      const { include, score } = shouldInclude(title, '', 'USPTO', 'patent', keyword)
      if (!include) continue

      results.push({
        title,
        summary: p.abstractText?.slice(0, 300) || null,
        source_url: appNo
          ? `https://patents.google.com/patent/US${appNo.replace(/\//g,'')}`
          : `https://developer.uspto.gov`,
        source_name: 'USPTO',
        published_at: appDate || new Date().toISOString(),
        country: 'US',
        relevance_score: score,
        trust_score: trustScore('USPTO', 'patent')
      })
    }
    return results
  } catch (e) { console.error('USPTO 오류:', e.message); return [] }
}

async function fetchKIPRIS(keyword) {
  if (!process.env.KIPRIS_KEY) {
    console.warn('KIPRIS_KEY 미설정 — KIPRIS 수집 건너뜀')
    return []
  }
  const url = `http://plus.kipris.or.kr/openapi/rest/patUtiModInfoSearchSevice/patentUtilityInfo?ServiceKey=${process.env.KIPRIS_KEY}&word=${encodeURIComponent(keyword)}&numOfRows=10&pageNo=1`
  try {
    const res = await fetch(url)
    if (!res.ok) { console.error(`KIPRIS HTTP ${res.status}`); return [] }
    const text = await res.text()
    const items = []
    const re = /<item>([\s\S]*?)<\/item>/g
    let m
    while ((m = re.exec(text)) !== null) {
      const item = m[1]
      const title = item.match(/<inventionTitle>([\s\S]*?)<\/inventionTitle>/)?.[1]?.trim()
      const appNo = item.match(/<applicationNumber>([\s\S]*?)<\/applicationNumber>/)?.[1]?.trim()
      const appDate = item.match(/<applicationDate>([\s\S]*?)<\/applicationDate>/)?.[1]?.trim()
      if (title) {
        const { include, score } = shouldInclude(title, '', 'KIPRIS', 'patent', keyword)
        if (include) items.push({
          title, summary: null,
          source_url: appNo ? `https://doi.kipris.or.kr/infoDS?appl_no=${appNo}` : 'https://www.kipris.or.kr',
          published_at: appDate || new Date().toISOString(), country: 'KR',
          relevance_score: score, trust_score: trustScore('KIPRIS_출원', 'patent')
        })
      }
    }
    return items
  } catch (e) { console.error('KIPRIS 오류:', e.message); return [] }
}

async function fetchEPO(keyword) {
  if (!process.env.EPO_TOKEN) {
    console.warn('EPO_TOKEN 미설정 — EPO 수집 건너뜀')
    return []
  }
  try {
    const res = await fetch(
      `https://ops.epo.org/3.2/rest-services/published-data/search?q=txt%3D%22${encodeURIComponent(keyword)}%22&Range=1-10`,
      { headers: { 'Authorization': `Bearer ${process.env.EPO_TOKEN}`, 'Accept': 'application/json' } }
    )
    if (!res.ok) { console.error(`EPO HTTP ${res.status}`); return [] }
    const data = await res.json()
    const searchResult = data?.['ops:world-patent-data']?.['ops:biblio-search']?.['ops:search-result']
    const pubRefs = searchResult?.['exchange-documents'] || []
    const docs = Array.isArray(pubRefs) ? pubRefs : [pubRefs]
    return docs.slice(0, 10).map(doc => {
      const biblio = doc?.['exchange-document']?.['bibliographic-data'] || {}
      const titleNode = biblio?.['invention-title']
      let title = keyword + ' — EPO Patent'
      if (titleNode) {
        if (Array.isArray(titleNode)) { title = titleNode.find(t => t?.['@lang'] === 'en')?.['$'] || titleNode[0]?.['$'] || title }
        else if (typeof titleNode === 'object') { title = titleNode['$'] || title }
      }
      const docId = doc?.['exchange-document']?.['@doc-number'] || ''
      return {
        title, summary: null,
        source_url: docId ? `https://worldwide.espacenet.com/patent/search?q=${docId}` : `https://worldwide.espacenet.com/patent/search?q=${encodeURIComponent(keyword)}`,
        published_at: new Date().toISOString(), country: 'EU'
      }
    })
  } catch (e) { console.error('EPO 오류:', e.message); return [] }
}

async function getTrendId(keyword) {
  const { data } = await supabase.from('trends').select('id').eq('keyword', keyword).single()
  return data?.id
}

async function saveEvidence(trendId, items, sourceName) {
  if (!items.length) return 0
  const rows = items.filter(item => item.source_url).map(item => ({
    trend_id: trendId, type: 'patent', title: item.title, summary: item.summary,
    source_url: item.source_url, source_name: item.source_name || sourceName,
    country: item.country, region: regionOf(item.country),
    language: item.country === 'KR' ? 'ko' : 'en',
    published_at: item.published_at || new Date().toISOString(),
    relevance_score: item.relevance_score || 0.75,
    trust_score: item.trust_score || 0.75
  }))
  if (!rows.length) return 0
  const { data, error } = await supabase.from('evidence')
    .upsert(rows, { onConflict: 'trend_id,source_url', ignoreDuplicates: true }).select('id')
  if (error) { console.error('특허 저장 오류:', error.message); return 0 }
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
      const [kr, ep, us] = await Promise.all([
        fetchKIPRIS(kw.ko),
        fetchEPO(kw.en),
        fetchUSPTO(kw.ko, kw.en)
      ])
      const sKR = await saveEvidence(trendId, kr, 'KIPRIS')
      const sEP = await saveEvidence(trendId, ep, 'EPO')
      const sUS = await saveEvidence(trendId, us, 'USPTO')
      console.log(`[${kw.ko}] 특허 KR:${sKR} EU:${sEP} US:${sUS}`)
      results.push({ keyword: kw.ko, KIPRIS: sKR, EPO: sEP, USPTO: sUS })
      await new Promise(r => setTimeout(r, 1500))
    }
    res.status(200).json({ ok: true, message: `특허 수집 완료 — ${results.length}개 키워드 (KR+EU)`, details: results })
  } catch (e) {
    console.error('특허 수집 오류:', e)
    res.status(500).json({ error: e.message })
  }
}
