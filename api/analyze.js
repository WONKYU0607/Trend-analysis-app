import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

// 타입별 가중치 (법안/정책이 가장 강한 신호)
const WEIGHTS = { law: 0.30, patent: 0.25, paper: 0.25, policy: 0.10, news: 0.10 }

// ★ 필터링 API 호출 추가로 BATCH_SIZE 축소 (Vercel 60초 제한)
const BATCH_SIZE = 3

// ============================================
// ★ 1단계 핵심: AI 관련성 필터링
// ============================================
async function filterByRelevance(keyword, evidenceList) {
  if (!process.env.GEMINI_API_KEY || !evidenceList.length) {
    return evidenceList // API 키 없으면 필터링 건너뜀
  }

  // evidence 목록을 번호 매긴 리스트로 변환
  const itemList = evidenceList.map((e, i) => {
    const title = (e.title || '').slice(0, 120)
    const summary = (e.summary || '').slice(0, 150)
    return `${i + 1}. [${e.type}] ${title}${summary ? ' — ' + summary : ''}`
  }).join('\n')

  const prompt = `당신은 기술 트렌드 데이터 품질 관리 전문가입니다.
아래는 "${keyword}" 키워드로 수집된 근거 자료 목록입니다.
각 항목이 "${keyword}" 기술/산업과 **직접적으로 관련이 있는지** 판단해주세요.

판단 기준:
- ✅ 관련 있음: 해당 기술의 개발, 응용, 시장, 투자, 규제, 정책을 직접 다루는 자료
- ❌ 관련 없음: 키워드가 우연히 포함된 것, 다른 분야의 자료, 너무 일반적인 내용

${itemList}

반드시 아래 JSON 형식으로만 응답하세요 (마크다운 코드블록 없이 순수 JSON):
{"relevant": [관련 있는 항목 번호들], "irrelevant": [관련 없는 항목 번호들]}

예시: {"relevant": [1, 3, 5, 7], "irrelevant": [2, 4, 6]}`

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 500 }
        })
      }
    )

    if (!res.ok) {
      console.error(`필터링 Gemini HTTP ${res.status}`)
      return evidenceList // 실패 시 전체 유지
    }

    const data = await res.json()
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}'
    const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim()
    const result = JSON.parse(cleaned)

    const relevantSet = new Set((result.relevant || []).map(n => n - 1)) // 0-indexed
    const irrelevantSet = new Set((result.irrelevant || []).map(n => n - 1))

    // ★ DB에 관련성 점수 업데이트
    const updatePromises = []
    for (let i = 0; i < evidenceList.length; i++) {
      const e = evidenceList[i]
      if (irrelevantSet.has(i)) {
        // 관련 없는 것: relevance_score를 0으로
        updatePromises.push(
          supabase.from('evidence').update({ relevance_score: 0 }).eq('id', e.id)
        )
      } else if (relevantSet.has(i)) {
        // 관련 있는 것: relevance_score를 높게 유지/업데이트
        const newScore = Math.max(e.relevance_score || 0, 0.8)
        updatePromises.push(
          supabase.from('evidence').update({ relevance_score: newScore }).eq('id', e.id)
        )
      }
    }
    await Promise.all(updatePromises)

    // 관련 있는 것만 반환
    const filtered = evidenceList.filter((_, i) => relevantSet.has(i))

    const removedCount = evidenceList.length - filtered.length
    console.log(`[${keyword}] 필터링: ${evidenceList.length}건 → ${filtered.length}건 (${removedCount}건 제거)`)

    // 필터링 후 아무것도 안 남으면 최소 상위 5개는 유지
    if (filtered.length === 0 && evidenceList.length > 0) {
      console.warn(`[${keyword}] 필터링 결과 0건 — 상위 5건 유지`)
      return evidenceList.slice(0, 5)
    }

    return filtered
  } catch (e) {
    console.error(`[${keyword}] 필터링 오류:`, e.message)
    return evidenceList // 오류 시 전체 유지
  }
}

