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

async function generateReport(keyword, evidenceList, score) {
  // ★ API 키 체크
  if (!process.env.GEMINI_API_KEY) {
    console.warn('GEMINI_API_KEY 미설정 — AI 분석 건너뜀')
    return {
      summary: '분석 대기 중 (API 키 미설정)',
      prediction: '',
      sector: '',
      time_horizon: '중기(3년)',
      key_signals: [],
      risk_factors: [],
      countries_leading: []
    }
  }

  const byType = {}
  for (const e of evidenceList) {
    if (!byType[e.type]) byType[e.type] = []
    byType[e.type].push(`[${e.country || 'global'}] ${e.title}${e.summary ? ' — ' + e.summary : ''}`)
  }

  const dataBlock = Object.entries(byType).map(([type, items]) =>
    `[${type.toUpperCase()}]\n${items.slice(0, 5).join('\n')}`
  ).join('\n\n')

  const prompt = `당신은 글로벌 기술 트렌드 전문 분석가입니다.
아래 데이터를 종합해서 "${keyword}" 기술의 투자 전망을 분석해주세요.
트렌드 점수: ${score}/100

${dataBlock}

반드시 아래 JSON 형식으로만 응답하세요 (마크다운 코드블록 없이 순수 JSON):
{
  "summary": "2~3문장 핵심 요약 (한국어)",
  "prediction": "향후 1~3년 전망 및 투자 포인트 (한국어, 3~5문장)",
  "sector": "관련 산업 분야",
  "time_horizon": "단기(1년) 또는 중기(3년) 또는 장기(5년+)",
  "key_signals": ["핵심 신호1", "핵심 신호2", "핵심 신호3"],
  "risk_factors": ["리스크1", "리스크2"],
  "countries_leading": ["주도국가1", "주도국가2"]
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
            maxOutputTokens: 1000
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

    // JSON 파싱 (코드블록 감싸기 대응)
    const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim()
    return JSON.parse(cleaned)
  } catch (e) {
    console.error('AI report error:', e.message)
    return {
      summary: `"${keyword}" 분석 중 오류 발생`,
      prediction: '',
      sector: '',
      time_horizon: '중기(3년)',
      key_signals: [],
      risk_factors: [],
      countries_leading: []
    }
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
