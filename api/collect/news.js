import { createClient } from '@supabase/supabase-js'
import { TECH_KEYWORDS, toEn } from '../lib/keywords.js'
import { shouldInclude, trustScore } from '../lib/trust.js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

// ── 네이버 뉴스 (신뢰도 필터링 포함) ──
async function fetchNaverNews(keyword) {
  if (!process.env.NAVER_CLIENT_ID || !process.env.NAVER_CLIENT_SECRET) return []
  const url = `https://openapi.naver.com/v1/search/news.json?query=${encodeURIComponent(keyword)}&display=30&sort=date`
  try {
    const res = await fetch(url, {
      headers: {
        'X-Naver-Client-Id':     process.env.NAVER_CLIENT_ID,
        'X-Naver-Client-Secret': process.env.NAVER_CLIENT_SECRET
      }
    })
    if (!res.ok) return []
    const data = await res.json()
    const results = []
    for (const item of data.items || []) {
      const title   = item.title.replace(/<\/?b>/g,'').replace(/&quot;/g,'"').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
      const summary = item.description.replace(/<\/?b>/g,'').replace(/&quot;/g,'"').replace(/&amp;/g,'&')
      const source  = item.originallink ? new URL(item.originallink).hostname.replace('www.','') : '네이버 뉴스'

      const { include, score } = shouldInclude(title, summary, source, 'news', keyword)
      if (!include) continue

      results.push({
        title, summary: summary.slice(0,300),
        source_url:   item.originallink || item.link,
        source_name:  source,
        published_at: new Date(item.pubDate).toISOString(),
        country: 'KR',
        relevance_score: score,
        trust_score: trustScore(source, 'news')
      })
    }
    return results.slice(0, 15)
  } catch (e) { console.error('네이버 뉴스 오류:', e.message); return [] }
}

// ── 네이버 데이터랩 검색량 트렌드 ──
async function fetchNaverDataLab(keyword) {
  if (!process.env.NAVER_CLIENT_ID || !process.env.NAVER_CLIENT_SECRET) return null
  const today = new Date()
  const startDate = new Date(today); startDate.setDate(today.getDate() - 30)
  const fmt = d => d.toISOString().slice(0,10)

  try {
    const res = await fetch('https://openapi.naver.com/v1/datalab/search', {
      method: 'POST',
      headers: {
        'X-Naver-Client-Id':     process.env.NAVER_CLIENT_ID,
        'X-Naver-Client-Secret': process.env.NAVER_CLIENT_SECRET,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        startDate: fmt(startDate),
        endDate:   fmt(today),
        timeUnit:  'week',
        keywordGroups: [{
          groupName: keyword,
          keywords:  [keyword]
        }]
      })
    })
    if (!res.ok) return null
    const data = await res.json()
    const results = data.results?.[0]?.data || []
    if (!results.length) return null

    // 최근 2주 평균 vs 이전 2주 평균으로 변화율 계산
    const recent = results.slice(-2).map(d => d.ratio)
    const prev   = results.slice(-4, -2).map(d => d.ratio)
    const recentAvg = recent.reduce((a,b) => a+b, 0) / Math.max(recent.length, 1)
    const prevAvg   = prev.reduce((a,b) => a+b, 0)   / Math.max(prev.length, 1)
    const changeRate = prevAvg > 0 ? Math.round(((recentAvg - prevAvg) / prevAvg) * 100) : 0

    return {
      keyword,
      current_index: Math.round(recentAvg),   // 현재 검색 지수 (0~100)
      change_rate:   changeRate,               // 전주 대비 변화율 (%)
      weekly_data:   results.slice(-8)         // 최근 8주 데이터
    }
  } catch (e) { console.error('데이터랩 오류:', e.message); return null }
}

// ── Google News RSS (글로벌) ──
async function fetchGoogleNews(keyword, enKeyword) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(enKeyword + ' technology')}&hl=en&gl=US&ceid=US:en`
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
      const pubDate = item.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1]?.trim()
      const source  = item.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1]?.trim() || 'Google News'
      if (!title || !link) continue

      const { include, score } = shouldInclude(title, '', source, 'news', keyword)
      if (!include) continue

      items.push({
        title, summary: null,
        source_url:   link, source_name: source,
        published_at: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
        country: 'US',
        relevance_score: score,
        trust_score: trustScore(source, 'news')
      })
    }
    return items.slice(0, 10)
  } catch (e) { console.error('Google News 오류:', e.message); return [] }
}

async function getTrendId(keyword) {
  const { data } = await supabase.from('trends').select('id').eq('keyword', keyword).single()
  return data?.id
}

async function saveEvidence(trendId, items) {
  if (!items.length) return 0
  const rows = items.filter(i => i.source_url).map(i => ({
    trend_id: trendId, type: 'news',
    title: i.title, summary: i.summary,
    source_url: i.source_url, source_name: i.source_name,
    country: i.country || 'KR',
    region: i.country === 'US' ? 'Americas' : 'Asia',
    language: i.country === 'KR' ? 'ko' : 'en',
    published_at: i.published_at || new Date().toISOString(),
    relevance_score: i.relevance_score || 0.6,
    trust_score: i.trust_score || 0.6
  }))
  if (!rows.length) return 0
  const { data, error } = await supabase.from('evidence')
    .upsert(rows, { onConflict: 'trend_id,source_url', ignoreDuplicates: true }).select('id')
  if (error) { console.error('뉴스 저장 오류:', error.message); return 0 }
  return data?.length || 0
}

// ── 검색량 트렌드 저장 (trends 테이블에 search_trend 컬럼) ──
async function saveSearchTrend(trendId, datalabData) {
  if (!datalabData) return
  await supabase.from('trends').update({
    search_index:      datalabData.current_index,
    search_change:     datalabData.change_rate,
    search_weekly:     JSON.stringify(datalabData.weekly_data)
  }).eq('id', trendId)
}

export default async function handler(req, res) {
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  const results = []
  try {
    for (const kw of TECH_KEYWORDS) {
      const trendId = await getTrendId(kw.ko)
      if (!trendId) { console.warn(`[${kw.ko}] trend 없음`); continue }

      // 뉴스 수집 + 검색량 동시
      const [naverNews, googleNews, datalabData] = await Promise.all([
        fetchNaverNews(kw.ko),
        fetchGoogleNews(kw.ko, kw.en),
        fetchNaverDataLab(kw.ko)
      ])

      const sN = await saveEvidence(trendId, naverNews)
      const sG = await saveEvidence(trendId, googleNews)
      await saveSearchTrend(trendId, datalabData)

      results.push({
        keyword:      kw.ko,
        naver:        sN,
        google:       sG,
        search_index: datalabData?.current_index || null,
        search_change: datalabData?.change_rate || null
      })
      await new Promise(r => setTimeout(r, 500))
    }
    res.status(200).json({ ok: true, message: `뉴스+검색량 수집 완료`, details: results })
  } catch (e) {
    console.error('뉴스 수집 오류:', e)
    res.status(500).json({ error: e.message })
  }
}
