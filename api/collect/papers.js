import { createClient } from '@supabase/supabase-js'
import { TECH_KEYWORDS, toEn, categoryOf } from '../lib/keywords.js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

// ── RISS 한국 논문 (키 불필요) ──
async function fetchRISS(keyword) {
  const url = `http://www.riss.kr/search/openapi/search.do?query=${encodeURIComponent(keyword)}&displayCount=10&startCount=0&collection=ALL&p_year1=2024&p_year2=2026&output=xml`
  try {
    const res = await fetch(url)
    if (!res.ok) { console.error(`RISS HTTP ${res.status}`); return [] }
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
      if (title && link) {
        items.push({
          title,
          summary: description?.slice(0, 300) || null,
          source_url: link,
          published_at: pubDate || new Date().toISOString(),
          country: 'KR'
        })
      }
    }
    return items
  } catch (e) {
    console.error('RISS 오류:', e.message)
    return []
  }
}

// ── arXiv (글로벌 논문, 키 불필요) ──
async function fetchArxiv(keyword) {
  const q = encodeURIComponent(keyword)
  const url = `https://export.arxiv.org/api/query?search_query=all:${q}&sortBy=submittedDate&sortOrder=descending&max_results=8`
  try {
    const res = await fetch(url)
    if (!res.ok) return []
    const text = await res.text()
    const entries = []
    const re = /<entry>([\s\S]*?)<\/entry>/g
    let m
    while ((m = re.exec(text)) !== null) {
      const e = m[1]
      const title = e.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.replace(/\s+/g, ' ').trim()
      const summary = e.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.replace(/\s+/g, ' ').trim()
      const link = e.match(/<id>([\s\S]*?)<\/id>/)?.[1]?.trim()
      const published = e.match(/<published>([\s\S]*?)<\/published>/)?.[1]?.trim()
      if (title && link) {
        entries.push({ title, summary: summary?.slice(0, 300), source_url: link, published_at: published, country: 'global' })
      }
    }
    return entries
  } catch (e) {
    console.error('arXiv 오류:', e.message)
    return []
  }
}

// ── OpenAlex (글로벌 논문, 키 불필요) ──
async function fetchOpenAlex(keyword) {
  const url = `https://api.openalex.org/works?search=${encodeURIComponent(keyword)}&sort=publication_date:desc&per-page=8&mailto=techtrend@example.com`
  try {
    const res = await fetch(url)
    if (!res.ok) return []
    const data = await res.json()
    return (data.results || []).map(w => ({
      title: w.title || '(제목 없음)',
      summary: w.abstract?.slice(0, 300) || null,
      source_url: w.doi ? `https://doi.org/${w.doi}` : w.id,
      published_at: w.publication_date,
      country: w.authorships?.[0]?.institutions?.[0]?.country_code || 'global'
    }))
  } catch (e) {
    console.error('OpenAlex 오류:', e.message)
    return []
  }
}

// ── 트렌드 upsert (한국어 키워드 메인) ──
async function upsertTrend(kw) {
  const { data, error } = await supabase
    .from('trends')
    .upsert(
      { keyword: kw.ko, category: categoryOf(kw.ko), updated_at: new Date().toISOString() },
      { onConflict: 'keyword' }
    )
    .select()
  if (error) throw error
  return data[0]
}

function regionOf(country) {
  const map = { KR: 'Asia', JP: 'Asia', CN: 'Asia', US: 'Americas', CA: 'Americas', GB: 'Europe', DE: 'Europe', FR: 'Europe' }
  return map[country] || 'Global'
}

async function saveEvidence(trendId, items, sourceName) {
  if (!items.length) return 0
  const rows = items
    .filter(item => item.source_url)
    .map(item => ({
      trend_id: trendId,
      type: 'paper',
      title: item.title,
      summary: item.summary,
      source_url: item.source_url,
      source_name: sourceName,
      country: item.country || 'global',
      region: regionOf(item.country),
      language: item.country === 'KR' ? 'ko' : 'en',
      published_at: item.published_at || new Date().toISOString(),
      relevance_score: 0.8
    }))

  if (!rows.length) return 0

  const { data, error } = await supabase
    .from('evidence')
    .upsert(rows, { onConflict: 'trend_id,source_url', ignoreDuplicates: true })
    .select('id')

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

      // 한국 논문 (RISS)
      const rissPapers = await fetchRISS(kw.ko)
      const savedRiss = await saveEvidence(trend.id, rissPapers, 'RISS')

      // 글로벌 논문 (arXiv + OpenAlex)
      const [arxivPapers, alexPapers] = await Promise.all([
        fetchArxiv(kw.en),
        fetchOpenAlex(kw.en)
      ])
      const savedArxiv = await saveEvidence(trend.id, arxivPapers, 'arXiv')
      const savedAlex = await saveEvidence(trend.id, alexPapers, 'OpenAlex')

      results.push({ keyword: kw.ko, RISS: savedRiss, arXiv: savedArxiv, OpenAlex: savedAlex })
      await new Promise(r => setTimeout(r, 800))
    }

    res.status(200).json({
      ok: true,
      message: `논문 수집 완료 — ${results.length}개 키워드 (RISS+arXiv+OpenAlex)`,
      details: results
    })
  } catch (e) {
    console.error('논문 수집 오류:', e)
    res.status(500).json({ error: e.message })
  }
}
