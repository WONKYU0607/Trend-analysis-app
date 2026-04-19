import { createClient } from '@supabase/supabase-js'
import { TECH_KEYWORDS, toEn } from '../lib/keywords.js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

// 뉴스 제목에서 관련 없는 것 걷어내는 1차 필터 (AI 전 단계)
function isRelevant(title, keyword) {
  const t = title.toLowerCase()
  const k = keyword.toLowerCase()
  // 키워드 또는 연관어 포함 여부
  if (t.includes(k)) return true
  // 영문 키워드도 체크
  const enMap = {
    '인공지능': ['ai', 'artificial intelligence', '머신러닝', '딥러닝'],
    '반도체': ['semiconductor', 'chip', '칩', 'hbm', '파운드리', 'tsmc'],
    '자율주행': ['autonomous', 'self-driving', '무인', 'lidar'],
    '신재생에너지': ['renewable', '태양광', '풍력', '에너지전환'],
    '2차전지': ['battery', '배터리', '전기차', 'ev', 'lifepo'],
    '생성형ai': ['generative', 'gpt', 'llm', 'chatgpt', 'claude', 'gemini'],
    '6g통신': ['6g', '통신망', '이동통신', 'itu'],
    '양자컴퓨팅': ['quantum', '양자', 'qubit'],
    '사이버보안': ['cyber', 'security', '보안', '해킹', 'ransomware'],
    '블록체인': ['blockchain', 'crypto', '암호화폐', 'web3', 'nft'],
    '로봇공학': ['robot', 'robotics', '로봇', '자동화', 'automation'],
    '바이오테크': ['biotech', 'mrna', '유전자', 'crispr', '신약'],
    '핵융합': ['fusion', '핵융합', 'iter', 'plasma'],
    '우주기술': ['space', '위성', 'rocket', '발사체', 'nasa', 'spacex'],
    '수소에너지': ['hydrogen', '수소', '연료전지'],
    '디지털트윈': ['digital twin', '디지털트윈', 'simulation'],
    '스마트팩토리': ['smart factory', '스마트팩토리', '공장자동화', 'iot'],
    '메타버스': ['metaverse', '메타버스', 'vr', 'ar', 'xr'],
    '클라우드컴퓨팅': ['cloud', '클라우드', 'aws', 'azure', 'gcp'],
    '드론': ['drone', '드론', 'uav', '무인기'],
  }
  const aliases = enMap[k] || []
  return aliases.some(a => t.includes(a))
}

async function fetchNaverNews(keyword) {
  if (!process.env.NAVER_CLIENT_ID || !process.env.NAVER_CLIENT_SECRET) {
    console.warn('네이버 API 키 미설정')
    return []
  }
  const url = `https://openapi.naver.com/v1/search/news.json?query=${encodeURIComponent(keyword + ' 기술')}&display=20&sort=date`
  try {
    const res = await fetch(url, {
      headers: {
        'X-Naver-Client-Id':     process.env.NAVER_CLIENT_ID,
        'X-Naver-Client-Secret': process.env.NAVER_CLIENT_SECRET
      }
    })
    if (!res.ok) { console.error(`네이버 HTTP ${res.status}`); return [] }
    const data = await res.json()
    return (data.items || [])
      .map(item => ({
        title:        item.title.replace(/<\/?b>/g,'').replace(/&quot;/g,'"').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>'),
        summary:      item.description.replace(/<\/?b>/g,'').replace(/&quot;/g,'"').replace(/&amp;/g,'&').slice(0,300),
        source_url:   item.originallink || item.link,
        source_name:  '네이버 뉴스',
        published_at: new Date(item.pubDate).toISOString(),
        country: 'KR'
      }))
      .filter(item => isRelevant(item.title, keyword))  // ★ 1차 필터
      .slice(0, 10)
  } catch (e) { console.error('네이버 뉴스 오류:', e.message); return [] }
}

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
      const title   = item.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.replace(/<!\[CDATA\[(.*?)\]\]>/g,'$1').trim()
      const link    = item.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim()
      const pubDate = item.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1]?.trim()
      const source  = item.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1]?.trim()
      if (title && link && isRelevant(title, keyword)) {  // ★ 1차 필터
        items.push({
          title, summary: null,
          source_url:   link,
          source_name:  source || 'Google News',
          published_at: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString(),
          country: 'US'
        })
      }
    }
    return items.slice(0, 8)
  } catch (e) { console.error('Google News 오류:', e.message); return [] }
}

// ★ getTrendId 버그 수정 (기존 .or() 문법 오류)
async function getTrendId(keyword) {
  const { data } = await supabase
    .from('trends').select('id').eq('keyword', keyword).single()
  return data?.id
}

async function saveEvidence(trendId, items) {
  if (!items.length) return 0
  const rows = items.filter(i => i.source_url).map(i => ({
    trend_id:     trendId,
    type:         'news',
    title:        i.title,
    summary:      i.summary,
    source_url:   i.source_url,
    source_name:  i.source_name,
    country:      i.country || 'KR',
    region:       i.country === 'US' ? 'Americas' : 'Asia',
    language:     i.country === 'KR' ? 'ko' : 'en',
    published_at: i.published_at || new Date().toISOString(),
    relevance_score: 0.7
  }))
  if (!rows.length) return 0
  const { data, error } = await supabase.from('evidence')
    .upsert(rows, { onConflict: 'trend_id,source_url', ignoreDuplicates: true }).select('id')
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
      if (!trendId) { console.warn(`[${kw.ko}] trend 없음`); continue }
      const naverNews  = await fetchNaverNews(kw.ko)
      const savedNaver = await saveEvidence(trendId, naverNews)
      const googleNews  = await fetchGoogleNews(kw.ko)
      const savedGoogle = await saveEvidence(trendId, googleNews)
      results.push({ keyword: kw.ko, naver: savedNaver, google: savedGoogle })
      await new Promise(r => setTimeout(r, 500))
    }
    res.status(200).json({ ok: true, message: `뉴스 수집 완료 — ${results.length}개 키워드`, details: results })
  } catch (e) {
    console.error('뉴스 수집 오류:', e)
    res.status(500).json({ error: e.message })
  }
}
