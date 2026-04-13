import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const TECH_KEYWORDS = [
  'quantum computing', 'artificial intelligence', 'semiconductor',
  'biotechnology', 'renewable energy', 'robotics'
]

// ★ KIPRIS용 한국어 키워드 매핑
const KR_KEYWORD_MAP = {
  'quantum computing': '양자컴퓨팅',
  'artificial intelligence': '인공지능',
  'semiconductor': '반도체',
  'biotechnology': '바이오',
  'renewable energy': '신재생에너지',
  'robotics': '로봇'
}

function regionOf(country) {
  const map = { KR: 'Asia', JP: 'Asia', US: 'Americas', EU: 'Europe' }
  return map[country] || 'Global'
}

// ── USPTO (PatentsView API) ──
async function fetchUSPTO(keyword) {
  const url = `https://api.patentsview.org/patents/query?q={"_text_any":{"patent_abstract":"${keyword}"}}&f=["patent_title","patent_abstract","patent_date","patent_number"]&o={"per_page":10,"sort":[{"patent_date":"desc"}]}`
  try {
    const res = await fetch(url)
    if (!res.ok) { console.error(`USPTO HTTP ${res.status}`); return [] }
    const data = await res.json()
    return (data.patents || []).map(p => ({
      title: p.patent_title || '(Untitled)',
      summary: p.patent_abstract?.slice(0, 300) || null,
      source_url: p.patent_number
        ? `https://patents.google.com/patent/US${p.patent_number}`
        : `https://patents.google.com/?q=${encodeURIComponent(keyword)}`,
      published_at: p.patent_date,
      country: 'US'
    }))
  } catch (e) {
    console.error('USPTO error:', e.message)
    return []
  }
}

// ── EPO (Open Patent Services) ──
// ★ 수정: 실제 응답 구조에 맞게 파싱
async function fetchEPO(keyword) {
  if (!process.env.EPO_TOKEN) {
    console.warn('EPO_TOKEN 미설정 — EPO 수집 건너뜀')
    return []
  }

  try {
    const res = await fetch(
      `https://ops.epo.org/3.2/rest-services/published-data/search?q=txt%3D%22${encodeURIComponent(keyword)}%22&Range=1-10`,
      {
        headers: {
          'Authorization': `Bearer ${process.env.EPO_TOKEN}`,
          'Accept': 'application/json'
        }
      }
    )

    if (!res.ok) {
      console.error(`EPO HTTP ${res.status}`)
      return []
    }

    const data = await res.json()
    const searchResult = data?.['ops:world-patent-data']?.['ops:biblio-search']?.['ops:search-result']
    const pubRefs = searchResult?.['exchange-documents'] || searchResult?.['ops:publication-reference'] || []
    const docs = Array.isArray(pubRefs) ? pubRefs : [pubRefs]

    return docs.slice(0, 10).map(doc => {
      // 실제 EPO 응답에서 제목과 번호 추출 시도
      const biblio = doc?.['exchange-document']?.['bibliographic-data'] || {}
      const titleNode = biblio?.['invention-title']
      let title = keyword + ' — EPO Patent'

      if (titleNode) {
        if (Array.isArray(titleNode)) {
          const enTitle = titleNode.find(t => t?.['@lang'] === 'en')
          title = enTitle?.['$'] || titleNode[0]?.['$'] || title
        } else if (typeof titleNode === 'object') {
          title = titleNode['$'] || title
        }
      }

      const docId = doc?.['exchange-document']?.['@doc-number'] || ''
      const country = doc?.['exchange-document']?.['@country'] || 'EU'

      return {
        title,
        summary: null,
        source_url: docId
          ? `https://worldwide.espacenet.com/patent/search?q=${docId}`
          : `https://worldwide.espacenet.com/patent/search?q=${encodeURIComponent(keyword)}`,
        published_at: new Date().toISOString(),
        country: 'EU'
      }
    })
  } catch (e) {
    console.error('EPO error:', e.message)
    return []
  }
}

// ── KIPRIS (한국 특허) ──
// ★ 수정: 한국어 키워드로 검색
async function fetchKIPRIS(keyword) {
  if (!process.env.KIPRIS_KEY) {
    console.warn('KIPRIS_KEY 미설정 — KIPRIS 수집 건너뜀')
    return []
  }

  const krKeyword = KR_KEYWORD_MAP[keyword] || keyword
  const url = `http://plus.kipris.or.kr/openapi/rest/patUtiModInfoSearchSevice/patentUtilityInfo?ServiceKey=${process.env.KIPRIS_KEY}&word=${encodeURIComponent(krKeyword)}&numOfRows=10&pageNo=1`

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
        items.push({
          title,
          summary: null,
          source_url: appNo
            ? `https://doi.kipris.or.kr/infoDS?appl_no=${appNo}`
            : `https://www.kipris.or.kr`,
          published_at: appDate || new Date().toISOString(),
          country: 'KR'
        })
      }
    }
    return items
  } catch (e) {
    console.error('KIPRIS error:', e.message)
    return []
  }
}

async function getTrendId(keyword) {
  const { data } = await supabase
    .from('trends')
    .select('id')
    .eq('keyword', keyword)
    .single()
  return data?.id
}

// ★ 중복 방지: upsert + ignoreDuplicates
async function saveEvidence(trendId, items, sourceName) {
  if (!items.length) return 0

  const rows = items
    .filter(item => item.source_url)
    .map(item => ({
      trend_id: trendId,
      type: 'patent',
      title: item.title,
      summary: item.summary,
      source_url: item.source_url,
      source_name: sourceName,
      country: item.country,
      region: regionOf(item.country),
      published_at: item.published_at || new Date().toISOString(),
      relevance_score: 0.85
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
    console.error('patent evidence error:', error.message)
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
    for (const keyword of TECH_KEYWORDS) {
      const trendId = await getTrendId(keyword)
      if (!trendId) {
        console.warn(`트렌드 없음: ${keyword}`)
        continue
      }

      const [us, ep, kr] = await Promise.all([
        fetchUSPTO(keyword),
        fetchEPO(keyword),
        fetchKIPRIS(keyword)
      ])

      const sUS = await saveEvidence(trendId, us, 'USPTO')
      const sEP = await saveEvidence(trendId, ep, 'EPO')
      const sKR = await saveEvidence(trendId, kr, 'KIPRIS')

      results.push({ keyword, USPTO: sUS, EPO: sEP, KIPRIS: sKR })
      await new Promise(r => setTimeout(r, 1500))
    }

    res.status(200).json({
      ok: true,
      message: '특허 수집 완료 (US+EU+KR)',
      details: results
    })
  } catch (e) {
    console.error('patents handler error:', e)
    res.status(500).json({ error: e.message })
  }
}
