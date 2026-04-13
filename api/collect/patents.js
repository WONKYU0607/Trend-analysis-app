import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const TECH_KEYWORDS = [
  'quantum computing', 'artificial intelligence', 'semiconductor',
  'biotechnology', 'renewable energy', 'robotics'
]

async function fetchUSPTO(keyword) {
  const url = `https://api.patentsview.org/patents/query?q={"_text_any":{"patent_abstract":"${keyword}"}}&f=["patent_title","patent_abstract","patent_date","patent_url"]&o={"per_page":10,"sort":[{"patent_date":"desc"}]}`
  try {
    const res = await fetch(url)
    const data = await res.json()
    return (data.patents || []).map(p => ({
      title: p.patent_title,
      summary: p.patent_abstract?.slice(0, 300),
      source_url: p.patent_url || `https://patents.google.com/?q=${encodeURIComponent(keyword)}`,
      published_at: p.patent_date,
      country: 'US'
    }))
  } catch (e) {
    console.error('USPTO error:', e.message)
    return []
  }
}

async function fetchEPO(keyword) {
  try {
    const res = await fetch(
      `https://ops.epo.org/3.2/rest-services/published-data/search?q=txt%3D"${encodeURIComponent(keyword)}"&Range=1-10`,
      { headers: { 'Authorization': `Bearer ${process.env.EPO_TOKEN}`, 'Accept': 'application/json' } }
    )
    if (!res.ok) return []
    const data = await res.json()
    const docs = data['ops:world-patent-data']?.['ops:biblio-search']?.['ops:search-result']?.['ops:publication-reference'] || []
    return docs.slice(0, 10).map(() => ({
      title: `${keyword} - EPO 특허`,
      summary: null,
      source_url: `https://www.epo.org/searching-for-patents.html?q=${encodeURIComponent(keyword)}`,
      published_at: new Date().toISOString(),
      country: 'EU'
    }))
  } catch (e) {
    console.error('EPO error:', e.message)
    return []
  }
}

async function fetchKIPRIS(keyword) {
  const url = `http://plus.kipris.or.kr/openapi/rest/patUtiModInfoSearchSevice/patentUtilityInfo?ServiceKey=${process.env.KIPRIS_KEY}&word=${encodeURIComponent(keyword)}&numOfRows=10&pageNo=1`
  try {
    const res = await fetch(url)
    const text = await res.text()
    const items = []
    const re = /<item>([\s\S]*?)<\/item>/g
    let m
    while ((m = re.exec(text)) !== null) {
      const item = m[1]
      const title = item.match(/<inventionTitle>([\s\S]*?)<\/inventionTitle>/)?.[1]
      const appNo = item.match(/<applicationNumber>([\s\S]*?)<\/applicationNumber>/)?.[1]
      const appDate = item.match(/<applicationDate>([\s\S]*?)<\/applicationDate>/)?.[1]
      if (title) items.push({
        title,
        summary: null,
        source_url: appNo ? `https://doi.kipris.or.kr/infoDS?appl_no=${appNo}` : 'https://www.kipris.or.kr',
        published_at: appDate,
        country: 'KR'
      })
    }
    return items
  } catch (e) {
    console.error('KIPRIS error:', e.message)
    return []
  }
}

async function getTrendId(keyword) {
  const { data } = await supabase.from('trends').select('id').eq('keyword', keyword).single()
  return data?.id
}

async function saveEvidence(trendId, items, sourceName) {
  if (!items.length) return
  const rows = items.map(item => ({
    trend_id: trendId,
    type: 'patent',
    title: item.title,
    summary: item.summary,
    source_url: item.source_url,
    source_name: sourceName,
    country: item.country,
    region: item.country === 'KR' ? 'Asia' : item.country === 'US' ? 'Americas' : 'Europe',
    published_at: item.published_at,
    relevance_score: 0.85
  }))
  const { error } = await supabase.from('evidence').insert(rows)
  if (error) console.error('patent evidence error:', error)
}

export default async function handler(req, res) {
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  try {
    for (const keyword of TECH_KEYWORDS) {
      const trendId = await getTrendId(keyword)
      if (!trendId) continue
      const [us, ep, kr] = await Promise.all([
        fetchUSPTO(keyword),
        fetchEPO(keyword),
        fetchKIPRIS(keyword)
      ])
      await saveEvidence(trendId, us, 'USPTO')
      await saveEvidence(trendId, ep, 'EPO')
      await saveEvidence(trendId, kr, 'KIPRIS')
      await new Promise(r => setTimeout(r, 1500))
    }
    res.status(200).json({ ok: true, message: '특허 수집 완료 (US+EU+KR)' })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
}