function calcTrendScore(evidenceList) {
  const count = { paper: 0, patent: 0, law: 0, policy: 0, news: 0 }
  for (const e of evidenceList) {
    if (count[e.type] !== undefined) count[e.type]++
  }

  // 다국가 교차 신호 보너스
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
// ★ 2단계: 카테고리별 핵심 요약 리포트 생성
// ============================================
const EMPTY_REPORT = {
  headline: '',
  summary: '',
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

async function generateReport(keyword, evidenceList, score) {
  if (!process.env.GEMINI_API_KEY) {
    console.warn('GEMINI_API_KEY 미설정 — AI 분석 건너뜀')
    return { ...EMPTY_REPORT, summary: '분석 대기 중 (API 키 미설정)' }
  }

  // 타입별로 정리 (각 카테고리 최대 8건씩)
  const byType = {}
  for (const e of evidenceList) {
    if (!byType[e.type]) byType[e.type] = []
    if (byType[e.type].length < 8) {
      byType[e.type].push(`[${e.country || 'global'}] ${e.title}${e.summary ? ' — ' + e.summary.slice(0, 200) : ''}`)
    }
  }

  const dataBlock = Object.entries(byType).map(([type, items]) =>
    `[${type.toUpperCase()}]\n${items.join('\n')}`
  ).join('\n\n')

  // 각 카테고리에 데이터가 있는지 확인
  const hasNews = (byType.news?.length || 0) > 0
  const hasPaper = (byType.paper?.length || 0) > 0
  const hasLaw = (byType.law?.length || 0) > 0 || (byType.policy?.length || 0) > 0
  const hasPatent = (byType.patent?.length || 0) > 0

  const prompt = `당신은 글로벌 기술 트렌드 전문 분석가입니다.
아래 수집 데이터를 종합해서 "${keyword}" 기술의 **원페이지 대시보드용 분석 리포트**를 작성하세요.
트렌드 점수: ${score}/100
일반인도 쉽게 이해할 수 있는 한국어로, 구체적이고 간결하게 작성하세요.
related_companies에는 이 기술을 영위하거나 진출하려는 주요 기업 5~8개를 포함하세요.
한국 상장사(코스피/코스닥)를 우선 포함하고, 글로벌 빅테크와 유망 스타트업도 섞어주세요.

${dataBlock}

반드시 아래 JSON 형식으로만 응답하세요 (마크다운 코드블록 없이 순수 JSON):
{
  "headline": "${keyword} 기술 현황을 한 문장으로 (예: '글로벌 투자 급증, 한국은 규제 정비 단계')",
  "summary": "이번 주 핵심 동향 3줄 요약 (각 줄을 \\n으로 구분, 뉴스·논문·정책을 종합)",
  ${hasNews ? `"news_highlights": [
    {"title": "뉴스 핵심 1번 제목 (15자 이내)", "insight": "왜 중요한지 1줄 설명"},
    {"title": "뉴스 핵심 2번 제목", "insight": "왜 중요한지 1줄 설명"},
    {"title": "뉴스 핵심 3번 제목", "insight": "왜 중요한지 1줄 설명"}
  ],` : `"news_highlights": [],`}
  ${hasPaper ? `"paper_highlights": [
    {"title": "논문/연구 핵심 1번 (15자 이내)", "insight": "연구 의미 1줄 설명"},
    {"title": "논문/연구 핵심 2번", "insight": "연구 의미 1줄 설명"},
    {"title": "논문/연구 핵심 3번", "insight": "연구 의미 1줄 설명"}
  ],` : `"paper_highlights": [],`}
  ${hasLaw ? `"law_highlights": [
    {"title": "정책/법안 핵심 1번 (15자 이내)", "insight": "영향 1줄 설명", "country": "KR 또는 US 등"},
    {"title": "정책/법안 핵심 2번", "insight": "영향 1줄 설명", "country": "국가코드"},
    {"title": "정책/법안 핵심 3번", "insight": "영향 1줄 설명", "country": "국가코드"}
  ],` : `"law_highlights": [],`}
  ${hasPatent ? `"patent_highlights": [
    {"title": "특허 동향 핵심 1번 (15자 이내)", "insight": "의미 1줄 설명", "company": "출원 기업/기관"},
    {"title": "특허 동향 핵심 2번", "insight": "의미 1줄 설명", "company": "기업/기관"},
    {"title": "특허 동향 핵심 3번", "insight": "의미 1줄 설명", "company": "기업/기관"}
  ],` : `"patent_highlights": [],`}
  "prediction": "향후 1~3년 전망 (3~5문장, 구체적 수치나 시점 포함)",
  "sector": "관련 산업 분야",
  "time_horizon": "단기(1년) 또는 중기(3년) 또는 장기(5년+)",
  "key_signals": ["핵심 신호1", "핵심 신호2", "핵심 신호3"],
  "risk_factors": ["리스크1 (구체적으로)", "리스크2"],
  "countries_leading": ["주도국가1", "주도국가2"],
  "related_companies": [
    {"name": "기업명", "ticker": "종목코드 (상장사만, 없으면 빈 문자열)", "type": "대기업/중견기업/스타트업", "role": "이 기술에서 어떤 역할을 하는지 1줄", "country": "KR/US/등"},
    {"name": "기업명2", "ticker": "", "type": "스타트업", "role": "역할 1줄", "country": "KR"}
  ],
  "investment_tip": "투자자/사업자를 위한 핵심 조언 1~2문장"
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
            temperature: 0.7,
            maxOutputTokens: 2500  // ★ 기업 정보 포함 확장 구조
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

    // ★ 누락된 필드 기본값으로 보완
    return { ...EMPTY_REPORT, ...parsed }
  } catch (e) {
    console.error('AI report error:', e.message)
    return { ...EMPTY_REPORT, summary: `"${keyword}" 분석 중 오류 발생` }
  }
}

export default async function handler(req, res) {
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  try {
    // ★ updated_at이 가장 오래된 순서로 BATCH_SIZE개만 처리
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

      // ★ 1단계: AI 관련성 필터링 (쓰레기 데이터 제거)
      const filteredEvidence = await filterByRelevance(trend.keyword, evidenceList)

      // ★ 필터링된 데이터로 점수 계산
      const newScore = calcTrendScore(filteredEvidence)
      const confidence = getConfidence(newScore)

      // weekly_change 계산: 이전 점수와 비교
      const prevScore = trend.score || 0
      const weeklyChange = newScore - prevScore

      await supabase.from('trends').update({
        prev_score: prevScore,
        score: newScore,
        weekly_change: weeklyChange,
        confidence_level: confidence,
        updated_at: new Date().toISOString()
      }).eq('id', trend.id)

      // ★ 필터링된 데이터로 리포트 생성
      const report = await generateReport(trend.keyword, filteredEvidence, newScore)

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
        filtered: `${filteredEvidence.length}/${evidenceList.length}`  // ★ 필터링 결과 표시
      })

      analyzed++
      await new Promise(r => setTimeout(r, 2000))
    }

    res.status(200).json({
      ok: true,
      message: `${analyzed}/${trends.length}개 트렌드 분석 완료 (배치 ${BATCH_SIZE}, 관련성 필터링 적용)`,
      details: results
    })
  } catch (e) {
    console.error('analyze handler error:', e)
    res.status(500).json({ error: e.message })
  }
}
