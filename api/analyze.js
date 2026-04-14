import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

// 타입별 가중치 (법안/정책이 가장 강한 신호)
const WEIGHTS = { law: 0.30, patent: 0.25, paper: 0.25, policy: 0.10, news: 0.10 }

const BATCH_SIZE = 3

// ★ Gemini Rate Limit 대응: 호출 간 딜레이 (ms)
const API_DELAY = 6000

// 기본 리포트 구조 (fallback용)
const EMPTY_REPORT = {
  headline: '',
  summary: '',
  irrelevant_items: [],
  news_highlights: [],
  paper_highlights: [],
  law_highlights: [],
  patent_highlights: [],
  related_companies: [],
  prediction: '',
  sector: '',
  time_horizon: '중기(3년)',
  key_signals: [],
  risk_factors: [],
  countries_leading: [],
  investment_tip: ''
}

function calcTrendScore(evidenceList) {
  const count = { paper: 0, patent: 0, law: 0, policy: 0, news: 0 }
  for (const e of evidenceList) {
    if (count[e.type] !== undefined) count[e.type]++
  }
  const countries = new Set(evidenceList.map(e => e.country).filter(Boolean))
  const globalBonus = countries.size >= 3 ? 15 : countries.size >= 2 ? 8 : 0

  let raw = 0
  for (const [type, weight] of Object.entries(WEIGHTS)) {
    raw += Math.min(count[type] * 5, 25) * weight
  }
  return Math.min(Math.round(raw * 4 + globalBonus), 100)
}

function getConfidence(score) {
  if (score >= 70) return 'high'
  if (score >= 40) return 'medium'
  return 'low'
}

// ============================================
// ★ 핵심: 필터링 + 리포트를 단일 Gemini 호출로 통합
//    기존: 트렌드당 2회 호출 → 429 Rate Limit
//    수정: 트렌드당 1회 호출 → Rate Limit 해결
// ============================================
async function filterAndReport(keyword, evidenceList, score) {
  if (!process.env.GEMINI_API_KEY) {
    console.warn('GEMINI_API_KEY 미설정 — AI 분석 건너뜀')
    return {
      report: { ...EMPTY_REPORT, summary: '분석 대기 중 (API 키 미설정)' },
      filteredEvidence: evidenceList
    }
  }

  // evidence → 번호 리스트
  const itemList = evidenceList.map((e, i) => {
    const title = (e.title || '').slice(0, 120)
    const summary = (e.summary || '').slice(0, 150)
    return `${i + 1}. [${e.type}][${e.country || 'global'}] ${title}${summary ? ' — ' + summary : ''}`
  }).join('\n')

  // 카테고리별 데이터 존재 여부
  const byType = {}
  for (const e of evidenceList) {
    if (!byType[e.type]) byType[e.type] = []
    byType[e.type].push(e)
  }
  const hasNews = (byType.news?.length || 0) > 0
  const hasPaper = (byType.paper?.length || 0) > 0
  const hasLaw = (byType.law?.length || 0) > 0 || (byType.policy?.length || 0) > 0
  const hasPatent = (byType.patent?.length || 0) > 0

  const prompt = `당신은 글로벌 기술 트렌드 전문 분석가입니다.
아래는 "${keyword}" 키워드로 수집된 근거 자료 목록입니다.
트렌드 점수: ${score}/100

**2가지 작업을 한 번에 수행하세요:**

작업1) 관련성 필터링 — 각 항목이 "${keyword}" 기술과 직접 관련 있는지 판단
- 관련 없음: 키워드가 우연히 포함된 것, 다른 분야, 너무 일반적인 내용
- irrelevant_items에 관련 없는 항목 번호를 넣으세요

작업2) 관련 있는 자료만 기반으로 원페이지 대시보드용 분석 리포트 작성
- 일반인도 쉽게 이해할 수 있는 한국어로, 구체적이고 간결하게
- related_companies: 이 기술을 영위/진출하는 주요 기업 5~8개 (한국 상장사 우선 + 글로벌 빅테크 + 스타트업)

수집 데이터:
${itemList}

반드시 아래 JSON 형식으로만 응답하세요 (마크다운 코드블록 없이 순수 JSON):
{
  "irrelevant_items": [관련 없는 항목 번호들],
  "headline": "${keyword} 현황 한 문장",
  "summary": "이번 주 핵심 동향 3줄 요약 (각 줄을 \\n으로 구분)",
  ${hasNews ? `"news_highlights": [
    {"title": "뉴스 핵심 제목 15자 이내", "insight": "왜 중요한지 1줄"},
    {"title": "핵심 2", "insight": "1줄"},
    {"title": "핵심 3", "insight": "1줄"}
  ],` : `"news_highlights": [],`}
  ${hasPaper ? `"paper_highlights": [
    {"title": "논문 핵심 15자 이내", "insight": "연구 의미 1줄"},
    {"title": "핵심 2", "insight": "1줄"},
    {"title": "핵심 3", "insight": "1줄"}
  ],` : `"paper_highlights": [],`}
  ${hasLaw ? `"law_highlights": [
    {"title": "정책/법안 핵심 15자 이내", "insight": "영향 1줄", "country": "KR/US"},
    {"title": "핵심 2", "insight": "1줄", "country": "국가코드"},
    {"title": "핵심 3", "insight": "1줄", "country": "국가코드"}
  ],` : `"law_highlights": [],`}
  ${hasPatent ? `"patent_highlights": [
    {"title": "특허 핵심 15자 이내", "insight": "의미 1줄", "company": "출원 기업"},
    {"title": "핵심 2", "insight": "1줄", "company": "기업"},
    {"title": "핵심 3", "insight": "1줄", "company": "기업"}
  ],` : `"patent_highlights": [],`}
  "related_companies": [
    {"name": "기업명", "ticker": "종목코드(상장사만,없으면빈문자열)", "type": "대기업/스타트업", "role": "역할 1줄", "country": "KR"},
    {"name": "기업2", "ticker": "", "type": "스타트업", "role": "역할", "country": "US"}
  ],
  "prediction": "향후 1~3년 전망 3~5문장",
  "sector": "관련 산업 분야",
  "time_horizon": "단기(1년)/중기(3년)/장기(5년+)",
  "key_signals": ["핵심 신호1", "신호2", "신호3"],
  "risk_factors": ["리스크1 구체적", "리스크2"],
  "countries_leading": ["주도국가1", "주도국가2"],
  "investment_tip": "투자자/사업자 핵심 조언 1~2문장"
}`

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.5,
            maxOutputTokens: 3000
          }
        })
      }
    )

    if (!res.ok) {
      const errBody = await res.text()
      console.error(`Gemini API HTTP ${res.status}:`, errBody)
      throw new Error(`Gemini API ${res.status}`)
    }

    const data = await res.json()
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}'
    const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim()
    const parsed = JSON.parse(cleaned)
    const report = { ...EMPTY_REPORT, ...parsed }

    // ★ 필터링 결과 DB 반영
    const irrelevantSet = new Set((report.irrelevant_items || []).map(n => n - 1))
    const updatePromises = []
    for (let i = 0; i < evidenceList.length; i++) {
      const e = evidenceList[i]
      if (irrelevantSet.has(i)) {
        updatePromises.push(
          supabase.from('evidence').update({ relevance_score: 0 }).eq('id', e.id)
        )
      } else {
        const newScore = Math.max(e.relevance_score || 0, 0.8)
        updatePromises.push(
          supabase.from('evidence').update({ relevance_score: newScore }).eq('id', e.id)
        )
      }
    }
    await Promise.all(updatePromises)

    const filteredEvidence = evidenceList.filter((_, i) => !irrelevantSet.has(i))
    console.log(`[${keyword}] 필터링: ${evidenceList.length}건 → ${filteredEvidence.length}건 (${irrelevantSet.size}건 제거)`)

    if (filteredEvidence.length === 0 && evidenceList.length > 0) {
      console.warn(`[${keyword}] 필터링 결과 0건 — 전체 유지`)
      return { report, filteredEvidence: evidenceList }
    }

    return { report, filteredEvidence }
  } catch (e) {
    console.error(`[${keyword}] AI 분석 오류:`, e.message)
    return {
      report: { ...EMPTY_REPORT, summary: `"${keyword}" 분석 중 오류 발생` },
      filteredEvidence: evidenceList
    }
  }
}

