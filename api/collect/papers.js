import { createClient } from '@supabase/supabase-js'
import { TECH_KEYWORDS, toEn, categoryOf } from '../lib/keywords.js'
import { shouldInclude, trustScore } from '../lib/trust.js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

// ── arXiv (글로벌, 무료) ──
async function fetchArxiv(keyword, enKeyword) {
  const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(enKeyword)}&sortBy=submittedDate&sortOrder=descending&max_results=15`
  try {
    const res = await fetch(url)
    if (!res.ok) return []
    const text = await res.text()
    const entries = []
    const re = /<entry>([\s\S]*?)<\/entry>/g
    let m
    while ((m = re.exec(text)) !== null) {
      const e = m[1]
      const title     = e.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.replace(/\s+/g,' ').trim()
      const summary   = e.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.replace(/\s+/g,' ').trim()
      const link      = e.match(/<id>([\s\S]*?)<\/id>/)?.[1]?.trim()
      const published = e.match(/<published>([\s\S]*?)<\/published>/)?.[1]?.trim()
      // 저널 정보 추출
      const journal   = e.match(/<arxiv:journal_ref[^>]*>([\s\S]*?)<\/arxiv:journal_ref>/)?.[1]?.trim() || 'arXiv'

      if (!title || !link) continue

      const { include, score } = shouldInclude(title, summary, 'arXiv', 'paper', keyword)
      if (!include) continue

      // 저널명으로 신뢰도 재계산
      const sourceName = journal.includes('Nature') ? 'Nature'
        : journal.includes('Science') ? 'Science'
        : journal.includes('IEEE') ? 'IEEE'
        : journal.includes('ACM') ? 'ACM'
        : 'arXiv'

      entries.push({
        title, summary: summary?.slice(0, 400),
        source_url: link, source_name: sourceName,
        published_at: published,
        country: 'global',
        relevance_score: score,
        trust_score: trustScore(sourceName, 'paper')
      })
    }
    return entries
  } catch (e) { console.error('arXiv 오류:', e.message); return [] }
}

// ── OpenAlex (글로벌, 무료) ──
async function fetchOpenAlex(keyword, enKeyword) {
  const url = `https://api.openalex.org/works?search=${encodeURIComponent(enKeyword)}&sort=publication_date:desc&per-page=15&filter=publication_year:2023-2026&mailto=atlas@example.com`
  try {
    const res = await fetch(url)
    if (!res.ok) return []
    const data = await res.json()
    const results = []
    for (const w of data.results || []) {
      const title   = w.title || ''
      const summary = w.abstract?.slice(0, 400) || ''
      const source  = w.primary_location?.source?.display_name || 'OpenAlex'

      const { include, score } = shouldInclude(title, summary, source, 'paper', keyword)
      if (!include) continue

      results.push({
        title,
        summary: summary || null,
        source_url:   w.doi ? `https://doi.org/${w.doi}` : w.id,
        source_name:  source,
        published_at: w.publication_date,
        country:      w.authorships?.[0]?.institutions?.[0]?.country_code || 'global',
        relevance_score: score,
        trust_score:  trustScore(source, 'paper')
      })
    }
    return results
  } catch (e) { console.error('OpenAlex 오류:', e.message); return [] }
}

// ── RISS 한국 논문 ──
async function fetchRISS(keyword) {
  if (!process.env.RISS_KEY) { console.warn('RISS_KEY 미설정'); return [] }
  const url = `https://openapi.riss.kr/openapi/search/search?serviceKey=${process.env.RISS_KEY}&query=${encodeURIComponent(keyword)}&display=15&start=1&output=xml`
  try {
    const res = await fetch(url)
    if (!res.ok) return []
    const text = await res.text()
    const items = []
    const re = /<item>([\s\S]*?)<\/item>/g
    let m
    while ((m = re.exec(text)) !== null) {
      const item    = m[1]
      const title   = item.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.replace(/<!\[CDATA\[(.*?)\]\]>/g,'$1').trim()
      const link    = item.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim()
      const desc    = item.match(/<description>([\s\S]*?)<\/description>/)?.[1]?.replace(/<!\[CDATA\[(.*?)\]\]>/g,'$1').trim()
      const pubDate = item.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1]?.trim()
      if (!title || !link) continue

      const { include, score } = shouldInclude(title, desc, 'RISS', 'paper', keyword)
      if (!include) continue

      items.push({
        title, summary: desc?.slice(0, 400) || null,
        source_url: link, source_name: 'RISS',
        published_at: pubDate || new Date().toISOString(),
        country: 'KR',
        relevance_score: score,
        trust_score: trustScore('RISS', 'paper')
      })
    }
    return items
  } catch (e) { console.error('RISS 오류:', e.message); return [] }
}

async function upsertTrend(kw) {
  const { data, error } = await supabase
    .from('trends')
    .upsert({ keyword: kw.ko, category: categoryOf(kw.ko), updated_at: new Date().toISOString() }, { onConflict: 'keyword' })
    .select()
  if (error) throw error
  return data[0]
}

function regionOf(c) {
  const map = { KR:'Asia', JP:'Asia', CN:'Asia', US:'Americas', CA:'Americas', GB:'Europe', DE:'Europe', FR:'Europe' }
  return map[c] || 'Global'
}

async function saveEvidence(trendId, items, sourceName) {
  if (!items.length) return 0
  const rows = items.filter(i => i.source_url).map(i => ({
    trend_id: trendId, type: 'paper',
    title: i.title, summary: i.summary,
    source_url: i.source_url, source_name: i.source_name || sourceName,
    country: i.country || 'global', region: regionOf(i.country),
    language: i.country === 'KR' ? 'ko' : 'en',
    published_at: i.published_at || new Date().toISOString(),
    relevance_score: i.relevance_score || 0.7,
    trust_score: i.trust_score || 0.7
  }))
  if (!rows.length) return 0
  const { data, error } = await supabase.from('evidence')
    .upsert(rows, { onConflict: 'trend_id,source_url', ignoreDuplicates: true }).select('id')
  if (error) { console.error('논문 저장 오류:', error.message); return 0 }
  return data?.length || 0
}

export default async function handler(req, res) {
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  const results = []
  try {
    for (const kw of TECH_KEYWORDS) {
      const trend = await upsertTrend(kw)
      const [riss, arxiv, alex] = await Promise.all([
        fetchRISS(kw.ko),
        fetchArxiv(kw.ko, kw.en),
        fetchOpenAlex(kw.ko, kw.en)
      ])
      const sR = await saveEvidence(trend.id, riss,  'RISS')
      const sA = await saveEvidence(trend.id, arxiv, 'arXiv')
      const sO = await saveEvidence(trend.id, alex,  'OpenAlex')
      const total = sR + sA + sO
      const filtered = riss.length + arxiv.length + alex.length
      console.log(`[${kw.ko}] 논문 ${total}건 저장 (필터링 후)`)
      results.push({ keyword: kw.ko, RISS: sR, arXiv: sA, OpenAlex: sO, total })
      await new Promise(r => setTimeout(r, 500))
    }
    res.status(200).json({ ok: true, message: `논문 수집 완료`, details: results })
  } catch (e) {
    console.error('논문 수집 오류:', e)
    res.status(500).json({ error: e.message })
  }
}
