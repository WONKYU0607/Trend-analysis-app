import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const WEIGHTS = { law: 0.30, patent: 0.25, paper: 0.25, policy: 0.10, news: 0.10 }
const BATCH_SIZE = 3
const API_DELAY = 15000    // 15초 (429 rate limit 방지)
const RETRY_DELAY = 30000   // 429 시 재시도 대기
const MAX_RETRY = 2

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

// ★ 수정: 점수 차별화 — 타입 다양성 + 국가 다양성 + 최신성 반영
function calcTrendScore(evidenceList) {
  if (!evidenceList.length) return 0

  const count = { paper: 0, patent: 0, law: 0, policy: 0, news: 0 }
  for (const e of evidenceList) {
    if (count[e.type] !== undefined) count[e.type]++
  }

  // 타입별 점수 (30건 있어도 20점 이상은 못 받게 캡 조정)
  let typeScore = 0
  for (const [type, weight] of Object.entries(WEIGHTS)) {
    // 5건마다 1점, 최대 10점씩
    typeScore += Math.min(Math.floor(count[type] / 5), 10) * weight * 10
  }

  // 국가 다양성 보너스
  const countries = new Set(evidenceList.map(e => e.country).filter(Boolean))
  const globalBonus = countries.size >= 5 ? 20
    : countries.size >= 3 ? 12
    : countries.size >= 2 ? 6 : 0

  // 타입 다양성 보너스 (법안+논문+특허 다 있으면 +15)
  const typeCount = Object.values(count).filter(v => v > 0).length
  const diversityBonus = typeCount >= 4 ? 15 : typeCount >= 3 ? 8 : typeCount >= 2 ? 3 : 0

  // 최신성 보너스 (30일 이내 자료가 절반 이상이면 +10)
  const now = Date.now()
  const recentCount = evidenceList.filter(e => {
    if (!e.published_at) return false
    return (now - new Date(e.published_at).getTime()) < 30 * 24 * 60 * 60 * 1000
  }).length
  const recencyBonus = recentCount >= evidenceList.length * 0.5 ? 10 : 0

  return Math.min(Math.round(typeScore + globalBonus + diversityBonus + recencyBonus), 100)
}

function getConfidence(score) {
  if (score >= 70) return 'high'
  if (score >= 40) return 'medium'
  return 'low'
}

// ★ summary 필드 안전하게 추출
function extractSummary(parsed, keyword) {
  // Gemini가 summary를 다양한 키로 반환하는 경우 대응
  const raw =
    parsed.summary ||
    parsed.핵심요약 ||
    parsed.core_summary ||
    parsed.overview ||
    ''

  if (raw && raw.trim().length > 10) return raw.trim()

  // summary가 비었어도 highlights에서 조합
  const highlights = [
    ...(parsed.news_highlights   || []),
    ...(parsed.paper_highlights  || []),
    ...(parsed.law_highlights    || []),
    ...(parsed.patent_highlights || [])
  ]
  if (highlights.length >= 2) {
    return highlights.slice(0, 3).map(h => h.insight || h.title || '').filter(Boolean).join('\n')
  }

  return `${keyword} 관련 최신 동향을 분석 중입니다.`
}

