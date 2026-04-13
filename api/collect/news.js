import { createClient } from '@supabase/supabase-js'
import { TECH_KEYWORDS, toEn } from '../lib/keywords.js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

// ── 네이버 뉴스 검색 ──
async function fetchNaverNews(keyword) {
  if (!process.env.NAVER_CLIENT_ID || !process.env.NAVER_CLIENT_SECRET) {
    console.warn('네이버 API 키 미설정 — 뉴스 수집 건너뜀')
    return []
  }

  const url = `https://openapi.naver.com/v1/search/news.json?query=${encodeURIComponent(keyword + ' 기술')}&display=10&sort=date`
  try {
    const res = await fetch(url, {
      headers: {
        'X-Naver-Client-Id': process.env.NAVER_CLIENT_ID,
        'X-Naver-Client-Secret': process.env.NAVER_CLIENT_SECRET
      }
    })
    if (!res.ok) { console.error(`네이버 HTTP ${res.status}`); return [] }
    const data = await res.json()

    return (data.items || []).map(item => ({
      title: item.title.replace(/<\/?b>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&'),
      summary: item.description.replace(/<\/?b>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').slice(0, 300),
      source_url: item.originallink || item.link,
      source_name: '네이버 뉴스',
      published_at: new Date(item.pubDate).toISOString(),
      country: 'KR'
    }))
  } catch (e) {
    console.error('네이버 뉴스 오류:', e.message)
    return []
  }
}

// ── Google News RSS (글로벌 뉴스, 무료, 키 불필요) ──
async function fetchGoogleNews(keyword) {
  const enKeyword = toEn(keyword)
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(enKeyword + ' technology')}&hl=en&gl=US&ceid=US:en`
  try {
    const res = await fetch(url)
    if (!res.ok) { console.error(`Google News HTTP ${res.status}`); return [] }
    const text = await res.text()
    const items = []
    const re = /<item>([\s\S]*?)<\/item>/g
    let m
    while ((m = re.exec(text)) !== null) {
      const item = m[1]
      const title = item.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1').trim()
      const link = item.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim()
      const pubDate = item.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1]?.trim()
      const source = item.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1]?.trim()
      if (title && link) {
        items.push({
          title,
          summary: null,
          source_url: link,
          source_name: source || 'Google News',
          published_at: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
          country: 'US'
        })
      }
    }
    return items.slice(0, 8)
  } catch (e) {
    console.error('Google News 오류:', e.message)
    return []
  }
}

// ── DB 저장 ──
async function getTrendId(keyword) {
  const { data } = await supabase
    .from('trends')
    .select('id')
    .or(`keyword.eq.${keyword},keyword.ilike.%${keyword}%`)
    .limit(1)
  return data?.[0]?.id
}

async function saveEvidence(trendId, items, type = 'news') {
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
      region: item.country === 'US' ? 'Americas' : 'Asia',
      language: item.country === 'KR' ? 'ko' : 'en',
      published_at: item.published_at || new Date().toISOString(),
      relevance_score: 0.7
    }))

  if (!rows.length) return 0

  const { data, error } = await supabase
    .from('evidence')
    .upsert(rows, { onConflict: 'trend_id,source_url', ignoreDuplicates: true })
    .select('id')

  if (error) { console.error('뉴스 저장 오류:', error.message); return 0 }
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

      // 네이버 뉴스 (한국)
      const naverNews = await fetchNaverNews(kw.ko)
      const savedNaver = await saveEvidence(trendId, naverNews)

      // Google News (글로벌)
      const googleNews = await fetchGoogleNews(kw.ko)
      const savedGoogle = await saveEvidence(trendId, googleNews)

      results.push({ keyword: kw.ko, naver: savedNaver, google: savedGoogle })
      await new Promise(r => setTimeout(r, 500))
    }

    res.status(200).json({
      ok: true,
      message: `뉴스 수집 완료 — ${results.length}개 키워드`,
      details: results
    })
  } catch (e) {
    console.error('뉴스 수집 오류:', e)
    res.status(500).json({ error: e.message })
  }
}