export default async function handler(req, res) {
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  try {
    const { data: trends } = await supabase
      .from('trends')
      .select('id, keyword, score')
      .order('updated_at', { ascending: true })
      .limit(BATCH_SIZE)

    if (!trends?.length) {
      return res.status(200).json({ ok: true, message: '분석할 트렌드 없음' })
    }

    let analyzed = 0
    const results = []

    for (const trend of trends) {
      const { data: evidenceList } = await supabase
        .from('evidence')
        .select('*')
        .eq('trend_id', trend.id)
        .order('published_at', { ascending: false })
        .limit(30)

      if (!evidenceList?.length) continue

      // ★ 단일 Gemini 호출: 필터링 + 리포트 동시 처리
      const { report, filteredEvidence } = await filterAndReport(
        trend.keyword, evidenceList, trend.score || 0
      )

      const newScore = calcTrendScore(filteredEvidence)
      const confidence = getConfidence(newScore)
      const prevScore = trend.score || 0
      const weeklyChange = newScore - prevScore

      await supabase.from('trends').update({
        prev_score: prevScore,
        score: newScore,
        weekly_change: weeklyChange,
        confidence_level: confidence,
        updated_at: new Date().toISOString()
      }).eq('id', trend.id)

      await supabase.from('reports').upsert({
        trend_id: trend.id,
        summary: report.summary,
        prediction: report.prediction,
        sector: report.sector,
        time_horizon: report.time_horizon,
        evidence_summary: report,
        generated_at: new Date().toISOString()
      }, { onConflict: 'trend_id' })

      results.push({
        keyword: trend.keyword,
        score: newScore,
        change: weeklyChange,
        confidence,
        filtered: `${filteredEvidence.length}/${evidenceList.length}`
      })

      analyzed++

      // ★ Rate Limit 방지: 트렌드 간 6초 딜레이
      await new Promise(r => setTimeout(r, API_DELAY))
    }

    res.status(200).json({
      ok: true,
      message: `${analyzed}/${trends.length}개 트렌드 분석 완료 (배치 ${BATCH_SIZE})`,
      details: results
    })
  } catch (e) {
    console.error('analyze handler error:', e)
    res.status(500).json({ error: e.message })
  }
}
