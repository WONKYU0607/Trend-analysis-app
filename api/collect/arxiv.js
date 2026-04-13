import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const TECH_KEYWORDS = [
  'quantum computing', 'artificial intelligence', 'semiconductor',
  'biotechnology', 'renewable energy', 'robotics', 'blockchain',
  'nuclear fusion', 'space technology', 'autonomous vehicle'
]

async function fetchArxiv(keyword) {
  const q = encodeURIComponent(keyword)
  const url = `https://export.arxiv.org/api/query?search_query=all:${q}&sortBy=submittedDate&sortOrder=descending&max_results=10`
  const res = await fetch(url)
  const text = await res.text()
  const entries = []
  const re = /<entry>([\s\S]*?)<\/entry>/g
  let m
  while ((m = re.exec(text)) !== null) {
    const e = m[1]
    const title = e.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim()
    const summary = e.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim()
    const link = e.match(/<id>([\s\S]*?)<\/id>/)?.[1]?.trim()
    const published = e.match(/<published>([\s\S]*?)<\/published>/)?.[1]?.trim()
    if (title && link) entries.push({ title, summary: summary?.slice(0, 300), source_url: link, published_at: published, country: 'global' })
  }
  return entries
}

async function fetchOpenAlex(keyword) {
  const url = `https://api.openalex.org/works?search=${encodeURIComponent(keyword)}&sort=publication_date:desc&per-page=10&mailto=techtrend@example.com`
  const res = await fetch(url)
  const data = await res.json()
  return (data.results || []).map(w => ({
    title: w.title,
    summary: w.abstract?.slice(0, 300),
    source_url: w.doi ? `https://doi.org/${w.doi}` : w.id,
    published_at: w.publication_date,
    country: w.institutions?.[0]?.country_code || 'global'
  }))
}

async function upsertTrend(keyword) {
  const { data, error } = await supabase
    .from('trends')
    .upsert({ keyword, category: 'technology', updated_at: new Date().toISOString() }, { onConflict: 'keyword' })
    .select()
  if (error) throw error
  return data[0]
}

async function saveEvidence(trendId, items, sourceName) {
  if (!items.length) return
  const rows = items.map(item => ({
    trend_id: trendId,
    type: 'paper',
    title: item.title,
    summary: item.summary,
    source_url: item.source_url,
    source_name: sourceName,
    country: item.country || 'global',
    region: item.country === 'KR' ? 'Asia' : item.country === 'US' ? 'Americas' : 'Global',
    published_at: item.published_at || new Date().toISOString(),
    relevance_score: 0.8
  }))
  const { error } = await supabase.from('evidence').insert(rows)
  if (error) console.error('evidence insert error:', error)
}

export default async function handler(req, res) {
  // 보안: cron secret 확인
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  try {
    for (const keyword of TECH_KEYWORDS) {
      const trend = await upsertTrend(keyword)
      const [arxivPapers, alexPapers] = await Promise.all([
        fetchArxiv(keyword),
        fetchOpenAlex(keyword)
      ])
      await saveEvidence(trend.id, arxivPapers, 'arXiv')
      await saveEvidence(trend.id, alexPapers, 'OpenAlex')
      await new Promise(r => setTimeout(r, 1000))
    }
    res.status(200).json({ ok: true, message: `논문 수집 완료 - ${TECH_KEYWORDS.length}개 키워드` })
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: e.message })
  }
}