async function filterAndReport(keyword, evidenceList, score) {
  if (!process.env.GEMINI_API_KEY) {
    console.warn('GEMINI_API_KEY 미설정 — AI 분석 건너뜀')
    return {
      report: { ...EMPTY_REPORT, summary: '분석 대기 중 (API 키 미설정)' },
      filteredEvidence: evidenceList
    }
  }

  const itemList = evidenceList.map((e, i) => {
    const title   = (e.title   || '').slice(0, 120)
    const summary = (e.summary || '').slice(0, 150)
    return `${i + 1}. [${e.type}][${e.country || 'global'}] ${title}${summary ? ' — ' + summary : ''}`
  }).join('\n')

  const byType = {}
  for (const e of evidenceList) {
    if (!byType[e.type]) byType[e.type] = []
    byType[e.type].push(e)
  }
  const hasNews   = (byType.news?.length   || 0) > 0
  const hasPaper  = (byType.paper?.length  || 0) > 0
  const hasLaw    = (byType.law?.length    || 0) > 0 || (byType.policy?.length || 0) > 0
  const hasPatent = (byType.patent?.length || 0) > 0

  const prompt = `당신은 글로벌 기술 트렌드 전문 분석가입니다.
아래는 "${keyword}" 키워드로 수집된 근거 자료 목록입니다.
트렌드 점수: ${score}/100

**2가지 작업을 한 번에 수행하세요:**

작업1) 관련성 필터링
- "${keyword}" 기술과 직접 관련 없는 항목 번호를 irrelevant_items에 넣으세요
- 관련 없음 기준: 키워드가 우연히 포함, 다른 분야, 너무 일반적

작업2) 관련 있는 자료만 기반으로 리포트 작성
- 반드시 한국어로, 구체적이고 간결하게
- summary 필드는 절대 비워두지 마세요. 최소 2문장 이상 작성하세요.
- related_companies: 5~8개 (한국 상장사 우선)

수집 데이터:
${itemList}

반드시 아래 JSON 형식으로만 응답 (마크다운 없이 순수 JSON):
{
  "irrelevant_items": [],
  "headline": "${keyword} 현황 핵심 한 문장",
  "summary": "이번 주 핵심 동향 2~3줄. 반드시 작성. (줄바꿈은 \\n 사용)",
  ${hasNews ? `"news_highlights": [{"title": "15자 이내", "insight": "왜 중요한지 1줄"},{"title": "핵심2", "insight": "1줄"},{"title": "핵심3", "insight": "1줄"}],` : '"news_highlights": [],'}
  ${hasPaper ? `"paper_highlights": [{"title": "15자 이내", "insight": "연구 의미 1줄"},{"title": "핵심2", "insight": "1줄"},{"title": "핵심3", "insight": "1줄"}],` : '"paper_highlights": [],'}
  ${hasLaw ? `"law_highlights": [{"title": "15자 이내", "insight": "영향 1줄", "country": "KR"},{"title": "핵심2", "insight": "1줄", "country": "KR"},{"title": "핵심3", "insight": "1줄", "country": "US"}],` : '"law_highlights": [],'}
  ${hasPatent ? `"patent_highlights": [{"title": "15자 이내", "insight": "의미 1줄", "company": "기업명"},{"title": "핵심2", "insight": "1줄", "company": "기업"},{"title": "핵심3", "insight": "1줄", "company": "기업"}],` : '"patent_highlights": [],'}
  "related_companies": [
    {"name": "기업명", "ticker": "종목코드또는빈문자열", "type": "대기업", "role": "역할 1줄", "country": "KR"}
  ],
  "prediction": "향후 1~3년 전망 3~5문장",
  "sector": "산업 분야",
  "time_horizon": "단기(1년)/중기(3년)/장기(5년+)",
  "key_signals": ["신호1", "신호2", "신호3"],
  "risk_factors": ["리스크1", "리스크2"],
  "countries_leading": ["국가1", "국가2"],
  "investment_tip": "핵심 조언 1~2문장"
}`

  // ★ 429 재시도 로직
  async function callGemini(prompt) {
    for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.4, maxOutputTokens: 3000 }
          })
        }
      )
      if (res.status === 429) {
        console.warn(`Gemini 429 Rate Limit — ${attempt + 1}/${MAX_RETRY + 1}회 시도, ${RETRY_DELAY/1000}초 대기...`)
        if (attempt < MAX_RETRY) await new Promise(r => setTimeout(r, RETRY_DELAY))
        continue
      }
      if (!res.ok) {
        const errBody = await res.text()
        console.error(`Gemini API HTTP ${res.status}:`, errBody)
        throw new Error(`Gemini API ${res.status}`)
      }
      return res
    }
    throw new Error('Gemini API 429 — 재시도 한도 초과')
  }

  try {
    const res = await callGemini(prompt)

    if (!res.ok) {
      const errBody = await res.text()
      console.error(`Gemini API HTTP ${res.status}:`, errBody)
      throw new Error(`Gemini API ${res.status}`)
    }

    const data    = await res.json()
    const text    = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}'
    const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim()

    let parsed
    try {
      parsed = JSON.parse(cleaned)
    } catch {
      // ★ 핵심 수정: Gemini가 문자열 안에 실제 개행을 넣으면 JSON 파싱 실패
      // 문자열 값 내부의 실제 개행을 \n 이스케이프로 교체 후 재시도
      try {
        const fixedNewlines = cleaned.replace(
          /"((?:[^"\\]|\\.)*)"/g,
          (_, val) => '"' + val.replace(/\r?\n/g, '\\n') + '"'
        )
        parsed = JSON.parse(fixedNewlines)
      } catch {
        // 그래도 실패하면 중괄호 추출 후 같은 처리
        const match = cleaned.match(/\{[\s\S]*\}/)
        if (match) {
          try {
            const fixedMatch = match[0].replace(
              /"((?:[^"\\]|\\.)*)"/g,
              (_, val) => '"' + val.replace(/\r?\n/g, '\\n') + '"'
            )
            parsed = JSON.parse(fixedMatch)
          } catch {
            parsed = {}
          }
        } else {
          parsed = {}
        }
      }
    }

    // ★ summary 안전 추출
    const safeSummary = extractSummary(parsed, keyword)
    const report = { ...EMPTY_REPORT, ...parsed, summary: safeSummary }

    // 필터링 DB 반영
    const irrelevantSet = new Set((report.irrelevant_items || []).map(n => n - 1))
    const updatePromises = []
    for (let i = 0; i < evidenceList.length; i++) {
      const e = evidenceList[i]
      if (irrelevantSet.has(i)) {
        updatePromises.push(supabase.from('evidence').update({ relevance_score: 0 }).eq('id', e.id))
      } else {
        const newScore = Math.max(e.relevance_score || 0, 0.8)
        updatePromises.push(supabase.from('evidence').update({ relevance_score: newScore }).eq('id', e.id))
      }
    }
    await Promise.all(updatePromises)

    const filteredEvidence = evidenceList.filter((_, i) => !irrelevantSet.has(i))
    console.log(`[${keyword}] 필터링: ${evidenceList.length} → ${filteredEvidence.length}건 | summary: "${safeSummary.slice(0, 30)}..."`)

    if (filteredEvidence.length === 0 && evidenceList.length > 0) {
      console.warn(`[${keyword}] 필터링 결과 0건 — 전체 유지`)
      return { report, filteredEvidence: evidenceList }
    }

    return { report, filteredEvidence }
  } catch (e) {
    console.error(`[${keyword}] AI 분석 오류:`, e.message)
    return {
      report: { ...EMPTY_REPORT, summary: `${keyword} 관련 최신 동향을 분석 중입니다.` },
      filteredEvidence: evidenceList
    }
  }
}

export default async function handler(req, res) {
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  try {
    // ★ 수정: 리포트 없는 트렌드 우선 처리 → 그 다음 오래된 것 순
    const { data: trendsWithReport } = await supabase
      .from('reports')
      .select('trend_id')

    const analyzedIds = new Set((trendsWithReport || []).map(r => r.trend_id))

    const { data: allTrends } = await supabase
      .from('trends')
      .select('id, keyword, score, updated_at')
      .order('updated_at', { ascending: true })

    if (!allTrends?.length) {
      return res.status(200).json({ ok: true, message: '분석할 트렌드 없음' })
    }

    // 리포트 없는 것 먼저, 그 다음 오래된 순
    const unanalyzed = allTrends.filter(t => !analyzedIds.has(t.id))
    const analyzed   = allTrends.filter(t =>  analyzedIds.has(t.id))
    const targets    = [...unanalyzed, ...analyzed].slice(0, BATCH_SIZE)

    let analyzedCount = 0
    const results = []

    for (const trend of targets) {
      const { data: evidenceList } = await supabase
        .from('evidence')
        .select('*')
        .eq('trend_id', trend.id)
        .order('published_at', { ascending: false })
        .limit(30)

      if (!evidenceList?.length) {
        console.log(`[${trend.keyword}] 근거자료 없음 — 건너뜀`)
        continue
      }

      const { report, filteredEvidence } = await filterAndReport(
        trend.keyword, evidenceList, trend.score || 0
      )

      const newScore   = calcTrendScore(filteredEvidence)
      const confidence = getConfidence(newScore)
      const prevScore  = trend.score || 0
      const weeklyChange = newScore - prevScore

      await supabase.from('trends').update({
        prev_score: prevScore,
        score: newScore,
        weekly_change: weeklyChange,
        confidence_level: confidence,
        updated_at: new Date().toISOString()
      }).eq('id', trend.id)

      await supabase.from('reports').upsert({
        trend_id:        trend.id,
        summary:         report.summary,
        prediction:      report.prediction,
        sector:          report.sector,
        time_horizon:    report.time_horizon,
        evidence_summary: report,
        generated_at:    new Date().toISOString()
      }, { onConflict: 'trend_id' })

      results.push({
        keyword:    trend.keyword,
        score:      newScore,
        change:     weeklyChange,
        confidence,
        filtered:   `${filteredEvidence.length}/${evidenceList.length}`,
        summary_ok: report.summary.length > 10
      })

      analyzedCount++
      await new Promise(r => setTimeout(r, API_DELAY))
    }

    res.status(200).json({
      ok: true,
      message: `${analyzedCount}/${targets.length}개 트렌드 분석 완료 (배치 ${BATCH_SIZE})`,
      details: results
    })
  } catch (e) {
    console.error('analyze handler error:', e)
    res.status(500).json({ error: e.message })
  }
}
